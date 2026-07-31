"""U-P: batch sibling re-deny within window."""

from __future__ import annotations

import time


def test_pa_sibling_same_prompt_within_window(hook):
    sid = "sess-p"
    pid = "prompt-1"
    ctx = "batch recall context"
    hook.write_recall_state(sid, pid, ctx)
    first = hook.consume_recall({"sessionId": sid, "promptId": pid})
    assert first == ctx
    # Simulate small gap.
    time.sleep(0.1)
    sib = hook.sibling_recall_context({"sessionId": sid, "promptId": pid})
    assert sib == ctx


def test_pb_sibling_after_window_allows(hook, monkeypatch):
    sid = "sess-p2"
    pid = "prompt-2"
    ctx = "later batch"
    monkeypatch.setattr(hook, "RUNIR_BATCH_SIBLING_S", 0.05)
    hook.write_recall_state(sid, pid, ctx)
    assert hook.consume_recall({"sessionId": sid, "promptId": pid}) == ctx
    time.sleep(0.08)
    assert hook.sibling_recall_context({"sessionId": sid, "promptId": pid}) is None


def test_pc_sibling_different_prompt_no_leak(hook):
    sid = "sess-p3"
    hook.write_recall_state(sid, "prompt-a", "ctx-a")
    assert hook.consume_recall({"sessionId": sid, "promptId": "prompt-a"}) == "ctx-a"
    assert (
        hook.sibling_recall_context({"sessionId": sid, "promptId": "prompt-b"}) is None
    )
