#!/usr/bin/env python3
"""Live second-pane tail of runir-grok memory activity.

Polls status-*.json + trace-*.jsonl under ~/.grok/state/runir/ and prints
turn-by-turn observability events as they appear. Strictly read-only.

Modes:
  once   — snapshot latest status + last N trace lines, exit 0
  watch  — poll --interval seconds until SIGINT (default)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import signal
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_STATE = Path.home() / ".grok" / "state" / "runir"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("once", "watch"),
        default="watch",
        help="once = snapshot; watch = live poll (default)",
    )
    parser.add_argument(
        "--interval", type=float, default=1.0, help="Poll interval seconds"
    )
    parser.add_argument("--lines", type=int, default=20, help="Initial tail lines")
    parser.add_argument("--session", help="Plaintext session id")
    parser.add_argument("--digest", help="Session digest hex")
    parser.add_argument(
        "--latest",
        action="store_true",
        default=False,
        help="Follow newest session by mtime (default when no --session/--digest)",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=DEFAULT_STATE,
        help=f"State directory (default: {DEFAULT_STATE})",
    )
    return parser.parse_args()


def digest_of(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def resolve_digest(args: argparse.Namespace, state_dir: Path) -> str | None:
    if args.digest:
        return args.digest.strip().lower()
    if args.session:
        return digest_of(args.session)
    return latest_digest(state_dir)


def latest_digest(state_dir: Path) -> str | None:
    if not state_dir.is_dir():
        return None
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


def load_status(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def file_inode(path: Path) -> int | None:
    """Inode for rotation detection (os.replace rewrites change inode)."""
    try:
        return path.stat().st_ino
    except OSError:
        return None


def format_status_line(digest: str, status: dict[str, Any] | None) -> str:
    if not status:
        return f"[runir] digest={digest[:12]}… (no status yet)"
    return (
        f"[runir] digest={digest[:12]}… phase={status.get('phase')} "
        f"lastKind={status.get('lastKind')} "
        f"counts={json.dumps(status.get('counts') or {}, separators=(',', ':'))} "
        f"updatedAt={status.get('updatedAt')}"
    )


def format_event(ev: dict[str, Any]) -> str:
    parts = [str(ev.get("at", "?")), str(ev.get("kind", "?"))]
    if ev.get("channel"):
        parts.append(f"ch={ev['channel']}")
    if ev.get("reason"):
        parts.append(f"reason={ev['reason']}")
    if ev.get("status") is not None and ev.get("kind") == "capture":
        parts.append(f"status={ev['status']}")
    if ev.get("contextChars") is not None:
        parts.append(f"chars={ev['contextChars']}")
    if ev.get("hash12"):
        parts.append(f"hash={ev['hash12']}")
    if ev.get("durationMs") is not None:
        parts.append(f"{ev['durationMs']}ms")
    if ev.get("type"):
        parts.append(f"type={ev['type']}")
    return "  " + " ".join(parts)


def read_new_lines(path: Path, offset: int) -> tuple[list[str], int]:
    """Read lines after byte offset; return (lines, new_offset)."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            handle.seek(offset)
            chunk = handle.read()
            new_offset = handle.tell()
    except OSError:
        return [], offset
    if not chunk:
        return [], offset
    lines = [ln for ln in chunk.splitlines() if ln.strip()]
    return lines, new_offset


def read_all_nonempty_lines(path: Path) -> list[str]:
    """Read every non-empty line (used after ring rewrite / inode change)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    return [ln for ln in text.splitlines() if ln.strip()]


def lines_after_marker(lines: list[str], marker: str | None) -> list[str]:
    """Return lines strictly after the last occurrence of marker.

    Used after os.replace ring rewrite: retained ring lines were already
    tailed; replaying them every poll breaks live-tail. If marker is missing
    (aged out of the ring) return [] — seek-to-end, no full-ring replay.
    If marker is None (no prior line observed) return [] for the same reason.
    """
    if not lines or not marker:
        return []
    last_idx = -1
    for i, ln in enumerate(lines):
        if ln == marker:
            last_idx = i
    if last_idx < 0:
        return []
    return lines[last_idx + 1 :]


def parse_events(lines: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def snapshot(state_dir: Path, digest: str, lines: int) -> int:
    status_path = state_dir / f"status-{digest}.json"
    trace_path = state_dir / f"trace-{digest}.jsonl"
    status = load_status(status_path)
    print(format_status_line(digest, status), flush=True)
    if not trace_path.is_file():
        print("  (no trace yet)", flush=True)
        return 0
    try:
        text = trace_path.read_text(encoding="utf-8")
    except OSError:
        print("  (trace unreadable)", flush=True)
        return 0
    raw = [ln for ln in text.splitlines() if ln.strip()]
    tail = raw[-lines:] if lines > 0 else raw
    for ev in parse_events(tail):
        print(format_event(ev), flush=True)
    return 0


def watch_loop(state_dir: Path, digest: str | None, interval: float, lines: int) -> int:
    stop = {"flag": False}

    def _on_sigint(_signum: int, _frame: Any) -> None:
        stop["flag"] = True

    signal.signal(signal.SIGINT, _on_sigint)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_sigint)

    last_status_mtime = 0.0
    last_trace_size = 0
    last_trace_ino: int | None = None
    last_seen_line: str | None = None
    current_digest = digest
    printed_header_for: str | None = None

    # Initial snapshot
    if current_digest:
        status_path = state_dir / f"status-{current_digest}.json"
        trace_path = state_dir / f"trace-{current_digest}.jsonl"
        status = load_status(status_path)
        print(format_status_line(current_digest, status), flush=True)
        printed_header_for = current_digest
        last_status_mtime = mtime(status_path)
        if trace_path.is_file():
            try:
                raw = read_all_nonempty_lines(trace_path)
                for ev in parse_events(raw[-lines:] if lines > 0 else raw):
                    print(format_event(ev), flush=True)
                last_trace_size = file_size(trace_path)
                last_trace_ino = file_inode(trace_path)
                last_seen_line = raw[-1] if raw else None
            except OSError:
                pass
    else:
        print("[runir] waiting for state…", flush=True)

    while not stop["flag"]:
        time.sleep(max(0.1, interval))
        if not state_dir.is_dir():
            continue
        # Re-resolve latest if following newest
        if digest is None:
            fresh = latest_digest(state_dir)
            if fresh and fresh != current_digest:
                current_digest = fresh
                last_status_mtime = 0.0
                last_trace_size = 0
                last_trace_ino = None
                last_seen_line = None
                printed_header_for = None
        if not current_digest:
            continue
        status_path = state_dir / f"status-{current_digest}.json"
        trace_path = state_dir / f"trace-{current_digest}.jsonl"
        sm = mtime(status_path)
        if sm > last_status_mtime or printed_header_for != current_digest:
            status = load_status(status_path)
            print(format_status_line(current_digest, status), flush=True)
            last_status_mtime = sm
            printed_header_for = current_digest
        ts = file_size(trace_path)
        ino = file_inode(trace_path)
        rotated = ts < last_trace_size or (
            last_trace_ino is not None and ino is not None and ino != last_trace_ino
        )
        if rotated:
            # Ring rewrite (os.replace → new inode) or truncate: emit only lines
            # after last-seen fingerprint. Never reset offset to 0 (full-ring replay).
            all_lines = read_all_nonempty_lines(trace_path)
            new_lines = lines_after_marker(all_lines, last_seen_line)
            for ev in parse_events(new_lines):
                print(format_event(ev), flush=True)
            if all_lines:
                last_seen_line = all_lines[-1]
            last_trace_size = ts
            last_trace_ino = ino
        elif ts > last_trace_size:
            new_lines, _ = read_new_lines(trace_path, last_trace_size)
            for ev in parse_events(new_lines):
                print(format_event(ev), flush=True)
            if new_lines:
                last_seen_line = new_lines[-1]
            last_trace_size = ts
            last_trace_ino = ino
        else:
            last_trace_ino = ino
    return 0


def main() -> int:
    args = parse_args()
    state_dir = args.state_dir.expanduser()
    if not state_dir.exists() and args.mode == "once":
        print(f"[runir] state dir missing: {state_dir}", file=sys.stderr)
        return 1

    # For --latest / default: digest=None means follow newest in watch mode
    fixed = bool(args.session or args.digest)
    digest = resolve_digest(args, state_dir) if (fixed or args.mode == "once") else None
    if args.mode == "once":
        if not digest:
            digest = latest_digest(state_dir)
        if not digest:
            print("[runir] no session state found", file=sys.stderr)
            return 1
        return snapshot(state_dir, digest, args.lines)

    # watch: if user fixed session, lock to it; else follow latest
    locked = digest if fixed else None
    return watch_loop(state_dir, locked, args.interval, args.lines)


if __name__ == "__main__":
    raise SystemExit(main())
