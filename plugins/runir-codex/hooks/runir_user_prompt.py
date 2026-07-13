#!/usr/bin/env python3
"""Codex UserPromptSubmit hook — gated recall.

Thin client-side negative filter skips obviously pointless prompts.
All positive recall decisions stay on the server.
"""

import json
import os
import sys
import urllib.request

from recall_filter import should_skip_client_recall

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _debug(msg: str, debug: bool = False) -> None:
    if debug:
        print(f"[runir-recall] {msg}", file=sys.stderr)


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

    prompt = event.get("prompt", "")
    session_id = event.get("session_id")
    cwd = event.get("cwd")

    if not isinstance(prompt, str) or not prompt.strip():
        return 0

    if should_skip_client_recall(prompt):
        _debug(f"skipped: {prompt[:60]}", debug)
        return 0

    body = json.dumps({
        "prompt": prompt,
        "userId": runir_user_id,
        "client": runir_client,
        "sessionId": session_id,
        "path": cwd,
    }).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": runir_user_agent,
    }
    if runir_api_key:
        headers["Authorization"] = f"Bearer {runir_api_key}"

    req = urllib.request.Request(
        f"{runir_base}/hooks/recall",
        data=body,
        headers=headers,
        method="POST",
    )

    try:
        with OPENER.open(req, timeout=5) as resp:
            recall = json.load(resp)
    except Exception as exc:
        _debug(f"recall request failed: {exc}", debug)
        return 0

    prepend = recall.get("prependContext")
    if prepend:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": prepend,
                }
            },
            sys.stdout,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
