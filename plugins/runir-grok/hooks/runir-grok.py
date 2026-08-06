#!/usr/bin/env python3
"""Native Grok lifecycle adapter for Rúnir.

TUI floor (honest):
- UserPromptSubmit: record turn prompt for capture + ambient MEMORY.md bridge
  publish (prompt-blind / session-stale — no pre-inference TUI memory inject).
- Stop (reason=end_turn): capture-only (no additionalContext / decision:block).
- PreToolUse deny-for-memory transport is retired (handler removed).

Hardening retained:
- D1: stale capture-marker bail (RUNIR_CAPTURE_STALE_S) before UPS continues
- flock on state / bridge RMW (local FS only)
- ambient memory_bridge managed block + explicit runir-recall skill

Headless inject (scripts/headless_inject.py) still uses /hooks/recall +
RECALL_FEEDBACK_PREFIX for pre-inference memory. TUI cannot surface that
channel before the model runs.

No terminal-session hook is registered: durable memory is turn-based because
sessions may crash, disappear, or resume without a clean terminal event.

Hook failures are fail-open and silent unless RUNIR_DEBUG=1.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

# Shared leaves live in lib/runir_core.py (path-loaded, no package install).
_LIB = Path(__file__).resolve().parents[1] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
import runir_core as _core  # noqa: E402
from runir_core import (  # noqa: E402
    RUNIR_BASE,
    env_float,
    event_value,
    exclusive_lock,
    grok_home,
    normalize_content,
    read_dotenv_value as read_dotenv_value,
    read_json,
    resolve_credential,
    resolve_effective_user_id,
    unwrap_user_query,
    write_json_atomic,
)

# Re-export for tests/headless that still import via the hook module.
from runir_core import RECALL_FEEDBACK_PREFIX, content_hash, selection_id  # noqa: E402,F401


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


# Identity: fail-loud conflict → None (TUI main still fail-open). Never invent.
_EFFECTIVE_USER = resolve_effective_user_id()
RUNIR_USER_ID = _EFFECTIVE_USER.user_id
RUNIR_USER_ID_SOURCE = _EFFECTIVE_USER.source
RUNIR_USER_ID_CONFLICT = _EFFECTIVE_USER.conflict
# API keys stay process-first without conflict detection (key freshness).
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
RUNIR_SYNC_MIN_S = env_float("RUNIR_SYNC_MIN_S", 300.0)
RUNIR_SYNC_LEASE_S = env_float("RUNIR_SYNC_LEASE_S", 60.0)
RUNIR_SYNC_FIRST_TURN_TIMEOUT_S = env_float("RUNIR_SYNC_FIRST_TURN_TIMEOUT_S", 8.0)
BRIDGE_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "memory_bridge.py"
STATE_DIR = grok_home() / "state" / "runir"
# Observability ring retention (Pi TRACE_LIMIT parity). Hard cap: keep last TRACE_LIMIT.
TRACE_LIMIT = 100


def debug(message: str) -> None:
    if RUNIR_DEBUG:
        print(f"[runir-grok] {message}", file=sys.stderr)


def resolved_state_dir() -> Path:
    """Prefer $GROK_HOME/state/runir when set; else module STATE_DIR (tests monkeypatch)."""
    raw = (os.environ.get("GROK_HOME") or "").strip()
    if raw:
        return Path(raw).expanduser() / "state" / "runir"
    return STATE_DIR


def state_path(kind: str, session_id: str, suffix: str = ".json") -> Path | None:
    if not session_id:
        return None
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return resolved_state_dir() / f"{kind}-{digest}{suffix}"


def capture_marker_path(session_id: str) -> Path | None:
    return state_path("capture", session_id)


def recall_state_path(session_id: str) -> Path | None:
    return state_path("recall", session_id)


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
    resolved_state_dir().mkdir(parents=True, exist_ok=True)
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
    return read_json(path)


def write_json_state(path: Path | None, data: dict[str, Any]) -> None:
    if path is None:
        return
    resolved_state_dir().mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, data)


@contextlib.contextmanager
def exclusive_state_lock(path: Path | None) -> Iterator[None]:
    """Advisory exclusive lock beside a state file (fcntl flock; local FS only)."""
    if path is not None:
        resolved_state_dir().mkdir(parents=True, exist_ok=True)
    with exclusive_lock(path):
        yield


def read_capture_marker(session_id: str) -> dict[str, Any] | None:
    return read_json_state(capture_marker_path(session_id))


def mark_capture(session_id: str, token: str, status: str) -> None:
    path = capture_marker_path(session_id)
    if path is None:
        return
    resolved_state_dir().mkdir(parents=True, exist_ok=True)
    current = read_capture_marker(session_id)
    if (
        status != "pending"
        and isinstance(current, dict)
        and current.get("token") != token
    ):
        return
    write_json_state(path, {"token": token, "status": status, "updatedAt": time.time()})


def write_recall_state(
    session_id: str,
    prompt_id: str,
    context: str = "",
    *,
    delivered: bool | None = None,
    content_hash_value: str | None = None,
    prompt: str | None = None,
    selection_id_value: str | None = None,
    memory_ids: list[str] | None = None,
    retrieval_trace_id: str | None = None,
) -> None:
    """Persist turn state for capture (prompt). Context/identity optional (headless)."""
    path = recall_state_path(session_id)
    # Default: empty context is already "delivered" (nothing for retired TUI transports).
    if delivered is None:
        delivered = not bool(context)
    payload: dict[str, Any] = {
        "schema": 2,
        "promptId": prompt_id,
        "context": context or "",
        "delivered": delivered,
        "updatedAt": time.time(),
    }
    if content_hash_value:
        payload["contentHash"] = content_hash_value
    if prompt:
        payload["prompt"] = prompt
    if selection_id_value:
        payload["selectionId"] = selection_id_value
    if memory_ids:
        payload["memoryIds"] = list(memory_ids)
    if retrieval_trace_id:
        payload["retrievalTraceId"] = retrieval_trace_id
    with exclusive_state_lock(path):
        write_json_state(path, payload)


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
    """UPS path: prompt-only turn state. No TUI /hooks/recall HTTP (prompt-blind).

    Capture still reads state["prompt"] (and optional identity if a future path
    writes it). Wait for prior capture (D1) to avoid races with Stop capture.
    """
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
    write_recall_state(
        session_id,
        prompt_id,
        "",
        delivered=True,
        prompt=prompt,
    )
    record_event(
        session_id,
        "skip",
        reason="prompt_only",
        promptId=prompt_id or None,
        channel="user_prompt_submit",
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
        state = read_json_state(recall_state_path(session_id)) or {}
        state_prompt = state.get("prompt")
        if isinstance(state_prompt, str) and state_prompt.strip():
            # Prefer original unwrapped human prompt over host-wrapped transcript text.
            replaced = False
            for i, msg in enumerate(messages):
                if msg.get("role") == "user":
                    messages[i] = {"role": "user", "content": state_prompt.strip()}
                    replaced = True
                    break
            if not replaced:
                messages = [
                    {"role": "user", "content": state_prompt.strip()}
                ] + messages
        payload: dict[str, Any] = {
            "messages": messages,
            "userId": RUNIR_USER_ID,
            "client": RUNIR_CLIENT,
            "sessionId": session_id or None,
            "path": event_value(event, "workspaceRoot", "workspace_root", "cwd"),
        }
        rtid = state.get("retrievalTraceId")
        if isinstance(rtid, str) and rtid:
            payload["retrievalTraceId"] = rtid
        mids = state.get("memoryIds")
        if isinstance(mids, list) and mids:
            payload["memoryIds"] = [str(x) for x in mids if str(x)]
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
    """Capture-only Stop: no additionalContext / decision:block memory transport."""
    if event_value(event, "reason") != "end_turn":
        return
    # stopHookActive: host may re-enter after a prior block; still capture once.
    # No memory delivery — retired transports cannot re-burn drafts.
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


def bridge_sync_state_path() -> Path:
    return resolved_state_dir() / "bridge-sync.json"


def native_state_path(session_id: str) -> Path | None:
    return state_path("native", session_id)


def _load_memory_bridge():
    """Path-load memory_bridge.py (same pattern as tests)."""
    import importlib.util

    name = "runir_grok_memory_bridge_runtime"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BRIDGE_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def ensure_session_baseline(event: dict[str, Any]) -> list[str]:
    """First UPS of a session: snapshot managed-block ids before publish. Fail-open."""
    session_id = str(event_value(event, "sessionId", "session_id", default=""))
    path = native_state_path(session_id)
    if path is None:
        return []
    try:
        with exclusive_state_lock(path):
            existing = read_json_state(path)
            if isinstance(existing, dict) and "baselineIds" in existing:
                ids = existing.get("baselineIds")
                return [str(x) for x in ids] if isinstance(ids, list) else []
            baseline: list[str] = []
            try:
                bridge = _load_memory_bridge()
                mem_path = grok_home() / "memory" / "MEMORY.md"
                baseline = list(bridge.read_managed_ids(mem_path) or [])
            except Exception as exc:
                debug(f"baseline read failed open: {exc}")
                baseline = []
            write_json_state(
                path,
                {
                    "schema": 1,
                    "baselineIds": baseline,
                    "publishedAt": 0.0,
                    "publishStatus": "",
                    "updatedAt": time.time(),
                },
            )
            # Register session digest in bridge-sync sessions without burning lastSyncAt.
            _register_session_digest(session_id)
            return baseline
    except Exception as exc:
        debug(f"ensure_session_baseline failed open: {exc}")
        return []


def read_baseline_ids(session_id: str) -> list[str]:
    path = native_state_path(session_id)
    state = read_json_state(path) if path else None
    if not state:
        return []
    ids = state.get("baselineIds")
    if not isinstance(ids, list):
        return []
    return [str(x) for x in ids if str(x)]


def _register_session_digest(session_id: str) -> None:
    path = bridge_sync_state_path()
    digest = (
        hashlib.sha256(session_id.encode("utf-8")).hexdigest() if session_id else ""
    )
    if not digest:
        return
    with exclusive_state_lock(path):
        state = read_json_state(path) or {}
        sessions = state.get("sessions")
        if not isinstance(sessions, list):
            sessions = []
        if digest not in sessions:
            sessions = (sessions + [digest])[-32:]
        now = time.time()
        write_json_state(
            path,
            {
                "schema": 2,
                "lastSyncAt": state.get("lastSyncAt")
                if isinstance(state.get("lastSyncAt"), (int, float))
                else 0.0,
                "lastAttemptAt": state.get("lastAttemptAt")
                if isinstance(state.get("lastAttemptAt"), (int, float))
                else 0.0,
                "lastStatus": state.get("lastStatus") or "",
                "inFlightUntil": state.get("inFlightUntil")
                if isinstance(state.get("inFlightUntil"), (int, float))
                else 0.0,
                "sessions": sessions,
                "factCount": int(state.get("factCount") or 0),
                "updatedAt": now,
            },
        )


def should_sync(session_id: str) -> bool:
    """Throttle gate: first-of-session forces True; else skip while lastSyncAt is
    young or an in-flight lease is active. Does NOT write lastSyncAt (bridge does)."""
    path = bridge_sync_state_path()
    digest = (
        hashlib.sha256(session_id.encode("utf-8")).hexdigest() if session_id else ""
    )
    now = time.time()
    with exclusive_state_lock(path):
        state = read_json_state(path) or {}
        sessions = state.get("sessions")
        if not isinstance(sessions, list):
            sessions = []
        first_of_session = bool(digest) and digest not in sessions
        last = state.get("lastSyncAt")
        recent = (
            isinstance(last, (int, float))
            and last > 0
            and (now - float(last)) < RUNIR_SYNC_MIN_S
        )
        inflight_until = state.get("inFlightUntil")
        in_flight = isinstance(inflight_until, (int, float)) and now < float(
            inflight_until
        )
        if in_flight and not first_of_session:
            return False
        if recent and not first_of_session:
            return False
        if digest and first_of_session:
            sessions = (sessions + [digest])[-32:]
        write_json_state(
            path,
            {
                "schema": 2,
                "lastSyncAt": float(last) if isinstance(last, (int, float)) else 0.0,
                "lastAttemptAt": state.get("lastAttemptAt")
                if isinstance(state.get("lastAttemptAt"), (int, float))
                else 0.0,
                "lastStatus": state.get("lastStatus") or "",
                "inFlightUntil": now + RUNIR_SYNC_LEASE_S,
                "sessions": sessions,
                "factCount": int(state.get("factCount") or 0),
                "updatedAt": now,
            },
        )
        return True


# Back-compat alias for older tests/callers.
def claim_bridge_sync(session_id: str) -> bool:
    return should_sync(session_id)


def spawn_bridge_sync() -> None:
    """Run memory_bridge.py --sync detached; never blocks the awaited hook."""
    env = dict(os.environ)
    if RUNIR_USER_ID:
        env.setdefault("RUNIR_USER_ID", RUNIR_USER_ID)
    if RUNIR_API_KEY:
        env.setdefault("RUNIR_API_KEY", RUNIR_API_KEY)
    gh = (os.environ.get("GROK_HOME") or "").strip()
    if gh:
        env["GROK_HOME"] = gh
    subprocess.Popen(
        [sys.executable, str(BRIDGE_SCRIPT), "--sync"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=env,
    )


def native_publish_or_spawn(event: dict[str, Any]) -> None:
    """First UPS: synchronous global MEMORY.md publish; later turns: detached throttle."""
    try:
        session_id = str(event_value(event, "sessionId", "session_id", default=""))
        path = native_state_path(session_id)
        native = read_json_state(path) if path else None
        first_turn = True
        if isinstance(native, dict):
            published_at = native.get("publishedAt")
            if isinstance(published_at, (int, float)) and float(published_at) > 0:
                first_turn = False
            elif native.get("publishStatus"):
                first_turn = False

        if first_turn:
            publish_status = "error"
            published_count = 0
            try:
                bridge = _load_memory_bridge()
                timeout = RUNIR_SYNC_FIRST_TURN_TIMEOUT_S
                result = bridge.sync_once(
                    memory_root=grok_home() / "memory",
                    runir_base=RUNIR_BASE,
                    user_id=RUNIR_USER_ID,
                    api_key=RUNIR_API_KEY,
                    canary=False,
                    timeout=timeout,
                    state_dir=resolved_state_dir(),
                    record_throttle=True,
                )
                publish_status = str(result.get("status") or "error")
                published_count = len(result.get("publishedIds") or [])
            except Exception as exc:
                debug(f"native sync_once failed open: {exc}")
                publish_status = "error"
                record_event(
                    session_id,
                    "error",
                    where="native_publish",
                    type=type(exc).__name__,
                    channel="native",
                )
            if path is not None:
                with exclusive_state_lock(path):
                    cur = read_json_state(path) or {
                        "schema": 1,
                        "baselineIds": [],
                    }
                    cur["publishedAt"] = time.time()
                    cur["publishStatus"] = publish_status
                    cur["updatedAt"] = time.time()
                    write_json_state(path, cur)
            record_event(
                session_id,
                "recall" if publish_status == "ok" else "skip",
                reason=None if publish_status == "ok" else f"native_{publish_status}",
                channel="native",
                publishStatus=publish_status,
                publishedCount=published_count,
            )
            return

        if not should_sync(session_id):
            debug("bridge sync throttled")
            return
        spawn_bridge_sync()
        debug("bridge sync spawned")
    except Exception as exc:
        debug(f"native_publish_or_spawn failed open: {exc}")


def maybe_sync_bridge(event: dict[str, Any]) -> None:
    """Fail-open projection sync trigger (global MEMORY.md managed block)."""
    native_publish_or_spawn(event)


def main() -> int:
    # Missing or conflict (RUNIR_USER_ID is None) → fail-open for TUI.
    if not RUNIR_USER_ID:
        if RUNIR_DEBUG and RUNIR_USER_ID_SOURCE == "conflict":
            debug(f"identity conflict (fail-open): {RUNIR_USER_ID_CONFLICT}")
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
            ensure_session_baseline(event)
            handle_recall(event)
            maybe_sync_bridge(event)
        elif name == "pre_tool_use":
            # Retired deny-for-memory transport: inert (no deny JSON).
            debug("pre_tool_use ignored (deny transport retired)")
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
