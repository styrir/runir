import type {
  RecentWrite,
  ShadowCandidateSnapshot,
  SimilarCandidate,
} from "../../domain/memory/types.js";

/** Rúnir-pn1l.13.6 (Item B): pure point-in-time snapshot of a `SimilarCandidate`'s content,
 *  for the keep-both/veto create sites that need a shadow-replayable copy of the
 *  candidate that triggered them (as at arbitration time, immune to later DB mutation —
 *  see the investigation §3.3: candidates are never mutated in place by this module, but
 *  the OFFLINE adjudication tooling re-fetches by id from the live DB at adjudication time,
 *  which can be stale by then). Covers both `mergeKeepBothReason` replay (`l2`+`tags`) and
 *  `proveReferentIdentity` replay (`factKey`/`atomicFact`).
 *  `noemaClaimKey` is preserved on this snapshot for `candidate_snapshot_json`
 *  ONLY — it is NOT a `proveReferentIdentity` proof arm (Rúnir-pn1l Q4 U0,
 *  2026-07-07: removed from `ReferentKeys`; read here directly off
 *  `SimilarCandidate`, never via `ReferentKeys`/`candidateReferentKeys`).
 *  Rúnir-pn1l Q4 U1: `role` defaults to `"matched_candidate"` so the FOUR
 *  pre-U1 call sites (merge-band veto, merge keep-both guard, recent-band veto,
 *  store-near-dup veto — all genuinely snapshotting the row's matched/vetoed
 *  candidate) are unchanged; the two new correction-band blocked-nomination
 *  snapshot sites pass `"blocked_nomination"` explicitly. */
export function snapshotCandidate(
  c: SimilarCandidate,
  role: "matched_candidate" | "blocked_nomination" = "matched_candidate",
): ShadowCandidateSnapshot {
  return {
    id: c.id,
    l2: c.l2,
    tags: c.tags ?? null,
    factKey: c.factKey ?? null,
    noemaClaimKey: c.noemaClaimKey ?? null,
    atomicFact: c.atomicFact ?? null,
    snapshot_role: role,
  };
}

/** Rúnir-pn1l.13.6 (Item B, Codex round-2 refinement #1): recent-cache candidates are
 *  `RecentWrite`, NOT `SimilarCandidate` — they carry `.text` (not `.l2`) and no
 *  `id`/`tags`/`factKey`/`noemaClaimKey`/`atomicFact` (confirmed: `RecentWrite` has no
 *  referent keys, see `referentOfRecent` in the arbitration pipeline). A dedicated helper avoids
 *  passing a `RecentWrite` to `snapshotCandidate`, which expects the DB-candidate shape.
 *  Rúnir-pn1l Q4 U1: only ever called from the recent-band veto (the sole caller), which
 *  genuinely snapshots the row's matched/vetoed candidate — role is always
 *  `"matched_candidate"`, no parameter needed. */
export function snapshotRecentWrite(rw: RecentWrite): ShadowCandidateSnapshot {
  return { l2: rw.text, tags: null, factKey: null, noemaClaimKey: null, atomicFact: null, snapshot_role: "matched_candidate" };
}
