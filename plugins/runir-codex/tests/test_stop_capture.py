import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hooks"))


def _make_transcript_line(role: str, text: str) -> str:
    return json.dumps({
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": role,
            "content": [{"text": text}],
        },
    })


def _write_transcript(path: str, messages: list) -> None:
    with open(path, "w") as f:
        for role, text in messages:
            f.write(_make_transcript_line(role, text) + "\n")


class CaptureHandler(BaseHTTPRequestHandler):
    captured_body = None
    response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}
    status_code = 200
    last_auth = None

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        CaptureHandler.last_auth = self.headers.get("Authorization")
        CaptureHandler.captured_body = json.loads(self.rfile.read(length))
        self.send_response(CaptureHandler.status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(CaptureHandler.response_body).encode())

    def log_message(self, *args):
        pass


class TestIncrementalCapture:
    def _start_server(self):
        server = HTTPServer(("127.0.0.1", 0), CaptureHandler)
        port = server.server_address[1]
        t = Thread(target=server.serve_forever, daemon=True)
        t.start()
        return server, port

    def test_first_capture_sends_all_messages(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi there"),
            ("user", "do X"),
            ("assistant", "done X"),
        ])

        server, port = self._start_server()
        try:
            monkeypatch.setenv("RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setenv("RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-1",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is not None
        assert len(CaptureHandler.captured_body["messages"]) == 4
        assert CaptureHandler.last_auth is None

        from watermark import load_watermark
        assert load_watermark("sess-1") == 4

    def test_api_key_adds_authorization_header(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.last_auth = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi there"),
        ])

        server, port = self._start_server()
        try:
            monkeypatch.setenv("RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setenv("RUNIR_USER_ID", "test-user")
            monkeypatch.setenv("RUNIR_API_KEY", "secret-token")

            event = {
                "session_id": "sess-auth",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_API_KEY", "secret-token")

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.last_auth == "Bearer secret-token"

    def test_second_capture_sends_only_new(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        # Pre-seed watermark at 4
        from watermark import save_watermark
        os.makedirs(wm_dir, exist_ok=True)
        save_watermark("sess-2", 4)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi there"),
            ("user", "do X"),
            ("assistant", "done X"),
            ("user", "now do Y"),
            ("assistant", "done Y"),
        ])

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-2",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is not None
        messages = CaptureHandler.captured_body["messages"]
        assert len(messages) == 2
        assert messages[0]["content"] == "now do Y"

    def test_no_new_messages_skips_http(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        from watermark import save_watermark
        os.makedirs(wm_dir, exist_ok=True)
        save_watermark("sess-3", 4)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi there"),
            ("user", "do X"),
            ("assistant", "done X"),
        ])

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-3",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is None

    def test_failure_does_not_advance_watermark(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 500
        CaptureHandler.response_body = {"error": "internal server error"}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi there"),
        ])

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-4",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()
            CaptureHandler.status_code = 200
            CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        from watermark import load_watermark
        assert load_watermark("sess-4") == 0

    def test_transcript_shorter_than_watermark_resets(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        from watermark import save_watermark
        os.makedirs(wm_dir, exist_ok=True)
        save_watermark("sess-5", 100)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "fresh start"),
            ("assistant", "ok"),
        ])

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-5",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is not None
        assert len(CaptureHandler.captured_body["messages"]) == 2

    def test_last_assistant_fallback_when_no_transcript(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-6",
                "cwd": "/tmp",
                "last_assistant_message": "I completed the task",
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is not None
        messages = CaptureHandler.captured_body["messages"]
        assert len(messages) == 1
        assert messages[0]["role"] == "assistant"
        assert messages[0]["content"] == "I completed the task"

    def test_repeated_last_assistant_fallback_captures_new_outputs(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            first_event = {
                "session_id": "sess-6b",
                "cwd": "/tmp",
                "last_assistant_message": "I completed the first task",
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(first_event)))
            first_result = runir_stop_capture.main()
            assert first_result == 0
            assert CaptureHandler.captured_body is not None
            assert CaptureHandler.captured_body["messages"][0]["content"] == "I completed the first task"

            CaptureHandler.captured_body = None
            second_event = {
                "session_id": "sess-6b",
                "cwd": "/tmp",
                "last_assistant_message": "I completed the second task",
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(second_event)))
            second_result = runir_stop_capture.main()
            assert second_result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is not None
        assert CaptureHandler.captured_body["messages"][0]["content"] == "I completed the second task"

    def test_duplicate_last_assistant_fallback_is_deduped(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-6c",
                "cwd": "/tmp",
                "last_assistant_message": "I completed the same task",
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
            first_result = runir_stop_capture.main()
            assert first_result == 0
            assert CaptureHandler.captured_body is not None

            CaptureHandler.captured_body = None
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
            second_result = runir_stop_capture.main()
            assert second_result == 0
        finally:
            server.shutdown()

        assert CaptureHandler.captured_body is None

    def test_noise_bank_skip_advances_watermark(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": True, "reason": "noise-bank"}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi"),
        ])

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-7",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()
            CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        from watermark import load_watermark
        assert load_watermark("sess-7") == 2

    def test_no_api_key_skip_holds_watermark(self, tmp_path, monkeypatch):
        CaptureHandler.captured_body = None
        CaptureHandler.status_code = 200
        CaptureHandler.response_body = {"skipped": True, "reason": "no capture API key"}

        wm_dir = str(tmp_path / "wm")
        monkeypatch.setattr("watermark.WATERMARK_DIR", wm_dir)

        transcript = tmp_path / "transcript.jsonl"
        _write_transcript(str(transcript), [
            ("user", "hello"),
            ("assistant", "hi"),
        ])

        server, port = self._start_server()
        try:
            import runir_stop_capture
            monkeypatch.setattr(runir_stop_capture, "RUNIR_BASE", f"http://127.0.0.1:{port}")
            monkeypatch.setattr(runir_stop_capture, "RUNIR_USER_ID", "test-user")

            event = {
                "session_id": "sess-8",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
            }
            monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))

            result = runir_stop_capture.main()
            assert result == 0
        finally:
            server.shutdown()
            CaptureHandler.response_body = {"skipped": False, "factsFound": 1, "outcomes": {"create": 1}}

        from watermark import load_watermark
        assert load_watermark("sess-8") == 0
