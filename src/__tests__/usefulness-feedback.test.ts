import { describe, expect, it } from "vitest";
import { applyUsefulnessFeedback, initializeUsefulnessState } from "../lifecycle/semion/usefulness-feedback.js";

describe("usefulness-feedback", () => {
  it("initializes a stronger prior from higher confidence", () => {
    const low = initializeUsefulnessState(0.2);
    const high = initializeUsefulnessState(0.9);

    expect(high.usefulnessScore).toBeGreaterThan(low.usefulnessScore);
    expect(high.usefulnessAlpha).toBeGreaterThan(low.usefulnessAlpha);
  });

  it("rewards overlapping successful use", () => {
    const updated = applyUsefulnessFeedback({
      memoryText: "The service writes semiote records from the capture hook.",
      answer: "The capture hook now writes semiote records directly.",
      responseResolution: "explicit_success",
      corrected: false,
      crossSession: false,
      previous: {
        usefulnessAlpha: 2,
        usefulnessBeta: 2,
        usefulnessScore: 0.5,
        retrievedCount: 1,
        usedCount: 0,
        successfulUseCount: 0,
        crossSessionUseCount: 0,
        contradictionCount: 0,
      },
      traceCreatedAt: "2026-04-13T15:00:00.000Z",
      now: "2026-04-13T15:05:00.000Z",
    });

    expect(updated.usefulnessScore).toBeGreaterThan(0.5);
    expect(updated.retrievedCount).toBe(2);
    expect(updated.usedCount).toBe(1);
    expect(updated.successfulUseCount).toBe(1);
    expect(updated.lastEvaluatedAt).toBe("2026-04-13T15:05:00.000Z");
  });

  it("penalizes corrected memories", () => {
    const updated = applyUsefulnessFeedback({
      memoryText: "The current auth provider is legacy-auth.",
      answer: "Correction: the system no longer uses legacy-auth.",
      responseResolution: "failure",
      corrected: true,
      crossSession: false,
      previous: {
        usefulnessAlpha: 3,
        usefulnessBeta: 1,
        usefulnessScore: 0.75,
        retrievedCount: 2,
        usedCount: 2,
        successfulUseCount: 2,
        crossSessionUseCount: 0,
        contradictionCount: 0,
      },
      now: "2026-04-13T15:10:00.000Z",
    });

    expect(updated.usefulnessScore).toBeLessThan(0.75);
    expect(updated.contradictionCount).toBe(1);
    expect(updated.successfulUseCount).toBe(2);
  });
});
