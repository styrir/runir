def test_grok_accepts_redaction_drop_body(hook, monkeypatch):
    body = {"skipped": False, "reason": "redaction_assertion_failed", "factsFound": 0,
            "outcomes": {"create": 0, "skip": 0, "merge-update": 0, "supersede": 0}, "units": []}
    monkeypatch.setattr(hook, "current_turn_messages", lambda event: [{"role": "user", "content": "synthetic"}])
    monkeypatch.setattr(hook, "post_json", lambda url, payload, timeout: (200, body))
    hook.handle_capture({"promptId": "synthetic"}, "synthetic-session", "synthetic-token")
    state = hook.read_json_state(hook.capture_marker_path("synthetic-session"))
    assert state["status"] == "done"
