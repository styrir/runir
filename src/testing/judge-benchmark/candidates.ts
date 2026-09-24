import { canonicalHash } from "../model-benchmark/provenance.js";
import {
  DEFAULT_JUDGE_CONFIDENCE_FLOOR,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_TEMPERATURE,
  JUDGE_PROMPT_VERSION_BY_VIEW,
  JUDGE_SYSTEM_PROMPT,
  type JudgeInputView,
} from "../../storage/writes/supersession-judge.js";
import {
  CHOICE_DEFAULT_THRESHOLD,
  JEV_MODEL_ID,
  NOUL_DEFAULT_THRESHOLD,
  PRODUCTION_DUPLICATE_FLOOR,
  type CandidateFamily,
  type CandidateId,
  type Decision,
  type EffectiveDecision,
  type GoldLabel,
  type JudgeBenchmarkRow,
  type JudgePair,
  type JudgeSignals,
  type OutcomeId,
} from "./types.js";

/**
 * Exact noul question frozen from the 2026-09-24 decision-model bake-off prototype.
 * Do not paraphrase: the cassette key covers this text.
 */
export const JEV_NOUL_V1_INSTRUCTIONS =
  "The state contains OLD, an existing stored memory, and NEW, an incoming memory. True if NEW and OLD are about the very same fact — the same status slot moving to a new state, the same subject with a refreshed value, the same task or issue identifying the same fact, the same file location with the same diagnosis, an explicit replacement of OLD, or a restatement of the same claim — so that retiring OLD in favour of NEW loses no still-valid information. False if they are distinct facts that merely share a project, session, file, tool name or topic, or if NEW continues, builds on, or partially overlaps OLD.";

/** Exact choice question from the bake-off. */
export const JEV_CHOICE_V1_QUESTION = {
  type: "choice",
  instructions:
    "The state contains OLD, an existing stored memory, and NEW, an incoming memory. Does NEW make OLD stale?",
  criteria: {
    supersede:
      "NEW replaces OLD because it states a DIFFERENT, current value for the SAME subject and the SAME exclusive attribute (only one value can hold at a time, e.g. the current tech lead, the datastore in use). OLD is now stale.",
    duplicate: "NEW restates the SAME fact as OLD: no new information, same value.",
    independent:
      "NEW and OLD can both be true at once: different subjects, additive detail, a non-exclusive attribute, a sequential move where both were valid in turn, or a CONTINUATION — NEW is the fix, result, follow-up, review verdict, or refinement of the diagnosis, plan, finding, or state that OLD records, so OLD remains valid history.",
  },
} as const;

/** Frozen in the judge-benchmark brief before any fresh-set result. */
export const JEV_NOUL_V2_INSTRUCTIONS =
  "The state contains OLD, an earlier stored memory, and NEW, a later memory. True only if NEW makes OLD stale: both describe the same subject and the same attribute that can hold one value at a time, and NEW gives the current value, or NEW restates exactly the same claim. False if they are different facts, if NEW adds detail, or if NEW is a fix, result, next step or review of what OLD describes, because OLD then remains valid history.";

export const JEV_NOUL_V3_INSTRUCTIONS = "Should OLD be retired because NEW replaces or repeats it?";

export type FrozenCandidate = {
  id: CandidateId;
  label: string;
  family: CandidateFamily;
  modelId: string;
  defaultThreshold: number;
  /** Duplicate decisions are never threshold-fitted. Null for noul lanes. */
  duplicateFloor: number | null;
  /** Question object or judge prompt. Covered by candidateConfigHash. */
  question: unknown;
  /**
   * Hash of the frozen question/prompt, model, and default thresholds.
   * The fitted retire threshold is NOT included: cassettes stay valid across calibration.
   */
  candidateConfigHash: string;
};

function noulQuestion(instructions: string): { type: "noul"; instructions: string } {
  return { type: "noul", instructions };
}

function freeze(candidate: Omit<FrozenCandidate, "candidateConfigHash">): FrozenCandidate {
  const candidateConfigHash = canonicalHash({
    id: candidate.id,
    family: candidate.family,
    modelId: candidate.modelId,
    defaultThreshold: candidate.defaultThreshold,
    duplicateFloor: candidate.duplicateFloor,
    question: candidate.question,
  });
  return { ...candidate, candidateConfigHash };
}

export const JUDGE_CANDIDATES: readonly FrozenCandidate[] = [
  freeze({
    id: "judge-v2",
    label: "Production supersession judge v2",
    family: "judge",
    modelId: DEFAULT_JUDGE_MODEL,
    defaultThreshold: DEFAULT_JUDGE_CONFIDENCE_FLOOR,
    duplicateFloor: PRODUCTION_DUPLICATE_FLOOR,
    question: {
      prompt: JUDGE_SYSTEM_PROMPT,
      promptVersion: JUDGE_PROMPT_VERSION_BY_VIEW.raw,
      temperature: DEFAULT_JUDGE_TEMPERATURE,
    },
  }),
  freeze({
    id: "judge-v3",
    label: "Production supersession judge v3 (provenance blocks stripped)",
    family: "judge",
    modelId: DEFAULT_JUDGE_MODEL,
    defaultThreshold: DEFAULT_JUDGE_CONFIDENCE_FLOOR,
    duplicateFloor: PRODUCTION_DUPLICATE_FLOOR,
    question: {
      prompt: JUDGE_SYSTEM_PROMPT,
      promptVersion: JUDGE_PROMPT_VERSION_BY_VIEW["strip-provenance"],
      temperature: DEFAULT_JUDGE_TEMPERATURE,
      inputView: "strip-provenance-blocks",
    },
  }),
  freeze({
    id: "jev-noul-v1",
    label: "Jev noul v1",
    family: "noul",
    modelId: JEV_MODEL_ID,
    defaultThreshold: NOUL_DEFAULT_THRESHOLD,
    duplicateFloor: null,
    question: noulQuestion(JEV_NOUL_V1_INSTRUCTIONS),
  }),
  freeze({
    id: "jev-choice-v1",
    label: "Jev choice v1",
    family: "choice",
    modelId: JEV_MODEL_ID,
    defaultThreshold: CHOICE_DEFAULT_THRESHOLD,
    duplicateFloor: null,
    question: JEV_CHOICE_V1_QUESTION,
  }),
  freeze({
    id: "jev-noul-v2",
    label: "Jev noul v2",
    family: "noul",
    modelId: JEV_MODEL_ID,
    defaultThreshold: NOUL_DEFAULT_THRESHOLD,
    duplicateFloor: null,
    question: noulQuestion(JEV_NOUL_V2_INSTRUCTIONS),
  }),
  freeze({
    id: "jev-noul-v3",
    label: "Jev noul v3",
    family: "noul",
    modelId: JEV_MODEL_ID,
    defaultThreshold: NOUL_DEFAULT_THRESHOLD,
    duplicateFloor: null,
    question: noulQuestion(JEV_NOUL_V3_INSTRUCTIONS),
  }),
];

const BY_ID = new Map(JUDGE_CANDIDATES.map((candidate) => [candidate.id, candidate]));

const JUDGE_INPUT_VIEW: Partial<Record<CandidateId, JudgeInputView>> = {
  "judge-v2": "raw",
  "judge-v3": "strip-provenance",
};

/** The judge input view a frozen judge-family candidate was defined with. */
export function judgeInputViewFor(candidate: FrozenCandidate): JudgeInputView {
  const view = JUDGE_INPUT_VIEW[candidate.id];
  if (!view) throw new Error(`${candidate.id} has no judge input view`);
  return view;
}

export function candidateById(id: string): FrozenCandidate {
  const candidate = BY_ID.get(id as CandidateId);
  if (!candidate) throw new Error(`Unknown judge-benchmark candidate: ${id}`);
  return candidate;
}

export function isCandidateId(id: string): id is CandidateId {
  return BY_ID.has(id as CandidateId);
}

export type LaneDecision = {
  decision: Decision;
  effectiveDecision: EffectiveDecision;
  retireScore: number | null;
};

function unitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function scoreError(): LaneDecision {
  return { decision: "error", effectiveDecision: "keep", retireScore: null };
}

/**
 * A missing, non-finite, or out-of-range probability is validated before any
 * retire or duplicate choice. Those rows are decision=error and
 * effectiveDecision=keep, so they count in error/coverage.
 */
export function decideLane(
  candidate: FrozenCandidate,
  signals: JudgeSignals | null,
  threshold: number,
): LaneDecision {
  if (!signals || signals.family === "none") return scoreError();
  if (candidate.family === "judge") {
    if (signals.family !== "judge" || !unitInterval(signals.confidence)) return scoreError();
    const retireScore = signals.verdict === "supersede" ? signals.confidence : 0;
    const duplicateFloor = candidate.duplicateFloor ?? PRODUCTION_DUPLICATE_FLOOR;
    let decision: Decision = "keep";
    if (signals.verdict === "supersede" && signals.confidence >= threshold) decision = "retire";
    else if (signals.verdict === "duplicate" && signals.confidence >= duplicateFloor) decision = "duplicate";
    return { decision, effectiveDecision: decision, retireScore };
  }
  if (candidate.family === "noul") {
    if (signals.family !== "noul" || !unitInterval(signals.probability)) return scoreError();
    const decision: Decision = signals.probability >= threshold ? "retire" : "keep";
    return { decision, effectiveDecision: decision, retireScore: signals.probability };
  }
  if (signals.family !== "choice" || !unitInterval(signals.pSupersede)) return scoreError();
  if (signals.argmax === "duplicate") {
    return { decision: "duplicate", effectiveDecision: "duplicate", retireScore: signals.pSupersede };
  }
  if (signals.argmax !== "supersede" && signals.argmax !== "independent") return scoreError();
  const decision: Decision = signals.pSupersede >= threshold ? "retire" : "keep";
  return { decision, effectiveDecision: decision, retireScore: signals.pSupersede };
}

export const OUTCOME_MATRIX: Record<GoldLabel, Record<EffectiveDecision, OutcomeId>> = {
  supersede: {
    retire: "update_landed",
    duplicate: "correction_dropped",
    keep: "missed_update",
  },
  duplicate: {
    retire: "duplicate_as_retire",
    duplicate: "duplicate_as_duplicate",
    keep: "redundant_row",
  },
  independent: {
    retire: "wrong_retirement",
    duplicate: "wrong_skip",
    keep: "correct_keep",
  },
};

export function classifyOutcome(gold: GoldLabel, decision: EffectiveDecision): OutcomeId {
  return OUTCOME_MATRIX[gold][decision];
}

export function headlineGold(pair: JudgePair): GoldLabel {
  return pair.goldHeadline ?? pair.gold.label;
}

export function rowHeadlineGold(row: JudgeBenchmarkRow): GoldLabel {
  return row.gold.headline ?? row.gold.label;
}

export function jevQuestionFor(candidate: FrozenCandidate): unknown {
  if (candidate.family === "judge") {
    throw new Error(`${candidate.id} is not a Jev question lane`);
  }
  return candidate.question;
}

export const JUDGE_PLANNING_USD_PER_MILLION = 0.25;
export const JEV_PLANNING_USD_PER_MILLION = 0.042;
