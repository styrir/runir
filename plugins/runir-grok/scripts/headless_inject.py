#!/usr/bin/env python3
"""Headless one-shot: recall → grok --prompt-json [memory,user] → capture.

Programmatic path for ask.sh-style callers. Owns recall and capture end-to-end;
sets RUNIR_GROK_DISABLE_GATE=1 on the child so TUI correction hooks stay inert.

Exit codes:
  0  ok (incl. recall fail-open, capture failure)
  2  usage / missing RUNIR_USER_ID
  3  grok spawn failure or non-zero exit
  4  grok stdout unparseable or session identity mismatch
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

_LIB = Path(__file__).resolve().parents[1] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
import runir_core as core  # noqa: E402

# Verified against `grok --help` (2026-07-31): --prompt-json takes JSON content
# blocks (not a path); --output-format json; --resume / -r; --always-approve
# (no --yolo). Prefer writing 0600 tempfile then passing contents as --prompt-json
# value (CLI has no path form — argv caveat documented in README).

# Parent owns recall/capture; never hand Rúnir bearer material to the grok child
# (prompt-injection / --yolo tool exfil surface).
_CHILD_STRIP_ENV = (
    "RUNIR_API_KEY",
    "RUNIR_ENV_FILE",
)


def build_child_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    for key in _CHILD_STRIP_ENV:
        env.pop(key, None)
    env["RUNIR_GROK_DISABLE_GATE"] = "1"
    return env


def build_grok_argv(
    prompt_json: str,
    *,
    resume: str | None = None,
    session_id: str | None = None,
    path: str | None = None,
    yolo: bool = False,
    max_turns: int | None = None,
    no_memory: bool = False,
    disable_web_search: bool = False,
) -> list[str]:
    if resume and session_id:
        raise ValueError("--session-id cannot be combined with --resume")
    argv = ["grok", "--prompt-json", prompt_json, "--output-format", "json"]
    if resume:
        argv.extend(["--resume", resume])
    elif session_id:
        argv.extend(["--session-id", session_id])
    if path:
        argv.extend(["--cwd", path])
    if yolo:
        argv.append("--always-approve")
    if max_turns is not None:
        argv.extend(["--max-turns", str(max_turns)])
    if no_memory:
        argv.append("--no-memory")
    if disable_web_search:
        argv.append("--disable-web-search")
    return argv


def write_prompt_json_file(blocks: list[dict[str, str]]) -> Path:
    """Write content blocks to a 0600 tempfile; caller must unlink."""
    raw = json.dumps(blocks, ensure_ascii=False)
    fd, name = tempfile.mkstemp(prefix="runir-prompt-", suffix=".json")
    path = Path(name)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(raw)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        path.unlink(missing_ok=True)
        raise
    return path


def parse_grok_json(stdout: str) -> dict[str, Any] | None:
    """Parse single JSON object or last complete JSONL object."""
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass
    last: dict[str, Any] | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(obj, dict):
            last = obj
    return last


def extract_model_calls(result: dict[str, Any]) -> int | None:
    """Sum modelUsage.*.modelCalls; fall back to top-level modelCalls/num_turns."""
    if "modelCalls" in result and isinstance(result["modelCalls"], int):
        return result["modelCalls"]
    usage = result.get("modelUsage")
    if isinstance(usage, dict) and usage:
        total = 0
        found = False
        for row in usage.values():
            if isinstance(row, dict) and isinstance(row.get("modelCalls"), int):
                total += row["modelCalls"]
                found = True
        if found:
            return total
    if isinstance(result.get("num_turns"), int):
        return result["num_turns"]
    return None


def extract_assistant_text(result: dict[str, Any]) -> str:
    text = result.get("text")
    if isinstance(text, str):
        return text
    return ""


def resolve_session_id(*, resume: str | None = None) -> str:
    """Return the real Grok session UUID used by recall, Grok, and capture."""
    resume_value = (resume or "").strip()
    if resume_value:
        return resume_value
    return str(uuid.uuid4())


def recall_with_retry(
    prompt: str,
    *,
    user_id: str,
    session_id: str = "",
    path: str | None = None,
    api_key: str | None = None,
    client: str = core.DEFAULT_CLIENT,
    user_agent: str = core.DEFAULT_USER_AGENT,
    attempts: int = 2,
) -> core.RecallResult:
    """Recall once, retry once on empty context (cold embedder / short timeout)."""
    last = core.RecallResult()
    for i in range(max(1, attempts)):
        try:
            last = core.recall_result(
                prompt,
                user_id=user_id,
                session_id=session_id,
                path=path,
                api_key=api_key,
                client=client,
                user_agent=user_agent,
            )
        except Exception as exc:
            print(f"warn: recall failed open: {exc}", file=sys.stderr)
            last = core.RecallResult()
        if last.context:
            return last
        if i + 1 < attempts:
            # Brief pause so ollama nomic-embed can finish cold start.
            try:
                import time

                time.sleep(2.0)
            except Exception:
                pass
    return last


def run_inject(
    prompt: str,
    *,
    resume: str | None = None,
    path: str | None = None,
    no_capture: bool = False,
    yolo: bool = False,
    timeout: float | None = None,
    as_json: bool = False,
    max_turns: int | None = None,
    no_memory: bool = False,
    disable_web_search: bool = False,
    grok_runner=None,
) -> int:
    user_id = core.resolve_credential("RUNIR_USER_ID")
    if not user_id:
        print("error: RUNIR_USER_ID is required", file=sys.stderr)
        return 2
    api_key = core.resolve_credential("RUNIR_API_KEY")
    client = os.environ.get("RUNIR_GROK_CLIENT", core.DEFAULT_CLIENT)
    user_agent = os.environ.get("RUNIR_GROK_USER_AGENT", core.DEFAULT_USER_AGENT)
    cwd = path or os.getcwd()

    # Fresh turns pre-generate the actual Grok UUID; resume turns reuse the real
    # Grok session ID. The same identity threads recall, Grok, and capture.
    session_id = resolve_session_id(resume=resume)

    recall = recall_with_retry(
        prompt,
        user_id=user_id,
        session_id=session_id,
        path=cwd,
        api_key=api_key,
        client=client,
        user_agent=user_agent,
        attempts=2,
    )
    memory = recall.context

    blocks = core.build_prompt_blocks(prompt, memory)

    prompt_path: Path | None = None
    try:
        prompt_path = write_prompt_json_file(blocks)
        prompt_json = prompt_path.read_text(encoding="utf-8")
        argv = build_grok_argv(
            prompt_json,
            resume=resume,
            session_id=None if resume else session_id,
            path=cwd,
            yolo=yolo,
            max_turns=max_turns,
            no_memory=no_memory,
            disable_web_search=disable_web_search,
        )
        env = build_child_env()
        runner = grok_runner or _default_spawn
        try:
            proc = runner(argv, env=env, timeout=timeout)
        except FileNotFoundError:
            print("error: grok binary not found on PATH", file=sys.stderr)
            return 3
        except subprocess.TimeoutExpired:
            print("error: grok timed out", file=sys.stderr)
            return 3
        except OSError as exc:
            print(f"error: grok spawn failed: {exc}", file=sys.stderr)
            return 3

        if proc.returncode != 0:
            if proc.stderr:
                print(proc.stderr, file=sys.stderr, end="")
            print(f"error: grok exited {proc.returncode}", file=sys.stderr)
            return 3

        result = parse_grok_json(proc.stdout or "")
        if result is None:
            print("error: unparseable grok stdout", file=sys.stderr)
            if proc.stdout:
                print(proc.stdout, file=sys.stderr, end="")
            return 4

        returned_session_id = str(result.get("sessionId") or "").strip()
        if returned_session_id != session_id:
            print(
                "error: grok sessionId mismatch: "
                f"expected {session_id!r}, got {returned_session_id!r}",
                file=sys.stderr,
            )
            return 4
        model_calls = extract_model_calls(result)
        assistant = extract_assistant_text(result)

        if not no_capture and assistant:
            messages = [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": assistant},
            ]
            ok = core.capture_turn(
                messages,
                user_id=user_id,
                session_id=session_id,
                path=cwd,
                api_key=api_key,
                client=client,
                user_agent=user_agent,
                retrieval_trace_id=recall.retrieval_trace_id,
                memory_ids=list(recall.memory_ids) if recall.memory_ids else None,
                capture_receipt=bool(recall.retrieval_trace_id),
            )
            if not ok:
                print("warn: capture failed (non-fatal)", file=sys.stderr)

        out = {
            "sessionId": session_id,
            "modelCalls": model_calls,
            "text": assistant,
            "memoryInjected": bool(memory),
            "retrievalTraceId": recall.retrieval_trace_id or "",
            "memoryIds": list(recall.memory_ids),
            "stopReason": result.get("stopReason"),
        }
        if as_json:
            print(json.dumps(out, ensure_ascii=False))
        else:
            print(assistant)
        return 0
    finally:
        if prompt_path is not None:
            try:
                prompt_path.unlink(missing_ok=True)
            except OSError:
                pass


class _ProcResult:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _default_spawn(
    argv: list[str], *, env: dict[str, str], timeout: float | None
) -> _ProcResult:
    completed = subprocess.run(
        argv,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return _ProcResult(completed.returncode, completed.stdout, completed.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Headless Runir memory inject for Grok one-shots"
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--prompt", help="User prompt text")
    src.add_argument("--prompt-file", type=Path, help="Read user prompt from file")
    parser.add_argument("--resume", help="Existing Grok session UUID to resume")
    parser.add_argument("--path", help="Workspace cwd for recall/capture/grok")
    parser.add_argument(
        "--no-capture",
        action="store_true",
        help="Skip /hooks/capture after the turn",
    )
    parser.add_argument(
        "--yolo",
        action="store_true",
        help="Pass --always-approve to grok (auto-approve tools)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="Grok subprocess timeout seconds",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Print structured result JSON instead of assistant text",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=None,
        help="Pass --max-turns N to grok (canary uses 1 to pin modelCalls)",
    )
    parser.add_argument(
        "--no-memory",
        action="store_true",
        help="Pass --no-memory to grok (disable native cross-session memory)",
    )
    parser.add_argument(
        "--disable-web-search",
        action="store_true",
        help="Pass --disable-web-search to grok",
    )
    args = parser.parse_args(argv)

    if args.prompt_file is not None:
        try:
            prompt = args.prompt_file.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"error: cannot read prompt file: {exc}", file=sys.stderr)
            return 2
    else:
        prompt = args.prompt or ""
    if not prompt.strip():
        print("error: empty prompt", file=sys.stderr)
        return 2

    return run_inject(
        prompt,
        resume=args.resume,
        path=args.path,
        no_capture=args.no_capture,
        yolo=args.yolo,
        timeout=args.timeout,
        as_json=args.as_json,
        max_turns=args.max_turns,
        no_memory=args.no_memory,
        disable_web_search=args.disable_web_search,
    )


if __name__ == "__main__":
    raise SystemExit(main())
