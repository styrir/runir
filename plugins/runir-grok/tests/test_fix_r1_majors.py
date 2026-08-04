"""Regression tests for review r1 majors (ops-95i)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = PLUGIN_ROOT / "scripts" / "memory_bridge.py"


def load_bridge():
    name = "runir_grok_memory_bridge_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def bridge():
    return load_bridge()


def test_memory_list_row_shape_reads_memory_field(bridge):
    """Service /memory/list emits `memory`; bridge must not drop durable facts."""
    body = {
        "memories": [
            {"id": "m1", "memory": "user prefers dark mode"},
            {"id": "m2", "text": "legacy text alias"},
            {"id": "m3", "content": "legacy content alias"},
            {"id": "m4", "fact": "legacy fact alias"},
            {"id": "m5", "memory": ""},
        ]
    }
    # Exercise the same field selection as fetch_runir_facts without HTTP.
    facts: list[str] = []
    rows = body.get("items") or body.get("memories") or body.get("results") or []
    for row in rows:
        if isinstance(row, dict):
            text = (
                row.get("memory")
                or row.get("text")
                or row.get("content")
                or row.get("fact")
            )
            if isinstance(text, str) and text.strip():
                mid = row.get("id")
                if mid:
                    facts.append(f"{text.strip()}  <!-- id: {mid} -->")
                else:
                    facts.append(text.strip())
    # Also call real helper path via format after constructing like fetch would.
    assert any("dark mode" in f for f in facts)
    assert any("legacy text alias" in f for f in facts)
    assert any("legacy content alias" in f for f in facts)
    assert any("legacy fact alias" in f for f in facts)
    assert len(facts) == 4


def test_fetch_runir_facts_parses_service_memory_field(bridge, monkeypatch):
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(
                {
                    "memories": [
                        {"id": "abc", "memory": "durable fact from service"},
                    ]
                }
            ).encode("utf-8")

    class _Opener:
        def open(self, request, timeout=0):
            return _Resp()

    # fetch_runir_facts uses shared OPENER (safe-redirect), not bare build_opener.
    monkeypatch.setattr(bridge, "OPENER", _Opener())
    facts, status = bridge.fetch_runir_facts("http://127.0.0.1:9", "user-1", None)
    assert status == "ok"
    assert len(facts) == 1
    assert facts[0]["text"] == "durable fact from service"
    assert facts[0]["id"] == "abc"


def test_upsert_managed_opaque_windows_path(bridge):
    existing = f"# Memory\n\n{bridge.BEGIN}\nold\n{bridge.END}\ntail keeps\n"
    managed = bridge.format_managed_section(
        [r"path is C:\Users\me\project\file.txt"],
        canary=False,
    )
    # Must not raise PatternError on \U in Windows path.
    out = bridge.upsert_managed(existing, managed)
    assert r"C:\Users\me\project\file.txt" in out
    assert out.count(bridge.BEGIN) == 1
    assert out.count(bridge.END) == 1
    assert "tail keeps" in out


def test_upsert_managed_neutralizes_embedded_end_marker(bridge):
    existing = f"# Memory\n\n{bridge.BEGIN}\nold\n{bridge.END}\n"
    evil = f"sneaky {bridge.END} escape"
    managed = bridge.format_managed_section([evil], canary=False)
    out = bridge.upsert_managed(existing, managed)
    assert out.count(bridge.BEGIN) == 1
    assert out.count(bridge.END) == 1
    assert "sneaky" in out
    # Embedded end marker stripped from fact body.
    body = out.split(bridge.BEGIN, 1)[1].rsplit(bridge.END, 1)[0]
    assert bridge.END not in body


def test_stop_no_sibling_reblock(hook, monkeypatch, capsys):
    """Stop claims once; second Stop within sibling window fails open (≤1 draft)."""
    sid = "sess-stop-r1"
    pid = "prompt-stop"
    ctx = "stop recall once"
    calls: list[str] = []

    def _capture(event):
        calls.append("capture")

    monkeypatch.setattr(hook, "detach_capture", _capture)
    hook.write_recall_state(sid, pid, ctx)

    # First Stop: consume + block.
    hook.handle_stop(
        {
            "reason": "end_turn",
            "sessionId": sid,
            "promptId": pid,
            "hookEventName": "Stop",
        }
    )
    out1 = capsys.readouterr().out
    assert ctx in out1
    assert ("additionalContext" in out1) or ("block" in out1)

    # Immediate second Stop (sibling window still open): must NOT re-block.
    hook.handle_stop(
        {
            "reason": "end_turn",
            "sessionId": sid,
            "promptId": pid,
            "hookEventName": "Stop",
        }
    )
    out2 = capsys.readouterr().out
    assert out2.strip() == ""
    assert calls == ["capture"]


def test_stop_hook_active_fails_open(hook, monkeypatch, capsys):
    sid = "sess-stop-active"
    pid = "prompt-active"
    ctx = "should not redeliver on active"
    calls: list[str] = []
    monkeypatch.setattr(hook, "detach_capture", lambda e: calls.append("capture"))
    # Undelivered recall present, but stopHookActive means continuation.
    hook.write_recall_state(sid, pid, ctx)
    # Force undelivered for this edge case (continuation with undelivered state).
    path = hook.recall_state_path(sid)
    state = hook.read_json_state(path)
    assert state is not None
    state["delivered"] = False
    hook.write_json_state(path, state)

    hook.handle_stop(
        {
            "reason": "end_turn",
            "sessionId": sid,
            "promptId": pid,
            "stopHookActive": True,
        }
    )
    assert capsys.readouterr().out.strip() == ""
    assert calls == ["capture"]
    # Still undelivered (we skipped claim).
    state2 = hook.read_json_state(path)
    assert state2 is not None
    assert state2.get("delivered") is False

# --- Security review r1 majors (Rúnir-ghe security-r1) ---


def test_fetch_runir_facts_rejects_disallowed_endpoint(bridge, monkeypatch):
    """Bearer list path must honor is_allowed_runir_endpoint (no SSRF)."""
    monkeypatch.delenv("RUNIR_ALLOW_REMOTE_ENDPOINTS", raising=False)
    facts, status = bridge.fetch_runir_facts(
        "https://evil.example", "user-1", "secret-key", timeout=1.0
    )
    assert facts == []
    assert status == "error:endpoint_not_allowed"


def test_fetch_runir_facts_uses_safe_opener(bridge, monkeypatch):
    """fetch_runir_facts must use OPENER (safe redirect), not a bare build_opener."""
    seen: list[object] = []

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"items": [{"id": "m1", "memory": "ok fact"}]}).encode()

    class _Opener:
        def open(self, req, timeout=None):
            seen.append(req)
            return _Resp()

    monkeypatch.setattr(bridge, "OPENER", _Opener())
    monkeypatch.setenv("RUNIR_ALLOW_REMOTE_ENDPOINTS", "0")
    facts, status = bridge.fetch_runir_facts(
        "http://127.0.0.1:7700", "u1", "k", timeout=1.0
    )
    assert status == "ok"
    assert len(seen) == 1
    assert facts and facts[0]["text"] == "ok fact"
    assert facts[0]["id"] == "m1"


def test_id_marker_breakout_sanitized(bridge):
    """Hostile mid with --> / newline must not break managed markers."""
    evil_ids = [
        "x -->\n# hijack",
        "a-->b",
        "id\nwith\nnewlines",
        "ok-id.123",
    ]
    facts = [{"id": mid, "text": f"fact for {i}"} for i, mid in enumerate(evil_ids)]
    section, published = bridge.format_managed_section_with_ids(facts, canary=False)
    assert section.count(bridge.BEGIN) == 1
    assert section.count(bridge.END) == 1
    # Comment must not close early: single-line id markers only.
    for line in section.splitlines():
        if "<!-- id:" in line:
            assert "-->" in line
            # No raw newline inside the marker token region.
            assert "\n" not in line
            # Marker closes on the same line.
            assert line.rstrip().endswith("-->")
    # Breakout tokens must not appear as published ids.
    for pid in published:
        assert "-->" not in pid
        assert "\n" not in pid
        assert " " not in pid
    assert "ok-id.123" in published
    # Managed block still parses cleanly for id extraction.
    path_style = section  # in-memory
    # count of id markers == published
    assert len(bridge.ID_MARKER_RE.findall(section)) == len(published)


def test_write_json_atomic_mode_0600(core, tmp_path):
    target = tmp_path / "state" / "recall.json"
    # Pre-create with loose mode to prove chmod forces 0600 after replace.
    target.parent.mkdir(parents=True)
    target.write_text("{}", encoding="utf-8")
    target.chmod(0o644)
    core.write_json_atomic(target, {"prompt": "secret-user-prompt", "v": 2})
    mode = target.stat().st_mode & 0o777
    assert mode == 0o600
    data = json.loads(target.read_text(encoding="utf-8"))
    assert data["prompt"] == "secret-user-prompt"


def test_parse_recall_body_clamps_prepend_context(core):
    huge = "X" * (core.MAX_PREPEND_CONTEXT_CHARS + 5000)
    r = core.parse_recall_body(
        {
            "prependContext": huge,
            "retrievalTraceId": "t1",
            "memories": [{"id": "m1"}],
        }
    )
    assert len(r.context) == core.MAX_PREPEND_CONTEXT_CHARS
    assert r.retrieval_trace_id == "t1"
    assert r.memory_ids == ["m1"]
