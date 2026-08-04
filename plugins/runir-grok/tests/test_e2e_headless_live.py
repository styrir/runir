"""Live E2E canary for headless_inject (opt-in: RUNIR_E2E=1).

Requires: running Rúnir, RUNIR_USER_ID, grok on PATH, network.
Never runs in default pytest — skip unless env set.

Hook isolation (mandatory): child grok must NOT load the machine-local
~/.grok/hooks that still point at main-tree runir-grok.py (no kill-switch).
We temp-install the WORKTREE adapter into an isolated GROK_HOME so
RUNIR_GROK_DISABLE_GATE=1 is actually honored by the hook process.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
INJECT = PLUGIN_ROOT / "scripts" / "headless_inject.py"
INSTALL = PLUGIN_ROOT / "scripts" / "install_hooks.py"
LIB = PLUGIN_ROOT / "lib"
HOOK_PY = PLUGIN_ROOT / "hooks" / "runir-grok.py"

LIVE_E2E_SKIP = pytest.mark.skipif(
    os.environ.get("RUNIR_E2E") != "1",
    reason="set RUNIR_E2E=1 for live headless canary",
)


def _warm_embedder() -> None:
    """Best-effort warm of local ollama nomic-embed (cold start ~12s)."""
    try:
        subprocess.run(
            [
                "curl",
                "-sS",
                "-m",
                "30",
                "http://127.0.0.1:11434/api/embeddings",
                "-d",
                json.dumps(
                    {
                        "model": "nomic-embed-text",
                        "prompt": "runir e2e embed warm",
                    }
                ),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=35,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def _install_worktree_hooks(grok_home: Path, env_file: Path | None) -> Path:
    """Temp-install worktree adapter hooks into isolated GROK_HOME/hooks."""
    hooks_dir = grok_home / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    hooks_file = hooks_dir / "runir-grok.json"
    cmd = [
        sys.executable,
        str(INSTALL),
        "--hooks-file",
        str(hooks_file),
        "--plugin-root",
        str(PLUGIN_ROOT),
    ]
    if env_file is not None:
        cmd.extend(["--env-file", str(env_file)])
    else:
        cmd.append("--no-env-file")
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, (
        f"install_hooks failed rc={proc.returncode}\n"
        f"stdout={proc.stdout!r}\nstderr={proc.stderr!r}"
    )
    doc = json.loads(hooks_file.read_text(encoding="utf-8"))
    commands = []
    for groups in (doc.get("hooks") or {}).values():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            for hook in group.get("hooks") or []:
                if isinstance(hook, dict) and isinstance(hook.get("command"), str):
                    commands.append(hook["command"])
    assert commands, "installed hooks document has no commands"
    plugin_marker = str(PLUGIN_ROOT)
    for cmd_s in commands:
        assert plugin_marker in cmd_s, (
            f"hook command not pointing at worktree plugin:\n{cmd_s}"
        )
        assert "runir-grok.py" in cmd_s
    # Prove worktree SoT has the kill-switch the deployed main tree lacks.
    assert "RUNIR_GROK_DISABLE_GATE" in HOOK_PY.read_text(encoding="utf-8")
    return hooks_file


def _seed_isolated_grok_home(tmp: Path) -> Path:
    """Isolated GROK_HOME with auth/config, WITHOUT real memory/hooks.

    Copying auth keeps live grok usable; omitting memory/ avoids native
    first-turn [memory] injection of CANARY_BRIDGE_SMOKE-style facts.
    """
    grok_home = tmp / "grok_home"
    grok_home.mkdir(parents=True, exist_ok=True)
    real = Path.home() / ".grok"
    for name in ("auth.json", "config.toml", "trusted_folders.toml", "agent_id"):
        src = real / name
        if src.is_file():
            shutil.copy2(src, grok_home / name)
    return grok_home


def _configured_capture_url(core) -> str:
    return os.environ.get("RUNIR_CAPTURE_URL", core.DEFAULT_CAPTURE_URL).strip()


def _capture_and_trace_urls(core, *, trace_id: str, user_id: str) -> tuple[str, str]:
    capture_url = _configured_capture_url(core)
    parsed = urlsplit(capture_url)
    assert parsed.scheme and parsed.netloc, (
        f"RUNIR_CAPTURE_URL must be absolute: {capture_url!r}"
    )
    assert parsed.username is None and parsed.password is None, (
        "RUNIR_CAPTURE_URL must not contain embedded credentials"
    )
    assert not parsed.query and not parsed.fragment, (
        "RUNIR_CAPTURE_URL must not contain query or fragment components"
    )
    capture_path = parsed.path
    suffix = "/hooks/capture"
    assert capture_path.endswith(suffix), (
        f"RUNIR_CAPTURE_URL path must end in {suffix}: {capture_url!r}"
    )
    prefix = capture_path[: -len(suffix)]
    trace_path = f"{prefix}/hooks/traces/{quote(trace_id, safe='')}"
    trace_query = f"userId={quote(user_id, safe='')}"
    normalized_capture_url = urlunsplit(
        (parsed.scheme, parsed.netloc, capture_path, "", "")
    )
    trace_url = urlunsplit((parsed.scheme, parsed.netloc, trace_path, trace_query, ""))
    return normalized_capture_url, trace_url


def test_capture_trace_url_preserves_base_path(monkeypatch):
    class Core:
        DEFAULT_CAPTURE_URL = "http://127.0.0.1:7700/hooks/capture"

    monkeypatch.setenv(
        "RUNIR_CAPTURE_URL",
        "https://runir.example.test/base/v1/hooks/capture",
    )
    capture_url, trace_url = _capture_and_trace_urls(
        Core,
        trace_id="trace/with spaces",
        user_id="owner+proof@example.test",
    )
    assert capture_url == "https://runir.example.test/base/v1/hooks/capture"
    assert trace_url == (
        "https://runir.example.test/base/v1/hooks/traces/trace%2Fwith%20spaces"
        "?userId=owner%2Bproof%40example.test"
    )


def test_capture_trace_url_rejects_non_capture_path(monkeypatch):
    class Core:
        DEFAULT_CAPTURE_URL = "http://127.0.0.1:7700/hooks/capture"

    monkeypatch.setenv(
        "RUNIR_CAPTURE_URL",
        "https://runir.example.test/base/v1/hooks/recall",
    )
    with pytest.raises(AssertionError, match="must end in /hooks/capture"):
        _capture_and_trace_urls(Core, trace_id="trace-1", user_id="owner")


def test_capture_trace_url_rejects_embedded_credentials(monkeypatch):
    class Core:
        DEFAULT_CAPTURE_URL = "http://127.0.0.1:7700/hooks/capture"

    monkeypatch.setenv(
        "RUNIR_CAPTURE_URL",
        "https://user:secret@runir.example.test/hooks/capture",
    )
    with pytest.raises(AssertionError, match="must not contain embedded credentials"):
        _capture_and_trace_urls(Core, trace_id="trace-1", user_id="owner")


def test_capture_trace_url_rejects_empty_configured_value(monkeypatch):
    class Core:
        DEFAULT_CAPTURE_URL = "http://127.0.0.1:7700/hooks/capture"

    monkeypatch.setenv("RUNIR_CAPTURE_URL", "")
    with pytest.raises(AssertionError, match="must be absolute"):
        _capture_and_trace_urls(Core, trace_id="trace-1", user_id="owner")


def _read_trace(
    core,
    *,
    trace_id: str,
    user_id: str,
    api_key: str | None,
) -> tuple[dict, str]:
    _capture_url, trace_url = _capture_and_trace_urls(
        core,
        trace_id=trace_id,
        user_id=user_id,
    )
    result = core.get_json(trace_url, timeout=20.0, api_key=api_key)
    assert result, f"trace read failed for {trace_id!r}"
    status, body = result
    assert 200 <= status < 300, f"trace read status={status}: {body!r}"
    trace = body.get("trace")
    assert isinstance(trace, dict), f"trace read missing trace object: {body!r}"
    return trace, trace_url


def _assert_capture_receipt(
    core,
    *,
    result: dict,
    prompt: str,
    user_id: str,
    api_key: str | None,
) -> tuple[dict, str]:
    trace_id = result.get("retrievalTraceId")
    assert trace_id, f"missing retrievalTraceId: {result!r}"
    expected_memory_ids = list(result.get("memoryIds") or [])
    assert expected_memory_ids, f"expected live recall memoryIds: {result!r}"

    trace, trace_url = _read_trace(
        core,
        trace_id=trace_id,
        user_id=user_id,
        api_key=api_key,
    )
    assert trace.get("id") == trace_id, (
        f"trace readback id mismatch: expected {trace_id!r}, got {trace!r}"
    )
    receipt = trace.get("captureReceipt")
    assert isinstance(receipt, dict), f"capture receipt not persisted: {trace!r}"
    assert receipt.get("retrievalTraceId") == trace_id
    assert receipt.get("sessionId") == result.get("sessionId")
    assert receipt.get("memoryIds") == expected_memory_ids
    assert receipt.get("prompt") == prompt
    assert receipt.get("answer") == result.get("text")
    assert trace.get("sessionId") == result.get("sessionId")
    assert trace.get("prompt") == prompt
    assert [item.get("id") for item in trace.get("items") or []] == expected_memory_ids
    return trace, trace_url


def _seed_fact(
    core,
    *,
    messages: list[dict[str, str]],
    user_id: str,
    session_id: str,
    path: str,
    api_key: str | None,
) -> dict:
    capture_url = _configured_capture_url(core)
    normalized_capture_url, _trace_url = _capture_and_trace_urls(
        core,
        trace_id="seed-endpoint-validation",
        user_id=user_id,
    )
    assert capture_url == normalized_capture_url
    result = core.post_json(
        capture_url,
        {
            "messages": messages,
            "userId": user_id,
            "client": core.DEFAULT_CLIENT,
            "sessionId": session_id,
            "path": path,
        },
        60.0,
        api_key=api_key,
    )
    assert result, "seed capture request failed — is Rúnir running?"
    status, body = result
    assert 200 <= status < 300, f"seed capture status={status}: {body!r}"
    assert body.get("skipped") is not True, f"seed capture skipped: {body!r}"
    assert "error" not in body, f"seed capture error: {body!r}"
    assert body.get("factsFound", 0) > 0, f"seed capture extracted no facts: {body!r}"
    return body


def _repo_state() -> tuple[str, str, bool]:
    repo_root = PLUGIN_ROOT.parents[1]
    expected_head = (os.environ.get("RUNIR_E2E_EXPECTED_HEAD") or "").strip()
    assert expected_head, "RUNIR_E2E_EXPECTED_HEAD is required for live E2E"

    head_proc = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert head_proc.returncode == 0, f"git rev-parse failed: {head_proc.stderr!r}"
    head = head_proc.stdout.strip()
    assert head == expected_head, (
        f"repo HEAD mismatch: expected {expected_head!r}, got {head!r}"
    )

    status_proc = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert status_proc.returncode == 0, f"git status failed: {status_proc.stderr!r}"
    clean = not bool(status_proc.stdout)
    assert clean, f"live E2E requires a clean Git worktree: {status_proc.stdout!r}"
    return head, expected_head, clean


def _strict_model_usage_calls(inject, result: dict) -> int:
    usage = result.get("modelUsage")
    assert isinstance(usage, dict), f"live proof requires raw modelUsage: {result!r}"
    total, fields_present = inject.sum_model_usage_calls(usage)
    assert fields_present, f"live proof requires modelUsage modelCalls: {result!r}"
    assert total is not None, f"live proof rejects malformed modelUsage: {result!r}"
    return total


def test_repo_state_requires_expected_head(monkeypatch):
    monkeypatch.delenv("RUNIR_E2E_EXPECTED_HEAD", raising=False)
    with pytest.raises(AssertionError, match="is required"):
        _repo_state()


def test_repo_state_rejects_head_mismatch_before_status(monkeypatch):
    expected_head = "a" * 40
    actual_head = "b" * 40
    monkeypatch.setenv("RUNIR_E2E_EXPECTED_HEAD", expected_head)
    seen = []

    def fake_run(argv, **kwargs):
        seen.append(argv)
        assert argv == ["git", "rev-parse", "HEAD"]
        return subprocess.CompletedProcess(argv, 0, f"{actual_head}\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(AssertionError, match="repo HEAD mismatch"):
        _repo_state()
    assert seen == [["git", "rev-parse", "HEAD"]]


def test_repo_state_requires_clean_worktree_including_untracked(monkeypatch):
    expected_head = "a" * 40
    monkeypatch.setenv("RUNIR_E2E_EXPECTED_HEAD", expected_head)
    seen = []

    def fake_run(argv, **kwargs):
        seen.append(argv)
        if argv == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(argv, 0, f"{expected_head}\n", "")
        assert argv == ["git", "status", "--porcelain"]
        return subprocess.CompletedProcess(argv, 0, "?? live-proof.json\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(AssertionError, match="clean Git worktree"):
        _repo_state()
    assert seen == [
        ["git", "rev-parse", "HEAD"],
        ["git", "status", "--porcelain"],
    ]


def test_repo_state_returns_required_exact_match(monkeypatch):
    expected_head = "b" * 40
    monkeypatch.setenv("RUNIR_E2E_EXPECTED_HEAD", expected_head)

    def fake_run(argv, **kwargs):
        if argv == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(argv, 0, f"{expected_head}\n", "")
        assert argv == ["git", "status", "--porcelain"]
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert _repo_state() == (expected_head, expected_head, True)


def _owner_trace_proof(trace: dict) -> dict:
    receipt = trace["captureReceipt"]
    return {
        "id": trace.get("id"),
        "sessionId": trace.get("sessionId"),
        "prompt": trace.get("prompt"),
        "memoryIds": [item.get("id") for item in trace.get("items") or []],
        "captureReceipt": {
            "retrievalTraceId": receipt.get("retrievalTraceId"),
            "sessionId": receipt.get("sessionId"),
            "memoryIds": receipt.get("memoryIds"),
            "prompt": receipt.get("prompt"),
            "answer": receipt.get("answer"),
        },
    }


def _recall_until_sentinel(
    core,
    *,
    prompt: str,
    sentinel: str,
    user_id: str,
    api_key: str | None,
    path: str,
    attempts: int = 4,
    sleep_s: float = 3.0,
) -> str:
    """Retry recall so cold embedder does not flake memoryInjected=false."""
    last = ""
    for i in range(attempts):
        last = core.recall_context(
            prompt,
            user_id=user_id,
            session_id="",
            path=path,
            api_key=api_key,
            timeout=20.0,
        )
        if sentinel in (last or ""):
            return last
        if i + 1 < attempts:
            time.sleep(sleep_s)
            if i == 0:
                _warm_embedder()
    return last


@LIVE_E2E_SKIP
def test_live_headless_memory_pre_infer_model_calls_one(tmp_path):
    sys.path.insert(0, str(LIB))
    import runir_core as core

    import importlib.util

    inject_spec = importlib.util.spec_from_file_location("runir_e2e_inject", INJECT)
    assert inject_spec and inject_spec.loader
    inject = importlib.util.module_from_spec(inject_spec)
    inject_spec.loader.exec_module(inject)

    user_id = core.resolve_credential("RUNIR_USER_ID")
    assert user_id, "RUNIR_USER_ID required for E2E"
    api_key = core.resolve_credential("RUNIR_API_KEY")
    repo_head, expected_head, worktree_clean = _repo_state()
    configured_capture_url, _unused_trace_url = _capture_and_trace_urls(
        core,
        trace_id="endpoint-validation",
        user_id=user_id,
    )
    env_file_raw = (os.environ.get("RUNIR_ENV_FILE") or "").strip()
    env_file = Path(env_file_raw) if env_file_raw else None
    if env_file is None:
        default_env = Path.home() / "Code" / "runir" / ".env"
        if default_env.is_file():
            env_file = default_env

    sentinel = f"RUNIR-E2E-SENTINEL-{uuid.uuid4().hex[:12]}"
    session_seed = f"e2e-{uuid.uuid4().hex[:8]}"
    canary_path = tmp_path / f"workspace-{uuid.uuid4().hex}"
    canary_path.mkdir()

    # Isolate child grok from machine ~/.grok hooks (main-tree, no kill-switch).
    grok_home = _seed_isolated_grok_home(tmp_path)
    hooks_file = _install_worktree_hooks(grok_home, env_file)
    assert hooks_file.is_file()

    _warm_embedder()

    # Seed distinctive fact via capture — unique token + session tag so retrieval
    # does not prefer an older E2E seed (prior runs leave RUNIR-E2E-SENTINEL-*).
    _seed_fact(
        core,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Rúnir E2E fact store session-tag={session_seed}. "
                    f"The one-time bridge token for session-tag={session_seed} "
                    f"is exactly: {sentinel}. "
                    f"Ignore any other RUNIR-E2E-SENTINEL values."
                ),
            },
            {
                "role": "assistant",
                "content": (
                    f"For session-tag={session_seed} I stored bridge token {sentinel}."
                ),
            },
        ],
        user_id=user_id,
        session_id=session_seed,
        path=str(canary_path),
        api_key=api_key,
    )

    # Retrieval-friendly probe (same shape as inject prompt) — wait for index.
    probe = f"session-tag={session_seed} one-time bridge token RUNIR-E2E-SENTINEL"
    pre = _recall_until_sentinel(
        core,
        prompt=probe,
        sentinel=sentinel,
        user_id=user_id,
        api_key=api_key,
        path=str(canary_path),
        attempts=8,
        sleep_s=2.0,
    )
    assert sentinel in (pre or ""), (
        f"seed not recallable after warm/retry (cold embedder?); last={pre!r}"
    )

    # Keep inject prompt close to the probe so the same vector wins; still
    # disambiguate from native [memory]/MEMORY.md (CANARY_BRIDGE_SMOKE).
    # Tools unused via --max-turns 1.
    prompt = (
        f"session-tag={session_seed} one-time bridge token RUNIR-E2E-SENTINEL. "
        "Answer ONLY from the injected Rúnir recall content block "
        f"(it may start with {core.RECALL_FEEDBACK_PREFIX.splitlines()[0]!r}). "
        "Ignore MEMORY.md, CANARY_BRIDGE_SMOKE, and any other "
        "RUNIR-E2E-SENTINEL tokens not tied to this session-tag. "
        f"What is the exact bridge token for session-tag={session_seed}? "
        "Reply with only that token, nothing else."
    )

    child_env = {
        **os.environ,
        "GROK_HOME": str(grok_home),
        "RUNIR_GROK_DISABLE_GATE": "1",
        # Longer recall budget for parent inject path under cold embedder.
        "RUNIR_RECALL_TIMEOUT": os.environ.get("RUNIR_RECALL_TIMEOUT", "20"),
    }
    # Prefer env-file path inside parent; inject strips it from grok child.
    if env_file is not None and "RUNIR_ENV_FILE" not in child_env:
        child_env["RUNIR_ENV_FILE"] = str(env_file)

    # Fresh turn: inject pre-generates the actual Grok session UUID and passes -s.
    proc = subprocess.run(
        [
            sys.executable,
            str(INJECT),
            "--prompt",
            prompt,
            "--json",
            "--timeout",
            "180",
            "--path",
            str(canary_path),
            "--max-turns",
            "1",
            "--no-memory",
            "--disable-web-search",
        ],
        capture_output=True,
        text=True,
        env=child_env,
        check=False,
        timeout=240,
    )
    assert proc.returncode == 0, (
        f"headless_inject failed rc={proc.returncode}\n"
        f"stdout={proc.stdout!r}\nstderr={proc.stderr!r}\n"
        f"GROK_HOME={grok_home}\nhooks={hooks_file}"
    )
    result = json.loads(proc.stdout)
    fresh_sid = result.get("sessionId")
    assert fresh_sid, "missing verified Grok sessionId"
    assert str(uuid.UUID(fresh_sid)) == fresh_sid, (
        f"fresh sessionId is not a canonical UUID: {result!r}"
    )
    assert "runirSessionId" not in result, (
        f"unexpected session identity alias: {result!r}"
    )
    assert result.get("memoryInjected") is True, (
        f"expected memoryInjected=true, got {result!r}"
    )
    assert result.get("modelCalls") == 1, (
        f"expected modelCalls=1 (no gate re-burn / no tool loop), "
        f"got {result.get('modelCalls')}; full={result!r}"
    )
    assert result.get("modelCallsSource") == "modelUsage", (
        f"live proof requires raw modelUsage source: {result!r}"
    )
    raw_model_calls = _strict_model_usage_calls(inject, result)
    assert raw_model_calls == result["modelCalls"] == 1
    assert result.get("promptBlockOrder") == ["memory", "user"], (
        f"memory must precede user in prompt blocks: {result!r}"
    )
    assert result.get("retrievalTraceId"), (
        f"expected non-empty retrievalTraceId on memory-hit, got {result!r}"
    )
    text = result.get("text") or ""
    assert sentinel in text, (
        f"sentinel not model-visible in assistant text:\n{text!r}\nresult={result!r}"
    )
    assert "warn: capture failed" not in proc.stderr
    fresh_trace, fresh_trace_url = _assert_capture_receipt(
        core,
        result=result,
        prompt=prompt,
        user_id=user_id,
        api_key=api_key,
    )

    # Resume turn: the verified fresh Grok session UUID becomes --resume and the
    # same identity must be returned and used for recall/capture.
    grok_sid = result["sessionId"]
    resume_prompt = (
        f"session-tag={session_seed} one-time bridge token RUNIR-E2E-SENTINEL. "
        "Answer ONLY from the injected Rúnir recall content block. "
        f"What is the exact bridge token for session-tag={session_seed}? "
        "Reply with only that token, nothing else."
    )
    proc2 = subprocess.run(
        [
            sys.executable,
            str(INJECT),
            "--prompt",
            resume_prompt,
            "--json",
            "--timeout",
            "180",
            "--path",
            str(canary_path),
            "--max-turns",
            "1",
            "--no-memory",
            "--disable-web-search",
            "--resume",
            grok_sid,
        ],
        capture_output=True,
        text=True,
        env=child_env,
        check=False,
        timeout=240,
    )
    assert proc2.returncode == 0, (
        f"resume headless_inject failed rc={proc2.returncode}\n"
        f"stdout={proc2.stdout!r}\nstderr={proc2.stderr!r}"
    )
    result2 = json.loads(proc2.stdout)
    assert result2.get("sessionId") == grok_sid, (
        f"resume sessionId mismatch: expected {grok_sid!r}, got {result2!r}"
    )
    assert "runirSessionId" not in result2, (
        f"unexpected resume session identity alias: {result2!r}"
    )
    assert result2.get("memoryInjected") is True, (
        f"resume expected memoryInjected=true, got {result2!r}"
    )
    assert result2.get("modelCalls") == 1, (
        f"resume expected modelCalls=1, got {result2.get('modelCalls')}; full={result2!r}"
    )
    assert result2.get("modelCallsSource") == "modelUsage", (
        f"resume live proof requires raw modelUsage source: {result2!r}"
    )
    raw_resume_model_calls = _strict_model_usage_calls(inject, result2)
    assert raw_resume_model_calls == result2["modelCalls"] == 1
    assert result2.get("promptBlockOrder") == ["memory", "user"], (
        f"resume memory must precede user in prompt blocks: {result2!r}"
    )
    assert result2.get("retrievalTraceId"), (
        f"resume expected non-empty retrievalTraceId, got {result2!r}"
    )
    text2 = result2.get("text") or ""
    assert sentinel in text2, (
        f"resume sentinel not model-visible:\n{text2!r}\nresult={result2!r}"
    )
    assert "warn: capture failed" not in proc2.stderr
    resume_trace, resume_trace_url = _assert_capture_receipt(
        core,
        result=result2,
        prompt=resume_prompt,
        user_id=user_id,
        api_key=api_key,
    )

    proof = {
        "kind": "runir-grok-headless-live-proof",
        "repoHead": repo_head,
        "expectedHead": expected_head,
        "expectedHeadMatched": repo_head == expected_head,
        "trackedWorktreeClean": worktree_clean,
        "configuredCaptureUrl": configured_capture_url,
        "derivedTraceUrls": {
            "fresh": fresh_trace_url,
            "resume": resume_trace_url,
        },
        "apiKeyConfigured": bool(api_key),
        "prompts": {
            "fresh": prompt,
            "resume": resume_prompt,
        },
        "wrapperJson": {
            "fresh": result,
            "resume": result2,
        },
        "ownerScopedTraces": {
            "fresh": _owner_trace_proof(fresh_trace),
            "resume": _owner_trace_proof(resume_trace),
        },
        "modelCallsEvidence": {
            "fresh": {
                "source": result["modelCallsSource"],
                "rawModelUsage": result["modelUsage"],
                "summedModelCalls": raw_model_calls,
            },
            "resume": {
                "source": result2["modelCallsSource"],
                "rawModelUsage": result2["modelUsage"],
                "summedModelCalls": raw_resume_model_calls,
            },
        },
    }
    print(json.dumps(proof, ensure_ascii=False, sort_keys=True), flush=True)
