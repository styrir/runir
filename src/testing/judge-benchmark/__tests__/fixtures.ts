import { sha256Text } from "../../model-benchmark/provenance.js";
import type {
  CandidateId,
  Decision,
  EffectiveDecision,
  GoldLabel,
  JudgeBenchmarkRow,
  JudgePair,
  JudgePopulation,
  JudgeSignals,
  JudgeSplit,
  OutcomeId,
  TokenUsage,
} from "../types.js";

const OLD_ID = "11111111-1111-1111-1111-111111111111";
const NEW_ID = "22222222-2222-2222-2222-222222222222";

export function makePair(args: {
  pairId?: string;
  oldText?: string;
  newText?: string;
  oldId?: string;
  newId?: string;
  split?: JudgeSplit;
  population?: JudgePopulation;
  cosine?: number | null;
  gold?: GoldLabel;
} = {}): JudgePair {
  const gold = args.gold ?? "supersede";
  return {
    pairId: args.pairId ?? "p1",
    oldRef: {
      source: "prod:main/main:semiote",
      id: args.oldId ?? OLD_ID,
      sha256: args.oldText !== undefined ? sha256Text(args.oldText) : "a".repeat(64),
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    newRef: {
      source: "prod:main/main:semiote",
      id: args.newId ?? NEW_ID,
      sha256: args.newText !== undefined ? sha256Text(args.newText) : "b".repeat(64),
      createdAt: "2026-07-02T00:00:00.000Z",
    },
    stratum: "c085-095",
    split: args.split ?? "test",
    origin: "fresh-2026-09",
    population: args.population ?? "probability",
    cosine: args.cosine === undefined ? 0.91 : args.cosine,
    gold: {
      label: gold,
      labelA: gold,
      labelB: gold,
      resolution: "agreed",
      spotChecked: false,
      spotCheckVerdict: null,
    },
  };
}

export function makeRow(args: {
  pairId?: string;
  datasetId?: string;
  candidateId?: CandidateId;
  candidateConfigHash?: string;
  split?: JudgeSplit;
  population?: JudgePopulation;
  stratum?: string;
  frame?: JudgeBenchmarkRow["frame"];
  legacyBinaryGold?: boolean;
  gold?: GoldLabel;
  oldRef?: JudgeBenchmarkRow["oldRef"];
  newRef?: JudgeBenchmarkRow["newRef"];
  decision?: Decision;
  effectiveDecision?: EffectiveDecision;
  retireScore?: number | null;
  signals?: JudgeSignals;
  outcome?: OutcomeId | null;
  latencyMs?: number;
  billedCostUsd?: number | null;
  estimatedCostUsd?: number | null;
  usage?: TokenUsage;
} = {}): JudgeBenchmarkRow {
  const gold = args.gold ?? "supersede";
  return {
    schemaVersion: "runir-judge-benchmark/v1",
    runId: "run",
    timestamp: "2026-09-24T00:00:00.000Z",
    pairId: args.pairId ?? "p1",
    datasetId: args.datasetId ?? "demo",
    candidateId: args.candidateId ?? "jev-noul-v1",
    candidateConfigHash: args.candidateConfigHash ?? "hash",
    repetition: 1,
    direction: "forward",
    split: args.split ?? "test",
    population: args.population ?? "probability",
    stratum: args.stratum ?? "c085-095",
    frame: args.frame === undefined ? null : args.frame,
    legacyBinaryGold: args.legacyBinaryGold ?? false,
    gold: {
      label: gold,
      labelA: gold,
      labelB: gold,
      resolution: "agreed",
      headline: gold,
      strict: gold,
    },
    oldRef: args.oldRef ?? { id: "old", sha256: "a".repeat(64) },
    newRef: args.newRef ?? { id: "new", sha256: "b".repeat(64) },
    decision: args.decision ?? "keep",
    effectiveDecision: args.effectiveDecision ?? "keep",
    retireScore: args.retireScore === undefined ? null : args.retireScore,
    signals: args.signals ?? { family: "none" },
    outcome: args.outcome === undefined ? null : args.outcome,
    latencyMs: args.latencyMs ?? 1,
    retryCount: 0,
    usage: args.usage ?? {},
    billedCostUsd: args.billedCostUsd === undefined ? null : args.billedCostUsd,
    estimatedCostUsd: args.estimatedCostUsd === undefined ? null : args.estimatedCostUsd,
  };
}
