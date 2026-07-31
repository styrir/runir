"""U-D1: stale capture marker bail."""

from __future__ import annotations

import threading
import time


def test_d1a_stale_pending_returns_fast_and_marks_stale(hook):
    sid = "sess-stale"
    path = hook.capture_marker_path(sid)
    hook.write_json_state(
        path,
        {"token": "t1", "status": "pending", "updatedAt": time.time() - 10.0},
    )
    t0 = time.monotonic()
    hook.wait_for_prior_capture(sid)
    elapsed = time.monotonic() - t0
    assert elapsed < 0.5
    state = hook.read_json_state(path)
    assert state is not None
    assert state.get("status") == "stale"


def test_d1b_fresh_pending_flipped_done_returns_before_cap(hook):
    sid = "sess-fresh"
    path = hook.capture_marker_path(sid)
    hook.write_json_state(
        path,
        {"token": "t2", "status": "pending", "updatedAt": time.time()},
    )

    def flip():
        time.sleep(0.2)
        hook.write_json_state(
            path,
            {"token": "t2", "status": "done", "updatedAt": time.time()},
        )

    threading.Thread(target=flip, daemon=True).start()
    t0 = time.monotonic()
    hook.wait_for_prior_capture(sid)
    elapsed = time.monotonic() - t0
    assert elapsed < 5.0
    state = hook.read_json_state(path)
    assert state is not None
    assert state.get("status") == "done"


def test_d1c_missing_updated_at_not_stale(hook, monkeypatch):
    sid = "sess-legacy"
    path = hook.capture_marker_path(sid)
    hook.write_json_state(path, {"token": "t3", "status": "pending"})
    # Short wait cap so test finishes; without updatedAt must not rewrite stale.
    monkeypatch.setattr(hook, "RUNIR_CAPTURE_WAIT_TIMEOUT", 0.15)
    monkeypatch.setattr(hook, "RUNIR_CAPTURE_POLL_INTERVAL", 0.02)
    hook.wait_for_prior_capture(sid)
    state = hook.read_json_state(path)
    assert state is not None
    assert state.get("status") == "pending"
