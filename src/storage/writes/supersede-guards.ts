/**
 * Pure supersede pre-guard predicates (Rúnir-pn1l.2/.7/.8).
 *
 * Extracted from write-arbitrator so tests can spy via `vi.spyOn` on this module
 * without a production-mutable dispatch object (arch-r2 P2).
 */

import type { SimilarCandidate } from "../../domain/memory/types.js";

// Transience cues = "this fact is TEMPORARY" (distinct from CURRENTNESS_CUE_PATTERNS,
// which mean "a change is happening"). They may only FORCE keep-both, never permit a
// supersede. `currently` is deliberately EXCLUDED (Codex brief-gate): "we currently use
// Postgres" is a legitimate durable-state replacement, not a temporary observation.
const TRANSIENCE_CUE_PATTERNS: RegExp[] = [
  /\bfor now\b/,
  /\bfor the moment\b/,
  /\bfor the time being\b/,
  /\btemporarily\b/,
  /\bat the moment\b/,
  /\bright now\b/,
  /\bthis (?:week|month|morning|afternoon|evening|sprint)\b/,
  /\btoday\b/,
  /\btonight\b/,
];

export function hasTransienceCue(text: string): boolean {
  const t = text.toLowerCase();
  return TRANSIENCE_CUE_PATTERNS.some((re) => re.test(t));
}

// Robust to the value shapes that actually reach candidate.validAt/createdAt at runtime:
// the SurrealDB row mapper can yield an ISO string, a `Date`, or (defensively) some other
// datetime-like object. Anything we cannot parse to a finite epoch returns null → the caller
// keeps both. That is the fail-SAFE direction (a wrong supersede is worse than a duplicate).
function parseEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Rúnir-pn1l.8 — the DURABILITY leg of the supersede pre-guard, split out as a
 *  standalone fact-level check (Codex round-1). Returns a keep-both reason (→ the
 *  caller turns supersede into create), or null to PERMIT the supersede.
 *
 *  A transient/ephemeral incoming fact must not overwrite a DURABLE stored fact.
 *  Tier is coarse (events/cases@>=0.9 are marked `durable`), so the incoming's own
 *  explicit non-durable tier OR a text transience cue is the transience signal.
 *
 *  Predicate (must NOT widen — Codex round-1): keep-both IFF
 *  `candidate.tier === "durable"` AND the incoming is *explicitly* transient
 *  (`incomingTier === "ephemeral"` OR `hasTransienceCue(incomingText)`).
 *   - `durable → durable` PERMITS (w077: the newer state of a durable fact supersedes).
 *   - An UNKNOWN incoming tier with no transience cue PERMITS (unknown is not a
 *     transience signal — keep-both-on-unknown is the temporal leg's stance, never this one).
 *
 *  Fact-level so it can run on EVERY supersede/fold path (F1, cue/judge, merge band),
 *  closing Finding 2 (f1_bypass) and Finding 3 (merge-band unreachability). */
export function durableTransientKeepBothReason(
  candidate: SimilarCandidate,
  incomingText: string,
  incomingTier: string | undefined,
): string | null {
  if (candidate.tier === "durable" && incomingTier !== "durable") {
    if (incomingTier === "ephemeral") return "ephemeral-over-durable";
    if (hasTransienceCue(incomingText)) return "transient-over-durable";
  }
  return null;
}

/** Rúnir-pn1l.2/.7 — the TEMPORAL-ORDERING leg of the supersede pre-guard. Returns a
 *  keep-both reason (→ the caller turns supersede into create), or null to PERMIT the
 *  supersede. A supersede must be driven by a fact NEWER than the one it replaces.
 *
 *  pn1l.7: a cue-qualified supersede with NO incoming validAt anchors to ingestion-now
 *  (Zep-style cue→reference-time anchoring at arbitration time — an explicit Runir
 *  adaptation, NOT the Graphiti resolver). ABSENT ⇒ now; UNPARSEABLE ⇒ keep-both
 *  (`invalid-incoming-validAt`, it must NOT silently become now). The candidate side
 *  falls back to `createdAt` (always present in prod). A strictly-older incoming (e.g. a
 *  future-dated candidate vs manufactured-now) keeps both — never supersede on a guess.
 *
 *  This leg stays OFF the F1 (`deterministic_text`) path (w077 — don't temporally-gate
 *  the deterministic same-key correction); only the durability leg extends to F1. */
export function temporalOrderingKeepBothReason(
  candidate: SimilarCandidate,
  incomingValidAt: string | undefined,
  /** Caller supplies the arbitration-time epoch (captured once in arbitrateWrite).
   *  Keeping Date.now() out of this pure function makes it deterministically testable
   *  and ensures the absent-validAt anchor is identical across both call sites in the
   *  same arbitration cycle (resolveDecision + resolveJudgeDecision). */
  nowMs: number,
): string | null {
  let incomingMs: number;
  if (incomingValidAt === undefined || incomingValidAt === "") {
    incomingMs = nowMs; // pn1l.7: ABSENT → anchor to arbitration-now
  } else {
    const parsed = parseEpochMs(incomingValidAt);
    if (parsed === null) return "invalid-incoming-validAt"; // UNPARSEABLE → keep both
    incomingMs = parsed;
  }
  const candidateMs = parseEpochMs(candidate.validAt ?? candidate.createdAt);
  if (candidateMs === null) return "invalid-candidate-time";
  if (incomingMs < candidateMs) return "older-incoming"; // candidate strictly newer → keep both
  return null;
}
