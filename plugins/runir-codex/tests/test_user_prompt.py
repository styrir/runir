import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hooks"))


class RecallHandler(BaseHTTPRequestHandler):
    called = False
    response_body = {"prependContext": "<memory>test</memory>", "count": 1}
    last_auth = None

    def do_POST(self):
        RecallHandler.called = True
        RecallHandler.last_auth = self.headers.get("Authorization")
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(RecallHandler.response_body).encode())

    def log_message(self, *args):
        pass


class TestRecallGuard:
    def test_ack_skips_http(self, monkeypatch, capsys):
        monkeypatch.setenv("RUNIR_USER_ID", "testuser")
        event = {"prompt": "ok", "session_id": "s1", "cwd": "/test"}
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(event)))

        RecallHandler.called = False
        from runir_user_prompt import main
        result = main()

        assert result == 0
        assert RecallHandler.called is False

    def test_real_prompt_calls_server(self, monkeypatch, capsys):
        server = HTTPServer(("127.0.0.1", 0), RecallHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        monkeypatch.setenv("RUNIR_BASE", f"http://127.0.0.1:{port}")
        monkeypatch.setenv("RUNIR_USER_ID", "testuser")

        RecallHandler.called = False
        RecallHandler.last_auth = None
        event = {"prompt": "what are we working on?", "session_id": "s1", "cwd": "/test"}
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(event)))

        from runir_user_prompt import main
        result = main()

        thread.join(timeout=2)
        server.server_close()

        assert result == 0
        assert RecallHandler.called is True
        output = capsys.readouterr().out
        assert "additionalContext" in output
        assert RecallHandler.last_auth is None

    def test_api_key_adds_authorization_header(self, monkeypatch):
        server = HTTPServer(("127.0.0.1", 0), RecallHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        monkeypatch.setenv("RUNIR_BASE", f"http://127.0.0.1:{port}")
        monkeypatch.setenv("RUNIR_USER_ID", "testuser")
        monkeypatch.setenv("RUNIR_API_KEY", "secret-token")

        RecallHandler.called = False
        RecallHandler.last_auth = None
        event = {"prompt": "what are we working on?", "session_id": "s1", "cwd": "/test"}
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(event)))

        from runir_user_prompt import main
        result = main()

        thread.join(timeout=2)
        server.server_close()

        assert result == 0
        assert RecallHandler.called is True
        assert RecallHandler.last_auth == "Bearer secret-token"

    def test_slash_command_skips(self, monkeypatch):
        monkeypatch.setenv("RUNIR_USER_ID", "testuser")
        event = {"prompt": "/help", "session_id": "s1", "cwd": "/test"}
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(event)))

        RecallHandler.called = False
        from runir_user_prompt import main
        main()

        assert RecallHandler.called is False

    def test_shell_command_skips(self, monkeypatch):
        monkeypatch.setenv("RUNIR_USER_ID", "testuser")
        event = {"prompt": "git status", "session_id": "s1", "cwd": "/test"}
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(event)))

        RecallHandler.called = False
        from runir_user_prompt import main
        main()

        assert RecallHandler.called is False

    def test_continue_passes_through(self, monkeypatch):
        server = HTTPServer(("127.0.0.1", 0), RecallHandler)
        port = server.server_address[1]
        thread = Thread(target=server.handle_request, daemon=True)
        thread.start()

        monkeypatch.setenv("RUNIR_BASE", f"http://127.0.0.1:{port}")
        monkeypatch.setenv("RUNIR_USER_ID", "testuser")

        RecallHandler.called = False
        event = {"prompt": "continue", "session_id": "s1", "cwd": "/test"}
        monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(event)))

        from runir_user_prompt import main
        main()

        thread.join(timeout=2)
        server.server_close()

        assert RecallHandler.called is True
