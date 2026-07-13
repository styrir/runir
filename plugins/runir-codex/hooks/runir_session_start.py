#!/usr/bin/env python3
"""Codex SessionStart hook — local Rúnir session opener recall."""

import json
import os
import sys
import urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _debug(msg: str, debug: bool = False) -> None:
    if debug:
        print(f"[runir-opener] {msg}", file=sys.stderr)


def main() -> int:
    runir_base = os.environ.get("RUNIR_BASE", "http://127.0.0.1:7700")
    runir_user_id = os.environ.get("RUNIR_USER_ID")
    runir_api_key = os.environ.get("RUNIR_API_KEY")
    runir_client = os.environ.get("RUNIR_CODEX_CLIENT", "codex")
    runir_user_agent = os.environ.get("RUNIR_CODEX_USER_AGENT", "runir-codex-hook/0.2")
    debug = os.environ.get("RUNIR_DEBUG") == "1"

    if not runir_user_id:
        return 0

    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0

    session_id = event.get("session_id")
    transcript_path = event.get("transcript_path")
    cwd = event.get("cwd")
    source = event.get("source")

    if not session_id and isinstance(transcript_path, str) and transcript_path:
        session_id = os.path.splitext(os.path.basename(transcript_path))[0]

    payload = {
        "prompt": "",
        "userId": runir_user_id,
        "client": runir_client,
        "sessionKind": "opener",
    }
    if session_id:
        payload["sessionId"] = session_id
    if cwd:
        payload["path"] = cwd
    if source:
        payload["resumeReason"] = source

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": runir_user_agent,
    }
    if runir_api_key:
        headers["Authorization"] = f"Bearer {runir_api_key}"

    req = urllib.request.Request(
        f"{runir_base}/hooks/recall",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with OPENER.open(req, timeout=5) as resp:
            recall = json.load(resp)
    except Exception as exc:
        _debug(f"opener request failed: {exc}", debug)
        return 0

    prepend = recall.get("prependContext")
    if prepend:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": prepend,
                }
            },
            sys.stdout,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
