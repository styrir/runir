#!/usr/bin/env python3
"""Minimal mock of the runir /hooks/* endpoints for integration testing.

Behavior:
- Accepts POST only (GET returns 405).
- Returns MOCK_STATUS (default 200) with MOCK_BODY (default {"prependContext":"hello"})
  as the response body.
- Echoes the received Authorization header, Content-Type, and raw body to stderr so
  test harnesses can assert exactly what the hook sent.

Usage:
  python3 plugins/runir-claudecode/hooks/test/mock_runir.py 8799
  MOCK_STATUS=401 MOCK_BODY='{"error":"unauthorized"}' python3 mock_runir.py 8799
"""
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args, **_kwargs):
        return

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8", errors="replace") if length else ""
        auth = self.headers.get("Authorization", "")
        ctype = self.headers.get("Content-Type", "")
        sys.stderr.write(f"Authorization: {auth}\n")
        sys.stderr.write(f"Content-Type: {ctype}\n")
        sys.stderr.write(f"Body: {body}\n")
        sys.stderr.flush()
        status = int(os.environ.get("MOCK_STATUS", "200"))
        payload = os.environ.get("MOCK_BODY", '{"prependContext":"hello"}').encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    HTTPServer(("127.0.0.1", port), MockHandler).serve_forever()
