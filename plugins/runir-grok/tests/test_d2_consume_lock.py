"""U-D2: fcntl flock on consume_recall — exactly one winner."""

from __future__ import annotations

import concurrent.futures


def test_d2_eight_threads_only_one_consumes(hook):
    sid = "sess-d2"
    prompt_id = "p1"
    context = "unique recall payload for d2"
    hook.write_recall_state(sid, prompt_id, context)
    event = {
        "sessionId": sid,
        "promptId": prompt_id,
        "hookEventName": "PreToolUse",
    }

    def worker() -> str | None:
        return hook.consume_recall(event)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: worker(), range(8)))

    winners = [r for r in results if r is not None]
    assert len(winners) == 1
    assert winners[0] == context
    state = hook.read_json_state(hook.recall_state_path(sid))
    assert state is not None
    assert state.get("delivered") is True
    # Context retained for sibling re-deny (P).
    assert state.get("context") == context
