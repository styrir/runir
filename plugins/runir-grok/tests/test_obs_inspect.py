"""Observability: runir_inspect.py subcommands over synthetic state."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

# conftest is pytest-loaded; import helper by path-adjacent module name.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from conftest import load_script_module  # noqa: E402


def _digest(sid: str) -> str:
    return hashlib.sha256(sid.encode("utf-8")).hexdigest()


def _seed_state(state_dir: Path, sid: str) -> str:
    d = _digest(sid)
    state_dir.mkdir(parents=True, exist_ok=True)
    status = {
        "schema": 1,
        "updatedAt": "2026-07-31T12:00:00.000Z",
        "phase": "delivered",
        "lastKind": "deliver",
        "promptId": "p1",
        "contextChars": 10,
        "hash12": "aabbccddeeff",
        "counts": {"recall": 1, "deliver": 1, "skip": 0, "capture": 0, "error": 1},
    }
    (state_dir / f"status-{d}.json").write_text(json.dumps(status), encoding="utf-8")
    events = [
        {
            "schema": 1,
            "at": "2026-07-31T12:00:00.000Z",
            "ms": 1,
            "kind": "recall",
            "promptId": "p1",
            "contextChars": 10,
            "hash12": "aabbccddeeff",
        },
        {
            "schema": 1,
            "at": "2026-07-31T12:00:01.000Z",
            "ms": 2,
            "kind": "deliver",
            "channel": "stop",
            "promptId": "p1",
            "contextChars": 10,
            "hash12": "aabbccddeeff",
        },
        {
            "schema": 1,
            "at": "2026-07-31T12:00:02.000Z",
            "ms": 3,
            "kind": "error",
            "where": "handle_recall",
            "type": "ValueError",
            "promptId": "p1",
        },
        {
            "schema": 1,
            "at": "2026-07-31T12:00:03.000Z",
            "ms": 4,
            "kind": "capture",
            "status": "done",
            "messages": 2,
        },
    ]
    with (state_dir / f"trace-{d}.jsonl").open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")
    (state_dir / f"capture-{d}.json").write_text(
        json.dumps({"status": "done", "token": "abc12345", "updatedAt": 1.0}),
        encoding="utf-8",
    )
    return d


def _run(mod, argv: list[str]) -> tuple[int, str]:
    old = sys.argv
    try:
        sys.argv = ["runir_inspect.py", *argv]
        # capture stdout
        import io
        from contextlib import redirect_stdout, redirect_stderr

        buf = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            code = mod.main()
        return code, buf.getvalue() + err.getvalue()
    finally:
        sys.argv = old


def test_inspect_all_subcommands(tmp_path):
    mod = load_script_module("runir_inspect.py")
    state = tmp_path / "state"
    mem = tmp_path / "memory"
    mem.mkdir()
    bridge = (
        "# Memory\n\n"
        "<!-- runir-bridge:begin -->\n"
        "- fact one\n"
        "<!-- runir-bridge:end -->\n"
    )
    (mem / "MEMORY.md").write_text(bridge, encoding="utf-8")
    d = _seed_state(state, "inspect-sess")

    for cmd in ("last", "session", "captures", "errors", "bridge", "status"):
        argv = [cmd, "--state-dir", str(state), "--memory-root", str(mem), "--json"]
        if cmd != "bridge":
            argv.extend(["--digest", d])
        code, out = _run(mod, argv)
        assert code == 0, f"{cmd} failed: {out}"
        data = json.loads(out)
        assert isinstance(data, dict)

    # last has events
    code, out = _run(
        mod,
        ["last", "--state-dir", str(state), "--digest", d, "--json"],
    )
    assert code == 0
    data = json.loads(out)
    assert data["eventCount"] == 4
    assert data["status"]["phase"] == "delivered"

    # session groups by promptId
    code, out = _run(
        mod,
        ["session", "--state-dir", str(state), "--digest", d, "--json"],
    )
    data = json.loads(out)
    assert data["turns"]

    # errors
    code, out = _run(
        mod, ["errors", "--state-dir", str(state), "--digest", d, "--json"]
    )
    data = json.loads(out)
    assert data["count"] >= 1
    assert data["errors"][0]["type"] == "ValueError"

    # bridge
    code, out = _run(
        mod,
        ["bridge", "--state-dir", str(state), "--memory-root", str(mem), "--json"],
    )
    data = json.loads(out)
    assert any(s.get("present") for s in data["sections"])

    # captures
    code, out = _run(
        mod, ["captures", "--state-dir", str(state), "--digest", d, "--json"]
    )
    data = json.loads(out)
    assert data["markers"]
    assert data["events"]
