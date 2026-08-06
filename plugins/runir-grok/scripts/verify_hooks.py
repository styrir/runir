#!/usr/bin/env python3
"""Verify Rúnir Grok hooks installation at ~/.grok/hooks/runir-grok.json.

Exit 0 when:
- UserPromptSubmit and Stop are present (capture + ambient bridge path)
- command path resolves to an existing file (plugin SoT)
- no Rúnir-owned PreToolUse group remains (deny transport retired)
- timeouts meet floors: UPS >= 15, Stop >= 5

With --live (after static checks pass):
- POST authed /hooks/recall using the same credential order as the adapter
  (process env → installed RUNIR_ENV_FILE wiring → --env-file / default)
- Live recall transport: preflight is_allowed_runir_endpoint, shared OPENER
  (proxy-stripped + same-origin redirect guard), read_capped_body (not the
  fail-open JSON helpers). Taxonomy:
  - 0 ok (2xx)
  - 3 missing_user_id / identity_conflict / endpoint_not_allowed /
    unauthorized (401/403) / http_NNN / oversize_response /
    cross_origin_redirect_blocked / invalid_url (malformed host/port
    after allowlist)
  - 4 service_down (URLError / TimeoutError / OSError)
- Ollama residency probe: OPENER + byte cap only (no Rúnir allowlist)
Never invents a default userId. Never prints credential values.
Identity uses resolve_effective_user_id (process vs env-file conflict fails).
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LIB = Path(__file__).resolve().parents[1] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
import runir_core as core  # noqa: E402

EXPECTED_EVENTS = ("UserPromptSubmit", "Stop")
TIMEOUT_FLOORS = {
    "UserPromptSubmit": 15,
    "Stop": 5,
}
DEFAULT_ENV_FILE = Path.home() / "Code" / "runir" / ".env"
LIVE_TIMEOUT_S = 5.0
LAUNCH_AGENT_LABEL = "com.runir.embed-warm"
NOMIC_MODEL_PREFIX = "nomic-embed-text"


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
        help=(
            "After static checks, POST an authed /hooks/recall probe (exits 3/4 on "
            "auth/service failures). With --launch-agent, also probe ollama /api/ps."
        ),
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
    parser.add_argument(
        "--launch-agent",
        action="store_true",
        help=(
            "Verify embed-warm LaunchAgent is installed, matches plugin SoT, "
            "and (unless --no-launchctl) is loaded via launchctl."
        ),
    )
    parser.add_argument(
        "--agents-dir",
        type=Path,
        default=None,
        help="LaunchAgents dir for --launch-agent (default: ~/Library/LaunchAgents).",
    )
    parser.add_argument(
        "--no-launchctl",
        action="store_true",
        help="Skip launchctl loaded probe (tests / offline).",
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


def _identity_env_file(
    ups_command: str | None, env_file_arg: Path | None
) -> str | None:
    """Env-file path used for identity conflict checks.

    Installed UserPromptSubmit wiring is authoritative because it is the env-file
    path the hook child will actually receive. Ambient process RUNIR_ENV_FILE is
    only a fallback when the installed command has no wiring, followed by an
    explicit --env-file. Does not invent a default path when none are present
    (process-only identity is valid).
    """
    wired = parse_env_file_from_command(ups_command)
    if wired:
        return wired
    process_path = (os.environ.get("RUNIR_ENV_FILE") or "").strip() or None
    if process_path:
        return process_path
    if env_file_arg is not None:
        try:
            return str(env_file_arg.expanduser().resolve())
        except OSError:
            return str(env_file_arg)
    return None


def resolve_live_identity(
    ups_command: str | None, env_file_arg: Path | None
) -> core.EffectiveUserId:
    """Canonical effective user id for verify --live (conflict never invents)."""
    return core.resolve_effective_user_id(
        env_file=_identity_env_file(ups_command, env_file_arg)
    )


def resolve_live_credential(
    ups_command: str | None, env_file_arg: Path | None
) -> tuple[str | None, str | None, str]:
    """Return (api_key, user_id, key_source). Never returns the key in logs.

    API key order matches adapter ``resolve_credential`` (process env first,
    then RUNIR_ENV_FILE). Installed wiring must not outrank a process
    RUNIR_API_KEY (stale inherited process key would mask a fresh file key).

    User id uses ``resolve_effective_user_id`` even when a process API key is
    set, so process≠file identity conflicts fail loud instead of silently
    preferring process.
    """
    effective = resolve_live_identity(ups_command, env_file_arg)
    user_id = effective.user_id  # None on missing or conflict

    # (a) process env — same as adapter resolve_credential for keys
    api_key = (os.environ.get("RUNIR_API_KEY") or "").strip() or None
    if api_key:
        return api_key, user_id, "process_env"

    # (b) deployed UserPromptSubmit RUNIR_ENV_FILE wiring (adapter env-file path)
    wired = parse_env_file_from_command(ups_command)
    if wired:
        file_key = read_dotenv_value(wired, "RUNIR_API_KEY")
        if file_key:
            return file_key, user_id, "installed_wiring"

    # (c) --env-file / default dotenv fallback
    fallback = env_file_arg or DEFAULT_ENV_FILE
    path = str(fallback.expanduser().resolve())
    api_key = read_dotenv_value(path, "RUNIR_API_KEY")
    if api_key:
        return api_key, user_id, "env_file_arg"

    return None, user_id, "none"


def expiry_is_resident(expires_at: str | None) -> bool:
    """True when expires_at year is far-future (keep_alive:-1 sentinel).

    Ollama keep_alive:-1 yields years that overflow datetime parsers, so we
    only parse the leading integer year and require year >= current_year + 10.
    """
    if not expires_at or not isinstance(expires_at, str):
        return False
    match = re.match(r"^(\d+)", expires_at.strip())
    if not match:
        return False
    try:
        year = int(match.group(1))
    except ValueError:
        return False
    current_year = datetime.now(timezone.utc).year
    return year >= current_year + 10


def verify_launch_agent(
    root: Path,
    agents_dir: Path,
    *,
    probe_launchctl: bool,
) -> tuple[list[str], dict[str, Any]]:
    """Static (+ optional launchctl) LaunchAgent checks. Returns (errors, detail)."""
    errors: list[str] = []
    sot = root / "launchd" / f"{LAUNCH_AGENT_LABEL}.plist"
    plist_path = agents_dir / f"{LAUNCH_AGENT_LABEL}.plist"
    detail: dict[str, Any] = {
        "agentsDir": str(agents_dir),
        "plistPath": str(plist_path),
        "sotPath": str(sot),
        "present": plist_path.is_file(),
        "matchesSot": False,
        "loaded": None,
    }
    if not sot.is_file():
        errors.append(f"launch agent SoT missing: {sot}")
        return errors, detail
    if not plist_path.is_file():
        errors.append(f"launch agent missing: {plist_path}")
        return errors, detail
    try:
        installed = plist_path.read_bytes()
        desired = sot.read_bytes()
    except OSError as exc:
        errors.append(f"launch agent unreadable: {type(exc).__name__}")
        return errors, detail
    detail["matchesSot"] = installed == desired
    if not detail["matchesSot"]:
        errors.append("launch agent drifted from SoT")
    if probe_launchctl:
        try:
            result = subprocess.run(
                ["launchctl", "print", f"gui/{os.getuid()}/{LAUNCH_AGENT_LABEL}"],
                capture_output=True,
                timeout=10,
                check=False,
            )
            detail["loaded"] = result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            detail["loaded"] = False
        if not detail["loaded"]:
            errors.append("launch agent not loaded")
    return errors, detail


def ollama_residency_probe() -> tuple[int, dict[str, Any]]:
    """GET ollama /api/ps; require nomic-embed-text with far-future expiry.

    Exit 0 resident · 3 present-but-not-far-future / absent / oversize ·
    4 service_down.

    Uses shared OPENER + capped body reader only. Ollama is not under the
    authenticated Rúnir endpoint allowlist (RUNIR_OLLAMA_BASE trust domain).
    """
    base = (os.environ.get("RUNIR_OLLAMA_BASE") or "http://127.0.0.1:11434").rstrip("/")
    url = f"{base}/api/ps"
    detail: dict[str, Any] = {"url": url, "modelPrefix": NOMIC_MODEL_PREFIX}
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "runir-grok-verify/0.1",
        },
        method="GET",
    )
    try:
        with core.OPENER.open(request, timeout=LIVE_TIMEOUT_S) as response:
            raw = core.read_capped_body(response)
            try:
                body = json.loads(raw) if raw else {}
            except (json.JSONDecodeError, ValueError):
                body = {}
    except core.ResponseTooLarge:
        detail["reason"] = "oversize_response"
        detail["resident"] = False
        return 3, detail
    except http.client.InvalidURL as exc:
        # Malformed RUNIR_OLLAMA_BASE (e.g. nonnumeric port) is config, not crash.
        detail["reason"] = "invalid_url"
        detail["error"] = type(exc).__name__
        detail["resident"] = False
        return 3, detail
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        detail["reason"] = "service_down"
        detail["error"] = type(exc).__name__
        return 4, detail

    models = body.get("models") if isinstance(body, dict) else None
    if not isinstance(models, list):
        models = []
    match: dict[str, Any] | None = None
    for entry in models:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or entry.get("model") or "")
        if name.startswith(NOMIC_MODEL_PREFIX):
            match = entry
            break
    if match is None:
        detail["reason"] = "model_absent"
        detail["resident"] = False
        return 3, detail
    expires_at = match.get("expires_at")
    if expires_at is None:
        expires_at = match.get("expiresAt")
    expires_s = str(expires_at) if expires_at is not None else None
    detail["model"] = str(match.get("name") or match.get("model") or "")
    detail["expiresAt"] = expires_s
    if expiry_is_resident(expires_s):
        detail["reason"] = "ok"
        detail["resident"] = True
        return 0, detail
    detail["reason"] = "model_not_resident"
    detail["resident"] = False
    return 3, detail


def _attach_identity_fields(
    live: dict[str, Any],
    *,
    effective: core.EffectiveUserId | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Non-secret identity fields for live JSON (never API keys / canary bodies)."""
    if effective is not None:
        live["effectiveUserId"] = effective.user_id
        live["identitySource"] = effective.source
        live["identityConflict"] = (
            effective.conflict if effective.source == "conflict" else False
        )
    else:
        live["effectiveUserId"] = (user_id or "").strip() or None
        live.setdefault("identitySource", "explicit")
        live.setdefault("identityConflict", False)
    return live


def live_recall_probe(
    api_key: str,
    user_id: str | None,
    key_source: str,
    *,
    effective: core.EffectiveUserId | None = None,
) -> tuple[int, dict[str, Any]]:
    """POST /hooks/recall. Returns (exit_code, live_detail).

    Exit 3 when user id is unresolved or identity conflicts — never invent a
    default identity (e.g. "owner") that could mask missing RUNIR_USER_ID.

    Transport: preflight is_allowed_runir_endpoint, then core.OPENER +
    read_capped_body. Does not route through fail-open JSON helpers so the
    0/3/4 taxonomy and hints stay intact.
    """
    base = (os.environ.get("RUNIR_BASE") or "http://127.0.0.1:7700").rstrip("/")
    url = os.environ.get("RUNIR_RECALL_URL") or f"{base}/hooks/recall"
    live: dict[str, Any] = {
        "url": url,
        "keySource": key_source,
        "authed": False,
    }
    _attach_identity_fields(live, effective=effective, user_id=user_id)
    if effective is not None and effective.source == "conflict":
        live["reason"] = "identity_conflict"
        live["hint"] = (
            "process RUNIR_USER_ID disagrees with env-file RUNIR_USER_ID; "
            "align them (never invent owner/default). detail="
            f"{effective.conflict}"
        )
        return 3, live
    resolved_user = (user_id or "").strip()
    if not resolved_user:
        live["reason"] = "missing_user_id"
        live["hint"] = (
            "set RUNIR_USER_ID in process env or dotenv (via RUNIR_ENV_FILE / --env-file); "
            "verify refuses to invent a default userId"
        )
        return 3, live
    if not core.is_allowed_runir_endpoint(url):
        live["reason"] = "endpoint_not_allowed"
        live["hint"] = (
            "recall endpoint must be loopback http(s), or https with "
            "RUNIR_ALLOW_REMOTE_ENDPOINTS=1; refusing to send Bearer to "
            "an unapproved origin"
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
    try:
        with core.OPENER.open(request, timeout=LIVE_TIMEOUT_S) as response:
            status = int(response.status)
            raw = core.read_capped_body(response)
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
    except core.ResponseTooLarge:
        live["reason"] = "oversize_response"
        live["authed"] = False
        live["hint"] = f"recall response exceeded {core.MAX_RESPONSE_BYTES} byte cap"
        return 3, live
    except urllib.error.HTTPError as exc:
        detail = str(getattr(exc, "reason", "") or "")
        if "cross-origin redirect blocked" in detail:
            live["reason"] = "cross_origin_redirect_blocked"
            live["authed"] = False
            live["hint"] = "refused to forward Authorization to a different origin"
            return 3, live
        live["status"] = int(exc.code)
        if exc.code in (401, 403):
            live["reason"] = "unauthorized"
            live["hint"] = "env wiring missing or key stale"
            live["authed"] = False
            return 3, live
        live["reason"] = f"http_{exc.code}"
        return 3, live
    except http.client.InvalidURL as exc:
        # Allowlist may pass loopback hosts with nonnumeric/out-of-range ports;
        # OPENER.open then raises InvalidURL (not URLError/OSError). Map to 3.
        live["reason"] = "invalid_url"
        live["error"] = type(exc).__name__
        live["authed"] = False
        live["hint"] = (
            "malformed recall URL (nonnumeric or out-of-range port / bad host); "
            "check RUNIR_BASE / RUNIR_RECALL_URL"
        )
        return 3, live
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        live["reason"] = "service_down"
        live["error"] = type(exc).__name__
        live["hint"] = f"service unreachable at {url}"
        return 4, live


def main() -> int:
    args = parse_args()
    if (
        not args.user
        and not args.hooks_file
        and not args.skill
        and not args.launch_agent
    ):
        print(
            "error: pass --user, --hooks-file, --skill, and/or --launch-agent",
            file=sys.stderr,
        )
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

        # PreToolUse deny transport retired — hard error if Rúnir still registered.
        ptu_groups = hooks.get("PreToolUse")
        details["preToolUse"] = ptu_groups
        template_path = root / "templates" / "user-hooks.json"
        details["templatePath"] = str(template_path)
        try:
            template_data = json.loads(template_path.read_text(encoding="utf-8"))
            template_has_ptu = "PreToolUse" in (template_data.get("hooks") or {})
        except (OSError, json.JSONDecodeError, TypeError, AttributeError):
            template_has_ptu = False
        details["templateHasPreToolUse"] = template_has_ptu
        if template_has_ptu:
            errors.append(
                "templates/user-hooks.json still registers PreToolUse "
                "(deny transport must stay retired)"
            )
        if isinstance(ptu_groups, list) and ptu_groups:
            runir_owned = False
            for group in ptu_groups:
                if not isinstance(group, dict):
                    continue
                for hook in group.get("hooks") or []:
                    if not isinstance(hook, dict):
                        continue
                    command = hook.get("command") or ""
                    if "runir-grok.py" in str(command):
                        runir_owned = True
                        break
                if runir_owned:
                    break
            if runir_owned:
                errors.append(
                    "Rúnir PreToolUse still registered after install "
                    "(re-run install_hooks.py --user to prune deny transport)"
                )
            else:
                details["preToolUseForeignOnly"] = True

    if args.skill:
        skills_root = (
            args.skills_root.expanduser().resolve()
            if args.skills_root
            else (Path.home() / ".grok" / "skills")
        )
        skill_errors, skill_detail = verify_skill(root, skills_root)
        details["skill"] = skill_detail
        errors.extend(skill_errors)

    if args.launch_agent:
        agents_dir = (
            args.agents_dir.expanduser().resolve()
            if args.agents_dir
            else (Path.home() / "Library" / "LaunchAgents")
        )
        la_errors, la_detail = verify_launch_agent(
            root,
            agents_dir,
            probe_launchctl=not args.no_launchctl,
        )
        details["launchAgent"] = la_detail
        errors.extend(la_errors)

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
        effective = resolve_live_identity(ups_command, args.env_file)
        api_key, user_id, key_source = resolve_live_credential(
            ups_command, args.env_file
        )
        if effective.source == "conflict" or not effective.user_id:
            # Fail before HTTP when identity is missing or conflicted.
            exit_code, live_detail = live_recall_probe(
                api_key or "",
                user_id,
                key_source,
                effective=effective,
            )
        elif not api_key:
            live_detail = {
                "reason": "no_credential",
                "keySource": key_source,
                "authed": False,
                "hint": "set RUNIR_ENV_FILE via install --env-file, or RUNIR_API_KEY, or --env-file",
            }
            _attach_identity_fields(live_detail, effective=effective)
            exit_code = 3
        else:
            exit_code, live_detail = live_recall_probe(
                api_key, user_id, key_source, effective=effective
            )

    launch_agent_live: dict[str, Any] | None = None
    if args.live and args.launch_agent:
        la_code, launch_agent_live = ollama_residency_probe()
        if exit_code == 0 and la_code != 0:
            exit_code = la_code

    ok = exit_code == 0
    summary = {
        "ok": ok,
        "errors": errors,
        **details,
    }
    if live_detail is not None:
        summary["live"] = live_detail
    if launch_agent_live is not None:
        summary["launchAgentLive"] = launch_agent_live
    print(json.dumps(summary, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
