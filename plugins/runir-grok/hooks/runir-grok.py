#!/usr/bin/env python3
"""Native Grok lifecycle adapter for Rúnir.

- UserPromptSubmit: prefetch relevant memory before inference.
- PreToolUse: deliver prefetched memory before the first substantive tool action.
- Stop (reason=end_turn): deliver memory before a direct answer, then capture the
  completed memory-informed user/assistant turn in the background.

Hardening (D1–D4 + P):
- D1: stale capture-marker bail (RUNIR_CAPTURE_STALE_S, default 5.0s)
- D2: fcntl flock on consume_recall / write_recall_state / dedupe
- D3: sha256(context) cross-turn dedupe (TTL 3600s, last 32)
- D4: narrow PreToolUse matcher lives in templates/user-hooks.json (not this file)
- P: batch-coherent sibling re-deny within RUNIR_BATCH_SIBLING_S (default 2.0s)

No terminal-session hook is registered: durable memory is turn-based because
sessions may crash, disappear, or resume without a clean terminal event.

The adapter is intentionally thin: Rúnir owns retrieval, extraction, ranking,
and write arbitration. Hook failures are fail-open and silent unless
RUNIR_DEBUG=1.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping

# Shared leaves live in lib/runir_core.py (path-loaded, no package install).
_LIB = Path(__file__).resolve().parents[1] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
import runir_core as _core  # noqa: E402
from runir_core import (  # noqa: E402
    RECALL_FEEDBACK_PREFIX,
    RUNIR_BASE,
    content_hash,
    env_float,
    env_int,
    event_value,
    normalize_content,
    read_dotenv_value,
    resolve_credential,
    unwrap_user_query,
)


def post_json(
    url: str, payload: dict[str, Any], timeout: float
) -> tuple[int, dict[str, Any]] | None:
    """Hook-local wrapper: passes module RUNIR_API_KEY so monkeypatches still work."""
    result = _core.post_json(
        url,
        payload,
        timeout,
        api_key=RUNIR_API_KEY,
        user_agent=RUNIR_USER_AGENT,
    )
    if result is None:
        debug(f"request failed for {url}")
    return result


RUNIR_USER_ID = resolve_credential("RUNIR_USER_ID")
RUNIR_API_KEY = resolve_credential("RUNIR_API_KEY")
RUNIR_CLIENT = os.environ.get("RUNIR_GROK_CLIENT", "grok")
RUNIR_USER_AGENT = os.environ.get("RUNIR_GROK_USER_AGENT", "runir-grok-hook/0.1")
RUNIR_RECALL_URL = os.environ.get("RUNIR_RECALL_URL", f"{RUNIR_BASE}/hooks/recall")
RUNIR_CAPTURE_URL = os.environ.get("RUNIR_CAPTURE_URL", f"{RUNIR_BASE}/hooks/capture")
RUNIR_DEBUG = os.environ.get("RUNIR_DEBUG") == "1"

RUNIR_RECALL_TIMEOUT = env_float("RUNIR_RECALL_TIMEOUT", 5.0)
RUNIR_CAPTURE_TIMEOUT = env_float("RUNIR_CAPTURE_TIMEOUT", 30.0)
RUNIR_CAPTURE_WAIT_TIMEOUT = env_float("RUNIR_CAPTURE_WAIT_TIMEOUT", 32.0)
RUNIR_CAPTURE_POLL_INTERVAL = env_float("RUNIR_CAPTURE_POLL_INTERVAL", 0.05)
RUNIR_CAPTURE_STALE_S = env_float("RUNIR_CAPTURE_STALE_S", 5.0)
RUNIR_BATCH_SIBLING_S = env_float("RUNIR_BATCH_SIBLING_S", 2.0)
RUNIR_RECALL_DEDUPE_TTL_S = env_float("RUNIR_RECALL_DEDUPE_TTL_S", 3600.0)
RUNIR_RECALL_DEDUPE_MAX = env_int("RUNIR_RECALL_DEDUPE_MAX", 32)
STATE_DIR = Path.home() / ".grok" / "state" / "runir"
# Observability ring retention (Pi TRACE_LIMIT parity). Hard cap: keep last TRACE_LIMIT.
TRACE_LIMIT = 100


def debug(message: str) -> None:
    if RUNIR_DEBUG:
        print(f"[runir-grok] {message}", file=sys.stderr)


def state_path(kind: str, session_id: str, suffix: str = ".json") -> Path | None:
    if not session_id:
        return None
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return STATE_DIR / f"{kind}-{digest}{suffix}"


def capture_marker_path(session_id: str) -> Path | None:
    return state_path("capture", session_id)


def recall_state_path(session_id: str) -> Path | None:
    return state_path("recall", session_id)


def dedupe_path(session_id: str) -> Path | None:
    return state_path("dedupe", session_id)


def trace_path(session_id: str) -> Path | None:
    return state_path("trace", session_id, suffix=".jsonl")


def status_path(session_id: str) -> Path | None:
    return state_path("status", session_id, suffix=".json")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def append_trace_event(session_id: str, event: dict[str, Any]) -> None:
    """Append one JSON object to trace-{digest}.jsonl; ring-trim under flock."""
    path = trace_path(session_id)
    if path is None:
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, separators=(",", ":")) + "\n"
    with exclusive_state_lock(path):
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(line)
        try:
            text = path.read_text(encoding="utf-8")
            lines = [ln for ln in text.splitlines() if ln.strip()]
            if len(lines) > TRACE_LIMIT:
                keep = lines[-TRACE_LIMIT:]
                temporary = path.with_name(
                    f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
                )
                try:
                    temporary.write_text("\n".join(keep) + "\n", encoding="utf-8")
                    os.replace(temporary, path)
                finally:
                    try:
                        temporary.unlink()
                    except FileNotFoundError:
                        pass
        except OSError:
            pass


def write_status(session_id: str, data: dict[str, Any]) -> None:
    """Atomic latest-turn status-{digest}.json (reuses write_json_state)."""
    write_json_state(status_path(session_id), data)


def record_event(
    session_id: str,
    kind: str,
    **fields: Any,
) -> None:
    """Fail-open observability: append trace + refresh status. Never raises."""
    try:
        if not session_id or not kind:
            return None
        now = time.time()
        at = _utc_now_iso()
        event: dict[str, Any] = {
            "schema": 1,
            "at": at,
            "ms": int(now * 1000),
            "kind": kind,
            "pid": os.getpid(),
        }
        for key, value in fields.items():
            if value is not None:
                event[key] = value
        append_trace_event(session_id, event)

        # Status RMW under exclusive lock so concurrent deliveries cannot lose counts.
        path = status_path(session_id)
        with exclusive_state_lock(path):
            prev = read_json_state(path) or {}
            raw_counts = (
                prev.get("counts") if isinstance(prev.get("counts"), dict) else {}
            )
            counts: dict[str, int] = {
                "recall": int(raw_counts.get("recall", 0) or 0),
                "deliver": int(raw_counts.get("deliver", 0) or 0),
                "skip": int(raw_counts.get("skip", 0) or 0),
                "capture": int(raw_counts.get("capture", 0) or 0),
                "error": int(raw_counts.get("error", 0) or 0),
            }
            if kind in counts:
                counts[kind] = counts[kind] + 1

            if kind == "capture":
                phase = "capturing" if fields.get("status") == "pending" else "captured"
            else:
                phase = {
                    "recall": "recall",
                    "deliver": "delivered",
                    "skip": "skipped",
                    "error": "error",
                }.get(kind, kind)

            status: dict[str, Any] = {
                "schema": 1,
                "updatedAt": at,
                "phase": phase,
                "lastKind": kind,
                "counts": counts,
            }
            prompt_id = fields.get("promptId") or prev.get("promptId")
            if prompt_id:
                status["promptId"] = prompt_id
            if "contextChars" in fields and fields["contextChars"] is not None:
                status["contextChars"] = fields["contextChars"]
            elif "contextChars" in prev:
                status["contextChars"] = prev["contextChars"]
            if fields.get("hash12"):
                status["hash12"] = fields["hash12"]
            elif prev.get("hash12"):
                status["hash12"] = prev["hash12"]
            if kind == "capture" and fields.get("status") is not None:
                status["captureStatus"] = fields["status"]
            elif prev.get("captureStatus") is not None:
                status["captureStatus"] = prev["captureStatus"]
            if kind == "error":
                status["lastError"] = {
                    "where": fields.get("where"),
                    "type": fields.get("type"),
                }
            elif isinstance(prev.get("lastError"), dict):
                status["lastError"] = prev["lastError"]
            write_status(session_id, status)
        return None
    except Exception:
        return None


def read_json_state(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def write_json_state(path: Path | None, data: dict[str, Any]) -> None:
    if path is None:
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


@contextlib.contextmanager
def exclusive_state_lock(path: Path | None) -> Iterator[None]:
    """D2: advisory exclusive lock beside a state file (fcntl flock; local FS only)."""
    if path is None:
        yield
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    handle = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def read_capture_marker(session_id: str) -> dict[str, Any] | None:
    return read_json_state(capture_marker_path(session_id))


def mark_capture(session_id: str, token: str, status: str) -> None:
    path = capture_marker_path(session_id)
    if path is None:
        return
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    current = read_capture_marker(session_id)
    if (
        status != "pending"
        and isinstance(current, dict)
        and current.get("token") != token
    ):
        return
    write_json_state(path, {"token": token, "status": status, "updatedAt": time.time()})


def prune_dedupe(
    entries: list[dict[str, Any]], now: float | None = None
) -> list[dict[str, Any]]:
    """Keep newest RUNIR_RECALL_DEDUPE_MAX entries within TTL."""
    now = time.time() if now is None else now
    ttl = RUNIR_RECALL_DEDUPE_TTL_S
    kept: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        ts = entry.get("at")
        digest = entry.get("hash")
        if not isinstance(digest, str) or not digest:
            continue
        if not isinstance(ts, (int, float)):
            continue
        if now - float(ts) > ttl:
            continue
        kept.append({"hash": digest, "at": float(ts)})
    kept.sort(key=lambda e: e["at"], reverse=True)
    return kept[:RUNIR_RECALL_DEDUPE_MAX]


def was_recently_delivered(session_id: str, digest: str) -> bool:
    path = dedupe_path(session_id)
    with exclusive_state_lock(path):
        state = read_json_state(path) or {}
        entries = state.get("entries")
        if not isinstance(entries, list):
            entries = []
        pruned = prune_dedupe(entries)
        if pruned != entries:
            write_json_state(path, {"entries": pruned, "updatedAt": time.time()})
        return any(e.get("hash") == digest for e in pruned)


def remember_delivered_hash(session_id: str, digest: str) -> None:
    path = dedupe_path(session_id)
    with exclusive_state_lock(path):
        state = read_json_state(path) or {}
        entries = state.get("entries")
        if not isinstance(entries, list):
            entries = []
        now = time.time()
        entries = [
            e for e in entries if isinstance(e, dict) and e.get("hash") != digest
        ]
        entries.append({"hash": digest, "at": now})
        write_json_state(
            path, {"entries": prune_dedupe(entries, now=now), "updatedAt": now}
        )


def write_recall_state(
    session_id: str,
    prompt_id: str,
    context: str,
    *,
    delivered: bool | None = None,
    content_hash_value: str | None = None,
) -> None:
    path = recall_state_path(session_id)
    payload: dict[str, Any] = {
        "promptId": prompt_id,
        "context": context,
        "delivered": (not bool(context)) if delivered is None else delivered,
        "updatedAt": time.time(),
    }
    if content_hash_value:
        payload["contentHash"] = content_hash_value
    with exclusive_state_lock(path):
        write_json_state(path, payload)


def pending_recall(event: dict[str, Any]) -> tuple[Path, dict[str, Any]] | None:
    session_id = str(event_value(event, "sessionId", "session_id", default=""))
    path = recall_state_path(session_id)
    state = read_json_state(path)
    if path is None or not state or state.get("delivered") is True:
        return None
    event_prompt_id = event_value(event, "promptId", "prompt_id")
    state_prompt_id = state.get("promptId")
    if event_prompt_id and state_prompt_id and event_prompt_id != state_prompt_id:
        return None
    context = state.get("context")
    if not isinstance(context, str) or not context:
        return None
    return path, state


def consume_recall(event: dict[str, Any]) -> str | None:
    """D2: claim undelivered recall under exclusive lock; keep context for sibling re-deny."""
    session_id = str(event_value(event, "sessionId", "session_id", default=""))
    path = recall_state_path(session_id)
    if path is None:
        return None
    with exclusive_state_lock(path):
        state = read_json_state(path)
        if not state or state.get("delivered") is True:
            return None
        event_prompt_id = event_value(event, "promptId", "prompt_id")
        state_prompt_id = state.get("promptId")
        if event_prompt_id and state_prompt_id and event_prompt_id != state_prompt_id:
            return None
        context = state.get("context")
        if not isinstance(context, str) or not context:
            return None
        state["delivered"] = True
        state["deliveredAt"] = time.time()
        # Keep context so batch siblings can re-deny with the same payload (P).
        write_json_state(path, state)
        return context


def sibling_recall_context(event: dict[str, Any]) -> str | None:
    """P: re-deny batch siblings within RUNIR_BATCH_SIBLING_S of first delivery."""
    session_id = str(event_value(event, "sessionId", "session_id", default=""))
    path = recall_state_path(session_id)
    if path is None:
        return None
    with exclusive_state_lock(path):
        state = read_json_state(path)
        if not state or state.get("delivered") is not True:
            return None
        event_prompt_id = event_value(event, "promptId", "prompt_id")
        state_prompt_id = state.get("promptId")
        if event_prompt_id and state_prompt_id and event_prompt_id != state_prompt_id:
            return None
        delivered_at = state.get("deliveredAt")
        if not isinstance(delivered_at, (int, float)):
            return None
        if time.time() - float(delivered_at) > RUNIR_BATCH_SIBLING_S:
            return None
        context = state.get("context")
        if not isinstance(context, str) or not context:
            return None
        return context


def wait_for_prior_capture(session_id: str) -> None:
    """D1: poll pending capture; bail early if updatedAt is older than RUNIR_CAPTURE_STALE_S."""
    if not session_id:
        return
    deadline = time.monotonic() + RUNIR_CAPTURE_WAIT_TIMEOUT
    while time.monotonic() < deadline:
        state = read_capture_marker(session_id)
        if not state or state.get("status") != "pending":
            return
        updated_at = state.get("updatedAt")
        # Legacy markers without updatedAt: fail-safe once (do not treat as stale).
        if isinstance(updated_at, (int, float)):
            age = time.time() - float(updated_at)
            if age > RUNIR_CAPTURE_STALE_S:
                path = capture_marker_path(session_id)
                write_json_state(
                    path,
                    {
                        "token": state.get("token"),
                        "status": "stale",
                        "updatedAt": time.time(),
                        "staleReason": "capture_pending_exceeded_stale_s",
                    },
                )
                debug(f"capture marker stale for session={session_id} age={age:.2f}s")
                return
        time.sleep(RUNIR_CAPTURE_POLL_INTERVAL)
    debug(f"capture wait timed out for session={session_id}")


def read_transcript_messages(transcript_path: str | None) -> list[dict[str, str]]:
    if not transcript_path:
        return []
    path = Path(transcript_path)
    if not path.is_file():
        return []

    messages: list[dict[str, str]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue

                # Native Grok updates.jsonl shape.
                update = (
                    item.get("params", {}).get("update", {})
                    if isinstance(item, dict)
                    else {}
                )
                update_type = update.get("sessionUpdate")
                role = None
                if update_type == "user_message_chunk":
                    role = "user"
                elif update_type == "agent_message_chunk":
                    role = "assistant"
                if role:
                    text = normalize_content(update.get("content"))
                    if text:
                        messages.append({"role": role, "content": text})
                    continue

                # Tolerate Codex-style response_item transcripts for fixtures/tools.
                if item.get("type") != "response_item":
                    continue
                payload = item.get("payload") or {}
                if payload.get("type") != "message" or payload.get("role") not in (
                    "user",
                    "assistant",
                ):
                    continue
                text = normalize_content(payload.get("content"))
                if text:
                    messages.append({"role": payload["role"], "content": text})
    except OSError as exc:
        debug(f"transcript read failed: {exc}")
        return []
    return messages


def handle_recall(event: dict[str, Any]) -> None:
    prompt = event_value(event, "prompt", default="")
    if not isinstance(prompt, str):
        return
    prompt = unwrap_user_query(prompt).strip()
    session_id = str(event_value(event, "sessionId", "session_id", default=""))
    prompt_id = str(event_value(event, "promptId", "prompt_id", default=""))
    if not prompt:
        record_event(
            session_id, "skip", reason="empty_prompt", promptId=prompt_id or None
        )
        return
    wait_for_prior_capture(session_id)
    payload = {
        "prompt": prompt,
        "userId": RUNIR_USER_ID,
        "client": RUNIR_CLIENT,
        "sessionId": session_id or None,
        "path": event_value(event, "workspaceRoot", "workspace_root", "cwd"),
    }
    t0 = time.monotonic()
    result = post_json(RUNIR_RECALL_URL, payload, RUNIR_RECALL_TIMEOUT)
    duration_ms = int((time.monotonic() - t0) * 1000)
    context = ""
    http_status: int | None = None
    if result is None:
        # Network / transport failure — surface as kind=error; still fail-open state.
        record_event(
            session_id,
            "error",
            where="recall",
            type="request_failed",
            promptId=prompt_id or None,
            durationMs=duration_ms,
        )
        write_recall_state(session_id, prompt_id, "")
        record_event(
            session_id,
            "skip",
            reason="request_failed",
            promptId=prompt_id or None,
            durationMs=duration_ms,
        )
        return
    status, body = result
    http_status = status
    if not 200 <= status < 300:
        debug(f"recall returned HTTP {status}")
        record_event(
            session_id,
            "error",
            where="recall",
            type="http_error",
            httpStatus=http_status,
            promptId=prompt_id or None,
            durationMs=duration_ms,
        )
        write_recall_state(session_id, prompt_id, "")
        record_event(
            session_id,
            "skip",
            reason="http_error",
            httpStatus=http_status,
            promptId=prompt_id or None,
            durationMs=duration_ms,
        )
        return
    recalled = body.get("prependContext")
    context = recalled if isinstance(recalled, str) else ""
    digest = content_hash(context) if context else ""
    hash12 = digest[:12] if digest else None
    record_event(
        session_id,
        "recall",
        promptId=prompt_id or None,
        httpStatus=http_status,
        contextChars=len(context),
        hash12=hash12,
        durationMs=duration_ms,
    )
    # D3: suppress gate if same context was recently delivered this session.
    if context and session_id and was_recently_delivered(session_id, digest):
        write_recall_state(
            session_id,
            prompt_id,
            context,
            delivered=True,
            content_hash_value=digest,
        )
        debug(f"dedupe hit for session={session_id} hash={digest[:12]}")
        record_event(
            session_id,
            "skip",
            reason="dedupe",
            promptId=prompt_id or None,
            hash12=hash12,
            contextChars=len(context),
        )
        return
    write_recall_state(
        session_id,
        prompt_id,
        context,
        content_hash_value=digest if digest else None,
    )
    if not context:
        record_event(
            session_id,
            "skip",
            reason="no_context",
            promptId=prompt_id or None,
        )


def handle_pre_tool_use(event: dict[str, Any]) -> None:
    context = consume_recall(event)
    if not context:
        context = sibling_recall_context(event)
    if context:
        session_id = str(event_value(event, "sessionId", "session_id", default=""))
        if session_id:
            remember_delivered_hash(session_id, content_hash(context))
        json.dump(
            {"decision": "deny", "reason": RECALL_FEEDBACK_PREFIX + context}, sys.stdout
        )
        # Host reads decision JSON before hook exit; flush before any LOCK_EX work.
        sys.stdout.flush()
        digest = content_hash(context)
        record_event(
            session_id,
            "deliver",
            channel="pre_tool_use",
            contextChars=len(context),
            hash12=digest[:12] if digest else None,
            promptId=str(event_value(event, "promptId", "prompt_id", default=""))
            or None,
        )


def current_turn_messages(event: dict[str, Any]) -> list[dict[str, str]]:
    transcript = event_value(event, "transcriptPath", "transcript_path")
    messages = read_transcript_messages(transcript)
    last_user: dict[str, str] | None = None
    for message in reversed(messages):
        if message["role"] == "user":
            last_user = message
            break

    assistant = event_value(event, "lastAssistantMessage", "last_assistant_message")
    assistant_text = assistant if isinstance(assistant, str) else ""
    if last_user and assistant_text:
        return [last_user, {"role": "assistant", "content": assistant_text}]
    if assistant_text:
        return [{"role": "assistant", "content": assistant_text}]
    return []


def handle_capture(event: dict[str, Any], session_id: str, token: str) -> None:
    status_name = "failed"
    messages_count = 0
    err_type: str | None = None
    http_status: int | None = None
    t0 = time.monotonic()
    prompt_id = str(event_value(event, "promptId", "prompt_id", default="")) or None
    try:
        messages = current_turn_messages(event)
        messages_count = len(messages)
        if not messages:
            status_name = "empty"
            return
        payload = {
            "messages": messages,
            "userId": RUNIR_USER_ID,
            "client": RUNIR_CLIENT,
            "sessionId": session_id or None,
            "path": event_value(event, "workspaceRoot", "workspace_root", "cwd"),
        }
        result = post_json(RUNIR_CAPTURE_URL, payload, RUNIR_CAPTURE_TIMEOUT)
        if not result:
            err_type = "request_failed"
            return
        status, body = result
        http_status = status
        if not 200 <= status < 300 or "error" in body:
            debug(f"capture was not accepted: HTTP {status}, body={body}")
            err_type = "http_error"
            return
        status_name = "done"
    finally:
        mark_capture(session_id, token, status_name)
        record_event(
            session_id,
            "capture",
            status=status_name,
            messages=messages_count,
            durationMs=int((time.monotonic() - t0) * 1000),
            promptId=prompt_id,
            httpStatus=http_status,
        )
        if err_type is not None:
            record_event(
                session_id,
                "error",
                where="capture",
                type=err_type,
                promptId=prompt_id,
                httpStatus=http_status,
                durationMs=int((time.monotonic() - t0) * 1000),
            )


def handle_stop(event: dict[str, Any]) -> None:
    if event_value(event, "reason") != "end_turn":
        return
    # Continuation after a prior Stop block must not re-burn a draft (≤1 draft).
    # stopHookActive is set by the host when Stop previously blocked this turn.
    if event_value(event, "stopHookActive", "stop_hook_active"):
        detach_capture(event)
        return
    # First undelivered claim only — sibling re-deny is PreToolUse batch (P).
    # Reusing sibling on Stop re-blocks continuations within RUNIR_BATCH_SIBLING_S.
    context = consume_recall(event)
    if context:
        session_id = str(event_value(event, "sessionId", "session_id", default=""))
        if session_id:
            remember_delivered_hash(session_id, content_hash(context))
        json.dump(
            {
                "decision": "block",
                "reason": RECALL_FEEDBACK_PREFIX + context,
            },
            sys.stdout,
        )
        # Host reads decision JSON before hook exit; flush before any LOCK_EX work.
        sys.stdout.flush()
        digest = content_hash(context)
        record_event(
            session_id,
            "deliver",
            channel="stop",
            contextChars=len(context),
            hash12=digest[:12] if digest else None,
            promptId=str(event_value(event, "promptId", "prompt_id", default=""))
            or None,
        )
        return
    detach_capture(event)


def detach_capture(event: dict[str, Any]) -> None:
    """Run capture off the Stop-hook hot path, matching the Claude adapter."""
    session_id = str(event_value(event, "sessionId", "session_id", default=""))
    token = uuid.uuid4().hex
    mark_capture(session_id, token, "pending")
    try:
        pid = os.fork()
    except OSError as exc:
        debug(f"capture fork failed, using synchronous fallback: {exc}")
        handle_capture(event, session_id, token)
        return
    if pid:
        return

    try:
        os.setsid()
        devnull = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(devnull, fd)
        if devnull > 2:
            os.close(devnull)
        handle_capture(event, session_id, token)
    finally:
        os._exit(0)


def main() -> int:
    if not RUNIR_USER_ID:
        return 0
    # Programmatic headless path owns recall+capture; full no-op all events.
    # Call-time env read (not import-time) so tests can monkeypatch.setenv.
    if os.environ.get("RUNIR_GROK_DISABLE_GATE") == "1":
        return 0
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(event, dict):
        return 0

    name = ""
    try:
        name = str(
            event_value(event, "hookEventName", "hook_event_name", default="")
        ).lower()
        if name == "user_prompt_submit":
            handle_recall(event)
        elif name == "pre_tool_use":
            handle_pre_tool_use(event)
        elif name == "stop":
            handle_stop(event)
    except Exception as exc:
        debug(f"hook handler failed open: {exc}")
        session_id = str(event_value(event, "sessionId", "session_id", default=""))
        prompt_id = str(event_value(event, "promptId", "prompt_id", default="")) or None
        record_event(
            session_id,
            "error",
            where=name or "main",
            type=type(exc).__name__,
            promptId=prompt_id,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
