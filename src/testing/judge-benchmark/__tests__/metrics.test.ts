import { describe, expect, it } from "vitest";
import { candidateById } from "../candidates.js";
import { fitRetireThreshold } from "../calibrate.js";
import { auroc, expectedCalibrationError, wilsonUpper } from "../metrics.js";
import type { JudgeBenchmarkRow, JudgeSignals } from "../types.js";
import { makeRow } from "./fixtures.js";

function row(args: {
  pairId: string;
  gold: "supersede" | "duplicate" | "independent";
  signals: JudgeSignals;
  retireScore: number | null;
}): JudgeBenchmarkRow {
  return makeRow({
    pairId: args.pairId,
    split: "calibration",
    gold: args.gold,
    signals: args.signals,
    retireScore: args.retireScore,
  });
}

describe("wilson, auroc, and ece", () => {
  it("keeps the n=100 harmful gate at x <= 4", () => {
    expect(wilsonUpper(0, 0)).toBe(1);
    expect(wilsonUpper(0, 100)).toBeGreaterThan(0.03);
    expect(wilsonUpper(0, 100)).toBeLessThan(0.04);
    expect(wilsonUpper(4, 100)).toBeLessThan(0.1);
    expect(wilsonUpper(5, 100)).toBeGreaterThanOrEqual(0.1);
    expect(wilsonUpper(0, 35)).toBeLessThan(0.1);
    expect(wilsonUpper(0, 34)).toBeGreaterThanOrEqual(0.1);
  });

  it("scores AUROC with ties and empty classes", () => {
    expect(auroc([1], [0])).toBe(1);
    expect(auroc([0], [1])).toBe(0);
    expect(auroc([1, 0], [0, 1])).toBe(0.5);
    expect(auroc([], [0.2])).toBeNull();
    expect(auroc([0.2], [])).toBeNull();
  });

  it("computes 10-bin ECE and returns null when there is nothing to score", () => {
    const ece = expectedCalibrationError([0.05, 0.95], [0, 1]);
    expect(ece).toBeCloseTo(0.05, 6);
    expect(expectedCalibrationError([], [])).toBeNull();
  });
});

describe("threshold fit", () => {
  it("breaks recall ties toward the highest threshold", () => {
    const candidate = candidateById("jev-noul-v1");
    const rows = [
      row({ pairId: "pos", gold: "supersede", signals: { family: "noul", probability: 0.95 }, retireScore: 0.95 }),
      ...Array.from({ length: 34 }, (_, index) => row({
        pairId: `neg-${index}`,
        gold: "independent",
        signals: { family: "noul", probability: 0.1 },
        retireScore: 0.1,
      })),
    ];
    const fit = fitRetireThreshold({ rows, candidate, thresholds: [0.95, 0.5] });
    expect(fit.thresholdSource).toBe("fitted");
    expect(fit.threshold).toBe(0.95);
    expect(fit.updateLanded).toBe(1);
    expect(fit.harmful).toBe(0);
  });

  it("prefers the lower threshold when it catches more updates", () => {
    const candidate = candidateById("jev-noul-v1");
    const rows = [
      row({ pairId: "high", gold: "supersede", signals: { family: "noul", probability: 0.95 }, retireScore: 0.95 }),
      row({ pairId: "low", gold: "supersede", signals: { family: "noul", probability: 0.4 }, retireScore: 0.4 }),
      ...Array.from({ length: 33 }, (_, index) => row({
        pairId: `neg-${index}`,
        gold: "independent",
        signals: { family: "noul", probability: 0.05 },
        retireScore: 0.05,
      })),
    ];
    const fit = fitRetireThreshold({ rows, candidate });
    expect(fit.threshold).toBe(0.4);
    expect(fit.updateLanded).toBe(2);
  });

  it("emits no_qualifying_threshold when every candidate threshold stays harmful", () => {
    const candidate = candidateById("jev-noul-v1");
    const rows = Array.from({ length: 35 }, (_, index) => row({
      pairId: `neg-${index}`,
      gold: "independent",
      signals: { family: "noul", probability: 1 },
      retireScore: 1,
    }));
    const fit = fitRetireThreshold({ rows, candidate });
    expect(fit.thresholdSource).toBe("no_qualifying_threshold");
    expect(fit.threshold).toBe(candidate.defaultThreshold);
  });

  it("counts duplicate decisions as harmful at every threshold", () => {
    const candidate = candidateById("judge-v2");
    const rows = Array.from({ length: 35 }, (_, index) => row({
      pairId: `dup-${index}`,
      gold: "independent",
      signals: { family: "judge", verdict: "duplicate", confidence: 0.9 },
      retireScore: 0,
    }));
    const low = fitRetireThreshold({ rows, candidate, thresholds: [0.99] });
    const high = fitRetireThreshold({ rows, candidate, thresholds: [0.2] });
    expect(low.harmful).toBe(35);
    expect(high.harmful).toBe(35);
    expect(low.thresholdSource).toBe("no_qualifying_threshold");
    expect(high.thresholdSource).toBe("no_qualifying_threshold");
  });

  it("treats an empty positive class as a tie on zero recall", () => {
    const candidate = candidateById("jev-noul-v1");
    const rows = Array.from({ length: 35 }, (_, index) => row({
      pairId: `neg-${index}`,
      gold: "independent",
      signals: { family: "noul", probability: 0.01 },
      retireScore: 0.01,
    }));
    const fit = fitRetireThreshold({ rows, candidate, thresholds: [0.2, 0.8] });
    expect(fit.thresholdSource).toBe("fitted");
    expect(fit.threshold).toBe(0.8);
    expect(fit.updateRecall).toBeNull();
    expect(fit.harmful).toBe(0);
  });
});
