"""Rúnir-pzt.3: restart-validation kit — validator, redaction, preflight, provenance.

Deterministic self-tests T1–T7. No live Rúnir service. Never assert real canary plaintext.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
RV_DIR = PLUGIN_ROOT / "scripts" / "restart_validation"
LIB = PLUGIN_ROOT / "lib"

# Synthetic fixture canaries only (not production plaintext).
FIXTURE_ANSWERS = {
    "ambient": "nonce-ambient-test",
    "explicit": "nonce-explicit-test",
    "headless": "nonce-headless-test",
}
FIXTURE_HASHES = {
    k: hashlib.sha256(v.encode("utf-8")).hexdigest() for k, v in FIXTURE_ANSWERS.items()
}
FIXTURE_MEMORY_IDS = {
    "ambient": "11111111-1111-1111-1111-111111111111",
    "explicit": "22222222-2222-2222-2222-222222222222",
    "headless": "33333333-3333-3333-3333-333333333333",
}


def _load_rv(name: str):
    """Load restart_validation/<name>.py with a stable module name."""
    path = RV_DIR / f"{name}.py"
    mod_name = f"runir_grok_rv_{name}_ut"
    if mod_name in sys.modules:
        del sys.modules[mod_name]
    # Ensure lib + package dir importable
    for p in (str(LIB), str(RV_DIR)):
        if p not in sys.path:
            sys.path.insert(0, p)
    spec = importlib.util.spec_from_file_location(mod_name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def common():
    return _load_rv("common")


@pytest.fixture
def validate_mod():
    return _load_rv("validate_answer")


@pytest.fixture
def redact_mod():
    return _load_rv("redact")


@pytest.fixture
def preflight_mod():
    return _load_rv("preflight")


@pytest.fixture
def provenance_mod():
    return _load_rv("provenance")


def _write(path: Path, text: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    os.chmod(path, mode)


def _write_json(path: Path, data: dict[str, Any], mode: int = 0o644) -> None:
    _write(path, json.dumps(data, indent=2) + "\n", mode=mode)


def _public_summary(
    kit_dir: Path,
    *,
    owners: dict[str, str] | None = None,
    expected_file: str | None = "expected.json",
    bridge_flags: bool = True,
) -> dict[str, Any]:
    canaries: dict[str, Any] = {}
    for kind in ("ambient", "explicit", "headless"):
        row: dict[str, Any] = {
            "label": f"RUNIR_TEST_{kind.upper()}",
            "memoryId": FIXTURE_MEMORY_IDS[kind],
            "sha256": FIXTURE_HASHES[kind],
            "query": f"value-free-cue-{kind}",
        }
        if owners and kind in owners:
            row["owner"] = owners[kind]
        canaries[kind] = row
    summary: dict[str, Any] = {
        "testId": kit_dir.name,
        "stateDir": str(kit_dir),
        "expectedFile": str(kit_dir / expected_file) if expected_file else None,
        "canaries": canaries,
    }
    if bridge_flags:
        summary["ambientBridgePresent"] = True
        summary["explicitBridgeAbsent"] = True
        summary["headlessBridgeAbsent"] = True
    return summary


def _build_dirty_kit(kit_dir: Path, *, owners: dict[str, str] | None = None) -> None:
    """Reproduce residual failure: body dumps + 0644 attempts + dual expected surface."""
    kit_dir.mkdir(parents=True, exist_ok=True)
    summary = _public_summary(kit_dir, owners=owners, expected_file="expected.json")
    _write_json(kit_dir / "public-summary.json", summary, mode=0o644)

    # Dual expected surface with hash-only content (still dual).
    _write_json(
        kit_dir / "expected.json",
        {
            "testId": kit_dir.name,
            "canaries": summary["canaries"],
            "redacted": False,
            "answer": FIXTURE_ANSWERS["ambient"],  # plaintext-capable leak
        },
        mode=0o600,
    )

    # Body-bearing search dump with long memory field
    long_memory = "SYNTHETIC_MEMORY_BODY_" + ("x" * 400)
    _write_json(
        kit_dir / "headless.search-current.json",
        {
            "results": [
                {
                    "id": FIXTURE_MEMORY_IDS["headless"],
                    "memory": long_memory,
                    "score": 0.9,
                }
            ]
        },
        mode=0o600,
    )
    _write_json(
        kit_dir / "explicit.get-current.json",
        {
            "id": FIXTURE_MEMORY_IDS["explicit"],
            "memory": "SYNTHETIC_GET_" + ("y" * 100),
        },
        mode=0o600,
    )
    _write(
        kit_dir / "headless.recall-diagnostic.txt",
        "diagnostic free text " + ("z" * 200),
        mode=0o600,
    )

    # World-readable attempt streams (repro 0644 residual)
    _write(kit_dir / "explicit.store.attempt-1.stdout", "created-id-aaa\n", mode=0o644)
    _write(kit_dir / "explicit.store.attempt-1.stderr", "", mode=0o644)
    _write(kit_dir / "headless.store.attempt-1.stdout", "created-id-bbb\n", mode=0o644)
    _write(kit_dir / "headless.store.attempt-1.stderr", "", mode=0o644)
    _write_json(
        kit_dir / "headless.validator.json",
        {
            "kind": "headless",
            "pass": False,
            "answerSha256": "0" * 64,
            "expectedSha256": FIXTURE_HASHES["headless"],
        },
        mode=0o644,
    )

    # Blind prompt template (must not be altered by provenance)
    _write(
        kit_dir / "blind-prompt.txt",
        "BLIND_AMBIENT_PROMPT_TEMPLATE_V1\n",
        mode=0o600,
    )


# ---------------------------------------------------------------------------
# T1 — hash-only validator
# ---------------------------------------------------------------------------


def test_validator_pass_fail_hash_only(tmp_path, validate_mod):
    kit = tmp_path / "kit-t1"
    kit.mkdir()
    summary = _public_summary(kit, expected_file=None)
    summary["expectedFile"] = None
    _write_json(kit / "public-summary.json", summary, mode=0o600)

    # Pass
    result = validate_mod.validate(
        "ambient", FIXTURE_ANSWERS["ambient"], FIXTURE_HASHES
    )
    assert result["pass"] is True
    assert result["answerSha256"] == FIXTURE_HASHES["ambient"]
    assert FIXTURE_ANSWERS["ambient"] not in json.dumps(result)

    # Fail
    bad = validate_mod.validate("ambient", "wrong-answer", FIXTURE_HASHES)
    assert bad["pass"] is False
    assert bad["answerSha256"] != FIXTURE_HASHES["ambient"]

    # CLI: pass via answer-file + kit-dir hashes
    answer_file = kit / "ambient.answer.txt"
    answer_file.write_text(FIXTURE_ANSWERS["ambient"] + "\n", encoding="utf-8")
    proc = subprocess.run(
        [
            sys.executable,
            str(RV_DIR / "validate_answer.py"),
            "--kind",
            "ambient",
            "--answer-file",
            str(answer_file),
            "--kit-dir",
            str(kit),
            "--no-frozen-fallback",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["pass"] is True
    assert FIXTURE_ANSWERS["ambient"] not in proc.stdout

    # CLI fail
    proc2 = subprocess.run(
        [
            sys.executable,
            str(RV_DIR / "validate_answer.py"),
            "--kind",
            "ambient",
            "--answer",
            "nope",
            "--kit-dir",
            str(kit),
            "--no-frozen-fallback",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc2.returncode == 1
    assert json.loads(proc2.stdout)["pass"] is False


# ---------------------------------------------------------------------------
# T2 — redact removes body dumps + enforces 0600
# ---------------------------------------------------------------------------


def test_redact_removes_body_dumps_and_enforces_0600(tmp_path, redact_mod, common):
    kit = tmp_path / "kit-t2"
    _build_dirty_kit(
        kit, owners={"ambient": "owner", "explicit": "owner", "headless": "owner"}
    )

    # Confirm dirty preconditions
    assert (kit / "headless.search-current.json").is_file()
    assert common.file_mode(kit / "explicit.store.attempt-1.stdout") == 0o644
    long_blob = (kit / "headless.search-current.json").read_text(encoding="utf-8")
    assert "SYNTHETIC_MEMORY_BODY_" in long_blob

    receipt = redact_mod.redact_kit(kit, dry_run=False, remove_body=True)
    assert receipt["ok"] is True, receipt.get("errors")
    assert receipt["counts"]["removed"] >= 3
    assert receipt["counts"]["chmodFixed"] >= 1

    # Body files gone
    assert not (kit / "headless.search-current.json").exists()
    assert not (kit / "explicit.get-current.json").exists()
    assert not (kit / "headless.recall-diagnostic.txt").exists()
    assert not (kit / "expected.json").exists()

    # No long memory strings remain anywhere in kit
    for path in common.iter_kit_files(kit):
        text = path.read_text(encoding="utf-8", errors="replace")
        assert "SYNTHETIC_MEMORY_BODY_" not in text
        assert FIXTURE_ANSWERS["ambient"] not in text
        mode = common.file_mode(path)
        assert mode == 0o600, f"{path.name} mode={oct(mode)}"

    # public-summary dual surface cleared
    summary = json.loads((kit / "public-summary.json").read_text(encoding="utf-8"))
    assert summary.get("expectedFile") in (None, "")
    assert summary.get("redacted") is True

    # Receipt 0600
    assert common.file_mode(kit / "redact-receipt.json") == 0o600


# ---------------------------------------------------------------------------
# T3 — preflight fails world-readable
# ---------------------------------------------------------------------------


def test_preflight_fails_world_readable(tmp_path, preflight_mod, common):
    kit = tmp_path / "kit-t3"
    _build_dirty_kit(
        kit, owners={"ambient": "owner", "explicit": "owner", "headless": "owner"}
    )

    def fake_recall(prompt, user_id="", **kwargs):
        return SimpleNamespace(memory_ids=[FIXTURE_MEMORY_IDS["headless"]])

    receipt = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={
            "ambient": "owner",
            "explicit": "owner",
            "headless": "owner",
        },
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        skip_bridge=False,
        write_receipt=True,
    )
    assert receipt["ok"] is False
    g4 = receipt["gates"]["G4_permissions"]
    assert g4["ok"] is False
    assert g4.get("error") == "non_owner_only_mode"
    assert any(
        row.get("pathBasename", "").endswith("stdout")
        or row.get("pathBasename", "").endswith("stderr")
        or "validator" in row.get("pathBasename", "")
        for row in g4.get("worldOrGroupReadable") or []
    )


# ---------------------------------------------------------------------------
# T4 — identity mismatch + no invent default
# ---------------------------------------------------------------------------


def test_preflight_fails_identity_mismatch(tmp_path, preflight_mod, monkeypatch):
    kit = tmp_path / "kit-t4"
    # Clean kit modes so G4 doesn't dominate
    _build_dirty_kit(
        kit, owners={"ambient": "brooks", "explicit": "brooks", "headless": "brooks"}
    )
    for p in kit.rglob("*"):
        if p.is_file():
            os.chmod(p, 0o600)

    def fake_recall(prompt, user_id="", **kwargs):
        return SimpleNamespace(memory_ids=[FIXTURE_MEMORY_IDS["headless"]])

    # Effective runtime id owner, canaries owned by brooks → G2 fail
    receipt = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={
            "ambient": "brooks",
            "explicit": "brooks",
            "headless": "brooks",
        },
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        write_receipt=True,
    )
    assert receipt["ok"] is False
    g2 = receipt["gates"]["G2_canary_ownership"]
    assert g2["ok"] is False
    assert g2.get("error") == "canary_owner_mismatch"
    assert g2.get("mismatches")

    # G1: unset identity → fail, never invent
    monkeypatch.delenv("RUNIR_USER_ID", raising=False)
    monkeypatch.delenv("RUNIR_ENV_FILE", raising=False)
    receipt2 = preflight_mod.run_preflight(
        kit,
        effective_user_id=None,
        identity_source=None,
        canary_owners={"ambient": "brooks"},
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        skip_recall=True,
        write_receipt=False,
        env={},
    )
    assert receipt2["ok"] is False
    g1 = receipt2["gates"]["G1_identity"]
    assert g1["ok"] is False
    assert g1.get("error") == "missing_user_id"
    assert receipt2.get("effectiveUserIdLength") == 0


# ---------------------------------------------------------------------------
# T5 — requires /hooks/recall selection, not get/search
# ---------------------------------------------------------------------------


def test_preflight_requires_hooks_recall_not_get_search(tmp_path, preflight_mod):
    kit = tmp_path / "kit-t5"
    _build_dirty_kit(
        kit, owners={"ambient": "owner", "explicit": "owner", "headless": "owner"}
    )
    for p in kit.rglob("*"):
        if p.is_file():
            os.chmod(p, 0o600)

    # Simulate: get/search would succeed (files present with body), but recall empty
    def recall_miss(prompt, user_id="", **kwargs):
        return SimpleNamespace(memory_ids=[])

    receipt = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={
            "ambient": "owner",
            "explicit": "owner",
            "headless": "owner",
        },
        cue="value-free-cue-headless",
        recall_fn=recall_miss,
        write_receipt=True,
    )
    assert receipt["ok"] is False
    g3 = receipt["gates"]["G3_hooks_recall"]
    assert g3["ok"] is False
    assert g3.get("recallPath") == "POST /hooks/recall"
    assert g3.get("error") == "expected_memory_not_selected"

    # Recall returns expected id → G3 pass (other gates may still fail on residual body)
    def recall_hit(prompt, user_id="", **kwargs):
        return SimpleNamespace(memory_ids=[FIXTURE_MEMORY_IDS["headless"], "other"])

    receipt2 = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={
            "ambient": "owner",
            "explicit": "owner",
            "headless": "owner",
        },
        cue="value-free-cue-headless",
        recall_fn=recall_hit,
        write_receipt=True,
    )
    assert receipt2["gates"]["G3_hooks_recall"]["ok"] is True
    assert receipt2["gates"]["G3_hooks_recall"]["selectedHasExpected"] is True


# ---------------------------------------------------------------------------
# M1 regression — skip_recall must never overall-pass / exit 0
# ---------------------------------------------------------------------------


def _clean_kit_for_preflight(
    kit_dir: Path,
    *,
    owners: dict[str, str] | None = None,
) -> None:
    """Hash-only kit at 0600 with dual-surface cleared so only intentional gates fail."""
    kit_dir.mkdir(parents=True, exist_ok=True)
    summary = _public_summary(
        kit_dir,
        owners=owners
        or {"ambient": "owner", "explicit": "owner", "headless": "owner"},
        expected_file=None,
    )
    summary["expectedFile"] = None
    summary["redacted"] = True
    _write_json(kit_dir / "public-summary.json", summary, mode=0o600)
    _write(kit_dir / "blind-prompt.txt", "BLIND_PROMPT\n", mode=0o600)


def test_skip_recall_never_overall_pass(tmp_path, preflight_mod, common):
    """M1: skip_recall=True / --skip-recall must not green preflight without recall."""
    kit = tmp_path / "kit-m1"
    _clean_kit_for_preflight(kit)

    def fake_recall(prompt, user_id="", **kwargs):
        # Would satisfy G3 if called — skip must still fail overall.
        return SimpleNamespace(memory_ids=[FIXTURE_MEMORY_IDS["headless"]])

    receipt = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={
            "ambient": "owner",
            "explicit": "owner",
            "headless": "owner",
        },
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        skip_recall=True,
        write_receipt=True,
    )
    assert receipt["ok"] is False
    g3 = receipt["gates"]["G3_hooks_recall"]
    assert g3["ok"] is False
    assert g3.get("skipped") is True
    assert g3.get("error") == "recall_skipped"
    assert g3.get("recallPath") == "POST /hooks/recall"
    assert any("recall_skipped" in e for e in receipt.get("errors") or [])
    # Other gates that can pass must not be enough for overall green
    assert receipt["gates"]["G1_identity"]["ok"] is True
    assert receipt["gates"]["G2_canary_ownership"]["ok"] is True

    # CLI: --skip-recall → exit != 0 and ok:false
    proc = subprocess.run(
        [
            sys.executable,
            str(RV_DIR / "preflight.py"),
            "--kit-dir",
            str(kit),
            "--effective-user-id",
            "owner",
            "--cue",
            "value-free-cue-headless",
            "--skip-recall",
            "--no-write",
        ],
        capture_output=True,
        text=True,
        check=False,
        env={
            **os.environ,
            "RUNIR_USER_ID": "owner",
        },
    )
    assert proc.returncode != 0, proc.stdout
    out = json.loads(proc.stdout)
    assert out["ok"] is False
    assert out["gates"]["G3_hooks_recall"]["ok"] is False
    assert out["gates"]["G3_hooks_recall"].get("skipped") is True


# ---------------------------------------------------------------------------
# M2 regression — partial canary owner map must fail G2
# ---------------------------------------------------------------------------


def test_partial_canary_owner_map_fails_g2(tmp_path, preflight_mod):
    """M2: every public-summary canary needs owner matching effective identity."""
    kit = tmp_path / "kit-m2"
    # Summary lists ambient+explicit+headless; owners omit explicit.
    partial_summary_owners = {"ambient": "owner", "headless": "owner"}
    _clean_kit_for_preflight(kit, owners=partial_summary_owners)

    def fake_recall(prompt, user_id="", **kwargs):
        return SimpleNamespace(memory_ids=[FIXTURE_MEMORY_IDS["headless"]])

    # Owners loaded from public-summary only (explicit missing)
    receipt = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners=None,  # load from summary
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        write_receipt=True,
    )
    assert receipt["ok"] is False
    g2 = receipt["gates"]["G2_canary_ownership"]
    assert g2["ok"] is False
    assert g2.get("error") == "missing_canary_owner"
    missing = g2.get("missingOwners") or []
    assert any(row.get("kind") == "explicit" for row in missing)

    # Explicit override map that is still partial must also fail
    receipt2 = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={"ambient": "owner", "headless": "owner"},
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        write_receipt=False,
    )
    assert receipt2["ok"] is False
    g2b = receipt2["gates"]["G2_canary_ownership"]
    assert g2b["ok"] is False
    assert g2b.get("error") == "missing_canary_owner"
    assert any(
        row.get("kind") == "explicit" for row in (g2b.get("missingOwners") or [])
    )

    # Full matching map → G2 pass (other gates may still run)
    receipt3 = preflight_mod.run_preflight(
        kit,
        effective_user_id="owner",
        identity_source="override",
        canary_owners={
            "ambient": "owner",
            "explicit": "owner",
            "headless": "owner",
        },
        cue="value-free-cue-headless",
        recall_fn=fake_recall,
        write_receipt=False,
    )
    assert receipt3["gates"]["G2_canary_ownership"]["ok"] is True
    assert receipt3["gates"]["G2_canary_ownership"].get("error") is None


# ---------------------------------------------------------------------------
# T6 — provenance sidecar without blind contamination
# ---------------------------------------------------------------------------


def test_provenance_sidecar_no_blind_contamination(tmp_path, provenance_mod, common):
    kit = tmp_path / "kit-t6"
    kit.mkdir()
    blind = kit / "blind-prompt.txt"
    blind_text = "BLIND_FIRST_PROMPT_DO_NOT_TOUCH\n"
    blind.write_text(blind_text, encoding="utf-8")
    os.chmod(blind, 0o600)
    before = common.content_sha256(blind.read_bytes())

    data = provenance_mod.update_provenance(
        kit,
        launch_method="fresh_quit_relaunch",
        grok_session_id="sess-abc-123",
        first_prompt_is_blind_ambient=True,
        blind_prompt_ordinal=1,
        recorded_by="operator",
    )
    assert data["launchMethod"] == "fresh_quit_relaunch"
    assert data.get("grokSessionDigest")
    assert data["firstPromptIsBlindAmbient"] is True
    assert data["blindPromptOrdinal"] == 1
    assert data["ambientGateProtocolValid"] is True
    assert data["contaminatesBlindPrompt"] is False

    # Blind prompt unchanged
    assert blind.read_text(encoding="utf-8") == blind_text
    assert common.content_sha256(blind.read_bytes()) == before

    # CLI --set path
    proc = subprocess.run(
        [
            sys.executable,
            str(RV_DIR / "provenance.py"),
            "--kit-dir",
            str(kit),
            "--set",
            "launchMethod=slash_new",
            "--set",
            "blindPromptOrdinal=2",
            "--set",
            "firstPromptIsBlindAmbient=false",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["launchMethod"] == "slash_new"
    assert out["blindPromptOrdinal"] == 2
    assert out.get("ambientGateProtocolValid") is False
    assert blind.read_text(encoding="utf-8") == blind_text
    assert common.file_mode(kit / "provenance.json") == 0o600


# ---------------------------------------------------------------------------
# T7 — public surface is hash-only after redact
# ---------------------------------------------------------------------------


def test_public_surface_is_hash_only(tmp_path, redact_mod, common):
    kit = tmp_path / "kit-t7"
    _build_dirty_kit(
        kit, owners={"ambient": "owner", "explicit": "owner", "headless": "owner"}
    )
    receipt = redact_mod.redact_kit(kit, dry_run=False, remove_body=True)
    assert receipt["ok"] is True, receipt.get("errors")

    # Shareable files: only allowlist names that remain
    public_files = [
        p for p in common.iter_kit_files(kit) if p.name in common.PUBLIC_ALLOWLIST
    ]
    assert any(p.name == "public-summary.json" for p in public_files)

    for path in public_files:
        text = path.read_text(encoding="utf-8", errors="replace")
        # No synthetic canary plaintext
        for plain in FIXTURE_ANSWERS.values():
            assert plain not in text
        assert "SYNTHETIC_MEMORY_BODY_" not in text
        # JSON public files should parse and avoid answer-like keys
        if path.suffix == ".json":
            data = json.loads(text)
            blob = json.dumps(data)
            assert '"answer"' not in blob or data.get("redacted") is True
            if path.name == "public-summary.json":
                assert data.get("expectedFile") in (None, "")
                for kind, row in data.get("canaries", {}).items():
                    assert "sha256" in row
                    assert "memoryId" in row
                    assert "label" in row
                    assert "answer" not in row
                    assert "memory" not in row

    # expected.json dual surface gone
    assert not (kit / "expected.json").exists()
