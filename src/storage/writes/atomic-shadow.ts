/**
 * Rúnir-h435.1 PIN-8: atomic-isolated counterfactual evaluation (single entry point).
 *
 * Runs REAL `resolveDecision` with applied-lane params EXCEPT `atomicAuthority: true`.
 * Nomination instrumentation is observation-only: pure `wouldSupersedeTexts` over every
 * ELIGIBLE candidate (applied floor + withinHours window + areAnswerDistinctTexts screen
 * identical to findSupersedeTarget) INCLUDING anchor-conflict-vetoed ones.
 * Never mutates applied state; findSupersedeTarget itself is UNCHANGED.
 * No LLM calls: outcome "judge" ⇒ isolated_unresolved "judge_pending" (never safety activation).
 */
import type {
  ArbitrationConfig,
  ArbitrationDecision,
  AtomicCandidateSnapshot,
  AtomicIncomingSnapshot,
  AtomicNominationDisposition,
  AtomicShadowActivationClass,
  MemoryAtomicFact,
  RecentWrite,
  SimilarCandidate,
} from "../../domain/memory/types.js";
import { areAnswerDistinctTexts } from "../../domain/memory/exact-qa.js";
import { proveReferentIdentity } from "./referent-identity.js";
import type { ReferentKeys } from "./referent-identity.js";
import {
  atomicFactIdentity,
  candidateReferentKeys,
} from "./referent-keys.js";
import { wouldSupersedeTexts } from "./write-signals.js";
// REAL resolveDecision — circular import is safe: only invoked after both modules load.
import { resolveDecision } from "./write-arbitrator.js";

export type AtomicNominationRecord = {
  nominationCandidateId: string;
  snapshot: AtomicCandidateSnapshot;
  disposition: AtomicNominationDisposition;
  selectedCandidateId?: string;
  selectedSignal?: string;
};

export type AtomicIsolatedEvaluation = {
  isolatedDecision: ArbitrationDecision;
  /** Set when isolated outcome is "judge" — never a safety activation. */
  isolatedUnresolved?: "judge_pending";
  nominations: AtomicNominationRecord[];
  /**
   * PIN-2 class for attempt-row creation, or null when no attempt row is required
   * (neither safety activation nor ≥1 F1 nomination).
   */
  activationClass: Exclude<AtomicShadowActivationClass, "computation_failed"> | null;
  retiredCandidateId?: string;
  incomingSnapshot: AtomicIncomingSnapshot;
  candidateSnapshot?: AtomicCandidateSnapshot;
  laneClockMs: number;
};

export type AtomicIsolatedEvaluationInput = {
  text: string;
  recentCandidates: RecentWrite[];
  similarCandidates: SimilarCandidate[];
  embedding: number[];
  config: ArbitrationConfig;
  incomingTags?: string[];
  /** Applied-lane flag values (isolated does NOT force flip-bundle ON). */
  judgeEnabled: boolean;
  keepBothGuardEnabled: boolean;
  temporalGuardEnabled: boolean;
  incomingValidAt?: string;
  incomingTier?: string;
  /** Applied temporal-guard anchor (identical to applied lane). */
  arbitrationNowMs: number;
  additiveSkipGuard: boolean;
  cueGateParam: boolean;
  incomingKeys: ReferentKeys;
  f2JudgeConfirm: boolean;
  /** Shared lane clock: withinHours + atomic guard unit + persisted lane_clock_ms. */
  laneClockMs: number;
  /** Applied decision for PIN-2 safety-activation comparison. */
  appliedDecision: ArbitrationDecision;
  /** Incoming metadata fields for decision-time snapshot. */
  incomingAtomicFact?: unknown;
  incomingTierMeta?: string;
  incomingValidAtMeta?: string;
};

function withinHours(candidate: SimilarCandidate, maxHours: number, nowMs: number): boolean {
  const reference = candidate.updatedAt ?? candidate.createdAt;
  const referenceMs = Date.parse(reference);
  if (Number.isNaN(referenceMs)) return false;
  return nowMs - referenceMs <= maxHours * 3600 * 1000;
}

/** Deep-copy helper — decision-time snapshots must not alias nested source objects (B-4). */
function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

function isEligible(
  candidate: SimilarCandidate,
  text: string,
  config: ArbitrationConfig,
  laneClockMs: number,
): boolean {
  const floor = config.supersedeCandidateFloor ?? config.mergeThreshold;
  if (candidate.similarity < floor) return false;
  if (!withinHours(candidate, config.mergeWindowHours, laneClockMs)) return false;
  if (areAnswerDistinctTexts(candidate.l2, text)) return false;
  return true;
}

function snapshotCandidateAtomic(c: SimilarCandidate): AtomicCandidateSnapshot {
  const keys = candidateReferentKeys(c);
  return {
    id: c.id,
    text: c.l2,
    tags: c.tags ? deepClone(c.tags) : null,
    atomicFact: c.atomicFact ? deepClone(c.atomicFact) : null,
    tier: c.tier ?? null,
    validAt: c.validAt ?? null,
    createdAt: c.createdAt ?? null,
    referentKeys: {
      factKey: keys.factKey ?? null,
      continuitySubjectKey: keys.continuitySubjectKey ?? null,
      atomicFactIdentity: keys.atomicFactIdentity ?? null,
    },
  };
}

function snapshotIncoming(input: AtomicIsolatedEvaluationInput): AtomicIncomingSnapshot {
  const raw = input.incomingAtomicFact;
  const identity = atomicFactIdentity(raw);
  let canonicalTriple: AtomicIncomingSnapshot["canonicalTriple"] = null;
  if (
    raw !== null &&
    typeof raw === "object" &&
    identity !== undefined
  ) {
    const f = raw as MemoryAtomicFact;
    if (
      typeof f.subject === "string" &&
      typeof f.predicate === "string" &&
      typeof f.value === "string"
    ) {
      // Store the canonical identity's subject|predicate parts + raw value (trim-preserved).
      const parts = identity.split("|");
      canonicalTriple = {
        subject: parts[0] ?? f.subject,
        predicate: parts[1] ?? f.predicate,
        value: f.value,
      };
    }
  }
  return {
    text: input.text,
    tags: input.incomingTags ? deepClone(input.incomingTags) : null,
    atomicFact:
      raw !== null && raw !== undefined && typeof raw === "object"
        ? deepClone(raw as MemoryAtomicFact)
        : null,
    canonicalIdentity: identity ?? null,
    canonicalTriple,
    tier: input.incomingTierMeta ?? null,
    validAt: input.incomingValidAtMeta ?? null,
  };
}

/**
 * Single entry point (PIN-8). Pure CPU over already-fetched candidates — no I/O, no env reads.
 */
export function computeAtomicIsolatedEvaluation(
  input: AtomicIsolatedEvaluationInput,
): AtomicIsolatedEvaluation {
  const {
    text,
    recentCandidates,
    similarCandidates,
    embedding,
    config,
    incomingTags,
    judgeEnabled,
    keepBothGuardEnabled,
    temporalGuardEnabled,
    incomingValidAt,
    incomingTier,
    arbitrationNowMs,
    additiveSkipGuard,
    cueGateParam,
    incomingKeys,
    f2JudgeConfirm,
    laneClockMs,
    appliedDecision,
  } = input;

  // Isolated lane = applied params EXCEPT atomicAuthority: true. No second Date.now().
  const isolatedDecision = resolveDecision(
    text,
    recentCandidates,
    similarCandidates,
    embedding,
    config,
    incomingTags,
    judgeEnabled,
    keepBothGuardEnabled,
    temporalGuardEnabled,
    incomingValidAt,
    incomingTier,
    arbitrationNowMs,
    additiveSkipGuard,
    cueGateParam,
    incomingKeys,
    laneClockMs, // withinHoursNowMs — shared lane clock (R2-3)
    f2JudgeConfirm,
    /* atomicAuthority */ true,
    laneClockMs,
  );

  const isolatedUnresolved: "judge_pending" | undefined =
    isolatedDecision.outcome === "judge" ? "judge_pending" : undefined;

  // ── F1 nomination instrumentation (observation-only; includes veto-short-circuited) ──
  // Guard keep-both: the guarded candidate is the "selected" proven target for frame
  // labeling (disposition guard-kept-both); other proven noms are proven-not-selected.
  const isGuardKeepBoth = isolatedDecision.guardKeepBoth !== undefined;
  const selectedId =
    isolatedDecision.outcome === "supersede" || isGuardKeepBoth
      ? isolatedDecision.candidate?.id
      : undefined;
  const selectedSignal =
    isolatedDecision.outcome === "supersede"
      ? isolatedDecision.supersedeSignal
      : isGuardKeepBoth
        ? isolatedDecision.guardKeepBoth!.signal
        : undefined;

  // Dedup BY CONSTRUCTION on (write_event_id, nomination_candidate_id) — unique candidate ids.
  const seenIds = new Set<string>();
  const nominations: AtomicNominationRecord[] = [];

  for (const candidate of similarCandidates) {
    if (!isEligible(candidate, text, config, laneClockMs)) continue;
    if (!wouldSupersedeTexts(candidate.l2, text)) continue;
    if (seenIds.has(candidate.id)) continue;
    seenIds.add(candidate.id);

    const referent = proveReferentIdentity({
      candidateText: candidate.l2,
      incomingText: text,
      candidateKeys: candidateReferentKeys(candidate),
      incomingKeys,
      atomicAuthority: true,
    });

    let disposition: AtomicNominationDisposition;
    let selectedCandidateId: string | undefined;
    let selectedSignalOut: string | undefined;

    if (referent.verdict === "conflict") {
      disposition = "anchor-vetoed";
    } else if (referent.verdict !== "proven") {
      disposition = "unproven-blocked";
    } else if (selectedId !== undefined && selectedId === candidate.id) {
      // Selected proven: retired via supersede, or kept-both via atomic guard.
      disposition = isGuardKeepBoth ? "guard-kept-both" : "proven-retired";
    } else if (selectedId !== undefined && selectedId !== candidate.id) {
      disposition = "proven-not-selected";
      selectedCandidateId = selectedId;
      selectedSignalOut = selectedSignal;
    } else {
      // Proven nomination present but isolated did not supersede / guard-select this id
      // (e.g. F2 won selection, or fall-through create without guardKeepBoth).
      disposition = "proven-not-selected";
    }

    nominations.push({
      nominationCandidateId: candidate.id,
      snapshot: snapshotCandidateAtomic(candidate),
      disposition,
      ...(selectedCandidateId !== undefined ? { selectedCandidateId } : {}),
      ...(selectedSignalOut !== undefined ? { selectedSignal: selectedSignalOut } : {}),
    });
  }

  // PIN-2: safety activation = isolated supersede AND (applied ≠ supersede OR different target).
  // judge_pending is NEVER a safety activation.
  let activationClass: AtomicIsolatedEvaluation["activationClass"] = null;
  let retiredCandidateId: string | undefined;

  if (
    isolatedUnresolved === undefined &&
    isolatedDecision.outcome === "supersede" &&
    isolatedDecision.candidate
  ) {
    const isolatedTarget = isolatedDecision.candidate.id;
    const appliedIsSupersede = appliedDecision.outcome === "supersede";
    const appliedTarget = appliedDecision.candidate?.id;
    if (!appliedIsSupersede || appliedTarget !== isolatedTarget) {
      activationClass = "safety_activation";
      retiredCandidateId = isolatedTarget;
    }
  }

  if (activationClass === null && nominations.length > 0) {
    activationClass = "efficacy_only";
  }

  const incomingSnapshot = snapshotIncoming(input);
  const candidateSnapshot =
    isolatedDecision.candidate !== undefined
      ? snapshotCandidateAtomic(isolatedDecision.candidate)
      : undefined;

  return {
    isolatedDecision,
    ...(isolatedUnresolved !== undefined ? { isolatedUnresolved } : {}),
    nominations,
    activationClass,
    ...(retiredCandidateId !== undefined ? { retiredCandidateId } : {}),
    incomingSnapshot,
    ...(candidateSnapshot !== undefined ? { candidateSnapshot } : {}),
    laneClockMs,
  };
}

/** PIN-3 pair_key encoding: write_event_id + NUL + retired_candidate_id. */
export function atomicPairKey(writeEventId: string, retiredCandidateId: string): string {
  return `${writeEventId}\u0000${retiredCandidateId}`;
}
