import fcntl
import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import runir_capture as capture
import runir_watermark as watermark
REAL_SEND = capture._send


def line(role, text, n, mid=None):
    body = {"type": role, "uuid": f"line-{n}", "message": {"role": role, "content": text}}
    if mid:
        body["message"]["id"] = mid
    return (json.dumps(body) + "\n").encode()


def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(watermark, "WATERMARK_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(capture.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(capture, "LOG_PATH", tmp_path / "capture.log")
    monkeypatch.setattr(capture, "RUNIR_USER_ID", "synthetic-user")
    path = tmp_path / "synthetic.jsonl"
    sent = []
    monkeypatch.setattr(capture, "_send", lambda messages, session, cwd: sent.append([dict(m) for m in messages]) or True)
    event = {"session_id": "synthetic-session", "transcript_path": str(path), "cwd": str(tmp_path)}
    return path, sent, event


def seed(path, offset=0, ordinal=0, **extra):
    ident = capture.file_identity(str(path))
    watermark.save_entry("synthetic-session", capture._cursor(ident, offset, ordinal, [], **extra))


def test_resume_partial_invalid_and_oversized(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "first", 1))
    seed(path, path.stat().st_size, 1)
    with path.open("ab") as f:
        f.write(b'{"type":"user","uuid":"bad",\x00}\n')
        f.write(line("user", "second", 2))
        f.write(line("assistant", "partial", 3, "a3")[:-1])
    capture._capture(event)
    assert [[m["content"] for m in batch] for batch in sent] == [["second"]]
    assert watermark.load_entry("synthetic-session")["offset"] < path.stat().st_size
    with path.open("ab") as f:
        f.write(b"\n")
    event["last_assistant_message"] = "partial"
    capture._capture(event)
    assert sent[-1][0]["turnKey"] == "claude:a3"
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_MAX_LINE_BYTES", 150)
    with path.open("ab") as f:
        f.write(line("user", "x" * 200, 4))
        f.write(line("user", "after-cap", 5))
    capture._capture(event)
    capture._capture(event)
    assert sent[-1][0]["content"] == "after-cap"
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size


def test_budget_hold_group_and_compact_boundary(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "prior", 1))
    seed(path, path.stat().st_size, 1)
    first = line("assistant", "draft", 2, "same")
    second = line("assistant", "final", 3, "same")
    with path.open("ab") as f:
        f.write(first + second + line("user", "next", 4))
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", len(first))
    capture._capture(event)
    assert sent == []
    assert watermark.load_entry("synthetic-session")["offset"] == len(line("user", "prior", 1))
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", 10000)
    capture._capture(event)
    assert [[m["content"] for m in batch] for batch in sent] == [["final", "next"]]
    assert sent[0][0]["turnKey"] == "claude:same"
    with path.open("ab") as f:
        f.write(b'{"type":"system","subtype":"compact_boundary"}\n')
    capture._capture(event)
    assert len(sent) == 1
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size


def test_budget_multiple_runs_and_error_hold(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "seed", 0))
    seed(path, path.stat().st_size, 1)
    additions = [line("user", f"new-{i}", i + 1) for i in range(5)]
    with path.open("ab") as f:
        f.write(b"".join(additions))
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", len(additions[0]))
    for _ in additions:
        capture._capture(event)
    assert [m["content"] for batch in sent for m in batch] == [f"new-{i}" for i in range(5)]
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size
    with path.open("ab") as f:
        f.write(line("user", "retry", 99))
    prior = watermark.load_entry("synthetic-session")["offset"]
    monkeypatch.setattr(capture, "_send", lambda *_: False)
    capture._capture(event)
    assert watermark.load_entry("synthetic-session")["offset"] == prior


def test_replacement_and_v1_migration(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    prefix = line("user", "old", 1)
    path.write_bytes(prefix)
    seed(path, len(prefix), 1)
    old = watermark.load_entry("synthetic-session")
    old["recentKeys"] = ["claude:line-1"]
    watermark.save_entry("synthetic-session", old)
    copied = tmp_path / "copy.jsonl"
    copied.write_bytes(prefix + line("user", "new", 2))
    os.replace(copied, path)
    capture._capture(event)
    assert [m["content"] for batch in sent for m in batch] == ["new"]
    path.write_bytes(line("user", "replacement", 3))
    capture._capture(event)
    assert sent[-1][0]["content"] == "replacement"
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size
    instruction = line("user", "# AGENTS.md instructions\nsynthetic", 77)
    path.write_bytes(b'{"type":"title"}\n' + instruction + prefix + b'bad\n' +
                     line("assistant", "draft", 4, "a") + line("assistant", "final", 5, "a") +
                     line("user", "tail", 6))
    watermark.save_entry("synthetic-session", {"messageCount": 3})
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", 120)
    for _ in range(10):
        capture._capture(event)
        if watermark.load_entry("synthetic-session").get("version") == 2:
            break
    entry = watermark.load_entry("synthetic-session")
    assert entry["v1ConsumedOffset"] == len(b'{"type":"title"}\n' + instruction + prefix + b'bad\n' +
                                             line("assistant", "draft", 4, "a") + line("assistant", "final", 5, "a"))
    assert all(m["content"] != "draft" for batch in sent for m in batch)


def test_bootstrap_eof_and_lock(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(b"".join(line("user", str(i), i) for i in range(20)))
    capture._capture(event)
    assert [m["content"] for m in sent[0]] == [str(i) for i in range(12, 20)]
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size
    capture._capture(event)
    assert len(sent) == 1
    lock_path = tmp_path / ".claude/state/runir" / (hashlib.sha256(b"synthetic-session").hexdigest() + ".lock")
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # flock is process-scoped here; a child is required for real contention.
        import subprocess
        proc = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a+b');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('acquired')\nexcept BlockingIOError: print('busy')", str(lock_path)], capture_output=True, text=True)
        assert proc.stdout.strip() == "busy"


def test_response_rules_and_thirty_mb_hot_path(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    assert capture.is_successful_response(200, {})[0]
    assert capture.is_successful_response(200, {"skipped": True, "reason": "noise-bank"})[0]
    assert not capture.is_successful_response(200, {"error": "fail"})[0]
    assert not capture.is_successful_response(500, {})[0]
    assert not capture.is_successful_response(200, {"skipped": True, "reason": "hold"})[0]
    with path.open("wb") as f:
        f.write(line("user", "start", 0))
        f.write(b'{"type":"title","padding":"' + b"x" * (30 * 1024 * 1024 - 100) + b'"}\n')
        f.write(line("user", "end", 1))
    seed(path, path.stat().st_size - len(line("user", "end", 1)), 1)
    started = time.perf_counter()
    capture._capture(event)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert elapsed_ms < 150, elapsed_ms
    assert sent[-1][0]["content"] == "end"
    print(f"30 MB near-EOF Stop: {elapsed_ms:.2f} ms")


def test_hook_lock_contention_exits_without_post(tmp_path, monkeypatch):
    import subprocess
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "hello", 1))
    seed(path, 0, 0)
    lock_path = tmp_path / ".claude/state/runir" / (hashlib.sha256(b"synthetic-session").hexdigest() + ".lock")
    script = Path(capture.__file__)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = subprocess.run([sys.executable, str(script)], input=json.dumps(event), text=True,
                                env={**os.environ, "HOME": str(tmp_path), "RUNIR_USER_ID": "synthetic-user"},
                                capture_output=True, timeout=5)
    assert result.returncode == 0
    assert "lock_contention" in (tmp_path / ".claude/state/runir/capture.log").read_text()
    assert watermark.load_entry("synthetic-session")["offset"] == 0


def test_session_end_size_guard_removed(tmp_path):
    import subprocess
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))) )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{}')

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        path = tmp_path / "synthetic.jsonl"
        path.write_bytes(line("user", "hello", 1) + line("assistant", "done", 2, "a2"))
        watermark_dir = tmp_path / ".claude/state/runir"
        watermark_dir.mkdir(parents=True)
        watermark_dir.joinpath("capture-watermarks.json").write_text(json.dumps({
            "session-end-synthetic": capture._cursor(capture.file_identity(str(path)), 0, 0, [])}))
        event = {"session_id": "session-end-synthetic", "transcript_path": str(path),
                 "cwd": str(tmp_path), "reason": "prompt_input_exit"}
        event_path = tmp_path / "event.json"
        event_path.write_text(json.dumps(event))
        script = Path(capture.__file__).with_name("runir-session-end-worker.sh")
        result = subprocess.run(["bash", str(script), "test-run", str(event_path), str(tmp_path / "end.log")],
                                env={**os.environ, "HOME": str(tmp_path), "STATE_DIR": str(tmp_path / "state"),
                                     "RUNIR_USER_ID": "synthetic-user", "RUNIR_MAX_TRANSCRIPT_BYTES": "1",
                                     "RUNIR_CAPTURE_READ_BUDGET_BYTES": str(max(len(line("user", "hello", 1)), len(line("assistant", "done", 2, "a2")))),
                                     "RUNIR_SESSION_END_URL": f"http://127.0.0.1:{server.server_port}/hooks/session-end",
                                     "RUNIR_CAPTURE_URL": f"http://127.0.0.1:{server.server_port}/hooks/capture"},
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        end = [body for route, body in requests if route == "/hooks/session-end"]
        assert len(end) == 1
        assert end[0]["messageOffset"] == 2
        assert end[0]["terminationReason"] == "prompt_input_exit"
        assert len(end[0]["messages"]) == 2
        assert len([route for route, _ in requests if route == "/hooks/capture"]) == 2
        event_path.write_text(json.dumps(event))
        repeated = subprocess.run(["bash", str(script), "test-run-repeat", str(event_path), str(tmp_path / "end.log")],
                                  env={**os.environ, "HOME": str(tmp_path), "STATE_DIR": str(tmp_path / "state"),
                                       "RUNIR_USER_ID": "synthetic-user",
                                       "RUNIR_SESSION_END_URL": f"http://127.0.0.1:{server.server_port}/hooks/session-end",
                                       "RUNIR_CAPTURE_URL": f"http://127.0.0.1:{server.server_port}/hooks/capture"},
                                  capture_output=True, text=True, timeout=10)
        assert repeated.returncode == 0, repeated.stderr
        second_end = [body for route, body in requests if route == "/hooks/session-end"][-1]
        assert second_end["messageOffset"] == 2
        assert len(second_end["messages"]) == 1
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_flush_retries_nonadvancing_post_then_drains_tail(tmp_path):
    import subprocess
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    captures = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/hooks/capture":
                captures.append(body)
                self.send_response(500 if len(captures) <= 2 else 200)
            else:
                self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{}')

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        path = tmp_path / "synthetic.jsonl"
        first = line("user", "already sent", 1)
        path.write_bytes(first + line("user", "unread tail", 2))
        watermark_dir = tmp_path / ".claude/state/runir"
        watermark_dir.mkdir(parents=True)
        watermark_dir.joinpath("capture-watermarks.json").write_text(json.dumps({
            "flush-retry": capture._cursor(capture.file_identity(str(path)), len(first), 1, [])}))
        event = {"session_id": "flush-retry", "transcript_path": str(path), "cwd": str(tmp_path)}
        event_path = tmp_path / "event.json"
        event_path.write_text(json.dumps(event))
        env = {**os.environ, "HOME": str(tmp_path), "STATE_DIR": str(tmp_path / "state"),
               "RUNIR_USER_ID": "synthetic-user", "RUNIR_SESSION_END_TIMEOUT": "5",
               "RUNIR_CAPTURE_URL": f"http://127.0.0.1:{server.server_port}/hooks/capture",
               "RUNIR_SESSION_END_URL": f"http://127.0.0.1:{server.server_port}/hooks/session-end"}
        script = Path(capture.__file__)
        failed = subprocess.run([sys.executable, str(script), "--flush"], input=json.dumps(event),
                                text=True, env=env, capture_output=True, timeout=5)
        assert failed.returncode != 0
        held = json.loads(watermark_dir.joinpath("capture-watermarks.json").read_text())["flush-retry"]
        assert held["offset"] == len(first)
        worker = script.with_name("runir-session-end-worker.sh")
        finished = subprocess.run(["bash", str(worker), "retry-run", str(event_path), str(tmp_path / "end.log")],
                                  env=env, capture_output=True, text=True, timeout=8)
        assert finished.returncode == 0, finished.stderr
        saved = json.loads(watermark_dir.joinpath("capture-watermarks.json").read_text())["flush-retry"]
        assert saved["offset"] == path.stat().st_size
        assert len(captures) >= 3
        assert all(body["messages"][0]["content"] == "unread tail" for body in captures)
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_post_batch_limit_and_saved_offset(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "seed", 0))
    seed(path, path.stat().st_size, 1)
    with path.open("ab") as f:
        f.write(b"".join(line("user", f"item-{i}", i + 1) for i in range(205)))
    capture._capture(event)
    assert [len(batch) for batch in sent] == [200, 5]
    assert sent[0][0]["turnIndex"] == 1
    assert sent[1][-1]["turnIndex"] == 205
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size
    assert len(watermark.load_entry("synthetic-session")["recentKeys"]) == 205


def test_short_head_growth_and_path_change_keep_cursor(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    prefix = line("user", "old", 1)
    path.write_bytes(prefix)
    seed(path, len(prefix), 1, v1ConsumedOffset=len(prefix))
    moved = tmp_path / "moved.jsonl"
    moved.write_bytes(prefix + b'{"type":"title","padding":"' + b"x" * 1100 + b'"}\n' + line("user", "new", 2))
    event["transcript_path"] = str(moved)
    capture._capture(event)
    assert [m["content"] for batch in sent for m in batch] == ["new"]
    entry = watermark.load_entry("synthetic-session")
    assert entry["v1ConsumedOffset"] == len(prefix)
    assert entry["headLen"] == 1024
    assert entry["offset"] == moved.stat().st_size


def test_budget_mid_line_and_overcap_newline_beyond_budget(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "old", 1))
    seed(path, path.stat().st_size, 1)
    start = path.stat().st_size
    addition = line("user", "new message", 2)
    with path.open("ab") as f:
        f.write(addition)
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", len(addition) - 1)
    capture._capture(event)
    assert sent == []
    assert watermark.load_entry("synthetic-session")["offset"] == start
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", len(addition))
    capture._capture(event)
    assert sent[-1][0]["content"] == "new message"
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_MAX_LINE_BYTES", 90)
    with path.open("ab") as f:
        f.write(line("user", "x" * 150, 3) + line("user", "after", 4))
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", 95)
    capture._capture(event)
    after_oversize = watermark.load_entry("synthetic-session")["offset"]
    assert after_oversize > start + len(addition) + 95
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", 1000)
    capture._capture(event)
    assert sent[-1][0]["content"] == "after"


def test_budget_cut_equal_last_assistant_stays_held_and_logs_private(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "old", 1))
    seed(path, path.stat().st_size, 1)
    first = line("assistant", "CANARY_PRIVATE_DRAFT", 2, "same")
    with path.open("ab") as f:
        f.write(first + line("assistant", "final", 3, "same"))
    event["last_assistant_message"] = "CANARY_PRIVATE_DRAFT"
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", len(first))
    capture._capture(event)
    assert sent == []
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", 1000)
    event["last_assistant_message"] = "final"
    monkeypatch.setattr(capture, "_send", REAL_SEND)
    monkeypatch.setattr(capture, "post_capture", lambda *_: (200, {}, b"{}"))
    capture._capture(event)
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size
    log_text = (tmp_path / "capture.log").read_text()
    assert "CANARY_PRIVATE_DRAFT" not in log_text
    assert "final" not in log_text


def test_bootstrap_fallback_zero_count_and_head_mismatch_dedupe(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(b'{"type":"title"}\n')
    event["last_assistant_message"] = "fallback-canary"
    watermark.save_entry("synthetic-session", {"messageCount": 0})
    capture._capture(event)
    assert sent[0][0]["content"] == "fallback-canary"
    capture._capture(event)
    assert len(sent) == 1
    path.write_bytes(b"".join(line("user", f"item-{i}", i) for i in range(12)))
    entry = watermark.load_entry("synthetic-session")
    entry["recentKeys"] = [f"claude:line-{i}" for i in range(8)]
    watermark.save_entry("synthetic-session", entry)
    capture._capture(event)
    assert [m["content"] for m in sent[-1]] == [f"item-{i}" for i in range(8, 12)]


def test_native_uuid_epoch_and_stop_replay(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("assistant", "native", 1))
    event["last_assistant_message"] = "native"
    capture._capture(event)
    assert sent[0][0]["turnKey"] == "claude:line-1"
    assert sent[0][0]["sessionEpoch"] == "claude-native"
    capture._capture(event)
    assert len(sent) == 1


def test_terminal_skip_does_not_consume_held_group(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "old", 1))
    seed(path, path.stat().st_size, 1)
    held = line("assistant", "draft", 2, "held")
    with path.open("ab") as f:
        f.write(line("user", "terminal", 3) + held + line("assistant", "final", 4, "held"))
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", len(line("user", "terminal", 3)) + len(held))
    monkeypatch.setattr(capture, "post_capture", lambda *_: (200, {"skipped": True, "reason": "noise-bank"}, b""))
    capture._capture(event)
    assert watermark.load_entry("synthetic-session")["offset"] == len(line("user", "old", 1) + line("user", "terminal", 3))
    assert capture.is_successful_response(200, {"skipped": True, "reason": "already captured"})[0]
    monkeypatch.setattr(capture, "RUNIR_CAPTURE_READ_BUDGET_BYTES", 1000)
    event["last_assistant_message"] = "final"
    capture._capture(event)
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size


def test_v1_consumed_prefix_never_posts(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    prefix = line("user", "v1-old", 1) + line("assistant", "v1-old-answer", 2, "old")
    path.write_bytes(prefix + line("user", "fresh", 3))
    watermark.save_entry("synthetic-session", {"messageCount": 2})
    capture._capture(event)
    assert [m["content"] for batch in sent for m in batch] == ["fresh"]
    assert watermark.load_entry("synthetic-session")["v1ConsumedOffset"] == len(prefix)


def test_flush_waits_for_stop_lock_and_emits(tmp_path, monkeypatch):
    import threading
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "old", 1))
    seed(path, path.stat().st_size, 1)
    with path.open("ab") as f:
        f.write(line("assistant", "held", 2, "a2"))
    lock_path = tmp_path / ".claude/state/runir" / (hashlib.sha256(b"synthetic-session").hexdigest() + ".lock")
    started = threading.Event()
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    def stop_holder():
        with lock_path.open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            started.set()
            time.sleep(0.35)
            fcntl.flock(lock, fcntl.LOCK_UN)

    thread = threading.Thread(target=stop_holder)
    thread.start()
    started.wait(timeout=2)
    began = time.monotonic()
    assert capture._capture(event, flush=True)
    assert time.monotonic() - began >= 0.3
    assert sent[-1][0]["content"] == "held"
    thread.join(timeout=2)


def test_server_accepted_then_client_timeout_replays_as_noop(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    path.write_bytes(line("user", "synthetic timeout turn", 1))
    server_seen = set()
    calls = []

    def post(payload):
        keys = tuple(message["turnKey"] for message in payload["messages"])
        calls.append(keys)
        if keys not in server_seen:
            server_seen.add(keys)
            return 0, {}, b""
        return 200, {"skipped": True, "reason": "already captured"}, b""

    monkeypatch.setattr(capture, "_send", REAL_SEND)
    monkeypatch.setattr(capture, "post_capture", post)
    capture._capture(event)
    assert not watermark.load_entry("synthetic-session")
    capture._capture(event)
    assert len(calls) == 2
    assert len(server_seen) == 1
    assert watermark.load_entry("synthetic-session")["offset"] == path.stat().st_size


def test_session_end_sparse_git_commits(tmp_path):
    import subprocess
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "src").mkdir()
    (repo / "src" / "synthetic.txt").write_text("synthetic source\n")
    subprocess.run(["git", "-C", str(repo), "add", "src/synthetic.txt"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test",
                    "commit", "-qm", "synthetic commit"], check=True)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        path = tmp_path / "sparse.jsonl"
        path.write_bytes(line("user", "sparse", 1))
        event_path = tmp_path / "sparse-event.json"
        event_path.write_text(json.dumps({"session_id": "sparse-synthetic", "transcript_path": str(path),
                                          "cwd": str(repo), "reason": "prompt_input_exit"}))
        script = Path(capture.__file__).with_name("runir-session-end-worker.sh")
        result = subprocess.run(["bash", str(script), "sparse-run", str(event_path), str(tmp_path / "sparse.log")],
                                env={**os.environ, "HOME": str(tmp_path), "STATE_DIR": str(tmp_path / "state"),
                                     "RUNIR_USER_ID": "synthetic-user",
                                     "RUNIR_SESSION_END_URL": f"http://127.0.0.1:{server.server_port}/hooks/session-end",
                                     "RUNIR_CAPTURE_URL": f"http://127.0.0.1:{server.server_port}/hooks/capture"},
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        end = [body for route, body in requests if route == "/hooks/session-end"][-1]
        assert end["gitCommits"][0]["subject"] == "synthetic commit"
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_first_sight_partial_line_retried(tmp_path, monkeypatch):
    path, sent, event = setup(tmp_path, monkeypatch)
    complete = line("user", "complete", 1)
    partial = line("user", "later", 2)
    path.write_bytes(complete + partial[:-1])
    capture._capture(event)
    assert [m["content"] for m in sent[0]] == ["complete"]
    assert watermark.load_entry("synthetic-session")["offset"] == len(complete)
    with path.open("ab") as f:
        f.write(b"\n")
    capture._capture(event)
    assert sent[-1][0]["content"] == "later"
