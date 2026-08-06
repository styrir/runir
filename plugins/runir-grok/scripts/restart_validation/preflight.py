#!/usr/bin/env python3
"""Preflight gates for Grok restart-validation kits (G1–G6).

G1 Identity resolved via core.resolve_credential order (no invented userId)
G2 Canary ownership matches effective runtime identity
G3 Headless POST /hooks/recall selects expected memoryId (get/search insufficient)
G4 Kit permissions all owner-only (0600)
G5 Bridge contract (ambient present / explicit+headless absent when configured)
G6 Redaction status — no body-bearing residual (or redacted:true stubs only)

Fail-closed. Writes preflight.json at 0600. Never prints canary plaintext or API keys.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Mapping

_HERE = Path(__file__).resolve().parent
_LIB = Path(__file__).resolve().parents[2] / "lib"
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
import common  # noqa: E402
import runir_core as core  # noqa: E402

RECALL_PATH = "POST /hooks/recall"

GateFn = Callable[..., dict[str, Any]]


def _gate(name: str, ok: bool, **detail: Any) -> dict[str, Any]:
    row: dict[str, Any] = {"gate": name, "ok": bool(ok)}
    row.update(detail)
    return row


def gate_identity(
    *,
    effective_user_id: str | None,
    identity_source: str,
) -> dict[str, Any]:
    if not effective_user_id:
        return _gate(
            "G1_identity",
            False,
            identitySource=identity_source,
            error="missing_user_id",
            detail=(
                "set RUNIR_USER_ID in process env or RUNIR_ENV_FILE; "
                "preflight refuses to invent a default userId"
            ),
            effectiveUserIdLength=0,
            effectiveUserIdDigest="",
        )
    return _gate(
        "G1_identity",
        True,
        identitySource=identity_source,
        effectiveUserIdLength=len(effective_user_id),
        effectiveUserIdDigest=common.id_digest(effective_user_id),
    )


def gate_canary_ownership(
    *,
    effective_user_id: str | None,
    owners: Mapping[str, str],
    memory_ids: Mapping[str, str],
) -> dict[str, Any]:
    """G2: every public-summary canary must have a non-empty owner matching identity.

    Partial owner maps fail closed (missing_canary_owner). Empty maps fail with
    no_canary_owners_recorded. Owner/identity compared by exact string; receipts
    expose length+digest only.
    """
    if not effective_user_id:
        return _gate(
            "G2_canary_ownership",
            False,
            error="missing_user_id",
            mismatches=[],
            missingOwners=[],
        )
    if not memory_ids and not owners:
        return _gate(
            "G2_canary_ownership",
            False,
            error="no_canary_owners_recorded",
            detail=(
                "record canaryOwner on public-summary canaries or provide "
                "canary-owners.json / --canary-owners-file"
            ),
            mismatches=[],
            missingOwners=[],
        )
    if not memory_ids:
        return _gate(
            "G2_canary_ownership",
            False,
            error="no_canaries_in_public_summary",
            detail="public-summary must list canaries with memoryId for G2 coverage",
            mismatches=[],
            missingOwners=[],
        )

    mismatches: list[dict[str, Any]] = []
    missing_owners: list[dict[str, Any]] = []
    checked = 0

    # Require a non-empty owner for every canary kind listed in public-summary.
    for kind, mid in memory_ids.items():
        owner = owners.get(kind)
        if not (isinstance(owner, str) and owner.strip()) and mid:
            # Allow owners keyed by memoryId when kind key absent.
            alt = owners.get(mid)
            if isinstance(alt, str) and alt.strip():
                owner = alt
        if not isinstance(owner, str) or not owner.strip():
            missing_owners.append(
                {
                    "kind": kind,
                    "memoryId": mid,
                }
            )
            continue
        owner = owner.strip()
        checked += 1
        if owner != effective_user_id:
            mismatches.append(
                {
                    "kind": kind,
                    "memoryId": mid,
                    "ownerLength": len(owner),
                    "ownerDigest": common.id_digest(owner),
                    "effectiveLength": len(effective_user_id),
                    "effectiveDigest": common.id_digest(effective_user_id),
                }
            )

    # Extra owner keys (e.g. memoryId-only entries not mapped to a kind) still
    # must match effective identity when present — fail-closed on drift.
    covered_keys = set(memory_ids.keys()) | set(memory_ids.values())
    for key, owner in owners.items():
        if key in covered_keys:
            continue
        if not isinstance(owner, str) or not owner.strip():
            continue
        owner = owner.strip()
        checked += 1
        if owner != effective_user_id:
            mismatches.append(
                {
                    "key": key,
                    "ownerLength": len(owner),
                    "ownerDigest": common.id_digest(owner),
                    "effectiveLength": len(effective_user_id),
                    "effectiveDigest": common.id_digest(effective_user_id),
                }
            )

    if missing_owners:
        return _gate(
            "G2_canary_ownership",
            False,
            checked=checked,
            mismatches=mismatches,
            missingOwners=missing_owners,
            error="missing_canary_owner",
            detail=(
                "every canary listed in public-summary requires a non-empty "
                "owner matching effective runtime identity"
            ),
        )

    ok = checked > 0 and not mismatches
    return _gate(
        "G2_canary_ownership",
        ok,
        checked=checked,
        mismatches=mismatches,
        missingOwners=[],
        error=None if ok else "canary_owner_mismatch",
    )


def gate_hooks_recall(
    *,
    effective_user_id: str | None,
    summary: Mapping[str, Any],
    cue: str | None,
    recall_fn: Callable[..., Any] | None = None,
    session_id: str = "restart-validation-preflight",
) -> dict[str, Any]:
    """Exercise POST /hooks/recall; require expected headless memoryId in selection."""
    if not effective_user_id:
        return _gate(
            "G3_hooks_recall",
            False,
            recallPath=RECALL_PATH,
            error="missing_user_id",
        )

    canaries = (
        summary.get("canaries") if isinstance(summary.get("canaries"), dict) else {}
    )
    headless = (
        canaries.get("headless") if isinstance(canaries.get("headless"), dict) else {}
    )
    expected_id = ""
    if isinstance(headless.get("memoryId"), str):
        expected_id = headless["memoryId"].strip()
    elif isinstance(headless.get("id"), str):
        expected_id = headless["id"].strip()

    if not expected_id:
        return _gate(
            "G3_hooks_recall",
            False,
            recallPath=RECALL_PATH,
            error="missing_expected_headless_memory_id",
        )

    prompt = cue
    if not prompt:
        q = headless.get("query")
        if isinstance(q, str) and q.strip():
            prompt = q.strip()
    if not prompt:
        label = headless.get("label")
        if isinstance(label, str) and label.strip():
            prompt = label.strip()
    if not prompt:
        return _gate(
            "G3_hooks_recall",
            False,
            recallPath=RECALL_PATH,
            error="missing_headless_cue",
            detail="provide --cue / --cue-file or canaries.headless.query",
        )

    fn = recall_fn or core.recall_result
    try:
        result = fn(
            prompt,
            user_id=effective_user_id,
            session_id=session_id,
            path="restart-validation-preflight",
        )
    except TypeError:
        # Allow simpler test doubles: recall_fn(prompt, user_id=...) only
        result = fn(prompt, user_id=effective_user_id)  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001 — fail-closed preflight
        return _gate(
            "G3_hooks_recall",
            False,
            recallPath=RECALL_PATH,
            error="recall_exception",
            detail=type(exc).__name__,
            expectedMemoryId=expected_id,
        )

    memory_ids: list[str] = []
    if hasattr(result, "memory_ids"):
        memory_ids = list(getattr(result, "memory_ids") or [])
    elif isinstance(result, dict):
        raw = result.get("memory_ids") or result.get("memoryIds") or []
        if isinstance(raw, list):
            memory_ids = [str(x) for x in raw]

    selected = expected_id in memory_ids
    return _gate(
        "G3_hooks_recall",
        selected,
        recallPath=RECALL_PATH,
        expectedMemoryId=expected_id,
        selectedCount=len(memory_ids),
        selectedHasExpected=selected,
        error=None if selected else "expected_memory_not_selected",
        detail=(
            None
            if selected
            else (
                "POST /hooks/recall did not select expected headless memoryId; "
                "get/search success is not a substitute"
            )
        ),
    )


def gate_permissions(kit_dir: Path) -> dict[str, Any]:
    bad: list[dict[str, Any]] = []
    for path in common.iter_kit_files(kit_dir):
        try:
            mode = common.file_mode(path)
            if common.is_world_or_group_readable(path) or mode != 0o600:
                # Allow execute bit only on validate_answer.py if owner-only
                if path.name == "validate_answer.py" and mode in (0o700, 0o600):
                    if not common.is_world_or_group_readable(path):
                        continue
                bad.append({"pathBasename": path.name, "mode": oct(mode)})
        except OSError:
            bad.append({"pathBasename": path.name, "mode": "unreadable"})
    return _gate(
        "G4_permissions",
        not bad,
        worldOrGroupReadable=bad,
        error=None if not bad else "non_owner_only_mode",
    )


def gate_bridge(
    kit_dir: Path,
    *,
    summary: Mapping[str, Any],
    skip: bool = False,
) -> dict[str, Any]:
    if skip:
        return _gate("G5_bridge", True, skipped=True)

    # Prefer explicit flags already recorded on summary / existing preflight.
    ambient = summary.get("ambientBridgePresent")
    explicit_absent = summary.get("explicitBridgeAbsent")
    headless_absent = summary.get("headlessBridgeAbsent")

    # Fall back to kit file presence (bridge projection dumps).
    if ambient is None:
        ambient = (kit_dir / "ambient.bridge.txt").is_file() or (
            kit_dir / "ambient.bridge.json"
        ).is_file()
    if explicit_absent is None:
        # Absent means no bridge projection for explicit canary path
        explicit_absent = not (
            (kit_dir / "explicit.bridge.txt").is_file()
            or (kit_dir / "explicit.bridge.json").is_file()
        )
    if headless_absent is None:
        headless_absent = not (
            (kit_dir / "headless.bridge.txt").is_file()
            or (kit_dir / "headless.bridge.json").is_file()
        )

    # If still unknown, pass with warning (bridge contract optional for pure unit kits)
    if ambient is None:
        return _gate(
            "G5_bridge",
            True,
            skipped=True,
            warning="bridge_flags_unknown",
        )

    ok = bool(ambient) and bool(explicit_absent) and bool(headless_absent)
    return _gate(
        "G5_bridge",
        ok,
        ambientBridgePresent=bool(ambient),
        explicitBridgeAbsent=bool(explicit_absent),
        headlessBridgeAbsent=bool(headless_absent),
        error=None if ok else "bridge_contract_failed",
    )


def gate_redaction(kit_dir: Path) -> dict[str, Any]:
    residual: list[str] = []
    for path in common.iter_kit_files(kit_dir):
        name = path.name
        if name in common.PUBLIC_ALLOWLIST:
            continue
        if not common.is_body_bearing_name(name):
            continue
        data = common.read_json(path)
        if isinstance(data, dict) and data.get("redacted") is True:
            continue
        # Non-JSON or unredacted body-bearing name
        residual.append(name)

    # expected.json dual surface
    if (kit_dir / "expected.json").is_file():
        data = common.read_json(kit_dir / "expected.json")
        if not (isinstance(data, dict) and data.get("redacted") is True):
            residual.append("expected.json")

    summary = common.load_public_summary(kit_dir)
    expected_file = summary.get("expectedFile")
    dual = bool(expected_file)

    ok = not residual and not dual
    return _gate(
        "G6_redaction",
        ok,
        bodyResidual=residual,
        expectedFileDualSurface=dual,
        error=None if ok else "body_or_dual_surface_residual",
    )


def run_preflight(
    kit_dir: Path,
    *,
    effective_user_id: str | None = None,
    identity_source: str | None = None,
    canary_owners: Mapping[str, str] | None = None,
    cue: str | None = None,
    recall_fn: Callable[..., Any] | None = None,
    skip_bridge: bool = False,
    skip_recall: bool = False,
    env: Mapping[str, str] | None = None,
    write_receipt: bool = True,
) -> dict[str, Any]:
    kit_dir = Path(kit_dir).expanduser().resolve()
    summary = common.load_public_summary(kit_dir)
    test_id = (
        summary.get("testId")
        if isinstance(summary.get("testId"), str)
        else kit_dir.name
    )

    if effective_user_id is None or identity_source is None:
        resolved_id, resolved_src = common.resolve_effective_user_id(
            env, override=effective_user_id
        )
        if effective_user_id is None:
            effective_user_id = resolved_id
        if identity_source is None:
            identity_source = resolved_src

    owners = (
        dict(canary_owners)
        if canary_owners is not None
        else common.load_canary_owners(kit_dir, summary)
    )
    memory_ids = common.canary_memory_ids(summary)

    gates: list[dict[str, Any]] = []
    g1 = gate_identity(
        effective_user_id=effective_user_id,
        identity_source=identity_source or "none",
    )
    gates.append(g1)

    g2 = gate_canary_ownership(
        effective_user_id=effective_user_id,
        owners=owners,
        memory_ids=memory_ids,
    )
    gates.append(g2)

    if skip_recall:
        # M1: skip never yields overall preflight ok / exit 0. G3 remains
        # fail-closed so production operators cannot green without POST /hooks/recall.
        g3 = _gate(
            "G3_hooks_recall",
            False,
            skipped=True,
            recallPath=RECALL_PATH,
            error="recall_skipped",
            detail=(
                "skip_recall/--skip-recall never permits overall preflight ok; "
                "POST /hooks/recall must select expected headless memoryId"
            ),
        )
    else:
        g3 = gate_hooks_recall(
            effective_user_id=effective_user_id,
            summary=summary,
            cue=cue,
            recall_fn=recall_fn,
        )
    gates.append(g3)

    g4 = gate_permissions(kit_dir)
    gates.append(g4)

    g5 = gate_bridge(kit_dir, summary=summary, skip=skip_bridge)
    gates.append(g5)

    g6 = gate_redaction(kit_dir)
    gates.append(g6)

    # Include skipped critical failures (recall_skipped) in errors + overall ok.
    errors = [
        f"{g['gate']}:{g.get('error') or 'failed'}"
        for g in gates
        if not g.get("ok")
    ]
    ok = all(g.get("ok") for g in gates)

    # Hash-only canaries for receipt
    canaries_public: dict[str, Any] = {}
    raw_canaries = summary.get("canaries")
    if isinstance(raw_canaries, dict):
        for kind, row in raw_canaries.items():
            if not isinstance(row, dict):
                continue
            canaries_public[str(kind)] = {
                k: row[k]
                for k in (
                    "label",
                    "memoryId",
                    "sha256",
                    "query",
                    "owner",
                    "canaryOwner",
                )
                if k in row
            }

    receipt: dict[str, Any] = {
        "testId": test_id,
        "ok": ok,
        "effectiveUserIdLength": len(effective_user_id or ""),
        "effectiveUserIdDigest": common.id_digest(effective_user_id),
        "identitySource": identity_source or "none",
        "recallPath": RECALL_PATH,
        "gates": {g["gate"]: g for g in gates},
        "canaries": canaries_public,
        "ambientBridgePresent": gates[4].get("ambientBridgePresent"),
        "explicitBridgeAbsent": gates[4].get("explicitBridgeAbsent"),
        "headlessBridgeAbsent": gates[4].get("headlessBridgeAbsent"),
        "errors": errors,
        "redacted": True,
    }

    if write_receipt and kit_dir.is_dir():
        common.write_private_json(kit_dir / "preflight.json", receipt)

    return receipt


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kit-dir", type=Path, required=True)
    p.add_argument(
        "--effective-user-id",
        default=None,
        help="Override resolved RUNIR_USER_ID (tests / operator); never invent default",
    )
    p.add_argument(
        "--canary-owners-file",
        type=Path,
        default=None,
        help="JSON map of kind/memoryId → owner userId",
    )
    p.add_argument("--cue", default=None, help="Headless value-free cue for G3")
    p.add_argument(
        "--cue-file", type=Path, default=None, help="Read headless cue from file"
    )
    p.add_argument(
        "--skip-bridge",
        action="store_true",
        help="Skip G5 bridge contract (unit kits without bridge dumps)",
    )
    p.add_argument(
        "--skip-recall",
        action="store_true",
        help=(
            "Skip live G3 POST /hooks/recall (unit tests only). "
            "Never yields overall preflight ok / exit 0 — G3 fails closed with recall_skipped"
        ),
    )
    p.add_argument(
        "--no-write",
        action="store_true",
        help="Do not write preflight.json",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cue = args.cue
    if cue is None and args.cue_file is not None:
        cue = Path(args.cue_file).read_text(encoding="utf-8").strip()

    owners: dict[str, str] | None = None
    if args.canary_owners_file is not None:
        data = common.read_json(Path(args.canary_owners_file))
        if isinstance(data, dict):
            owners = {}
            for k, v in data.items():
                if k in ("byKind", "byMemoryId") and isinstance(v, dict):
                    for kk, vv in v.items():
                        if isinstance(vv, str) and vv.strip():
                            owners[str(kk)] = vv.strip()
                elif isinstance(v, str) and v.strip():
                    owners[str(k)] = v.strip()

    receipt = run_preflight(
        args.kit_dir,
        effective_user_id=args.effective_user_id,
        canary_owners=owners,
        cue=cue,
        skip_bridge=args.skip_bridge,
        skip_recall=args.skip_recall,
        write_receipt=not args.no_write,
    )
    # Secrecy-safe stdout
    print(
        json.dumps(
            {
                "testId": receipt.get("testId"),
                "ok": receipt.get("ok"),
                "identitySource": receipt.get("identitySource"),
                "effectiveUserIdLength": receipt.get("effectiveUserIdLength"),
                "effectiveUserIdDigest": receipt.get("effectiveUserIdDigest"),
                "recallPath": receipt.get("recallPath"),
                "errors": receipt.get("errors"),
                "gates": {
                    name: {
                        "ok": g.get("ok"),
                        "error": g.get("error"),
                        "skipped": g.get("skipped"),
                    }
                    for name, g in (receipt.get("gates") or {}).items()
                },
            },
            separators=(",", ":"),
        )
    )
    return 0 if receipt.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
