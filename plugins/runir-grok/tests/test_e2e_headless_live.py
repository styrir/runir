"""Live E2E canary for headless_inject (opt-in: RUNIR_E2E=1).

Requires: running Rúnir, RUNIR_USER_ID, grok on PATH, network.
Never runs in default pytest — skip unless env set.

Hook isolation (mandatory): child grok must NOT load the machine-local
~/.grok/hooks that still point at main-tree runir-grok.py (no kill-switch).
We temp-install the WORKTREE adapter into an isolated GROK_HOME so
RUNIR_GROK_DISABLE_GATE=1 is actually honored by the hook process.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
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
    assert 200 <= status < 300, (
        f"trace read status={status}: body_keys="
        f"{sorted(body.keys()) if isinstance(body, dict) else type(body).__name__}"
    )
    trace = body.get("trace") if isinstance(body, dict) else None
    assert isinstance(trace, dict), (
        f"trace read missing trace object: body_keys="
        f"{sorted(body.keys()) if isinstance(body, dict) else type(body).__name__}"
    )
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
    assert trace_id, f"missing retrievalTraceId: {_result_diag(result)}"
    expected_memory_ids = list(result.get("memoryIds") or [])
    assert expected_memory_ids, f"expected live recall memoryIds: {_result_diag(result)}"

    trace, trace_url = _read_trace(
        core,
        trace_id=trace_id,
        user_id=user_id,
        api_key=api_key,
    )
    assert trace.get("id") == trace_id, (
        f"trace readback id mismatch: expected {trace_id!r}, "
        f"got id={trace.get('id')!r}"
    )
    receipt = trace.get("captureReceipt")
    assert isinstance(receipt, dict), (
        f"capture receipt not persisted: keys={sorted(trace.keys())!r}"
    )
    assert receipt.get("retrievalTraceId") == trace_id
    assert receipt.get("sessionId") == result.get("sessionId")
    assert receipt.get("memoryIds") == expected_memory_ids
    # Use pytest.fail helpers so assertion rewriting cannot dump bodies.
    _assert_text_equal_redacted(
        receipt.get("prompt"), prompt, label="receipt.prompt"
    )
    _assert_text_equal_redacted(
        receipt.get("answer"), result.get("text"), label="receipt.answer"
    )
    assert trace.get("sessionId") == result.get("sessionId")
    _assert_text_equal_redacted(
        trace.get("prompt"), prompt, label="trace.prompt"
    )
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
    body_diag = (
        {
            "keys": sorted(body.keys()),
            "skipped": body.get("skipped"),
            "factsFound": body.get("factsFound"),
            "hasError": "error" in body,
        }
        if isinstance(body, dict)
        else {"type": type(body).__name__}
    )
    assert 200 <= status < 300, f"seed capture status={status}: {body_diag}"
    assert body.get("skipped") is not True, f"seed capture skipped: {body_diag}"
    assert "error" not in body, f"seed capture error: {body_diag}"
    assert body.get("factsFound", 0) > 0, f"seed capture extracted no facts: {body_diag}"
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
        ["git", "status", "--porcelain", "--untracked-files=all"],
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
    assert isinstance(usage, dict), (
        f"live proof requires raw modelUsage: {_result_diag(result)}"
    )
    total, fields_present = inject.sum_model_usage_calls(usage)
    assert fields_present, (
        f"live proof requires modelUsage modelCalls: {_result_diag(result)}"
    )
    assert total is not None, (
        f"live proof rejects malformed modelUsage: {_result_diag(result)}"
    )
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
        assert argv == [
            "git",
            "status",
            "--porcelain",
            "--untracked-files=all",
        ]
        return subprocess.CompletedProcess(argv, 0, "?? live-proof.json\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(AssertionError, match="clean Git worktree"):
        _repo_state()
    assert seen == [
        ["git", "rev-parse", "HEAD"],
        ["git", "status", "--porcelain", "--untracked-files=all"],
    ]


def test_repo_state_returns_required_exact_match(monkeypatch):
    expected_head = "b" * 40
    monkeypatch.setenv("RUNIR_E2E_EXPECTED_HEAD", expected_head)

    def fake_run(argv, **kwargs):
        if argv == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(argv, 0, f"{expected_head}\n", "")
        assert argv == [
            "git",
            "status",
            "--porcelain",
            "--untracked-files=all",
        ]
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert _repo_state() == (expected_head, expected_head, True)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _text_digest_meta(value: str | None) -> dict[str, Any]:
    """Hash-only view of a sensitive string (no plaintext body)."""
    text = value if isinstance(value, str) else ""
    return {
        "sha256": _sha256_text(text),
        "length": len(text),
        "nonEmpty": bool(text),
    }


def _owner_trace_proof(trace: dict) -> dict:
    """Owner-scoped receipt evidence: digests/lengths/ids only (no bodies)."""
    receipt = trace["captureReceipt"]
    return {
        "id": trace.get("id"),
        "sessionId": trace.get("sessionId"),
        "prompt": _text_digest_meta(trace.get("prompt")),
        "memoryIds": [item.get("id") for item in trace.get("items") or []],
        "captureReceipt": {
            "retrievalTraceId": receipt.get("retrievalTraceId"),
            "sessionId": receipt.get("sessionId"),
            "memoryIds": receipt.get("memoryIds"),
            "prompt": _text_digest_meta(receipt.get("prompt")),
            "answer": _text_digest_meta(receipt.get("answer")),
        },
    }


def _wrapper_json_proof(result: dict) -> dict[str, Any]:
    """Serialize inject wrapper fields without assistant text / prompt bodies."""
    return {
        "sessionId": result.get("sessionId"),
        "retrievalTraceId": result.get("retrievalTraceId"),
        "memoryIds": list(result.get("memoryIds") or []),
        "memoryInjected": result.get("memoryInjected"),
        "modelCalls": result.get("modelCalls"),
        "modelCallsSource": result.get("modelCallsSource"),
        "promptBlockOrder": result.get("promptBlockOrder"),
        "answer": _text_digest_meta(result.get("text")),
    }


def _redact_url_query(url: str) -> str:
    """Drop query/fragment (e.g. userId) from proof URLs."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _model_usage_proof(usage: object) -> dict[str, Any]:
    """Numeric-only modelUsage summary (no free-text keys or nested strings).

    Untrusted Grok payloads may carry extra string fields; never serialize them.
    Model ids are reduced to short digests; only non-negative modelCalls ints
    are retained.
    """
    if not isinstance(usage, dict):
        return {
            "present": False,
            "modelCount": 0,
            "summedModelCalls": 0,
            "entries": [],
        }
    entries: list[dict[str, Any]] = []
    total = 0
    for key, row in usage.items():
        if not isinstance(row, dict):
            continue
        value = row.get("modelCalls")
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            continue
        key_text = key if isinstance(key, str) else ""
        entries.append(
            {
                "modelKeySha256_12": _sha256_text(key_text)[:12],
                "modelCalls": value,
            }
        )
        total += value
    entries.sort(key=lambda item: (item["modelKeySha256_12"], item["modelCalls"]))
    return {
        "present": True,
        "modelCount": len(entries),
        "summedModelCalls": total,
        "entries": entries,
    }


def _process_stdout_diag(stdout: str) -> dict[str, Any]:
    """Hash-only view of inject stdout (JSON wrapper or opaque blob)."""
    try:
        parsed = json.loads(stdout)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {"kind": "opaque", **_text_digest_meta(stdout)}
    if isinstance(parsed, dict):
        return {"kind": "wrapper", **_wrapper_json_proof(parsed)}
    return {"kind": "opaque", **_text_digest_meta(stdout)}


def _result_diag(result: dict) -> str:
    """Stable hash-only diagnostic for assertion messages (no bodies)."""
    return _serialize_live_proof(_wrapper_json_proof(result))


def _serialize_live_proof(proof: dict) -> str:
    """Canonical proof JSON (same shape as pytest -s stdout dump)."""
    return json.dumps(proof, ensure_ascii=False, sort_keys=True)


def _assert_proof_has_no_plaintext(serialized: str, forbidden: list[str]) -> None:
    """Fail closed without pytest rewrite dumping the forbidden bodies."""
    samples = [s for s in forbidden if isinstance(s, str) and s]
    if not samples:
        pytest.fail("forbidden samples must include at least one non-empty string")
    for sample in samples:
        if sample in serialized:
            # Digest-only message: do not interpolate sample or serialized body.
            pytest.fail(
                "live proof serialization must not contain plaintext canary bodies "
                f"(sample={_text_digest_meta(sample)}; "
                f"serialized={_text_digest_meta(serialized)})"
            )


def _assert_text_equal_redacted(actual: object, expected: object, *, label: str) -> None:
    """Equality without pytest assertion-rewrite dumping plaintext operands."""
    if actual != expected:
        pytest.fail(
            f"{label} mismatch: actual={_text_digest_meta(actual if isinstance(actual, str) else '')} "
            f"expected={_text_digest_meta(expected if isinstance(expected, str) else '')}"
        )


def _assert_contains_redacted(haystack: object, needle: str, *, label: str) -> None:
    """Membership check without dumping haystack plaintext on failure."""
    text = haystack if isinstance(haystack, str) else ""
    if needle not in text:
        pytest.fail(f"{label}: needle absent; haystack={_text_digest_meta(text)}")


def test_live_proof_serialization_is_hash_only_no_plaintext():
    """Regression: serialized proof excludes prompt/answer bodies (M1).

    Fail-before-fix class: a proof that embeds raw prompt/answer text must
    not pass the no-plaintext guard. Digests/lengths/booleans/ids remain.
    """
    secret_prompt = "RUNIR-E2E-PLAINTEXT-PROMPT-TOKEN-do-not-emit"
    secret_answer = "RUNIR-E2E-PLAINTEXT-ANSWER-TOKEN-do-not-emit"
    secret_resume = "RUNIR-E2E-PLAINTEXT-RESUME-PROMPT-TOKEN-do-not-emit"
    session_id = "11111111-2222-4333-8444-555555555555"
    trace_id = "trace-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    memory_ids = ["d954cd50-0000-4000-8000-000000000001"]

    bad_proof = {
        "kind": "runir-grok-headless-live-proof",
        "prompts": {"fresh": secret_prompt, "resume": secret_resume},
        "wrapperJson": {
            "fresh": {"sessionId": session_id, "text": secret_answer},
        },
        "ownerScopedTraces": {
            "fresh": {
                "prompt": secret_prompt,
                "captureReceipt": {
                    "prompt": secret_prompt,
                    "answer": secret_answer,
                },
            },
        },
    }
    bad_serialized = _serialize_live_proof(bad_proof)
    with pytest.raises(pytest.fail.Exception, match="must not contain plaintext") as excinfo:
        _assert_proof_has_no_plaintext(
            bad_serialized,
            [secret_prompt, secret_answer, secret_resume],
        )
    # Guard failure message itself must stay hash-only (no rewrite operands).
    fail_msg = str(excinfo.value)
    for secret in (secret_prompt, secret_answer, secret_resume, bad_serialized):
        assert secret not in fail_msg
    assert "sha256" in fail_msg

    safe_proof = {
        "kind": "runir-grok-headless-live-proof",
        "repoHead": "a" * 40,
        "expectedHead": "a" * 40,
        "expectedHeadMatched": True,
        "trackedWorktreeClean": True,
        "apiKeyConfigured": True,
        "prompts": {
            "fresh": _text_digest_meta(secret_prompt),
            "resume": _text_digest_meta(secret_resume),
        },
        "wrapperJson": {
            "fresh": _wrapper_json_proof(
                {
                    "sessionId": session_id,
                    "retrievalTraceId": trace_id,
                    "memoryIds": memory_ids,
                    "memoryInjected": True,
                    "modelCalls": 1,
                    "modelCallsSource": "modelUsage",
                    "promptBlockOrder": ["memory", "user"],
                    "text": secret_answer,
                }
            ),
        },
        "ownerScopedTraces": {
            "fresh": _owner_trace_proof(
                {
                    "id": trace_id,
                    "sessionId": session_id,
                    "prompt": secret_prompt,
                    "items": [{"id": memory_ids[0]}],
                    "captureReceipt": {
                        "retrievalTraceId": trace_id,
                        "sessionId": session_id,
                        "memoryIds": memory_ids,
                        "prompt": secret_prompt,
                        "answer": secret_answer,
                    },
                }
            ),
        },
    }
    serialized = _serialize_live_proof(safe_proof)
    _assert_proof_has_no_plaintext(
        serialized,
        [secret_prompt, secret_answer, secret_resume],
    )
    parsed = json.loads(serialized)
    assert parsed["prompts"]["fresh"] == _text_digest_meta(secret_prompt)
    assert parsed["wrapperJson"]["fresh"]["answer"] == _text_digest_meta(secret_answer)
    assert "text" not in parsed["wrapperJson"]["fresh"]
    assert isinstance(parsed["prompts"]["fresh"]["sha256"], str)
    assert parsed["prompts"]["fresh"]["length"] == len(secret_prompt)
    assert parsed["prompts"]["fresh"]["nonEmpty"] is True
    assert parsed["ownerScopedTraces"]["fresh"]["id"] == trace_id
    assert parsed["ownerScopedTraces"]["fresh"]["memoryIds"] == memory_ids
    # Digests must match independent recomputation (not empty stubs).
    assert parsed["prompts"]["fresh"]["sha256"] == _sha256_text(secret_prompt)
    assert parsed["wrapperJson"]["fresh"]["answer"]["sha256"] == _sha256_text(
        secret_answer
    )
    # Query strings (owner userId) must not ride along on proof URLs.
    owner_email = "owner+proof@example.test"
    dirty_url = (
        "http://127.0.0.1:7700/hooks/traces/trace-1"
        f"?userId={quote(owner_email, safe='')}"
    )
    assert owner_email not in _redact_url_query(dirty_url)
    assert "?" not in _redact_url_query(dirty_url)
    assert _redact_url_query(dirty_url).endswith("/hooks/traces/trace-1")
    # Untrusted modelUsage extras / free-text keys must not ride into proof.
    sneaky = "RUNIR-E2E-MODELUSAGE-PLAINTEXT-do-not-emit"
    dirty_usage = {
        "grok-4": {
            "modelCalls": 1,
            "promptPreview": sneaky,
            "notes": sneaky,
        },
        sneaky: {"modelCalls": 2},
    }
    usage_proof = _model_usage_proof(dirty_usage)
    usage_serialized = _serialize_live_proof(
        {
            "modelCallsEvidence": {
                "fresh": {
                    "source": "modelUsage",
                    "modelUsage": usage_proof,
                    "summedModelCalls": 1,
                }
            }
        }
    )
    assert sneaky not in usage_serialized
    assert "promptPreview" not in usage_serialized
    assert "notes" not in usage_serialized
    assert "grok-4" not in usage_serialized  # model ids not printed
    assert usage_proof["present"] is True
    assert usage_proof["modelCount"] == 2
    assert usage_proof["summedModelCalls"] == 3
    assert {e["modelCalls"] for e in usage_proof["entries"]} == {1, 2}
    for entry in usage_proof["entries"]:
        assert set(entry.keys()) == {"modelKeySha256_12", "modelCalls"}
        assert len(entry["modelKeySha256_12"]) == 12


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
    """Retry recall so cold embedder does not flake memoryInjected=false.

    Uses the headless inject shape: preferredClient + same workspace path
    (receipt identity footprint). Never logs prompt/context plaintext.
    """
    last = ""
    for i in range(attempts):
        last = core.recall_context(
            prompt,
            user_id=user_id,
            session_id="",
            path=path,
            api_key=api_key,
            client=None,
            preferred_client=core.DEFAULT_CLIENT,
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
    _assert_contains_redacted(
        pre,
        sentinel,
        label="seed not recallable after warm/retry (cold embedder?)",
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
        f"stdout={_process_stdout_diag(proc.stdout)}\n"
        f"stderr={_text_digest_meta(proc.stderr)}\n"
        f"GROK_HOME={grok_home}\nhooks={hooks_file}"
    )
    result = json.loads(proc.stdout)
    fresh_sid = result.get("sessionId")
    assert fresh_sid, "missing verified Grok sessionId"
    assert str(uuid.UUID(fresh_sid)) == fresh_sid, (
        f"fresh sessionId is not a canonical UUID: {_result_diag(result)}"
    )
    assert "runirSessionId" not in result, (
        f"unexpected session identity alias: {_result_diag(result)}"
    )
    assert result.get("memoryInjected") is True, (
        f"expected memoryInjected=true, got {_result_diag(result)}"
    )
    assert result.get("modelCalls") == 1, (
        f"expected modelCalls=1 (no gate re-burn / no tool loop), "
        f"got {result.get('modelCalls')}; diag={_result_diag(result)}"
    )
    assert result.get("modelCallsSource") == "modelUsage", (
        f"live proof requires raw modelUsage source: {_result_diag(result)}"
    )
    raw_model_calls = _strict_model_usage_calls(inject, result)
    assert raw_model_calls == result["modelCalls"] == 1
    assert result.get("promptBlockOrder") == ["memory", "user"], (
        f"memory must precede user in prompt blocks: {_result_diag(result)}"
    )
    assert result.get("retrievalTraceId"), (
        f"expected non-empty retrievalTraceId on memory-hit, "
        f"got {_result_diag(result)}"
    )
    text = result.get("text") or ""
    _assert_contains_redacted(
        text,
        sentinel,
        label="sentinel not model-visible in assistant text "
        f"(result={_result_diag(result)})",
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
        f"stdout={_process_stdout_diag(proc2.stdout)}\n"
        f"stderr={_text_digest_meta(proc2.stderr)}"
    )
    result2 = json.loads(proc2.stdout)
    assert result2.get("sessionId") == grok_sid, (
        f"resume sessionId mismatch: expected {grok_sid!r}, "
        f"got {_result_diag(result2)}"
    )
    assert "runirSessionId" not in result2, (
        f"unexpected resume session identity alias: {_result_diag(result2)}"
    )
    assert result2.get("memoryInjected") is True, (
        f"resume expected memoryInjected=true, got {_result_diag(result2)}"
    )
    assert result2.get("modelCalls") == 1, (
        f"resume expected modelCalls=1, got {result2.get('modelCalls')}; "
        f"diag={_result_diag(result2)}"
    )
    assert result2.get("modelCallsSource") == "modelUsage", (
        f"resume live proof requires raw modelUsage source: "
        f"{_result_diag(result2)}"
    )
    raw_resume_model_calls = _strict_model_usage_calls(inject, result2)
    assert raw_resume_model_calls == result2["modelCalls"] == 1
    assert result2.get("promptBlockOrder") == ["memory", "user"], (
        f"resume memory must precede user in prompt blocks: "
        f"{_result_diag(result2)}"
    )
    assert result2.get("retrievalTraceId"), (
        f"resume expected non-empty retrievalTraceId, got "
        f"{_result_diag(result2)}"
    )
    text2 = result2.get("text") or ""
    _assert_contains_redacted(
        text2,
        sentinel,
        label="resume sentinel not model-visible "
        f"(result={_result_diag(result2)})",
    )
    assert "warn: capture failed" not in proc2.stderr
    resume_trace, resume_trace_url = _assert_capture_receipt(
        core,
        result=result2,
        prompt=resume_prompt,
        user_id=user_id,
        api_key=api_key,
    )

    # Hash-only proof for pytest -s / CI logs: digests, lengths, booleans, and
    # non-sensitive ids only. Never emit prompt, answer, or recall context bodies.
    proof = {
        "kind": "runir-grok-headless-live-proof",
        "secrecy": "hash-only",
        "repoHead": repo_head,
        "expectedHead": expected_head,
        "expectedHeadMatched": repo_head == expected_head,
        "trackedWorktreeClean": worktree_clean,
        "configuredCaptureUrl": _redact_url_query(configured_capture_url),
        "derivedTraceUrls": {
            # Path-only: strip ?userId=… identity query from proof URLs.
            "fresh": _redact_url_query(fresh_trace_url),
            "resume": _redact_url_query(resume_trace_url),
        },
        "apiKeyConfigured": bool(api_key),
        "prompts": {
            "fresh": _text_digest_meta(prompt),
            "resume": _text_digest_meta(resume_prompt),
        },
        "wrapperJson": {
            "fresh": _wrapper_json_proof(result),
            "resume": _wrapper_json_proof(result2),
        },
        "ownerScopedTraces": {
            "fresh": _owner_trace_proof(fresh_trace),
            "resume": _owner_trace_proof(resume_trace),
        },
        "modelCallsEvidence": {
            "fresh": {
                "source": result["modelCallsSource"],
                "modelUsage": _model_usage_proof(result.get("modelUsage")),
                "summedModelCalls": raw_model_calls,
            },
            "resume": {
                "source": result2["modelCallsSource"],
                "modelUsage": _model_usage_proof(result2.get("modelUsage")),
                "summedModelCalls": raw_resume_model_calls,
            },
        },
        "sentinelMatched": {
            "fresh": sentinel in (result.get("text") or ""),
            "resume": sentinel in (result2.get("text") or ""),
        },
    }
    serialized = _serialize_live_proof(proof)
    _assert_proof_has_no_plaintext(
        serialized,
        [
            prompt,
            resume_prompt,
            result.get("text") or "",
            result2.get("text") or "",
            sentinel,
            # Seed/context bodies that must never appear in the printed proof.
            f"The one-time bridge token for session-tag={session_seed}",
        ],
    )
    print(serialized, flush=True)
