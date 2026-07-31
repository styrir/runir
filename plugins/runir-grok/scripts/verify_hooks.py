#!/usr/bin/env python3
"""Verify Rúnir Grok hooks installation at ~/.grok/hooks/runir-grok.json.

Exit 0 when:
- UserPromptSubmit, PreToolUse, Stop are present
- command path resolves to an existing file (plugin SoT)
- PreToolUse matcher is non-empty and != ".*"
- timeouts meet floors: UPS >= 15, PreToolUse >= 5, Stop >= 5

With --live (after static checks pass):
- POST authed /hooks/recall using the same credential order as the adapter
  (process env → installed RUNIR_ENV_FILE wiring → --env-file / default)
- Exit 3 unauthorized (401/403, missing credential, or missing RUNIR_USER_ID)
- Exit 4 service_down (connection refused / timeout / DNS)
Never invents a default userId. Never prints credential values.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

EXPECTED_EVENTS = ("UserPromptSubmit", "PreToolUse", "Stop")
TIMEOUT_FLOORS = {
    "UserPromptSubmit": 15,
    "PreToolUse": 5,
    "Stop": 5,
}
DEFAULT_ENV_FILE = Path.home() / "Code" / "runir" / ".env"
LIVE_TIMEOUT_S = 5.0


def plugin_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user", action="store_true", help="Verify ~/.grok/hooks/runir-grok.json"
    )
    parser.add_argument("--hooks-file", type=Path, help="Override hooks JSON path")
    parser.add_argument(
        "--plugin-root", type=Path, help="Expected plugin root for command path"
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="After static checks, POST an authed /hooks/recall probe (exits 3/4 on auth/service failures).",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help=(
            "Fallback dotenv path for live credential resolve "
            "(after process env + installed RUNIR_ENV_FILE wiring; matches adapter order)."
        ),
    )
    parser.add_argument(
        "--skill",
        action="store_true",
        help="Also verify deployed /runir skill (SKILL.md frontmatter + inspect script).",
    )
    parser.add_argument(
        "--skills-root",
        type=Path,
        default=None,
        help="Skills root for --skill (default: ~/.grok/skills).",
    )
    return parser.parse_args()


def parse_skill_frontmatter(text: str) -> dict[str, str]:
    """Minimal YAML-ish frontmatter parser for SKILL.md (key: value lines)."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[3:end]
    out: dict[str, str] = {}
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        out[key.strip()] = value.strip().strip("\"'")
    return out


def verify_skill(root: Path, skills_root: Path) -> tuple[list[str], dict[str, Any]]:
    """Static skill checks. Returns (errors, detail)."""
    errors: list[str] = []
    skill_path = skills_root / "runir" / "SKILL.md"
    detail: dict[str, Any] = {
        "skillsRoot": str(skills_root),
        "skillPath": str(skill_path),
        "present": skill_path.is_file(),
    }
    if not skill_path.is_file():
        errors.append(f"skill missing: {skill_path}")
        return errors, detail
    try:
        text = skill_path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"skill unreadable: {type(exc).__name__}")
        return errors, detail
    fm = parse_skill_frontmatter(text)
    detail["frontmatter"] = fm
    user_inv = fm.get("user-invocable", "").lower()
    disable_model = fm.get("disable-model-invocation", "").lower()
    detail["userInvocable"] = user_inv in ("true", "yes", "1")
    detail["disableModelInvocation"] = disable_model in ("true", "yes", "1")
    if not detail["userInvocable"]:
        errors.append("skill user-invocable must be true")
    if not detail["disableModelInvocation"]:
        errors.append("skill disable-model-invocation must be true")
    # Referenced inspector must resolve to plugin SoT (or exist under plugin scripts).
    inspect_sot = (root / "scripts" / "runir_inspect.py").resolve()
    detail["inspectScript"] = str(inspect_sot)
    detail["inspectPresent"] = inspect_sot.is_file()
    if not inspect_sot.is_file():
        errors.append(f"inspect script missing at plugin SoT: {inspect_sot}")
    if "runir_inspect.py" not in text:
        errors.append("SKILL.md does not reference runir_inspect.py")
    return errors, detail


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def first_hook(groups: Any) -> dict[str, Any] | None:
    if not isinstance(groups, list) or not groups:
        return None
    group = groups[0]
    if not isinstance(group, dict):
        return None
    hooks = group.get("hooks")
    if not isinstance(hooks, list) or not hooks:
        return None
    hook = hooks[0]
    return hook if isinstance(hook, dict) else None


def command_script_path(command: str) -> Path | None:
    """Extract the quoted python script path from a command string."""
    if not command:
        return None
    # Prefer last double-quoted path ending in .py
    matches = re.findall(r'"([^"]+\.py)"', command)
    if matches:
        return Path(matches[-1])
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    for part in reversed(parts):
        if part.endswith(".py"):
            return Path(part)
    return None


def parse_env_file_from_command(command: str | None) -> str | None:
    """Extract RUNIR_ENV_FILE=… from an installed hook command.

    Accepts single-quoted (shlex.quote), double-quoted (legacy), or bare
    tokens (shlex.quote leaves safe paths unquoted).
    """
    if not isinstance(command, str) or not command:
        return None
    # Prefer single-quoted token (shlex.quote when path has metacharacters).
    match = re.search(r"RUNIR_ENV_FILE='([^']+)'", command)
    if match:
        return match.group(1)
    match = re.search(r'RUNIR_ENV_FILE="([^"]+)"', command)
    if match:
        return match.group(1)
    match = re.search(r"RUNIR_ENV_FILE=(\S+)", command)
    return match.group(1) if match else None


def read_dotenv_value(path: str, key: str) -> str | None:
    """Minimal KEY=value reader (mirrors adapter; silent on error)."""
    if not path or not key:
        return None
    prefix = f"{key}="
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                trimmed = line.strip()
                if (
                    not trimmed
                    or trimmed.startswith("#")
                    or not trimmed.startswith(prefix)
                ):
                    continue
                raw = trimmed[len(prefix) :].strip()
                if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
                    raw = raw[1:-1]
                return raw.strip() or None
    except OSError:
        pass
    return None


def resolve_live_credential(
    ups_command: str | None, env_file_arg: Path | None
) -> tuple[str | None, str | None, str]:
    """Return (api_key, user_id, key_source). Never returns the key in logs.

    Order matches adapter ``resolve_credential`` (process env first, then
    RUNIR_ENV_FILE). Installed wiring supplies the same env-file path the
    hook command sets; it must not outrank a process RUNIR_API_KEY, or
    ``verify --live`` can pass on a fresh file key while the hook fails on
    a stale inherited process key.
    """
    # (a) process env — same as adapter resolve_credential
    api_key = (os.environ.get("RUNIR_API_KEY") or "").strip() or None
    user_id = (os.environ.get("RUNIR_USER_ID") or "").strip() or None
    if api_key:
        return api_key, user_id, "process_env"

    # (b) deployed UserPromptSubmit RUNIR_ENV_FILE wiring (adapter env-file path)
    wired = parse_env_file_from_command(ups_command)
    if wired:
        file_key = read_dotenv_value(wired, "RUNIR_API_KEY")
        file_user = read_dotenv_value(wired, "RUNIR_USER_ID")
        if file_key:
            return (
                file_key,
                user_id or file_user,
                "installed_wiring",
            )
        user_id = user_id or file_user

    # (c) --env-file / default dotenv fallback
    fallback = env_file_arg or DEFAULT_ENV_FILE
    path = str(fallback.expanduser().resolve())
    api_key = read_dotenv_value(path, "RUNIR_API_KEY")
    user_id = user_id or read_dotenv_value(path, "RUNIR_USER_ID")
    if api_key:
        return api_key, user_id, "env_file_arg"

    return None, user_id, "none"


def live_recall_probe(
    api_key: str,
    user_id: str | None,
    key_source: str,
) -> tuple[int, dict[str, Any]]:
    """POST /hooks/recall. Returns (exit_code, live_detail).

    Exit 3 when user id is unresolved — never invent a default identity
    (e.g. "owner") that could mask missing RUNIR_USER_ID.
    """
    base = (os.environ.get("RUNIR_BASE") or "http://127.0.0.1:7700").rstrip("/")
    url = os.environ.get("RUNIR_RECALL_URL") or f"{base}/hooks/recall"
    live: dict[str, Any] = {
        "url": url,
        "keySource": key_source,
        "authed": False,
    }
    resolved_user = (user_id or "").strip()
    if not resolved_user:
        live["reason"] = "missing_user_id"
        live["hint"] = (
            "set RUNIR_USER_ID in process env or dotenv (via RUNIR_ENV_FILE / --env-file); "
            "verify refuses to invent a default userId"
        )
        return 3, live
    payload = {
        "prompt": "verify_hooks live probe",
        "userId": resolved_user,
        "client": "grok",
        "sessionId": None,
        "path": None,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "runir-grok-verify/0.1",
        "Authorization": f"Bearer {api_key}",
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=LIVE_TIMEOUT_S) as response:
            status = int(response.status)
            raw = response.read()
            try:
                body = json.loads(raw) if raw else {}
            except (json.JSONDecodeError, ValueError):
                body = {}
            live["status"] = status
            live["authed"] = 200 <= status < 300
            # Empty prependContext on 2xx still counts as auth ok.
            if isinstance(body, dict):
                live["hasPrependContext"] = bool(body.get("prependContext"))
            if 200 <= status < 300:
                live["reason"] = "ok"
                return 0, live
            if status in (401, 403):
                live["reason"] = "unauthorized"
                live["hint"] = "env wiring missing or key stale"
                return 3, live
            live["reason"] = f"http_{status}"
            return 3, live
    except urllib.error.HTTPError as exc:
        live["status"] = int(exc.code)
        if exc.code in (401, 403):
            live["reason"] = "unauthorized"
            live["hint"] = "env wiring missing or key stale"
            live["authed"] = False
            return 3, live
        live["reason"] = f"http_{exc.code}"
        return 3, live
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        live["reason"] = "service_down"
        live["error"] = type(exc).__name__
        live["hint"] = f"service unreachable at {url}"
        return 4, live


def main() -> int:
    args = parse_args()
    if not args.user and not args.hooks_file and not args.skill:
        print("error: pass --user, --hooks-file, and/or --skill", file=sys.stderr)
        return 2

    root = (args.plugin_root or plugin_root()).resolve()
    errors: list[str] = []
    details: dict[str, Any] = {
        "pluginRoot": str(root),
    }
    ups_command: str | None = None
    exit_code = 0

    if args.user or args.hooks_file:
        hooks_file = (
            args.hooks_file.expanduser().resolve()
            if args.hooks_file
            else (Path.home() / ".grok" / "hooks" / "runir-grok.json")
        )
        expected_script = (root / "hooks" / "runir-grok.py").resolve()
        data = load_json(hooks_file)
        hooks = data.get("hooks") if isinstance(data.get("hooks"), dict) else {}

        details["hooksFile"] = str(hooks_file)
        details["expectedScript"] = str(expected_script)
        details["events"] = {}

        for event in EXPECTED_EVENTS:
            groups = hooks.get(event)
            hook = first_hook(groups)
            event_detail: dict[str, Any] = {"present": hook is not None}
            if hook is None:
                errors.append(f"missing event {event}")
                details["events"][event] = event_detail
                continue
            command = hook.get("command")
            timeout = hook.get("timeout")
            event_detail["command"] = command
            event_detail["timeout"] = timeout
            if event == "UserPromptSubmit" and isinstance(command, str):
                ups_command = command
            if not isinstance(command, str) or not command:
                errors.append(f"{event}: empty command")
            else:
                script = command_script_path(command)
                event_detail["scriptPath"] = str(script) if script else None
                if script is None or not script.is_file():
                    errors.append(
                        f"{event}: command path does not resolve to existing file: {command}"
                    )
                else:
                    resolved = script.resolve()
                    event_detail["scriptResolved"] = str(resolved)
                    if resolved != expected_script:
                        errors.append(
                            f"{event}: command script {resolved} != plugin SoT {expected_script}"
                        )
            floor = TIMEOUT_FLOORS[event]
            if not isinstance(timeout, (int, float)) or float(timeout) < floor:
                errors.append(f"{event}: timeout {timeout!r} below floor {floor}")
            details["events"][event] = event_detail

        # PreToolUse matcher
        matcher = None
        ptu_groups = hooks.get("PreToolUse")
        if (
            isinstance(ptu_groups, list)
            and ptu_groups
            and isinstance(ptu_groups[0], dict)
        ):
            matcher = ptu_groups[0].get("matcher")
        details["matcher"] = matcher
        if not isinstance(matcher, str) or not matcher.strip():
            errors.append("PreToolUse matcher missing or empty")
        elif matcher == ".*":
            errors.append('PreToolUse matcher must not be ".*"')
        else:
            try:
                re.compile(matcher)
                details["matcherCompiles"] = True
            except re.error as exc:
                errors.append(f"PreToolUse matcher does not compile: {exc}")
                details["matcherCompiles"] = False

    if args.skill:
        skills_root = (
            args.skills_root.expanduser().resolve()
            if args.skills_root
            else (Path.home() / ".grok" / "skills")
        )
        skill_errors, skill_detail = verify_skill(root, skills_root)
        details["skill"] = skill_detail
        errors.extend(skill_errors)

    if errors:
        summary = {
            "ok": False,
            "errors": errors,
            **details,
        }
        print(json.dumps(summary, indent=2))
        return 1

    live_detail: dict[str, Any] | None = None
    if args.live and (args.user or args.hooks_file):
        api_key, user_id, key_source = resolve_live_credential(
            ups_command, args.env_file
        )
        if not api_key:
            live_detail = {
                "reason": "no_credential",
                "keySource": key_source,
                "authed": False,
                "hint": "set RUNIR_ENV_FILE via install --env-file, or RUNIR_API_KEY, or --env-file",
            }
            exit_code = 3
        else:
            exit_code, live_detail = live_recall_probe(api_key, user_id, key_source)

    ok = exit_code == 0
    summary = {
        "ok": ok,
        "errors": errors,
        **details,
    }
    if live_detail is not None:
        summary["live"] = live_detail
    print(json.dumps(summary, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
