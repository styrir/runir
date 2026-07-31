#!/usr/bin/env python3
"""Read-only inspector for runir-grok observability state.

Subcommands: last | session | captures | errors | bridge | status

Reads ~/.grok/state/runir/ (trace-*.jsonl, status-*.json, capture-*.json)
and optional runir-bridge sections from MEMORY.md. Never writes state.
Never prints secrets or recalled content — only counts, hashes, statuses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

BEGIN = "<!-- runir-bridge:begin -->"
END = "<!-- runir-bridge:end -->"
DEFAULT_STATE = Path.home() / ".grok" / "state" / "runir"
DEFAULT_MEMORY = Path.home() / ".grok" / "memory"
ACTIVE_SESSIONS = Path.home() / ".grok" / "active_sessions.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("last", "session", "captures", "errors", "bridge", "status"),
        help="Inspector subcommand",
    )
    parser.add_argument("--session", help="Plaintext session id (hashed to digest)")
    parser.add_argument("--digest", help="Session digest (sha256 hex of session id)")
    parser.add_argument(
        "--latest",
        action="store_true",
        default=False,
        help="Use newest state file by mtime (default when no --session/--digest)",
    )
    parser.add_argument("--limit", type=int, default=20, help="Max events to show")
    parser.add_argument("--json", action="store_true", help="Machine-readable JSON")
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=DEFAULT_STATE,
        help=f"State directory (default: {DEFAULT_STATE})",
    )
    parser.add_argument(
        "--memory-root",
        type=Path,
        default=DEFAULT_MEMORY,
        help=f"Memory root for bridge (default: {DEFAULT_MEMORY})",
    )
    return parser.parse_args()


def digest_of(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def resolve_digest(args: argparse.Namespace) -> str | None:
    if args.digest:
        return args.digest.strip().lower()
    if args.session:
        return digest_of(args.session)
    return None


def list_status_files(state_dir: Path) -> list[Path]:
    if not state_dir.is_dir():
        return []
    return sorted(
        state_dir.glob("status-*.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


def list_trace_files(state_dir: Path) -> list[Path]:
    if not state_dir.is_dir():
        return []
    return sorted(
        state_dir.glob("trace-*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


def latest_digest(state_dir: Path) -> str | None:
    candidates: list[tuple[float, str]] = []
    for path in list(state_dir.glob("status-*.json")) + list(
        state_dir.glob("trace-*.jsonl")
    ):
        name = path.name
        if name.startswith("status-") and name.endswith(".json"):
            d = name[len("status-") : -len(".json")]
        elif name.startswith("trace-") and name.endswith(".jsonl"):
            d = name[len("trace-") : -len(".jsonl")]
        else:
            continue
        try:
            candidates.append((path.stat().st_mtime, d))
        except OSError:
            continue
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def read_trace(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return events
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            events.append(obj)
    return events


def session_label(digest: str) -> str | None:
    """Best-effort display label from active_sessions.json (never required)."""
    try:
        data = json.loads(ACTIVE_SESSIONS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, (dict, list)):
        return None
    items = data.values() if isinstance(data, dict) else data
    for item in items:
        if not isinstance(item, dict):
            continue
        sid = item.get("sessionId") or item.get("id") or item.get("session_id")
        if isinstance(sid, str) and digest_of(sid) == digest:
            title = item.get("title") or item.get("name") or sid[:12]
            return str(title)
    return None


def emit(data: Any, *, as_json: bool, text: str) -> int:
    if as_json:
        print(json.dumps(data, indent=2, default=str))
    else:
        print(text)
    return 0


def cmd_status(args: argparse.Namespace, digest: str) -> int:
    path = args.state_dir / f"status-{digest}.json"
    data = load_json(path)
    if data is None:
        msg = f"no status file for digest {digest[:12]}… ({path})"
        if args.json:
            print(json.dumps({"ok": False, "error": msg, "digest": digest}))
        else:
            print(msg, file=sys.stderr)
        return 1
    label = session_label(digest)
    payload = {"digest": digest, "label": label, "path": str(path), "status": data}
    text = (
        f"digest={digest[:12]}… label={label or '-'}\n"
        f"phase={data.get('phase')} lastKind={data.get('lastKind')} "
        f"updatedAt={data.get('updatedAt')}\n"
        f"counts={json.dumps(data.get('counts') or {})}\n"
        f"contextChars={data.get('contextChars')} hash12={data.get('hash12')} "
        f"captureStatus={data.get('captureStatus')}\n"
    )
    if data.get("lastError"):
        text += f"lastError={json.dumps(data['lastError'])}\n"
    return emit(payload, as_json=args.json, text=text)


def cmd_last(args: argparse.Namespace, digest: str) -> int:
    status_path = args.state_dir / f"status-{digest}.json"
    trace_path = args.state_dir / f"trace-{digest}.jsonl"
    status = load_json(status_path)
    events = read_trace(trace_path)
    tail = events[-args.limit :] if args.limit > 0 else events
    label = session_label(digest)
    payload = {
        "digest": digest,
        "label": label,
        "status": status,
        "events": tail,
        "eventCount": len(events),
    }
    lines = [
        f"digest={digest[:12]}… label={label or '-'} events={len(events)}",
    ]
    if status:
        lines.append(
            f"phase={status.get('phase')} lastKind={status.get('lastKind')} "
            f"updatedAt={status.get('updatedAt')}"
        )
    for ev in tail:
        lines.append(f"  {ev.get('at', '?')}  {ev.get('kind')}  {_event_brief(ev)}")
    return emit(payload, as_json=args.json, text="\n".join(lines) + "\n")


def _event_brief(ev: dict[str, Any]) -> str:
    parts: list[str] = []
    if ev.get("channel"):
        parts.append(f"channel={ev['channel']}")
    if ev.get("reason"):
        parts.append(f"reason={ev['reason']}")
    if ev.get("status") is not None and ev.get("kind") == "capture":
        parts.append(f"status={ev['status']}")
    if ev.get("contextChars") is not None:
        parts.append(f"chars={ev['contextChars']}")
    if ev.get("hash12"):
        parts.append(f"hash={ev['hash12']}")
    if ev.get("durationMs") is not None:
        parts.append(f"ms={ev['durationMs']}")
    if ev.get("type"):
        parts.append(f"type={ev['type']}")
    if ev.get("where"):
        parts.append(f"where={ev['where']}")
    if ev.get("promptId"):
        parts.append(f"promptId={ev['promptId']}")
    return " ".join(parts)


def cmd_session(args: argparse.Namespace, digest: str) -> int:
    trace_path = args.state_dir / f"trace-{digest}.jsonl"
    events = read_trace(trace_path)
    if args.limit > 0:
        events = events[-args.limit :]
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for ev in events:
        key = str(ev.get("promptId") or "_none")
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(ev)
    turns = [{"promptId": k, "events": groups[k]} for k in order]
    payload = {"digest": digest, "turns": turns, "eventCount": len(events)}
    lines = [f"digest={digest[:12]}… turns={len(turns)} events={len(events)}"]
    for turn in turns:
        lines.append(f"  promptId={turn['promptId']}")
        for ev in turn["events"]:
            lines.append(
                f"    {ev.get('at', '?')}  {ev.get('kind')}  {_event_brief(ev)}"
            )
    return emit(payload, as_json=args.json, text="\n".join(lines) + "\n")


def cmd_captures(args: argparse.Namespace, digest: str | None) -> int:
    state_dir: Path = args.state_dir
    markers: list[dict[str, Any]] = []
    if state_dir.is_dir():
        for path in sorted(
            state_dir.glob("capture-*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            d = path.name[len("capture-") : -len(".json")]
            if digest and d != digest:
                continue
            data = load_json(path) or {}
            markers.append(
                {
                    "digest": d,
                    "path": str(path),
                    "status": data.get("status"),
                    "updatedAt": data.get("updatedAt"),
                    "token": (str(data.get("token"))[:8] + "…")
                    if data.get("token")
                    else None,
                }
            )
    events: list[dict[str, Any]] = []
    traces = (
        [state_dir / f"trace-{digest}.jsonl"] if digest else list_trace_files(state_dir)
    )
    for tp in traces:
        if not tp.is_file():
            continue
        d = tp.name[len("trace-") : -len(".jsonl")]
        for ev in read_trace(tp):
            if ev.get("kind") == "capture":
                events.append({"digest": d, **ev})
    events.sort(key=lambda e: e.get("ms") or 0, reverse=True)
    events = events[: args.limit]
    payload = {"markers": markers, "events": events}
    lines = [f"capture markers={len(markers)} trace-events={len(events)}"]
    for m in markers[: args.limit]:
        lines.append(
            f"  marker digest={m['digest'][:12]}… status={m.get('status')} "
            f"updatedAt={m.get('updatedAt')}"
        )
    for ev in events:
        lines.append(
            f"  event digest={str(ev.get('digest', ''))[:12]}… "
            f"{ev.get('at')} status={ev.get('status')} msgs={ev.get('messages')}"
        )
    return emit(payload, as_json=args.json, text="\n".join(lines) + "\n")


def cmd_errors(args: argparse.Namespace, digest: str | None) -> int:
    state_dir: Path = args.state_dir
    events: list[dict[str, Any]] = []
    traces = (
        [state_dir / f"trace-{digest}.jsonl"] if digest else list_trace_files(state_dir)
    )
    for tp in traces:
        if not tp.is_file():
            continue
        d = tp.name[len("trace-") : -len(".jsonl")]
        for ev in read_trace(tp):
            if ev.get("kind") == "error":
                events.append({"digest": d, **ev})
    events.sort(key=lambda e: e.get("ms") or 0, reverse=True)
    events = events[: args.limit]
    payload = {"errors": events, "count": len(events)}
    lines = [f"errors={len(events)}"]
    for ev in events:
        lines.append(
            f"  {ev.get('at')} digest={str(ev.get('digest', ''))[:12]}… "
            f"where={ev.get('where')} type={ev.get('type')}"
        )
    return emit(payload, as_json=args.json, text="\n".join(lines) + "\n")


def extract_bridge_block(text: str) -> str | None:
    if BEGIN not in text or END not in text:
        return None
    start = text.find(BEGIN)
    end = text.find(END, start)
    if start < 0 or end < 0:
        return None
    return text[start : end + len(END)]


def discover_project_memory(memory_root: Path, state_dir: Path) -> Path | None:
    """Mirror memory_bridge.discover_project_memory (read-only pin read)."""
    pin_path = state_dir / "bridge-paths.json"
    if pin_path.is_file():
        try:
            pin = json.loads(pin_path.read_text(encoding="utf-8"))
            candidate = pin.get("projectMemory") if isinstance(pin, dict) else None
            if isinstance(candidate, str):
                p = Path(candidate)
                if p.is_file():
                    return p
                if (p / "MEMORY.md").is_file():
                    return p / "MEMORY.md"
        except Exception:
            pass
    if not memory_root.is_dir():
        return None
    found: list[Path] = []
    for child in memory_root.iterdir():
        if child.is_dir() and re.match(r".+-[0-9a-f]{8}$", child.name):
            mem = child / "MEMORY.md"
            if mem.is_file():
                found.append(mem)
    if len(found) == 1:
        return found[0]
    return None


def cmd_bridge(args: argparse.Namespace) -> int:
    memory_root: Path = args.memory_root.expanduser()
    state_dir: Path = args.state_dir.expanduser()
    global_path = memory_root / "MEMORY.md"
    project = discover_project_memory(memory_root, state_dir)
    sections: list[dict[str, Any]] = []
    for label, path in (("global", global_path), ("project", project)):
        if path is None or not path.is_file():
            sections.append(
                {"scope": label, "path": str(path) if path else None, "present": False}
            )
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            sections.append(
                {
                    "scope": label,
                    "path": str(path),
                    "present": False,
                    "error": type(exc).__name__,
                }
            )
            continue
        block = extract_bridge_block(text)
        sections.append(
            {
                "scope": label,
                "path": str(path),
                "present": block is not None,
                "bytes": len(block.encode("utf-8")) if block else 0,
                "preview": (block[:500] + ("…" if block and len(block) > 500 else ""))
                if block
                else None,
            }
        )
    payload = {"sections": sections}
    lines = ["runir-bridge sections:"]
    for s in sections:
        lines.append(
            f"  {s['scope']}: present={s.get('present')} path={s.get('path')} "
            f"bytes={s.get('bytes', 0)}"
        )
        if s.get("preview") and not args.json:
            # Keep preview short in text mode
            preview_lines = (s["preview"] or "").splitlines()[:8]
            for pl in preview_lines:
                lines.append(f"    | {pl}")
    return emit(payload, as_json=args.json, text="\n".join(lines) + "\n")


def main() -> int:
    args = parse_args()
    state_dir = args.state_dir.expanduser()
    if not state_dir.exists():
        msg = (
            f"state dir missing: {state_dir}\n"
            "hint: run a Grok turn with runir-grok hooks installed, or pass --state-dir"
        )
        if args.json:
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(msg, file=sys.stderr)
        return 1

    if args.command == "bridge":
        return cmd_bridge(args)

    digest = resolve_digest(args)
    # last/session/status require a single digest (default: newest).
    # captures/errors leave digest=None for across-session scan unless
    # --session/--digest/--latest pins one.
    needs_session = args.command in ("last", "session", "status")
    if digest is None and (args.latest or needs_session):
        digest = latest_digest(state_dir)

    if args.command == "captures":
        return cmd_captures(args, digest)
    if args.command == "errors":
        return cmd_errors(args, digest)

    if not digest:
        msg = "no session state found (pass --session, --digest, or generate a turn first)"
        if args.json:
            print(json.dumps({"ok": False, "error": msg}))
        else:
            print(msg, file=sys.stderr)
        return 1

    if args.command == "status":
        return cmd_status(args, digest)
    if args.command == "last":
        return cmd_last(args, digest)
    if args.command == "session":
        return cmd_session(args, digest)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
