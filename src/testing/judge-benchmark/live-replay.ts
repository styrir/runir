import { DEFAULT_ARBITRATION_CONFIG, type SimilarCandidate } from "../../domain/memory/types.js";
import { resolveDecision } from "../../storage/writes/write-arbitrator.js";
import { buildMergedText } from "../../storage/writes/write-signals.js";
import { normalizeText } from "../../storage/writes/text-normalize.js";

export type LiveFlags = {
  cueGate: boolean; temporalGuard: boolean; keepBothGuard: boolean;
  addSkipGuard: boolean; judgeGate: boolean; f2JudgeConfirm: boolean;
  atomicIdentityProof: boolean;
  f2RequireValueChange?: boolean; mergeKeepBothOnFusion?: boolean;
};
export type ReplayInput = {
  pairId: string; gold: "independent" | "duplicate" | "supersede";
  appliedOutcome: string; oldText: string; incomingText: string;
  oldId: string; oldCreatedAt: string; occurredAt: string;
  cosine: number; oldTags: string[]; incomingTags: string[];
  factKey?: string; atomicFact?: SimilarCandidate["atomicFact"];
  flags: LiveFlags; sameSession: boolean | null;
};
export type ReplayRow = {
  pairId: string; gold: ReplayInput["gold"]; appliedOutcome: string;
  replayOutcome: string | null; reproduced: boolean; unreplayable: string | null;
  signal: "F1" | "F2" | "other" | null; signalDetail: string | null;
  band: string | null; referent: "proven" | "unproven" | "f2_exception" | "conflict" | null;
  mergeKind: "containment_replacement" | "sentence_union" | "longer_text_1200" | null;
  sameSession: boolean | null; oldBeforeDecision: boolean | null; targetMatches: boolean | null;
  neitherContainsOther: boolean | null;
  afterOutcome?: string | null;
};

export function neitherContainsOther(oldText: string, incomingText: string): boolean {
  const oldNorm = normalizeText(oldText), incomingNorm = normalizeText(incomingText);
  return !oldNorm.includes(incomingNorm) && !incomingNorm.includes(oldNorm);
}

export function classifyMerge(oldText: string, incomingText: string): ReplayRow["mergeKind"] {
  const oldNorm = normalizeText(oldText), incomingNorm = normalizeText(incomingText);
  if (oldNorm.includes(incomingNorm) || incomingNorm.includes(oldNorm)) return "containment_replacement";
  const merged = buildMergedText(oldText, incomingText);
  // The helper's only longer-text fallback is the union exceeding 1,200 characters.
  if (merged === oldText || merged === incomingText) return "longer_text_1200";
  return "sentence_union";
}

export function replayLiveRow(input: ReplayInput): ReplayRow {
  const base: ReplayRow = {
    pairId: input.pairId, gold: input.gold, appliedOutcome: input.appliedOutcome,
    replayOutcome: null, reproduced: false, unreplayable: null, signal: null,
    signalDetail: null, band: null, referent: null,
    mergeKind: input.appliedOutcome === "merge-update" && input.oldText && input.incomingText
      ? classifyMerge(input.oldText, input.incomingText) : null,
    sameSession: input.sameSession,
    targetMatches: null,
    neitherContainsOther: input.appliedOutcome === "merge-update" && input.oldText && input.incomingText
      ? neitherContainsOther(input.oldText, input.incomingText) : null,
    oldBeforeDecision: Number.isFinite(Date.parse(input.oldCreatedAt)) && Number.isFinite(Date.parse(input.occurredAt))
      ? Date.parse(input.oldCreatedAt) < Date.parse(input.occurredAt) : null,
  };
  if (!input.oldText || !input.incomingText) return { ...base, unreplayable: "missing_text" };
  if (!Number.isFinite(input.cosine)) return { ...base, unreplayable: "missing_cosine" };
  const nowMs = Date.parse(input.occurredAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(Date.parse(input.oldCreatedAt))) return { ...base, unreplayable: "missing_clock" };
  if (input.flags.judgeGate || input.flags.f2JudgeConfirm || input.flags.temporalGuard || input.flags.atomicIdentityProof) {
    return { ...base, unreplayable: "unsupported_live_flags" };
  }
  const candidate: SimilarCandidate = {
    id: input.oldId, l2: input.oldText, similarity: input.cosine,
    createdAt: input.oldCreatedAt, tags: input.oldTags,
    factKey: input.factKey, atomicFact: input.atomicFact,
  };
  const decision = resolveDecision(
    input.incomingText, [], [candidate], [], DEFAULT_ARBITRATION_CONFIG,
    input.incomingTags, false, input.flags.keepBothGuard, false,
    undefined, undefined, 0, input.flags.addSkipGuard, input.flags.cueGate,
    {}, nowMs, false, false, nowMs,
    input.flags.f2RequireValueChange ?? false, input.flags.mergeKeepBothOnFusion ?? false,
  );
  const reproduced = decision.outcome === input.appliedOutcome;
  return {
    ...base, replayOutcome: decision.outcome, reproduced,
    // The incoming factKey was not logged. A replayed F1 block can hide a live F1
    // proof, so its apparent create/merge/skip cannot be treated as reproduced.
    unreplayable: decision.blockedNomination === "deterministic_text:unproven" ? "incoming_fact_key_missing" : null,
    signal: reproduced && decision.outcome === "supersede"
      ? decision.supersedeSignal === "deterministic_text" ? "F1" : decision.supersedeSignal?.startsWith("extractor_correction:") || decision.supersedeSignal?.startsWith("currentness_cue:") ? "F2" : "other"
      : reproduced && decision.outcome === "merge-update" ? "other" : null,
    signalDetail: reproduced ? decision.supersedeSignal ?? null : null,
    band: reproduced ? decision.band ?? null : null,
    referent: reproduced && ["proven", "unproven", "f2_exception", "conflict"].includes(decision.referentVerdict ?? "")
      ? decision.referentVerdict as ReplayRow["referent"] : null,
    mergeKind: input.appliedOutcome === "merge-update" ? classifyMerge(input.oldText, input.incomingText) : null,
  };
}

export function countBy(rows: readonly ReplayRow[], field: keyof ReplayRow): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) { const key = String(row[field] ?? "none"); out[key] = (out[key] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
