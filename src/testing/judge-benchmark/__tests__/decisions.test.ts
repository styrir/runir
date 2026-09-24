import { describe, expect, it } from "vitest";
import {
  JEV_NOUL_V2_INSTRUCTIONS,
  JEV_NOUL_V3_INSTRUCTIONS,
  OUTCOME_MATRIX,
  candidateById,
  classifyOutcome,
  decideLane,
} from "../candidates.js";
import { scoreJudgeRows } from "../score.js";
import type { EffectiveDecision, GoldLabel, JudgeBenchmarkRow, JudgeSignals } from "../types.js";
import { makeRow } from "./fixtures.js";

const GOLDS: GoldLabel[] = ["supersede", "duplicate", "independent"];
const DECISIONS: EffectiveDecision[] = ["retire", "duplicate", "keep"];

function scored(gold: GoldLabel, signals: JudgeSignals, candidateId: "judge-v2" | "jev-noul-v1" | "jev-choice-v1"): JudgeBenchmarkRow {
  const candidate = candidateById(candidateId);
  const decision = decideLane(candidate, signals, candidate.defaultThreshold);
  return makeRow({
    pairId: `${gold}-${decision.decision}`,
    candidateId,
    candidateConfigHash: candidate.candidateConfigHash,
    split: "test",
    gold,
    decision: decision.decision,
    effectiveDecision: decision.effectiveDecision,
    retireScore: decision.retireScore,
    signals,
    outcome: classifyOutcome(gold, decision.effectiveDecision),
    latencyMs: 5,
  });
}

describe("lane decision functions", () => {
  const judge = candidateById("judge-v2");
  const noul = candidateById("jev-noul-v1");
  const choice = candidateById("jev-choice-v1");

  it("freezes distinct question hashes for the three noul wordings", () => {
    expect(JEV_NOUL_V3_INSTRUCTIONS).toBe("Should OLD be retired because NEW replaces or repeats it?");
    expect(JEV_NOUL_V2_INSTRUCTIONS.startsWith("The state contains OLD, an earlier stored memory")).toBe(true);
    const hashes = ["jev-noul-v1", "jev-noul-v2", "jev-noul-v3"].map((id) => candidateById(id).candidateConfigHash);
    expect(new Set(hashes).size).toBe(3);
    expect(candidateById("jev-noul-v1").candidateConfigHash).toBe(noul.candidateConfigHash);
  });

  it("applies the judge floor, noul probability, and choice argmax rules", () => {
    expect(decideLane(judge, { family: "judge", verdict: "supersede", confidence: 0.6 }, 0.6).decision).toBe("retire");
    expect(decideLane(judge, { family: "judge", verdict: "supersede", confidence: 0.59 }, 0.6).decision).toBe("keep");
    expect(decideLane(judge, { family: "judge", verdict: "supersede", confidence: 0.59 }, 0.6).retireScore).toBe(0.59);
    expect(decideLane(judge, { family: "judge", verdict: "duplicate", confidence: 0.6 }, 0.99).decision).toBe("duplicate");
    expect(decideLane(judge, { family: "judge", verdict: "duplicate", confidence: 0.59 }, 0.1).decision).toBe("keep");
    expect(decideLane(judge, { family: "judge", verdict: "independent", confidence: 0.99 }, 0.1).retireScore).toBe(0);
    expect(decideLane(judge, null, 0.6)).toEqual({ decision: "error", effectiveDecision: "keep", retireScore: null });

    expect(decideLane(noul, { family: "noul", probability: 0.5 }, 0.5).decision).toBe("retire");
    expect(decideLane(noul, { family: "noul", probability: 0.49 }, 0.5).decision).toBe("keep");
    expect(decideLane(noul, { family: "none" }, 0.5).decision).toBe("error");

    expect(decideLane(choice, { family: "choice", argmax: "duplicate", pSupersede: 0.99 }, 0.1).decision).toBe("duplicate");
    expect(decideLane(choice, { family: "choice", argmax: "supersede", pSupersede: 0.5 }, 0.5).decision).toBe("retire");
    expect(decideLane(choice, { family: "choice", argmax: "independent", pSupersede: 0.49 }, 0.5).decision).toBe("keep");
    expect(decideLane(choice, { family: "choice", argmax: "supersede", pSupersede: null }, 0.5).effectiveDecision).toBe("keep");
    expect(decideLane(choice, { family: "choice", argmax: "supersede", pSupersede: null }, 0.5).decision).toBe("error");
  });

  it("rejects a missing or out-of-range probability before any duplicate or retire", () => {
    for (const pSupersede of [null, Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY]) {
      const decision = decideLane(choice, { family: "choice", argmax: "duplicate", pSupersede }, 0.5);
      expect(decision).toEqual({ decision: "error", effectiveDecision: "keep", retireScore: null });
    }
    expect(decideLane(noul, { family: "noul", probability: 1.2 }, 0.5).decision).toBe("error");
    expect(decideLane(noul, { family: "noul", probability: Number.NaN }, 0.5).decision).toBe("error");
    expect(decideLane(judge, { family: "judge", verdict: "duplicate", confidence: 1.4 }, 0.5).decision).toBe("error");
    expect(decideLane(judge, { family: "judge", verdict: "supersede", confidence: Number.NaN }, 0.5).decision).toBe("error");
    const report = scoreJudgeRows([
      scored("independent", { family: "choice", argmax: "duplicate", pSupersede: null }, "jev-choice-v1"),
    ], "descriptive");
    expect(report.groups[0]?.errorCount).toBe(1);
    expect(report.groups[0]?.wrongSkip).toBe(0);
    expect(report.groups[0]?.harmful).toBe(0);
  });

  it("classifies every gold/decision cell", () => {
    for (const gold of GOLDS) {
      for (const decision of DECISIONS) {
        expect(classifyOutcome(gold, decision)).toBe(OUTCOME_MATRIX[gold][decision]);
      }
    }
    expect(OUTCOME_MATRIX.supersede.duplicate).toBe("correction_dropped");
    expect(OUTCOME_MATRIX.duplicate.retire).toBe("duplicate_as_retire");
    expect(OUTCOME_MATRIX.independent.duplicate).toBe("wrong_skip");
    expect(OUTCOME_MATRIX.independent.retire).toBe("wrong_retirement");
  });

  it("scores each lane through the outcome matrix", () => {
    const rows = [
      scored("supersede", { family: "judge", verdict: "supersede", confidence: 0.8 }, "judge-v2"),
      scored("supersede", { family: "judge", verdict: "duplicate", confidence: 0.8 }, "judge-v2"),
      scored("independent", { family: "judge", verdict: "supersede", confidence: 0.8 }, "judge-v2"),
      scored("duplicate", { family: "judge", verdict: "duplicate", confidence: 0.8 }, "judge-v2"),
      scored("supersede", { family: "noul", probability: 0.8 }, "jev-noul-v1"),
      scored("duplicate", { family: "noul", probability: 0.8 }, "jev-noul-v1"),
      scored("independent", { family: "choice", argmax: "duplicate", pSupersede: 0.1 }, "jev-choice-v1"),
      scored("supersede", { family: "none" }, "judge-v2"),
    ];
    const report = scoreJudgeRows(rows, "descriptive");
    const group = report.groups[0]!;
    expect(group.updateLanded).toBe(2);
    expect(group.correctionDropped).toBe(1);
    expect(group.wrongRetire).toBe(1);
    expect(group.wrongSkip).toBe(1);
    expect(group.duplicateAsRetire).toBe(1);
    expect(group.duplicateAsDuplicate).toBe(1);
    expect(group.errorCount).toBe(1);
    expect(group.gate).toBe("underpowered");
  });
});
