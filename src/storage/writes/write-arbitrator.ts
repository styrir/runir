import { createHash } from "node:crypto";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
  type SurrealClient,
  updateMemoryText,
  upsertMemory,
} from "../surreal/surreal-store";
import {
  createAtomicShadowAttempt,
  createAtomicShadowEvent,
  createAtomicShadowNomination,
  finalizeAtomicShadowAttemptIfComplete,
} from "../surreal/atomic-shadow-store.js";
import {
  logSupersessionJudgeLedger,
  noteLedgerWriteFailure,
  type SupersessionJudgeLedgerRow,
} from "../surreal/supersession-judge-ledger.js";
import type {
  ArbitrationConfig,
  ArbitrationDecision,
  ArbitrationResult,
  AtomicFrameSource,
  MemoryRecordTable,
  MemoryRole,
  MemoryScope,
  RecentWrite,
  ShadowCandidateSnapshot,
  SimilarCandidate,
  WriteSource,
} from "../../domain/memory/types";
import { DEFAULT_ARBITRATION_CONFIG, PRIMARY_MEMORY_TABLE } from "../../domain/memory/types";
import { areAnswerDistinctTexts } from "../../domain/memory/exact-qa.js";
import { cosineSimilarity } from "../../shared/cosine";
import { normalizeText } from "./text-normalize.js";
import { proveReferentIdentity } from "./referent-identity.js";
import type { ReferentKeys, ReferentVerdict } from "./referent-identity.js";
import type {
  F2JudgeCheckResult,
  GuardOverride,
  JudgeOutcome,
  SupersessionJudgeHandle,
  SupersessionJudgeIdentity,
  SupersessionProvenance,
  SupersessionVerdict,
} from "./supersession-judge.js";
import * as supersedeGuards from "./supersede-guards.js";
// Re-export pure guard predicates for unit tests / external callers.
export {
  hasTransienceCue,
  durableTransientKeepBothReason,
  temporalOrderingKeepBothReason,
} from "./supersede-guards.js";

import type { OverlayHandle } from "./overlay-lifecycle.js";
import {
  buildOverlayEntry,
  emitMemoryCommitted,
  emitMemoryIndexed,
  lockKeyFromMetadata,
} from "./overlay-lifecycle.js";
export type { OverlayHandle } from "./overlay-lifecycle.js";

import {
  incomingReferentKeys,
  candidateReferentKeys,
  mergeAtomicFactAction,
} from "./referent-keys.js";
export {
  incomingReferentKeys,
  candidateReferentKeys,
  mergeAtomicFactAction,
  atomicFactIdentity,
} from "./referent-keys.js";

import {
  getRecentWriteKey,
  pruneRecentWrites,
  prunedRecentWritesView,
  rememberWrite,
} from "./recent-writes.js";
import {
  atomicPairKey,
  computeAtomicIsolatedEvaluation,
  type AtomicIsolatedEvaluation,
} from "./atomic-shadow.js";

import {
  snapshotCandidate,
  snapshotRecentWrite,
} from "./shadow-snapshots.js";

import {
  buildMergedText,
  hasCorrectionMarker,
  hasCurrentnessCue,
  wouldSupersedeTexts,
  conflictingSubjects,
  sharesSlotTags,
  subjectsChanged,
  incomingNamesCandidateValue,
  isAdditiveContent,
  isJudgeWorthy,
  mergeKeepBothReason,
  distinctOccasionAnchor,
} from "./write-signals.js";
export {
  deriveStatementKey,
  isAdditiveContent,
  mergeKeepBothReason,
  distinctOccasionAnchor,
} from "./write-signals.js";

import {
  cueGateEnabled,
  judgeGateEnabled,
  f2JudgeConfirmEnabled,
  mergeKeepBothGuardEnabled,
  additiveSkipGuardEnabled,
  supersedeShadowEnabled,
  supersedeTemporalGuardEnabled,
  atomicFactIdentityProofEnabled,
} from "./write-flags.js";
export {
  judgeGateEnabled,
  f2JudgeConfirmEnabled,
  atomicFactIdentityProofEnabled,
} from "./write-flags.js";

/** Rúnir-pn1l.13.7 D3 — content hash for ledger/provenance (candidate ids are not immutable). */
function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** F2 supersede signals (Rúnir-w077 / Layer 0) — the only origins that escalate under
 *  RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM (Rúnir-pn1l.13.7 D1/D2). */
function isF2SupersedeSignal(signal: string | undefined): boolean {
  return (
    signal === "extractor_correction:slot" ||
    signal === "extractor_correction:named_value" ||
    signal === "currentness_cue:slot"
  );
}

type WriteArbitrationInput = {
  db: SurrealClient;
  text: string;
  userId: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  scope: MemoryScope;
  sessionId?: string;
  source: WriteSource;
  recentWrites: Map<string, RecentWrite[]>;
  embedText: (text: string) => Promise<number[]>;
  config?: Partial<ArbitrationConfig>;
  targetTable?: MemoryRecordTable;
  /** When false (fingerprint mismatch or missing for non-empty corpus), skip all
   *  vector-similarity lookups and treat the write as a fresh create. */
  fingerprintOk?: boolean;
  overlay?: OverlayHandle;
  /** Rúnir-pn1l Layer 2 / 13.7 D4: injected supersession judge HANDLE. When provided
   *  AND `RUNIR_SUPERSEDE_JUDGE_GATE=1`, the arbitrator escalates Layer-0-abstain
   *  cue candidates to it. Separately, `RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM=1` escalates
   *  F2-selected targets regardless of handle availability (D1 — availability is a
   *  resolution concern). Absent / both flags off ⇒ never consulted for applied path. */
  judge?: SupersessionJudgeHandle;
  /** Rúnir-pn1l.13.7 D5: optional judge used ONLY to resolve WOULD-lane F2 escalations
   *  (replay). Never the applied path, never baseline. Prod callers never pass it. */
  shadowJudge?: SupersessionJudgeHandle;
  /** Rúnir-pn1l Q4 U2 (seeded-replay harness): an OPTIONAL injected clock (epoch ms)
   *  used ONLY for chronological replay. When present, `arbitrateWrite` passes it RAW
   *  (never captured-once) to `pruneRecentWrites`, `findSimilarMemories`, the applied
   *  `resolveDecision`'s recency (`withinHours`) checks, and every `rememberWrite`, so
   *  each of those clock reads is anchored to the replayed row's original `created_at`
   *  instead of the wall clock. **Every production caller omits this**, and each callee
   *  resolves `nowMs ?? Date.now()` LOCALLY — so when omitted the applied decision path
   *  is byte-identical to today (each site does its own independent `Date.now()`; the
   *  clocks are NOT collapsed). The shadow WOULD/BASELINE block separately resolves
   *  `input.nowMs ?? Date.now()` once (capture-once is correct there — both lanes want
   *  the same instant). The temporal-ordering guard's own `arbitrationNowMs` is
   *  deliberately NOT driven by this (it is gated on the temporal guard being enabled). */
  nowMs?: number;
  /**
   * Rúnir-pn1l.13.7 D5 (seeded-replay harness): optional per-step UUID stamped onto the
   * supersede_shadow row so fire-and-forget emits can be correlated uniquely BY
   * CONSTRUCTION. Derived keys (applied_memory_id / incoming text) collide across
   * merge-updates and identical skips; a timed-out row must never be claimable by a
   * later step. **Every production caller omits this** (same seam pattern as nowMs /
   * shadowJudge). When present, `emitShadow` forwards it to `logSupersedeShadow`.
   */
  shadowCorrelationId?: string;
  /**
   * Rúnir-h435.1 PIN-3 FRAME IDENTITY: optional replay/organic frame source.
   * Production omits → stratum `organic`, frameId `organic:<UTC-day from laneClockMs>`.
   * Replay (Unit C) passes `{stratum:"replay", frameId:"replay:"+runId}`.
   */
  atomicFrameSource?: AtomicFrameSource;
};

// Rúnir-pn1l Q4 U2: `nowMs` is an OPTIONAL injected clock for the seeded-replay
// harness. When omitted (every production caller) it resolves to `Date.now()` at
// THIS call site — each of the four `withinHours` call sites therefore keeps its
// OWN independent `Date.now()` read exactly as before (the raw optional is passed
// straight through from `arbitrateWrite`; it is NEVER captured once and shared, so
// the live path stays byte-identical). The seeder passes the replayed row's
// original `created_at` (ms) so recency is judged against simulated historical time.
function withinHours(candidate: SimilarCandidate, maxHours: number, nowMs?: number): boolean {
  const reference = candidate.updatedAt ?? candidate.createdAt;
  const referenceMs = Date.parse(reference);
  if (Number.isNaN(referenceMs)) {
    return false;
  }
  return (nowMs ?? Date.now()) - referenceMs <= maxHours * 3600 * 1000;
}

/** Rúnir-w077 correction pass: find the single best in-band candidate that a
 *  value change / tagged correction should SUPERSEDE, before any cosine-dedup or
 *  merge can swallow it. Candidates arrive ordered by similarity desc. Returns
 *  the matched candidate + the signal that qualified it, or null.
 *
 *  Rúnir-pn1l.13.2 D2: `cueGateParam` replaces the inline `cueGateEnabled()` env
 *  read so the caller (arbitrateWrite / resolveDecision) can pass a forced value for
 *  the shadow would-decision path without mutating process.env. The default behavior
 *  is preserved: arbitrateWrite resolves `cueGateEnabled()` once and passes the bool. */
function findSupersedeTarget(
  text: string,
  similarCandidates: SimilarCandidate[],
  incomingTags: string[] | undefined,
  config: ArbitrationConfig,
  cueGateParam: boolean,
  // Rúnir-pn1l.13.4 (U5): memoized referent verdict per candidate (computed once by
  // resolveDecision and consumed by every band). The F1/F2 authority now flows through it.
  referentOf: (candidate: SimilarCandidate) => ReferentVerdict,
  // Rúnir-pn1l Q4 U2: optional injected clock threaded to `withinHours`. Omitted ⇒
  // `withinHours` reads its own `Date.now()` (byte-identical prod path).
  withinHoursNowMs?: number,
): {
  target: { candidate: SimilarCandidate; signal: string; referentProof?: string } | null;
  // Surfaced to resolveDecision → decision → emitShadow (shadow v2 would_nomination_blocked).
  blockedNomination?: string;
  // Rúnir-pn1l Q4 U1 (A3a): a shadow-replayable snapshot of the FIRST candidate whose F1
  // nomination was blocked for lack of a proven referent identity — role-tagged
  // "blocked_nomination" so it can never masquerade as the row's matched-candidate
  // snapshot (Codex brief-gate P1 #2). `??=` first-captured-wins, mirroring
  // `blockedNomination` itself.
  blockedNominationSnapshot?: ShadowCandidateSnapshot;
  // Rúnir-pn1l Q4 U1 (A3b): the conflict detail from the FIRST correction-band candidate
  // vetoed by the unconditional anchor-conflict check below (a loop-level `continue` that
  // previously recorded nothing observability-wise in the correction pass specifically —
  // the merge/recent/store bands already stamp their own conflict vetoes, but a
  // conflict-vetoed CORRECTION-BAND candidate that no later band absorbs fell through with
  // null shadow referent fields). Paired snapshot, same first-captured-wins precedence.
  correctionBandConflict?: string;
  correctionBandConflictSnapshot?: ShadowCandidateSnapshot;
} {
  const marker = hasCorrectionMarker(incomingTags);
  // Rúnir-pn1l Layer 0: when the marker is dropped, a currentness/replacement cue in
  // the incoming text re-enables the tag-driven slot/named-value paths. The
  // conflicting-subject guard below still blocks cross-entity supersede, and the
  // structural slot conflict (sharesSlotTags / incomingNamesCandidateValue) is still
  // required — so the cue is necessary, never sufficient on its own.
  const cueGate = cueGateParam && hasCurrentnessCue(text);
  let best: { candidate: SimilarCandidate; signal: string; referentProof?: string } | null = null;
  let blockedNomination: string | undefined;
  let blockedNominationSnapshot: ShadowCandidateSnapshot | undefined;
  let correctionBandConflict: string | undefined;
  let correctionBandConflictSnapshot: ShadowCandidateSnapshot | undefined;
  for (const candidate of similarCandidates) {
    if (
      candidate.similarity < (config.supersedeCandidateFloor ?? config.mergeThreshold) ||
      !withinHours(candidate, config.mergeWindowHours, withinHoursNowMs)
    ) {
      continue;
    }
    if (areAnswerDistinctTexts(candidate.l2, text)) {
      continue;
    }
    // Rúnir-pn1l.13.4 (U5, R3): an anchor CONFLICT is a per-candidate veto BEFORE any
    // signal is considered — no F1/F2 signal may retire a candidate whose stable
    // identifiers disagree with the incoming write. Unconditional; NOT gated by any env
    // flag. (proveReferentIdentity is memoized in referentOf.)
    const referent = referentOf(candidate);
    if (referent.verdict === "conflict") {
      // Rúnir-pn1l Q4 U1 (A3b): capture the FIRST correction-band anchor-conflict veto
      // (role-tagged "blocked_nomination") so the fall-through create (if no later band
      // absorbs the write) can stamp referentVerdict:"conflict" + the snapshot — mirrors
      // the recentConflict/storeConflict deferred-stamp pattern in resolveDecision.
      correctionBandConflict ??= referent.conflict;
      correctionBandConflictSnapshot ??= snapshotCandidate(candidate, "blocked_nomination");
      continue;
    }

    // F2 tag-driven paths are refused when the extractor names disjoint
    // subjects (different entities). They fire on the extractor's correction
    // marker OR (Rúnir-pn1l Layer 0) a currentness cue in the incoming text.
    const tagDriveAllowed =
      (marker || cueGate) && !conflictingSubjects(candidate.tags, incomingTags);
    let signal: string | null = null;
    let referentProof: string | undefined;
    if (wouldSupersedeTexts(candidate.l2, text)) {
      // Rúnir-pn1l.13.4 (U5, R1): F1 nominate-only. Architect rule (GH#8 2026-07-05):
      // deterministic_text (text similarity) may NOMINATE, but may never RETIRE without an
      // independently-proven referent identity. `proven` → retire; `unproven` → record a
      // shadow-visible blocked nomination and fall through (no supersede from F1). The
      // `conflict` case never reaches here (vetoed above with `continue`).
      if (referent.verdict === "proven") {
        signal = "deterministic_text";
        referentProof = referent.proof;
      } else {
        blockedNomination ??= "deterministic_text:unproven";
        // Rúnir-pn1l Q4 U1 (A3a): snapshot the FIRST candidate whose F1 nomination was
        // blocked (unproven referent), role-tagged "blocked_nomination" — the exact
        // correction-band-only gap Codex brief-gate P1 #1 identified (a create+null-
        // matched row with no shadow-replayable snapshot at all).
        blockedNominationSnapshot ??= snapshotCandidate(candidate, "blocked_nomination");
        continue;
      }
    } else if (
      tagDriveAllowed &&
      sharesSlotTags(candidate.tags, incomingTags) &&
      // Cue-driven supersede also requires a same-subject VALUE change (§3b); the
      // marker path keeps w077 behavior (the extractor already asserted a correction).
      (marker || subjectsChanged(candidate.tags, incomingTags))
    ) {
      // KTD10: F2 gates are UNCHANGED — the anchor-conflict veto (above) is the ONLY
      // referent-identity requirement added to F2; no positive-proof requirement here.
      signal = marker ? "extractor_correction:slot" : "currentness_cue:slot";
    } else if (tagDriveAllowed && marker && incomingNamesCandidateValue(candidate, text, incomingTags)) {
      // named-value (e.g. a datastore migration) stays MARKER-only: naming the old
      // value tag-free is ambiguous (replace vs retain — "migrated off X" vs "X
      // remains"), so Layer 0 defers it to the extractor marker (w077) or the future
      // Layer 2 judge that can read the text relationship. (Codex round-2)
      signal = "extractor_correction:named_value";
    }
    if (!signal) continue;
    if (best === null || candidate.similarity > best.candidate.similarity) {
      best = { candidate, signal, referentProof };
    }
  }
  return {
    target: best,
    blockedNomination,
    blockedNominationSnapshot,
    correctionBandConflict,
    correctionBandConflictSnapshot,
  };
}

/**
 * Pure decision core (D2: env-free). Exported for the atomic-isolated lane
 * (`computeAtomicIsolatedEvaluation` in atomic-shadow.ts) which must call the REAL
 * resolver with applied params + atomicAuthority:true.
 */
export function resolveDecision(
  text: string,
  recentCandidates: RecentWrite[],
  similarCandidates: SimilarCandidate[],
  embedding: number[],
  config: ArbitrationConfig,
  incomingTags?: string[],
  judgeEnabled = false,
  keepBothGuardEnabled = false,
  temporalGuardEnabled = false,
  incomingValidAt?: string,
  incomingTier?: string,
  arbitrationNowMs = 0,
  additiveSkipGuard = false,
  cueGateParam = false,
  // Rúnir-pn1l.13.4 (U5): the incoming write's referent keys (projected once by
  // arbitrateWrite). Consumed by the memoized referent-identity verdict below.
  incomingKeys: ReferentKeys = {},
  // Rúnir-pn1l Q4 U2: optional injected clock for the recency (`withinHours`) checks
  // in every band. SEPARATE from `arbitrationNowMs` (which anchors only the temporal-
  // ordering keep-both guard). Omitted ⇒ each `withinHours` call reads its own
  // `Date.now()` (byte-identical prod path). The applied `resolveDecision` call in
  // `arbitrateWrite` passes the raw `input.nowMs`; the two shadow lanes pass the
  // shadow clock so WOULD/BASELINE recency is judged against the same simulated instant.
  withinHoursNowMs?: number,
  // Rúnir-pn1l.13.7 D1/D2: when ON, an F2-selected target ALWAYS escalates to
  // outcome:"judge" BEFORE the durability/temporal guard block. Guards run once
  // inside resolveJudgeDecision. F1-proven never escalates.
  f2JudgeConfirm = false,
  // Rúnir-h435.1 PIN-5: pure param (env read stays in arbitrateWrite). When false,
  // only the atomicFactIdentity key arm is skipped inside proveReferentIdentity.
  atomicAuthority = false,
  // Rúnir-h435.1 PIN-6 / PIN-8: single lane clock for the unconditional atomic-proven
  // guard unit's temporal leg. Captured once in arbitrateWrite as
  // `laneClockMs = input.nowMs ?? Date.now()`; never arbitrationNowMs=0, never an
  // independent wall clock inside the guard unit.
  laneClockMs = 0,
): ArbitrationDecision {
  const normalizedText = normalizeText(text);

  // Rúnir-pn1l.13.4 (U5): compute proveReferentIdentity ONCE per candidate and reuse the
  // verdict in every band (F1/F2 gate, recent-cache skip, store near-dup skip, merge band).
  // The anchor-conflict veto is unconditional (NOT gated by any env flag); the F1
  // nominate-only gate consumes the "proven"/"unproven" verdict. Memoized by candidate ref.
  const referentCache = new Map<SimilarCandidate, ReferentVerdict>();
  const referentOf = (candidate: SimilarCandidate): ReferentVerdict => {
    let v = referentCache.get(candidate);
    if (v === undefined) {
      v = proveReferentIdentity({
        candidateText: candidate.l2,
        incomingText: text,
        candidateKeys: candidateReferentKeys(candidate),
        incomingKeys,
        atomicAuthority,
      });
      referentCache.set(candidate, v);
    }
    return v;
  };
  // RecentWrite entries carry NO referent keys (verified: RecentWrite shape has no
  // factKey/atomicFact), so the recent-cache verdict is anchors-only — empty keys on
  // both sides, no text-similarity proof arm (near-verbatim was removed, Codex P1).
  // Only the "conflict" arm is consumed here (recent-band veto).
  const referentOfRecent = (rw: RecentWrite): ReferentVerdict =>
    proveReferentIdentity({
      candidateText: rw.text,
      incomingText: text,
      candidateKeys: {},
      incomingKeys,
      atomicAuthority,
    });

  // 1. Exact normalized duplicates → skip (recent cache + store window). Kept
  //    BEFORE the correction pass so a trivially reworded exact duplicate never
  //    triggers a supersede (Codex review of Rúnir-w077).
  for (const candidate of recentCandidates) {
    if (candidate.normalizedText === normalizedText) {
      return { outcome: "skip", reason: "matched recent in-memory duplicate", band: "exact-dup" };
    }
  }
  for (const candidate of similarCandidates) {
    if (
      normalizeText(candidate.l2) === normalizedText &&
      withinHours(candidate, config.skipWindowHours, withinHoursNowMs)
    ) {
      return {
        outcome: "skip",
        candidate,
        reason: "matched normalized duplicate in recent store window",
        band: "exact-dup",
      };
    }
  }

  // 2. Correction pass (Rúnir-w077 F1+F2): supersede the single best compatible
  //    in-band candidate BEFORE cosine-dedup or merge can swallow the change.
  //    F1 = same-subject-key value change; F2 = extractor correction tag +
  //    compatible candidate (shared slot tags, or the correction names the
  //    candidate's distinguishing value).
  const {
    target: corrected,
    blockedNomination,
    blockedNominationSnapshot,
    correctionBandConflict,
    correctionBandConflictSnapshot,
  } = findSupersedeTarget(
    text,
    similarCandidates,
    incomingTags,
    config,
    cueGateParam,
    referentOf,
    withinHoursNowMs,
  );
  if (corrected) {
    // Rúnir-pn1l.13.7 D1/D2: when f2JudgeConfirm is ON and the selected target is F2
    // (no referentProof — F1 carries proof), ALWAYS escalate BEFORE the durability/
    // temporal guard block. Guards run EXACTLY ONCE inside resolveJudgeDecision.
    // F1-proven (`corrected.referentProof` set) never escalates. Flag alone gates
    // escalation; missing judge → unavailable at resolution (D1).
    if (f2JudgeConfirm && !corrected.referentProof && isF2SupersedeSignal(corrected.signal)) {
      return {
        outcome: "judge",
        candidate: corrected.candidate,
        reason: `escalated F2 ${corrected.signal} to supersession judge confirm (cosine ${corrected.candidate.similarity.toFixed(3)})`,
        supersedeSignal: corrected.signal,
        band: "correction-supersede",
        // Carry F2 discriminant so shadow/resolve paths preserve authority model
        // (judge is a negative veto on F2, not a new retirement authority — D3).
        referentVerdict: "f2_exception",
        referentProof: `signal:${corrected.signal}`,
        shadowCandidateSnapshot: snapshotCandidate(corrected.candidate),
      };
    }
    // Rúnir-h435.1 PIN-6 [R1-6, R2-1, R3-1]: unconditional guard unit for
    // key:atomicFactIdentity-proven F1 retirements ONLY. Runs regardless of
    // RUNIR_SUPERSEDE_TEMPORAL_GUARD (or any other env flag). Keep-both direction
    // only. key:factKey / anchor-shared F1 keep today's behavior (guards still
    // gated on temporalGuardEnabled below). Clock = laneClockMs (never
    // arbitrationNowMs=0, never an independent wall clock). Occasion leg keys off
    // the equal canonical slot owner (proven identity's subject) — not subject:* tags.
    if (corrected.referentProof === "key:atomicFactIdentity") {
      const durKeepBoth = supersedeGuards.durableTransientKeepBothReason(
        corrected.candidate,
        text,
        incomingTier,
      );
      if (durKeepBoth) {
        // F1: preserve candidate/proof context for isolated frame; do NOT set
        // supersedeSignal (applied create metadata must stay free of it).
        return {
          outcome: "create",
          candidate: corrected.candidate,
          reason: `kept both (durability guard: ${durKeepBoth}; signal ${corrected.signal}, cosine ${corrected.candidate.similarity.toFixed(3)})`,
          band: "correction-supersede",
          referentVerdict: "proven",
          referentProof: "key:atomicFactIdentity",
          shadowCandidateSnapshot: snapshotCandidate(corrected.candidate),
          guardKeepBoth: {
            leg: "durability",
            reason: durKeepBoth,
            signal: corrected.signal,
          },
        };
      }
      const tempKeepBoth = supersedeGuards.temporalOrderingKeepBothReason(
        corrected.candidate,
        incomingValidAt,
        laneClockMs,
      );
      if (tempKeepBoth) {
        return {
          outcome: "create",
          candidate: corrected.candidate,
          reason: `kept both (temporal-ordering guard: ${tempKeepBoth}; signal ${corrected.signal}, cosine ${corrected.candidate.similarity.toFixed(3)})`,
          band: "correction-supersede",
          referentVerdict: "proven",
          referentProof: "key:atomicFactIdentity",
          shadowCandidateSnapshot: snapshotCandidate(corrected.candidate),
          guardKeepBoth: {
            leg: "temporal",
            reason: tempKeepBoth,
            signal: corrected.signal,
          },
        };
      }
      // Distinct-occasion: same-TYPE anchors with DIFFERENT values → keep-both.
      // Shared-subject precondition is satisfied by the equal canonical slot owner
      // (the proven atomicFactIdentity subject), NOT subjectValues(tags).
      const candAnchor = distinctOccasionAnchor(corrected.candidate.l2);
      const incAnchor = distinctOccasionAnchor(text);
      if (
        candAnchor !== null &&
        incAnchor !== null &&
        candAnchor.type === incAnchor.type &&
        candAnchor.value !== incAnchor.value
      ) {
        return {
          outcome: "create",
          candidate: corrected.candidate,
          reason: `kept both (distinct-occasion guard: same-type anchors differ; signal ${corrected.signal}, cosine ${corrected.candidate.similarity.toFixed(3)})`,
          band: "correction-supersede",
          referentVerdict: "proven",
          referentProof: "key:atomicFactIdentity",
          shadowCandidateSnapshot: snapshotCandidate(corrected.candidate),
          guardKeepBoth: {
            leg: "occasion",
            reason: "same-type anchors differ",
            signal: corrected.signal,
          },
        };
      }
    }
    if (temporalGuardEnabled) {
      // Rúnir-pn1l.8 Finding 2: the DURABILITY leg runs on ALL supersede paths INCLUDING
      // F1 (`deterministic_text`), so a transient restatement can't overwrite a durable
      // fact via the deterministic same-key path (closes f1_bypass). `durable → durable`
      // still supersedes (w077 unaffected).
      const durKeepBoth = supersedeGuards.durableTransientKeepBothReason(corrected.candidate, text, incomingTier);
      if (durKeepBoth) {
        return {
          outcome: "create",
          reason: `kept both (durability guard: ${durKeepBoth}; signal ${corrected.signal}, cosine ${corrected.candidate.similarity.toFixed(3)})`,
          band: "correction-supersede",
        };
      }
      // The TEMPORAL-ORDERING leg stays OFF the F1 path (w077 — don't temporally-gate the
      // deterministic same-key correction). It applies only to the cue/judge-class supersedes,
      // where pn1l.7 anchors an absent incoming validAt to ingestion-now.
      if (corrected.signal !== "deterministic_text") {
        const tempKeepBoth = supersedeGuards.temporalOrderingKeepBothReason(corrected.candidate, incomingValidAt, arbitrationNowMs);
        if (tempKeepBoth) {
          return {
            outcome: "create",
            reason: `kept both (temporal-ordering guard: ${tempKeepBoth}; signal ${corrected.signal}, cosine ${corrected.candidate.similarity.toFixed(3)})`,
            band: "correction-supersede",
          };
        }
      }
    }
    return {
      outcome: "supersede",
      candidate: corrected.candidate,
      reason: `superseded conflicting memory via ${corrected.signal} (cosine ${corrected.candidate.similarity.toFixed(3)})`,
      supersedeSignal: corrected.signal,
      band: "correction-supersede",
      // Rúnir-pn1l.13.4 (U5) / Rúnir-pn1l Q4 U1: referent-identity discriminant for
      // this retirement. F1 (`corrected.referentProof` set by findSupersedeTarget's
      // `deterministic_text` branch) requires + carries a proven referent proof.
      // F2 (`extractor_correction:slot`/`:named_value`, `currentness_cue:slot`) is a
      // SEPARATE retirement authority with no positive referent-identity proof
      // requirement (only the anchor-conflict veto applies to it) — stamp an explicit
      // `referentVerdict:"f2_exception"` discriminant instead of leaving the shadow
      // v2 columns null, so F1-proven and F2-exception retirements are reportable
      // SEPARATELY (plan §10.2 Route 3). The `signal:` prefix on `referentProof`
      // (Codex P2 #5) marks this as a signal-provenance string, not a referent-identity
      // proof string, so it is never mistaken for an `anchor-shared`/`key:*` proof arm.
      ...(corrected.referentProof
        ? { referentVerdict: "proven", referentProof: corrected.referentProof }
        : { referentVerdict: "f2_exception", referentProof: `signal:${corrected.signal}` }),
    };
  }
  // Rúnir-pn1l.13.4 (U5): bands 3-5 + create are wrapped so a blocked F1 nomination
  // (deterministic_text nominated but referent-unproven → no supersede) surfaces on the
  // fall-through decision for the shadow v2 `would_nomination_blocked` column, without
  // stamping every individual return site.
  const resolveRemainingBands = (): ArbitrationDecision => {
  const markerPresent = hasCorrectionMarker(incomingTags);
  // Rúnir-pn1l.13.4 (Codex P2): a recent-band anchor-conflict veto only `continue`s;
  // when no other candidate matches, the write falls to the generic `create` below
  // with null shadow referent fields, so the ledger cannot prove the hard veto fired.
  // Capture the conflict detail here and stamp it onto that final `create` (reason +
  // shadow v2 referent fields) — observability only, the keep-both OUTCOME is unchanged.
  let recentConflict: string | undefined;
  let recentConflictCandidate: RecentWrite | undefined;
  // Rúnir-pn1l.13.6 (Item A): the store-near-dup skip-band anchor-conflict veto (band 4,
  // below) previously recorded NOTHING — a bare `continue`, no reason, no shadow fields.
  // Mirrors the recentConflict deferred-stamp pattern: capture the conflict detail here,
  // stamp it onto a deferred fall-through create if no later band absorbs the write.
  let storeConflict: string | undefined;
  let storeConflictCandidate: SimilarCandidate | undefined;

  // 3. Recent in-memory near-duplicate → skip.
  for (const candidate of recentCandidates) {
    const similarity = cosineSimilarity(candidate.embedding, embedding);
    if (similarity >= config.skipThreshold) {
      if (areAnswerDistinctTexts(candidate.text, text)) {
        continue;
      }
      // Rúnir-pn1l.13.4 (U5, R3): an anchor conflict vetoes this recent entry from
      // absorbing the incoming as a near-dup skip — a conflicting stable identifier means
      // these are DIFFERENT referents. Fall through toward create. Unconditional (no flag).
      const recentReferent = referentOfRecent(candidate);
      if (recentReferent.verdict === "conflict") {
        if (recentConflict === undefined) {
          recentConflict = recentReferent.conflict;
          recentConflictCandidate = candidate;
        }
        continue;
      }
      // Rúnir-pn1l.10 Guard 2: if the incoming adds substantial new content (>= 3 novel
      // tokens AND novelty ratio >= 0.40), create a distinct record instead of skipping.
      // Gate: RUNIR_ADDITIVE_SKIP_GUARD=1. Default-OFF → byte-identical baseline.
      if (additiveSkipGuard && isAdditiveContent(candidate.text, text)) {
        return {
          outcome: "create",
          reason: `additive incoming kept (recent in-memory near-dup; cosine ${similarity.toFixed(3)})`,
          band: "recent-near-dup-skip",
        };
      }
      return {
        outcome: "skip",
        reason: `matched recent in-memory duplicate (cosine ${similarity.toFixed(3)})`,
        band: "recent-near-dup-skip",
      };
    }
  }

  // 4. Store near-duplicate → skip.
  for (const candidate of similarCandidates) {
    if (
      candidate.similarity >= config.skipThreshold &&
      withinHours(candidate, config.skipWindowHours, withinHoursNowMs)
    ) {
      if (areAnswerDistinctTexts(candidate.l2, text)) {
        continue;
      }
      // Rúnir-pn1l.13.4 (U5, R3): anchor-conflict veto — a conflicting-referent candidate
      // cannot absorb the incoming as a store near-dup skip. Fall through toward create.
      // Rúnir-pn1l.13.6 (Item A): capture the conflict detail (mirrors recentConflict) so
      // the ledger can prove the veto fired if no other band absorbs the write.
      {
        const referent = referentOf(candidate);
        if (referent.verdict === "conflict") {
          if (storeConflict === undefined) {
            storeConflict = referent.conflict;
            storeConflictCandidate = candidate;
          }
          continue;
        }
      }
      // Rúnir-pn1l.10 Guard 2: same additive-content check for the store near-dup band.
      // The only rows that reach this band at cos >= 0.95 are near-duplicates; Guard 2
      // rescues additive updates that would otherwise be silently dropped.
      if (additiveSkipGuard && isAdditiveContent(candidate.l2, text)) {
        return {
          outcome: "create",
          reason: `additive incoming kept (store near-dup; cosine ${candidate.similarity.toFixed(3)})`,
          band: "store-near-dup-skip",
        };
      }
      return {
        outcome: "skip",
        candidate,
        reason: `skipped similar recent memory (cosine ${candidate.similarity.toFixed(3)})`,
        band: "store-near-dup-skip",
      };
    }
  }

  // 5. Merge band.
  for (const candidate of similarCandidates) {
    if (
      candidate.similarity < config.mergeThreshold ||
      !withinHours(candidate, config.mergeWindowHours, withinHoursNowMs)
    ) {
      continue;
    }

    if (areAnswerDistinctTexts(candidate.l2, text)) {
      continue;
    }

    // Rúnir-pn1l.13.4 (U5, R3): unconditional anchor-conflict veto at the TOP of each
    // merge-band candidate iteration — BEFORE the containment-skip exits below and OUTSIDE
    // the RUNIR_MERGE_KEEPBOTH_GUARD block (U6's domain). A conflicting-referent candidate
    // must not be folded (merge-update), absorbed (containment skip), or kept as a merge
    // duplicate — the two facts are distinct referents. Returns create (keep both). NOT
    // gated by any env flag.
    {
      const referent = referentOf(candidate);
      if (referent.verdict === "conflict") {
        return {
          outcome: "create",
          reason: `kept both (referent-anchor-conflict: ${referent.conflict}; cosine ${candidate.similarity.toFixed(3)})`,
          band: "merge-band",
          // Rúnir-pn1l.13.6 (Item A+B): stamp the verdict/proof + a shadow-replayable
          // candidate snapshot on this immediate-return anchor-conflict veto.
          referentVerdict: "conflict",
          referentProof: referent.conflict,
          shadowCandidateSnapshot: snapshotCandidate(candidate),
        };
      }
    }

    const candidateNorm = normalizeText(candidate.l2);
    if (candidateNorm.includes(normalizedText)) {
      return {
        outcome: "skip",
        candidate,
        reason: "existing memory already contains incoming detail",
        band: "merge-band",
      };
    }

    const mergedText = buildMergedText(candidate.l2, text);
    if (normalizeText(mergedText) === candidateNorm) {
      return {
        outcome: "skip",
        candidate,
        reason: "merge candidate resolved to existing memory text",
        band: "merge-band",
      };
    }

    // Rúnir-pn1l.8 Finding 3: a same-subject attribute change (identical slot tags, no
    // subject change) never reaches the cue supersede path, so the durability protection
    // would be unreachable. Run the fact-level durability leg here in the merge band too —
    // a transient-over-durable fold must be kept-both DETERMINISTICALLY (Layer 0), never
    // escalated to the paid judge or folded. Orthogonal to the pn1l.5 keep-both guard
    // below (different reason); run it FIRST so it emits its own reason. Gate off ⇒
    // temporalGuardEnabled is false ⇒ the merge proceeds unchanged.
    if (temporalGuardEnabled) {
      const durKeepBoth = supersedeGuards.durableTransientKeepBothReason(candidate, text, incomingTier);
      if (durKeepBoth) {
        return {
          outcome: "create",
          reason: `kept both (merge-band durability guard: ${durKeepBoth}; cosine ${candidate.similarity.toFixed(3)})`,
          band: "merge-band",
        };
      }
    }

    // Rúnir-pn1l Layer 2: a non-marker, in-band, cued, same-subject conflict that
    // Layer 0 abstained on is escalated to the injected LLM judge instead of being
    // silently merged. Gate off ⇒ judgeEnabled is false ⇒ this never fires and the
    // merge proceeds exactly as before. Marker cases keep w077 behavior (handled
    // below), so the judge only sees the genuinely tag-free ambiguous set.
    if (!markerPresent && judgeEnabled && isJudgeWorthy(candidate, text, incomingTags)) {
      return {
        outcome: "judge",
        candidate,
        reason: `escalated to LLM supersession judge (cosine ${candidate.similarity.toFixed(3)})`,
        band: "merge-band",
      };
    }

    // Rúnir-w077 (F2): a tagged correction that found NO compatible supersede
    // target in pass 2 must not be folded into a compound "both states" merge.
    // Prefer coexistence — fall through to create. (Codex: a wrong supersede or
    // a compound append is worse than a temporary duplicate.)
    if (markerPresent) {
      break;
    }

    // Rúnir-pn1l.5: do not fold a cross-entity or ambiguous-handoff candidate into one row — keep
    // both as distinct records. Gate off ⇒ keepBothGuardEnabled is false ⇒ merge proceeds as before.
    if (keepBothGuardEnabled) {
      const keepBothReason = mergeKeepBothReason(candidate, text, incomingTags);
      if (keepBothReason) {
        return {
          outcome: "create",
          reason: `kept both (merge-band keep-both guard: ${keepBothReason}; cosine ${candidate.similarity.toFixed(3)})`,
          band: "merge-band",
          // Rúnir-pn1l.13.6 (Item B): the PRIMARY 13.5 replay target. Guard-driven (not
          // anchor-conflict), so no referentVerdict — snapshot only.
          shadowCandidateSnapshot: snapshotCandidate(candidate),
        };
      }
    }

    return {
      outcome: "merge-update",
      candidate,
      mergedText,
      reason: `merged into recent similar memory (cosine ${candidate.similarity.toFixed(3)})`,
      band: "merge-band",
    };
  }

  // Rúnir-pn1l.13.4 (Codex P2): a recent-band anchor-conflict veto that did not find any
  // other absorbing candidate lands here — record it so the shadow ledger can prove the
  // hard veto fired (reason + referent_verdict:"conflict" + referent_proof=conflict detail).
  // Mirrors how the merge-band veto (U5) surfaces its own referent-anchor-conflict reason.
  if (recentConflict !== undefined) {
    return {
      outcome: "create",
      reason: `kept both (referent-anchor-conflict: ${recentConflict}; recent-band veto)`,
      band: "recent-near-dup-skip",
      referentVerdict: "conflict",
      referentProof: recentConflict,
      // Rúnir-pn1l.13.6 (Item B): recent-cache candidates are RecentWrite, not
      // SimilarCandidate — use the dedicated snapshot helper (Codex round-2 refinement #1).
      shadowCandidateSnapshot: recentConflictCandidate
        ? snapshotRecentWrite(recentConflictCandidate)
        : undefined,
    };
  }

  // Rúnir-pn1l.13.6 (Item A): a store-near-dup skip-band anchor-conflict veto that did not
  // find any other absorbing candidate lands here — mirrors the recent-band veto fall-through
  // immediately above. Checked AFTER recentConflict for determinism (per the brief's ordering
  // note); the two are mutually exclusive per-candidate in practice, but the ordering keeps
  // the recent-band veto's precedent priority if a fixture ever tripped both.
  if (storeConflict !== undefined) {
    return {
      outcome: "create",
      reason: `kept both (referent-anchor-conflict: ${storeConflict}; store-near-dup-skip veto)`,
      band: "store-near-dup-skip",
      referentVerdict: "conflict",
      referentProof: storeConflict,
      shadowCandidateSnapshot: storeConflictCandidate
        ? snapshotCandidate(storeConflictCandidate)
        : undefined,
    };
  }

  return {
    outcome: "create",
    reason: markerPresent
      ? "tagged correction with no compatible supersede target — created to avoid compound merge"
      : "no recent duplicate or merge candidate found",
    band: "create",
  };
  };

  const decision = resolveRemainingBands();
  // Rúnir-pn1l.13.4 (U5): surface a blocked F1 nomination on the fall-through decision so
  // the shadow v2 logger can record it. Observability only — does not change the outcome.
  if (blockedNomination !== undefined) {
    decision.blockedNomination = blockedNomination;
  }
  // Rúnir-pn1l Q4 U1 (A3, Codex brief-gate P1 #2 precedence): stamp the correction-band
  // blocked-candidate snapshot/conflict onto the fall-through decision using `??=`
  // semantics AGAINST FIELDS resolveRemainingBands() MAY ALREADY HAVE SET — first-
  // captured-wins, later band wins. `resolveRemainingBands()` runs bands 3-5 (recent-cache
  // skip, store near-dup skip, merge band) AFTER the correction pass already ran above; if
  // ANY of those bands already stamped `decision.shadowCandidateSnapshot` (role
  // "matched_candidate", e.g. a merge-band anchor-conflict veto on candidate B, or the
  // merge keep-both guard), that snapshot is preserved untouched — the correction-band
  // snapshot (on a DIFFERENT candidate A that the correction pass blocked earlier) fills in
  // ONLY when no later band captured one. This is exactly what prevents the masquerade
  // Codex flagged: a row whose `would_matched_id=B` can never end up with A's snapshot
  // silently substituted for B's. The `snapshot_role` tag on each snapshot ("blocked_nomination"
  // vs "matched_candidate") is the second, independent layer of that same guarantee — even in
  // the (impossible per this precedence) case of a wrong pairing, the role tag alone would
  // still prevent misreading a blocked-nomination snapshot as the matched candidate's.
  if (decision.shadowCandidateSnapshot === undefined) {
    if (correctionBandConflictSnapshot !== undefined) {
      decision.shadowCandidateSnapshot = correctionBandConflictSnapshot;
    } else if (blockedNominationSnapshot !== undefined) {
      decision.shadowCandidateSnapshot = blockedNominationSnapshot;
    }
  }
  // A3b: the correction-band anchor-conflict veto also carries its own referent verdict —
  // stamp it the same way (fill in only if no later band already stamped referentVerdict,
  // e.g. its OWN merge/recent/store-band anchor-conflict veto on a different candidate).
  if (decision.referentVerdict === undefined && correctionBandConflict !== undefined) {
    decision.referentVerdict = "conflict";
    decision.referentProof = correctionBandConflict;
  }
  return decision;
}

/**
 * Rúnir-pn1l Layer 2 / 13.7 D3: resolve a `"judge"` escalation into a concrete
 * decision via the injected handle. Keep-both (create) on a missing handle or any
 * non-verdict / below-floor outcome — an uncertain judge must never produce a wrong
 * supersede.
 *
 * F2-confirm escalations (D1/D2) carry the original F2 `supersedeSignal`; the judge
 * is a negative veto only. Cue-path escalations keep `llm_judge:supersede` signal.
 * Floor is sourced from the handle identity (D4 / r3-#3) — no separate default
 * authority when a handle is present. No-handle: no verdict exists to floor-check.
 */
async function resolveJudgeDecision(
  decision: ArbitrationDecision,
  judge: SupersessionJudgeHandle | undefined,
  incomingText: string,
  temporalGuardEnabled = false,
  incomingValidAt?: string,
  incomingTier?: string,
  arbitrationNowMs = 0,
  /** When true, this is an F2-confirm escalation (live applied path only writes ledger). */
  f2ConfirmOrigin = false,
): Promise<ArbitrationDecision> {
  const candidate = decision.candidate!;
  const f2Origin = f2ConfirmOrigin || isF2SupersedeSignal(decision.supersedeSignal);
  const decisionId = crypto.randomUUID();
  // Mint decision timestamp ONCE — stable across ledger retries (P0#2).
  const decisionTs = new Date().toISOString();
  const candidateSha256 = sha256Text(candidate.l2);
  const incomingSha256 = sha256Text(incomingText);
  const identityStatus: "resolved" | "no_handle" = judge ? "resolved" : "no_handle";
  const judgeIdentity: SupersessionJudgeIdentity | null = judge ? judge.identity : null;
  // Preserve the pre-resolution candidate snapshot for shadow/replay (P1#4).
  const preservedSnapshot = decision.shadowCandidateSnapshot;

  let outcome: JudgeOutcome;
  if (!judge) {
    outcome = { status: "unavailable" };
  } else {
    try {
      outcome = await judge.judge(candidate.l2, incomingText);
    } catch (err) {
      // Handle contract: never throw. Defense-in-depth if a stub does.
      outcome = {
        status: "transport_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Build ledger/provenance helpers for the F2-confirm path only (cue path has no
  // supersession_judge_ledger / supersessionProvenance — D3 flag-off/F1/cue state).
  const floor = judge?.identity.confidenceFloor;
  const buildProvenance = (
    result: F2JudgeCheckResult,
    appliedOutcome: "create" | "supersede" | "skip",
    confidence?: number,
    guardOverride?: GuardOverride,
  ): SupersessionProvenance => ({
    authority: "f2_exception",
    decisionId,
    appliedOutcome,
    f2JudgeCheck: {
      result,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(guardOverride ? { guardOverride } : {}),
      judgeIdentity,
      identityStatus,
    },
  });

  const buildLedger = (
    result: F2JudgeCheckResult,
    appliedOutcome: "create" | "supersede" | "skip",
    confidence?: number,
    guardOverride?: GuardOverride,
  ): SupersessionJudgeLedgerRow | undefined => {
    if (!f2Origin) return undefined;
    return {
      decisionId,
      ts: decisionTs,
      userId: "", // filled by caller with arbitration context
      scope: "",
      candidateId: candidate.id,
      candidateSha256,
      incomingSha256,
      signal: decision.supersedeSignal ?? "unknown",
      band: decision.band ?? null,
      cosine: candidate.similarity,
      result,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(guardOverride ? { guardOverride } : {}),
      judgeIdentity,
      identityStatus,
      appliedOutcome,
    };
  };

  const withF2Meta = (
    base: ArbitrationDecision,
    result: F2JudgeCheckResult,
    confidence?: number,
    guardOverride?: GuardOverride,
  ): ArbitrationDecision => {
    // Always preserve the original shadow candidate snapshot through resolution
    // (P1#4) — resolver-produced decisions must not drop it.
    const withSnapshot: ArbitrationDecision = {
      ...base,
      shadowCandidateSnapshot: base.shadowCandidateSnapshot ?? preservedSnapshot,
    };
    if (!f2Origin) return withSnapshot;
    const appliedOutcome = withSnapshot.outcome as "create" | "supersede" | "skip";
    return {
      ...withSnapshot,
      supersessionProvenance: buildProvenance(result, appliedOutcome, confidence, guardOverride),
      judgeLedgerPending: buildLedger(result, appliedOutcome, confidence, guardOverride),
    };
  };

  // Non-verdict statuses → live keep-both with class-distinct reasons (D0/D3).
  // Also stamp judgeUnresolved so shadow emit can record judge_pending (P1#4)
  // and Slice 2's strict policy can read the failure class.
  if (outcome.status === "unavailable") {
    return withF2Meta(
      {
        outcome: "create",
        reason: f2Origin
          ? `f2_judge_confirm: kept both (unavailable; signal ${decision.supersedeSignal}, cosine ${candidate.similarity.toFixed(3)})`
          : "llm_judge: kept both (unavailable)",
        band: decision.band,
        candidate,
        supersedeSignal: decision.supersedeSignal,
        referentVerdict: decision.referentVerdict,
        referentProof: decision.referentProof,
        judgeUnresolved: { status: "unavailable" },
      },
      "unavailable",
    );
  }
  if (outcome.status === "transport_error") {
    return withF2Meta(
      {
        outcome: "create",
        reason: f2Origin
          ? `f2_judge_confirm: kept both (transport_error: ${outcome.detail}; signal ${decision.supersedeSignal}, cosine ${candidate.similarity.toFixed(3)})`
          : `llm_judge: kept both (transport_error: ${outcome.detail})`,
        band: decision.band,
        candidate,
        supersedeSignal: decision.supersedeSignal,
        referentVerdict: decision.referentVerdict,
        referentProof: decision.referentProof,
        judgeUnresolved: { status: "transport_error", detail: outcome.detail },
      },
      "transport_error",
    );
  }
  if (outcome.status === "invalid_response") {
    return withF2Meta(
      {
        outcome: "create",
        reason: f2Origin
          ? `f2_judge_confirm: kept both (invalid_response: ${outcome.detail}; signal ${decision.supersedeSignal}, cosine ${candidate.similarity.toFixed(3)})`
          : `llm_judge: kept both (invalid_response: ${outcome.detail})`,
        band: decision.band,
        candidate,
        supersedeSignal: decision.supersedeSignal,
        referentVerdict: decision.referentVerdict,
        referentProof: decision.referentProof,
        judgeUnresolved: { status: "invalid_response", detail: outcome.detail },
      },
      "invalid_response",
    );
  }

  const verdict: SupersessionVerdict = outcome.verdict;
  const conf = Number.isFinite(verdict.confidence) ? verdict.confidence.toFixed(2) : "NaN";
  // Single floor source: the handle's identity (D4 / r3-#3). No-handle already
  // returned above, so floor is defined when we have a verdict from a handle.
  const confidenceFloor = floor ?? 0;
  const actionable =
    Number.isFinite(verdict.confidence) &&
    verdict.confidence >= confidenceFloor &&
    verdict.confidence <= 1;

  if (actionable && verdict.verdict === "supersede") {
    // Guards run EXACTLY ONCE here for escalated targets (D2). Both legs for non-F1.
    // Namespace import of supersede-guards so tests spy via vi.spyOn without a
    // production-mutable dispatch object (arch-r2 P2).
    if (temporalGuardEnabled) {
      const durKeepBoth = supersedeGuards.durableTransientKeepBothReason(
        candidate,
        incomingText,
        incomingTier,
      );
      if (durKeepBoth) {
        const guardOverride: GuardOverride = { leg: "durability", reason: durKeepBoth };
        // r3-#4: result:"confirmed" + appliedOutcome:"create" + guardOverride.
        if (f2Origin) judge?.noteResolution("confirmed");
        return withF2Meta(
          {
            outcome: "create",
            reason: f2Origin
              ? `f2_judge_confirm supersede overridden — kept both (durability guard: ${durKeepBoth}, conf ${conf})`
              : `llm_judge supersede overridden — kept both (durability guard: ${durKeepBoth}, conf ${conf})`,
            band: decision.band,
            candidate,
            supersedeSignal: decision.supersedeSignal,
            referentVerdict: decision.referentVerdict,
            referentProof: decision.referentProof,
          },
          "confirmed",
          verdict.confidence,
          guardOverride,
        );
      }
      const tempKeepBoth = supersedeGuards.temporalOrderingKeepBothReason(
        candidate,
        incomingValidAt,
        arbitrationNowMs,
      );
      if (tempKeepBoth) {
        const guardOverride: GuardOverride = { leg: "temporal", reason: tempKeepBoth };
        if (f2Origin) judge?.noteResolution("confirmed");
        return withF2Meta(
          {
            outcome: "create",
            reason: f2Origin
              ? `f2_judge_confirm supersede overridden — kept both (temporal-ordering guard: ${tempKeepBoth}, conf ${conf})`
              : `llm_judge supersede overridden — kept both (temporal-ordering guard: ${tempKeepBoth}, conf ${conf})`,
            band: decision.band,
            candidate,
            supersedeSignal: decision.supersedeSignal,
            referentVerdict: decision.referentVerdict,
            referentProof: decision.referentProof,
          },
          "confirmed",
          verdict.confidence,
          guardOverride,
        );
      }
    }
    if (f2Origin) judge?.noteResolution("confirmed");
    // F2 authority: original F2 supersedeSignal + f2_exception discriminant (D3).
    // Cue path: llm_judge:supersede.
    return withF2Meta(
      {
        outcome: "supersede",
        candidate,
        supersedeSignal: f2Origin ? decision.supersedeSignal : "llm_judge:supersede",
        reason: f2Origin
          ? `superseded via f2_judge_confirm (signal ${decision.supersedeSignal}, cosine ${candidate.similarity.toFixed(3)}, conf ${conf})`
          : `superseded via llm_judge (cosine ${candidate.similarity.toFixed(3)}, conf ${conf})`,
        band: decision.band ?? (f2Origin ? "correction-supersede" : undefined),
        ...(f2Origin
          ? {
              referentVerdict: "f2_exception" as const,
              referentProof: `signal:${decision.supersedeSignal}`,
            }
          : {}),
      },
      "confirmed",
      verdict.confidence,
    );
  }

  if (actionable && verdict.verdict === "duplicate") {
    if (f2Origin) judge?.noteResolution("duplicate");
    return withF2Meta(
      {
        outcome: "skip",
        candidate,
        reason: f2Origin
          ? `f2_judge_confirm: duplicate of existing memory (conf ${conf})`
          : `llm_judge: duplicate of existing memory (conf ${conf})`,
        band: decision.band,
        supersedeSignal: decision.supersedeSignal,
      },
      "duplicate",
      verdict.confidence,
    );
  }

  // independent, below-floor, or non-actionable → keep-both (veto for F2).
  if (f2Origin) judge?.noteResolution("vetoed");
  return withF2Meta(
    {
      outcome: "create",
      reason: f2Origin
        ? `f2_judge_confirm: kept both (verdict ${verdict.verdict}, conf ${conf}; signal ${decision.supersedeSignal})`
        : `llm_judge: kept both (verdict ${verdict.verdict}, conf ${conf})`,
      band: decision.band,
      candidate,
      supersedeSignal: decision.supersedeSignal,
      referentVerdict: decision.referentVerdict,
      referentProof: decision.referentProof,
    },
    "vetoed",
    Number.isFinite(verdict.confidence) ? verdict.confidence : undefined,
  );
}

export async function arbitrateWrite(
  input: WriteArbitrationInput,
): Promise<ArbitrationResult> {
  if (!input.text || input.text.trim() === '') {
    console.warn('write-arbitrator: skipping empty-text write', { source: input.source });
    return { outcome: 'skip', reason: 'empty-text' } as any;
  }
  // Rúnir-h435.1 PIN-4: mint per-write-event correlation id UNCONDITIONALLY at entry.
  // Stamped on atomic_shadow_* tables + supersede_shadow.write_event_id.
  const writeEventId = crypto.randomUUID();
  const config: ArbitrationConfig = {
    ...DEFAULT_ARBITRATION_CONFIG,
    ...input.config,
  };
  // Rúnir-pn1l.12: resolve + clamp supersedeCandidateFloor ONCE after config is built.
  // Precedence: env explicitly-set wins (invalid env → mergeThreshold, no fall-through to
  // input.config); else input.config floor if in (0, mergeThreshold]; else mergeThreshold.
  {
    const envRaw = process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
    const inRange = (v: number): boolean => v > 0 && v <= config.mergeThreshold;
    let resolvedFloor: number;
    if (envRaw !== undefined) {
      // Env explicitly set → it decides; invalid/out-of-range → mergeThreshold (operator error,
      // must NOT silently defer to input.config — Codex v2 MUST-FIX).
      const v = Number(envRaw.trim());
      resolvedFloor = (Number.isFinite(v) && inRange(v)) ? v : config.mergeThreshold;
    } else if (typeof config.supersedeCandidateFloor === "number") {
      resolvedFloor = inRange(config.supersedeCandidateFloor)
        ? config.supersedeCandidateFloor
        : config.mergeThreshold;
    } else {
      resolvedFloor = config.mergeThreshold;
    }
    config.supersedeCandidateFloor = resolvedFloor;
  }
  const recentWriteTtlMs = config.recentWriteTtlMinutes * 60 * 1000;
  // Rúnir-h435.1 PIN-9 (R2-1): DECISION INPUT is a pure pruned VIEW — no map mutation yet.
  // Physical pruneRecentWrites runs after the attempt-row boundary (side-effect phase).
  // F5: single prune clock shared by view-build and deferred physical prune so end-of-call
  // map state matches HEAD prune-at-entry semantics when nowMs is omitted.
  const pruneNowMs = input.nowMs ?? Date.now();
  const cacheKey = getRecentWriteKey(input.userId, input.scope, input.sessionId);
  const recentWritesView = prunedRecentWritesView(
    input.recentWrites,
    recentWriteTtlMs,
    pruneNowMs,
  );
  const recentCandidates = recentWritesView.get(cacheKey) ?? [];
  // Skip vector similarity lookup when fingerprint is mismatched or missing for a
  // non-empty corpus — comparing across incompatible embedding spaces produces
  // meaningless scores that can corrupt the lineage chain.
  const similarCandidates =
    input.fingerprintOk === false
      ? []
      : await findSimilarMemories(
          input.db,
          input.userId,
          input.embedding,
          config.mergeWindowHours,
        config.candidateLimit,
        input.scope,
        input.sessionId,
        // Rúnir-ekos B4: explicit table, never findSimilarMemories's own
        // legacy default.
        input.targetTable ?? PRIMARY_MEMORY_TABLE,
        // Rúnir-pn1l Q4 U2: raw optional replay clock (undefined for prod ⇒
        // findSimilarMemories reads its own Date.now() for the cutoff, byte-identical).
        input.nowMs,
      );

  const incomingTags = Array.isArray(input.metadata?.tags)
    ? (input.metadata!.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;
  // Rúnir-pn1l Layer 2: the env gate is read HERE (not in the pure resolveDecision).
  // Cue-path still requires a wired handle (existing convention). F2-confirm (D1)
  // escalates on the flag ALONE — availability is a resolution concern.
  const judgeEnabled = judgeGateEnabled() && input.judge !== undefined;
  // Rúnir-pn1l.13.7 D1: dark flag; resolved once, threaded as pure param.
  const liveF2JudgeConfirm = f2JudgeConfirmEnabled();
  const keepBothGuardEnabled = mergeKeepBothGuardEnabled();
  // Rúnir-pn1l.10: additive-aware skip guard. Default-OFF; resolved once here and passed
  // as a pure param to resolveDecision (mirrors the keepBothGuardEnabled pattern).
  const addSkipGuard = additiveSkipGuardEnabled();
  // Rúnir-pn1l.13.2 D2: cue gate resolved once here and threaded as a param so the
  // shadow path can force it ON without env mutation. Default behavior byte-identical:
  // live path receives the real env value; shadow path receives forced true.
  const liveCueGate = cueGateEnabled();
  // Rúnir-pn1l.2/.7/.8: the supersede temporal/durability pre-guard. Read the env gate
  // once and pull the incoming fact's durability tier + valid-time from metadata.
  // `factMetadata` stamps `tier` on every write; `validAt` is present only for
  // continuity-state roles (set by `deriveContinuityMetadata`). When `validAt` is absent
  // the temporal-ordering leg anchors to `arbitrationNowMs` (pn1l.7 Zep-style anchoring —
  // an absent incoming validAt is treated as "now", permitting the cue supersede against
  // a past-created candidate). Gate off ⇒ resolvers receive false and behavior is unchanged.
  const temporalGuardEnabled = supersedeTemporalGuardEnabled();
  // Capture arbitration-now ONCE so both resolveDecision and resolveJudgeDecision use an
  // identical anchor (keeps the pure predicate free of Date.now() calls).
  const arbitrationNowMs = temporalGuardEnabled ? Date.now() : 0;
  const incomingValidAt =
    typeof input.metadata?.validAt === "string" ? input.metadata.validAt : undefined;
  const incomingTier =
    typeof input.metadata?.tier === "string" ? input.metadata.tier : undefined;
  // Rúnir-pn1l.13.4 (U5): project the incoming write's referent keys ONCE (factKey /
  // continuitySubjectKey + canonicalized atomicFactIdentity — noemaClaimKey removed
  // from this projection, Rúnir-pn1l Q4 U0) and thread them into every resolveDecision
  // call (live + both shadow lanes) so the referent-identity gate/veto sees identical
  // incoming keys across lanes.
  const incomingKeysResolved = incomingReferentKeys(input.metadata);
  // Rúnir-h435.1 PIN-5: applied-lane atomic authority from the quarantine flag (default-OFF).
  const liveAtomicAuthority = atomicFactIdentityProofEnabled();
  // Rúnir-h435.1 PIN-6 / PIN-8: ONE lane-clock capture. Used by the unconditional
  // atomic-proven guard unit (and Unit B's isolated lane). Applied withinHours still
  // receives the raw `input.nowMs` (prod: independent Date.now() per site — frozen
  // byte-identity). Under seeded replay (`input.nowMs` present) laneClockMs equals it.
  const laneClockMs = input.nowMs ?? Date.now();
  let decision = resolveDecision(
    input.text,
    recentCandidates,
    similarCandidates,
    input.embedding,
    config,
    incomingTags,
    judgeEnabled,
    keepBothGuardEnabled,
    temporalGuardEnabled,
    incomingValidAt,
    incomingTier,
    arbitrationNowMs,
    addSkipGuard,
    liveCueGate,
    incomingKeysResolved,
    // Rúnir-pn1l Q4 U2: raw optional replay clock for the applied path's withinHours
    // recency checks (undefined for prod ⇒ each withinHours reads its own Date.now(),
    // byte-identical). SEPARATE from arbitrationNowMs (the temporal-ordering anchor).
    input.nowMs,
    liveF2JudgeConfirm,
    // Rúnir-h435.1 PIN-5: applied atomic authority.
    liveAtomicAuthority,
    // Rúnir-h435.1 PIN-6: lane clock for the unconditional atomic guard unit.
    laneClockMs,
  );

  if (decision.outcome === "judge") {
    const f2ConfirmOrigin =
      liveF2JudgeConfirm && isF2SupersedeSignal(decision.supersedeSignal);
    decision = await resolveJudgeDecision(
      decision,
      input.judge,
      input.text,
      temporalGuardEnabled,
      incomingValidAt,
      incomingTier,
      arbitrationNowMs,
      f2ConfirmOrigin,
    );
  }

  // Rúnir-pn1l.13.7 D3: fill userId/scope on any pending ledger row (minted in
  // resolveJudgeDecision without arbitration context). Live-applied only.
  if (decision.judgeLedgerPending) {
    decision.judgeLedgerPending = {
      ...decision.judgeLedgerPending,
      userId: input.userId,
      scope: input.scope,
    };
  }

  // Rúnir-pn1l.13.2: shadow would-decision block. Default-OFF (RUNIR_SUPERSEDE_SHADOW unset
  // → skipped entirely; zero added work). When ON: compute WOULD (all 5 flip flags forced ON,
  // floor=0.75, judgeEnabled=false) and BASELINE (all flags OFF, judgeEnabled=false) over the
  // SAME candidates already fetched — pure CPU, no extra I/O. Stash both here at the seam;
  // emit AFTER the applied branch (so applied_memory_id is available). The entire block is
  // wrapped in try/catch so any throw is swallowed and NEVER affects the applied result.
  let _shadowWould: ArbitrationDecision | null = null;
  let _shadowBaseline: ArbitrationDecision | null = null;
  if (supersedeShadowEnabled()) {
    try {
      // MFA (R2): shadow always uses a real present-era now, independent of whether
      // the LIVE temporal guard is on. When the live guard is off, arbitrationNowMs=0
      // (1970-era), which would falsely anchor every absent validAt in shadow to 1970
      // and corrupt the adjudication signal. The applied path MUST keep its exact
      // arbitrationNowMs — this is shadow-only.
      // Rúnir-pn1l Q4 U2 (A4): under seeded replay `input.nowMs` is the replayed row's
      // original `created_at`, so BOTH the temporal-ordering anchor AND the `withinHours`
      // recency checks in the WOULD/BASELINE lanes must use it (else a row originally from
      // e.g. 2026-01 would be judged against real 2026-07 time → a false diverged
      // would-supersede; the measured metric is would_outcome/baseline_outcome). Capture-
      // once is CORRECT here — WOULD and BASELINE want the SAME instant (existing behavior).
      // Omitted (every prod caller) ⇒ `Date.now()` (byte-identical, present-era).
      const shadowNowMs = input.nowMs ?? Date.now();

      // WOULD: all flip flags ON (incl. f2JudgeConfirm as 6th — Rúnir-pn1l.13.7 D1/D4b),
      // judgeEnabled=false (no LLM calls in prod shadow). Uses an explicit shadowConfig
      // so neither floor nor any other live-tunable leaks in.
      const wouldConfig = { ...config, supersedeCandidateFloor: 0.75 };
      _shadowWould = resolveDecision(
        input.text,
        recentCandidates,
        similarCandidates,
        input.embedding,
        wouldConfig,
        incomingTags,
        /* judgeEnabled */ false,
        /* keepBothGuardEnabled */ true,
        /* temporalGuardEnabled */ true,
        incomingValidAt,
        incomingTier,
        shadowNowMs,
        /* additiveSkipGuard */ true,
        /* cueGateParam */ true,
        incomingKeysResolved,
        // Rúnir-pn1l Q4 U2 (A4): WOULD lane recency checks use the shadow replay clock.
        shadowNowMs,
        // Rúnir-pn1l.13.7 D1/D4b: 6th flip-bundle flag forced ON in WOULD.
        /* f2JudgeConfirm */ true,
        // Rúnir-h435.1 PIN-5: full-bundle WOULD forces atomic authority ON (arm always-on there).
        /* atomicAuthority */ true,
        // Rúnir-h435.1 PIN-6: same lane clock for the atomic guard unit.
        laneClockMs,
      );

      // Rúnir-pn1l.13.7 D5: optional shadowJudge resolves WOULD-lane F2 escalations
      // (replay only). Prod callers never pass it. Non-verdict statuses stamp
      // judgeUnresolved so emit maps them to judge_pending (P1#4); Slice 2 strict
      // policy reads that discriminator. Verdict resolutions become concrete
      // create/supersede/skip. shadowCandidateSnapshot is preserved through
      // resolveJudgeDecision (not stripped here).
      if (
        _shadowWould.outcome === "judge" &&
        input.shadowJudge !== undefined &&
        isF2SupersedeSignal(_shadowWould.supersedeSignal)
      ) {
        _shadowWould = await resolveJudgeDecision(
          _shadowWould,
          input.shadowJudge,
          input.text,
          /* temporalGuardEnabled */ true,
          incomingValidAt,
          incomingTier,
          shadowNowMs,
          /* f2ConfirmOrigin */ true,
        );
        // D3 r3-#4: shadow/replay resolutions NEVER write the service ledger.
        _shadowWould.judgeLedgerPending = undefined;
        // Strip applied provenance from shadow decisions (shadow is observe-only).
        // Keep judgeUnresolved + shadowCandidateSnapshot for emit / Slice 2.
        _shadowWould.supersessionProvenance = undefined;
      }

      // BASELINE: all flip flags OFF (incl. f2JudgeConfirm), judgeEnabled=false.
      // MFB (R2): explicit baselineConfig with floor=mergeThreshold so the baseline
      // is a true all-flags-OFF state and does NOT inherit the live/possibly-lowered
      // supersedeCandidateFloor. temporalGuardEnabled=false → the temporal-ordering
      // anchor (arg 12) is unused, but pass shadowNowMs for consistency.
      // Rúnir-pn1l Q4 U2 (A4): the withinHours recency checks (arg 16) MUST use the
      // SAME shadow replay clock as WOULD — otherwise BASELINE would judge candidate
      // recency against real time while WOULD uses replay time, producing a spurious
      // band-membership divergence that is an artifact of the clock, not the flags.
      const baselineConfig = { ...config, supersedeCandidateFloor: config.mergeThreshold };
      _shadowBaseline = resolveDecision(
        input.text,
        recentCandidates,
        similarCandidates,
        input.embedding,
        baselineConfig,
        incomingTags,
        /* judgeEnabled */ false,
        /* keepBothGuardEnabled */ false,
        /* temporalGuardEnabled */ false,
        incomingValidAt,
        incomingTier,
        shadowNowMs,
        /* additiveSkipGuard */ false,
        /* cueGateParam */ false,
        incomingKeysResolved,
        // Rúnir-pn1l Q4 U2 (A4): BASELINE lane recency checks use the shadow replay clock.
        shadowNowMs,
        /* f2JudgeConfirm */ false,
        // Rúnir-h435.1 PIN-5 [R2-3]: BASELINE FORCES atomic authority OFF (required honest
        // delta — legacy atomic-only F1 flips baseline proven-supersede → unproven-blocked).
        /* atomicAuthority */ false,
        // Rúnir-h435.1 PIN-6: same lane clock for the atomic guard unit.
        laneClockMs,
      );
    } catch {
      // Shadow compute failure is swallowed — never touches applied result.
      _shadowWould = null;
      _shadowBaseline = null;
    }
  }

  // Rúnir-h435.1 PIN-1/PIN-8: atomic-isolated counterfactual — OUTSIDE the WOULD/BASELINE
  // swallow. Failure ladder: success → proceed; throw → AWAIT computation_failed attempt
  // row then continue applied; if that write also fails → THROW (no applied side effect).
  // Residual clock skew vs applied withinHours (prod independent Date.now() sites) is a
  // documented bounded artifact against HOUR-scale recency windows (PIN-8 DOX).
  let _atomicIsolated: AtomicIsolatedEvaluation | null = null;
  let _atomicComputationFailed = false;
  if (supersedeShadowEnabled()) {
    try {
      _atomicIsolated = computeAtomicIsolatedEvaluation({
        text: input.text,
        recentCandidates,
        similarCandidates,
        embedding: input.embedding,
        config,
        incomingTags,
        judgeEnabled,
        keepBothGuardEnabled,
        temporalGuardEnabled,
        incomingValidAt,
        incomingTier,
        arbitrationNowMs,
        additiveSkipGuard: addSkipGuard,
        cueGateParam: liveCueGate,
        incomingKeys: incomingKeysResolved,
        f2JudgeConfirm: liveF2JudgeConfirm,
        laneClockMs,
        appliedDecision: decision,
        incomingAtomicFact: input.metadata?.atomicFact,
        incomingTierMeta: incomingTier,
        incomingValidAtMeta: incomingValidAt,
      });
    } catch (err) {
      _atomicComputationFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      const frame =
        input.atomicFrameSource ??
        ({
          stratum: "organic" as const,
          frameId: `organic:${new Date(laneClockMs).toISOString().slice(0, 10)}`,
        });
      try {
        await createAtomicShadowAttempt(input.db, {
          writeEventId,
          activationClass: "computation_failed",
          stratum: frame.stratum,
          frameId: frame.frameId,
          ...(input.shadowCorrelationId != null
            ? { replayStepId: input.shadowCorrelationId }
            : {}),
          errorDetail: msg.slice(0, 500),
        });
      } catch (attemptErr) {
        // PIN-1 step 3: failed-attempt write also fails → surface, zero applied side effects.
        throw attemptErr;
      }
      // Durable computation_failed row created; proceed with applied handling.
      _atomicIsolated = null;
    }
  }

  // Rúnir-h435.1 PIN-9: attempt-row boundary — AFTER all decisions, BEFORE any outcome
  // branch / applied side effect (rememberWrite, updateMemoryText, supersedeMemory, upsertMemory).
  if (_atomicIsolated !== null && _atomicIsolated.activationClass !== null) {
    const frame =
      input.atomicFrameSource ??
      ({
        stratum: "organic" as const,
        frameId: `organic:${new Date(laneClockMs).toISOString().slice(0, 10)}`,
      });
    const manifestKeys = _atomicIsolated.nominations.map((n) => n.nominationCandidateId);
    const isSafety = _atomicIsolated.activationClass === "safety_activation";
    const pairKey =
      isSafety && _atomicIsolated.retiredCandidateId
        ? atomicPairKey(writeEventId, _atomicIsolated.retiredCandidateId)
        : undefined;
    const selectionHash = pairKey !== undefined ? sha256Text(pairKey) : undefined;
    await createAtomicShadowAttempt(input.db, {
      writeEventId,
      activationClass: _atomicIsolated.activationClass,
      ...(pairKey !== undefined ? { pairKey } : {}),
      ...(selectionHash !== undefined ? { selectionHash } : {}),
      ...(isSafety && _atomicIsolated.retiredCandidateId
        ? { retiredCandidateId: _atomicIsolated.retiredCandidateId }
        : {}),
      nominationManifestKeys: manifestKeys,
      nominationManifestCount: manifestKeys.length,
      stratum: frame.stratum,
      frameId: frame.frameId,
      ...(input.shadowCorrelationId != null
        ? { replayStepId: input.shadowCorrelationId }
        : {}),
    });
  }

  // Rúnir-h435.1 PIN-9: physical prune moves to side-effect phase (same point when shadow
  // off). End-of-call map state matches HEAD on every success path.
  // F5: reuse the same pruneNowMs captured before view-build (not a second wall clock).
  pruneRecentWrites(input.recentWrites, recentWriteTtlMs, pruneNowMs);

  // Persist event packet + nominations + finalize AFTER attempt boundary, still BEFORE
  // applied outcome side effects. Failures leave the attempt unfinalized and never throw
  // into the applied path (PIN-1).
  async function emitAtomicFrameArtifacts(): Promise<void> {
    if (_atomicIsolated === null || _atomicIsolated.activationClass === null) return;
    if (_atomicComputationFailed) return;
    const evalResult = _atomicIsolated;
    // F2: isolated_outcome is the RAW isolated outcome ("judge" stays "judge");
    // isolated_unresolved:"judge_pending" is the separate discriminator.
    const isolatedOutcome = evalResult.isolatedDecision.outcome;
    const guardReason = evalResult.isolatedDecision.guardKeepBoth?.reason ?? null;
    try {
      await createAtomicShadowEvent(input.db, {
        writeEventId,
        isolatedOutcome,
        isolatedMatchedId: evalResult.isolatedDecision.candidate?.id ?? null,
        isolatedReferentProof: evalResult.isolatedDecision.referentProof ?? null,
        isolatedGuardKeepBothReason: guardReason,
        isolatedUnresolved: evalResult.isolatedUnresolved ?? null,
        incomingSnapshotJson: JSON.stringify(evalResult.incomingSnapshot),
        candidateSnapshotJson: evalResult.candidateSnapshot
          ? JSON.stringify(evalResult.candidateSnapshot)
          : null,
        laneClockMs: evalResult.laneClockMs,
        appliedOutcome: decision.outcome,
        appliedMatchedId: decision.candidate?.id ?? null,
      });
    } catch {
      // Packet failure → leave attempt unfinalized; frame reconstructable from attempt alone.
      return;
    }
    const manifestKeys = evalResult.nominations.map((n) => n.nominationCandidateId);
    try {
      for (const nom of evalResult.nominations) {
        await createAtomicShadowNomination(input.db, {
          writeEventId,
          nominationCandidateId: nom.nominationCandidateId,
          candidateSnapshotJson: JSON.stringify(nom.snapshot),
          disposition: nom.disposition,
          ...(nom.selectedCandidateId !== undefined
            ? { selectedCandidateId: nom.selectedCandidateId }
            : {}),
          ...(nom.selectedSignal !== undefined
            ? { selectedSignal: nom.selectedSignal }
            : {}),
        });
      }
    } catch {
      // Nomination writer failure → leave unfinalized.
      return;
    }
    try {
      // READ-BACK exact-SET finalization (R3-2 / R4-1) — never writer-resolution inference.
      await finalizeAtomicShadowAttemptIfComplete(input.db, writeEventId, manifestKeys);
    } catch {
      // Finalizer failure leaves finalized=false.
    }
  }
  await emitAtomicFrameArtifacts();

  // Shared shadow emit: closes over all fields that are constant across the 4 branch sites.
  // Only appliedMemoryId varies per branch. Fire-and-forget (.catch(()=>{}) is inside
  // logSupersedeShadow already; the outer .catch here matches the original call sites).
  function emitShadow(appliedMemoryId: string | null): void {
    if (_shadowWould === null || _shadowBaseline === null) return;
    // Rúnir-pn1l.13.7 D4b / P1#4: unresolved F2 judge escalations emit non-final
    // `judge_pending` (not create/supersede). Covers (a) judge-less WOULD outcome
    // "judge" and (b) shadowJudge non-verdict resolutions stamped judgeUnresolved.
    // EXCLUDED from ordinary diverged pool.
    const wouldOutcomeRaw = _shadowWould.outcome;
    const wouldOutcome =
      wouldOutcomeRaw === "judge" || _shadowWould.judgeUnresolved
        ? "judge_pending"
        : wouldOutcomeRaw;
    const baselineOutcome =
      _shadowBaseline.outcome === "judge" || _shadowBaseline.judgeUnresolved
        ? "judge_pending"
        : _shadowBaseline.outcome;
    const diverged =
      wouldOutcome !== "judge_pending" && baselineOutcome !== wouldOutcome;
    logSupersedeShadow(input.db, {
      appliedMemoryId,
      userId: input.userId,
      scope: input.scope,
      sessionId: input.sessionId,
      source: input.source,
      appliedOutcome: decision.outcome,
      baselineOutcome,
      wouldOutcome,
      diverged,
      liveFlags: {
        cueGate: liveCueGate,
        temporalGuard: temporalGuardEnabled,
        keepBothGuard: keepBothGuardEnabled,
        addSkipGuard: addSkipGuard,
        judgeGate: judgeEnabled,
        f2JudgeConfirm: liveF2JudgeConfirm,
        // Rúnir-h435.1 PIN-5: applied-lane atomicIdentityProof for series segmentation
        // (new-contract rows carry this key; pre-slice-1 rows lack it).
        atomicIdentityProof: liveAtomicAuthority,
      },
      wouldMatchedId: _shadowWould.candidate?.id ?? null,
      wouldCosine: _shadowWould.candidate?.similarity ?? null,
      wouldSignal: _shadowWould.supersedeSignal ?? null,
      wouldReason: _shadowWould.reason,
      wouldBand: _shadowWould.band ?? null,
      baselineMatchedId: _shadowBaseline.candidate?.id ?? null,
      baselineBand: _shadowBaseline.band ?? null,
      incomingTextTrunc: input.text.slice(0, 200),
      // Rúnir-pn1l.13.4 (U5) shadow v2 columns: referent-identity provenance from the WOULD
      // decision — a blocked F1 nomination and/or the verdict+proof that drove a retirement.
      wouldNominationBlocked: _shadowWould.blockedNomination ?? null,
      referentVerdict: _shadowWould.referentVerdict ?? null,
      referentProof: _shadowWould.referentProof ?? null,
      // Rúnir-pn1l.13.6 (Item B): full untruncated incoming text + incoming tags +
      // point-in-time candidate snapshot, so guard-blocked rows are replayable offline.
      incomingTextFull: input.text,
      incomingTagsJson: incomingTags ? JSON.stringify(incomingTags) : null,
      candidateSnapshotJson: _shadowWould.shadowCandidateSnapshot
        ? JSON.stringify(_shadowWould.shadowCandidateSnapshot)
        : null,
      // Rúnir-pn1l.13.7 D5: per-step UUID for replay correlation (prod omits → NONE).
      ...(input.shadowCorrelationId != null
        ? { shadowCorrelationId: input.shadowCorrelationId }
        : {}),
      // Rúnir-h435.1 PIN-4: per-write-event correlation (always minted at entry).
      writeEventId,
    }).catch(() => {});
  }

  // Rúnir-pn1l.13.7 D3 / P1#3: append ledger AFTER applied mutation succeeds.
  // AWAIT so skip/create/supersede does not return before the durable trace
  // settles. Failures are swallowed, logged, and counted via the module-owned
  // counter (handle-independent) — never fail the write (r3-#2).
  async function emitJudgeLedgerAfterApplied(): Promise<void> {
    const row = decision.judgeLedgerPending;
    if (!row) return;
    // Align appliedOutcome with the actual applied decision (guards may have flipped it).
    const appliedOutcome = decision.outcome as "create" | "supersede" | "skip";
    const payload: SupersessionJudgeLedgerRow = {
      ...row,
      appliedOutcome,
      userId: input.userId,
      scope: input.scope,
    };
    // Keep provenance.appliedOutcome in sync if present.
    if (decision.supersessionProvenance) {
      decision.supersessionProvenance = {
        ...decision.supersessionProvenance,
        appliedOutcome,
      };
    }
    try {
      await logSupersessionJudgeLedger(input.db, payload);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Module-owned: works with or without a judge handle (P1#3).
      // Handle.getCounters() reads this same module counter for /health.
      noteLedgerWriteFailure(detail);
    }
  }

  /** Metadata stamp seam for supersedeSignal + F2 supersessionProvenance (D3). */
  function appliedMetadataWithProvenance(
    base: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const hasSignal = !!decision.supersedeSignal;
    const hasProv = !!decision.supersessionProvenance;
    if (!hasSignal && !hasProv) return base;
    return {
      ...(base ?? {}),
      ...(hasSignal ? { supersedeSignal: decision.supersedeSignal } : {}),
      ...(hasProv ? { supersessionProvenance: decision.supersessionProvenance } : {}),
    };
  }

  if (decision.outcome === "skip") {
    rememberWrite(
      input.recentWrites,
      input.text,
      input.embedding,
      input.userId,
      input.scope,
      input.sessionId,
      input.source,
      // Rúnir-pn1l Q4 U2: raw optional replay clock (undefined for prod ⇒ Date.now()).
      input.nowMs,
    );
    const skipResult: ArbitrationResult = {
      outcome: "skip",
      memoryId: decision.candidate?.id,
      matchedMemoryId: decision.candidate?.id,
      reason: decision.reason,
    };
    // Rúnir-pn1l.13.7 D3: skip writes no memory record — ledger is the durable trace.
    // Await so the sole durable trace settles before return (P1#3).
    await emitJudgeLedgerAfterApplied();
    // Emit shadow log after applied branch — applied_memory_id=null for skip (no new row).
    emitShadow(null);
    return skipResult;
  }

  if (decision.outcome === "merge-update") {
    const mergedText = decision.mergedText ?? input.text;
    const mergedEmbedding =
      normalizeText(mergedText) === normalizeText(input.text)
        ? input.embedding
        : await input.embedText(mergedText);

    const continuityMetadata = {
      memoryRole: input.metadata?.memoryRole as MemoryRole | undefined,
      validAt: input.metadata?.validAt as string | undefined,
      continuitySubjectKey: input.metadata?.continuitySubjectKey as string | undefined,
    };
    // Rúnir-h435.1 PIN-7: STORED first, INCOMING second. Never write the incoming
    // triple onto the merged row — only "retain" | "clear".
    const atomicFactAction = mergeAtomicFactAction(
      decision.candidate!.atomicFact,
      input.metadata?.atomicFact,
    );
    // Rúnir-ekos B4: explicit table, never updateMemoryText's own legacy
    // default.
    await updateMemoryText(
      input.db,
      decision.candidate!.id,
      mergedText,
      mergedEmbedding,
      (input.metadata?.writeSource as WriteSource | undefined) ?? input.source,
      atomicFactAction,
      continuityMetadata,
      input.targetTable ?? PRIMARY_MEMORY_TABLE,
    );
    rememberWrite(
      input.recentWrites,
      mergedText,
      mergedEmbedding,
      input.userId,
      input.scope,
      input.sessionId,
      input.source,
      // Rúnir-pn1l Q4 U2: raw optional replay clock (undefined for prod ⇒ Date.now()).
      input.nowMs,
    );
    {
      const lockKey = lockKeyFromMetadata(input.metadata);
      if (input.overlay && lockKey !== null) {
        const entry = buildOverlayEntry(
          input.overlay,
          input.userId,
          decision.candidate!.id,
          mergedText,
          lockKey.factKey,
          lockKey.continuitySubjectKey,
          "merge-update",
        );
        input.overlay.registry.forUser(input.userId).put(lockKey, entry);
        emitMemoryCommitted(input.overlay, entry);
        emitMemoryIndexed(input.overlay, entry);
      }
    }
    const mergeResult: ArbitrationResult = {
      outcome: "merge-update",
      memoryId: decision.candidate!.id,
      mergedIntoId: decision.candidate!.id,
      matchedMemoryId: decision.candidate!.id,
      reason: decision.reason,
    };
    // Shadow log for merge-update (applied_memory_id = the existing merged-into id).
    emitShadow(decision.candidate!.id);
    return mergeResult;
  }

  if (decision.outcome === "supersede") {
    const id = crypto.randomUUID();
    const replacement = {
      id,
      l2: input.text,
      userId: input.userId,
      embedding: input.embedding,
      // Rúnir-w077 / Rúnir-pn1l.13.7 D3: supersedeSignal + optional F2 supersessionProvenance.
      metadata: appliedMetadataWithProvenance(input.metadata as Record<string, unknown> | undefined),
      scope: input.scope,
      sessionId: input.sessionId,
      writeSource: (input.metadata?.writeSource as WriteSource | undefined) ?? input.source,
    };
    // Rúnir-ekos B4: intended default-flip — a direct arbitrateWrite caller
    // that omits targetTable now reaches PRIMARY_MEMORY_TABLE ("semiote")
    // instead of supersedeMemory's legacy "memories" default. This path is
    // production-dead today: writeWithArbitration requires targetTable, and
    // both real callers (hooks/index.ts, memory/index.ts) pass "semiote".
    await supersedeMemory(
      input.db,
      decision.candidate!,
      replacement,
      "deterministic",
      undefined,
      undefined,
      input.targetTable ?? PRIMARY_MEMORY_TABLE,
    );
    rememberWrite(
      input.recentWrites,
      input.text,
      input.embedding,
      input.userId,
      input.scope,
      input.sessionId,
      input.source,
      // Rúnir-pn1l Q4 U2: raw optional replay clock (undefined for prod ⇒ Date.now()).
      input.nowMs,
    );
    {
      const lockKey = lockKeyFromMetadata(input.metadata);
      if (input.overlay && lockKey !== null) {
        // Co-eviction: explicit delete BEFORE put. The prior overlay entry is
        // typically keyed identically to the incoming write (supersession by
        // design preserves the lock key), so delete-then-put on the same key
        // is observably equivalent to put alone — but the explicit delete
        // closes the post-supersede phantom-active window if a future
        // refactor introduces a case where priorLockKey ≠ newLockKey.
        // See ADR 0009 §Phantom-prevention rules.
        const tenantStore = input.overlay.registry.forUser(input.userId);
        tenantStore.delete(lockKey);
        const entry = buildOverlayEntry(
          input.overlay,
          input.userId,
          id,
          input.text,
          lockKey.factKey,
          lockKey.continuitySubjectKey,
          "supersede",
        );
        tenantStore.put(lockKey, entry);
        emitMemoryCommitted(input.overlay, entry);
        emitMemoryIndexed(input.overlay, entry);
      }
    }
    const supersedeResult: ArbitrationResult = {
      outcome: "supersede",
      memoryId: id,
      matchedMemoryId: decision.candidate?.id,
      reason: decision.reason,
    };
    // Rúnir-pn1l.13.7 D3: mutation first, ledger second (awaited — P1#3).
    await emitJudgeLedgerAfterApplied();
    // Shadow log for supersede (applied_memory_id = the new replacement id).
    emitShadow(id);
    return supersedeResult;
  }

  const id = crypto.randomUUID();
  const createMeta = appliedMetadataWithProvenance({
    ...(input.metadata as Record<string, unknown> | undefined),
    writeSource: (input.metadata?.writeSource as WriteSource | undefined) ?? input.source,
    arbitrationOutcome: "create",
  });
  await upsertMemory(
    input.db,
    id,
    input.text,
    input.userId,
    input.embedding,
    createMeta,
    input.scope,
    input.sessionId,
    undefined,
    // Rúnir-ekos B4: explicit table, never upsertMemory's own legacy default.
    input.targetTable ?? PRIMARY_MEMORY_TABLE,
  );
  rememberWrite(
    input.recentWrites,
    input.text,
    input.embedding,
    input.userId,
    input.scope,
    input.sessionId,
    input.source,
    // Rúnir-pn1l Q4 U2: raw optional replay clock (undefined for prod ⇒ Date.now()).
    input.nowMs,
  );
  {
    const lockKey = lockKeyFromMetadata(input.metadata);
    if (input.overlay && lockKey !== null) {
      const entry = buildOverlayEntry(
        input.overlay,
        input.userId,
        id,
        input.text,
        lockKey.factKey,
        lockKey.continuitySubjectKey,
        "create",
      );
      input.overlay.registry.forUser(input.userId).put(lockKey, entry);
      emitMemoryCommitted(input.overlay, entry);
      emitMemoryIndexed(input.overlay, entry);
    }
  }
  const createResult: ArbitrationResult = {
    outcome: "create",
    memoryId: id,
    reason: decision.reason,
  };
  // Rúnir-pn1l.13.7 D3: mutation first, ledger second (awaited — P1#3).
  await emitJudgeLedgerAfterApplied();
  // Shadow log for create (applied_memory_id = the new id).
  emitShadow(id);
  return createResult;
}
