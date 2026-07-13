import { describe, it, expect } from "vitest";
import { inferNextStepFromBlocker } from "../src/recall/continuity/blocker-next-step.js";

describe("inferNextStepFromBlocker", () => {
  it("returns undefined when no blocker keyword is present", () => {
    expect(inferNextStepFromBlocker("everything is great")).toBeUndefined();
    expect(inferNextStepFromBlocker("just shipped a feature")).toBeUndefined();
  });

  it("handles the 'pending rollout of X to Y' pattern", () => {
    const out = inferNextStepFromBlocker(
      "blocked: pending rollout of feature-flag to production.",
    );
    expect(out).toBeDefined();
    expect(out!).toMatch(/Complete the .*rollout to .*production/);
  });

  it("handles the 'blocked until X lands in Y' pattern", () => {
    const out = inferNextStepFromBlocker(
      "We are blocked until the schema migration lands in production.",
    );
    expect(out).toBeDefined();
    expect(out!).toMatch(/Complete the .*rollout to .*production/);
  });

  it("handles the 'blocked until X is rolled out to Y' variant", () => {
    const out = inferNextStepFromBlocker(
      "Currently blocked until the new config is rolled out to all environments.",
    );
    expect(out).toBeDefined();
    expect(out!).toMatch(/rollout/);
  });

  it("returns undefined when blocker text matches neither pattern", () => {
    expect(
      inferNextStepFromBlocker("blocker: stale credentials in the CI runner"),
    ).toBeUndefined();
  });

  it("normalizes leading articles in the subject", () => {
    const out = inferNextStepFromBlocker(
      "blocked: pending rollout of the API change to the staging cluster.",
    );
    expect(out).toBeDefined();
    expect(out!).not.toContain("the the");
  });

  it("returns undefined when blocker text is empty", () => {
    expect(inferNextStepFromBlocker("")).toBeUndefined();
  });

  it("triggers on 'waiting on' as a blocker synonym", () => {
    const out = inferNextStepFromBlocker(
      "waiting on pending rollout of release-2 to main",
    );
    expect(out).toBeDefined();
  });

  it("does not duplicate 'rollout' when the subject already contains it", () => {
    const out = inferNextStepFromBlocker(
      "blocked: pending rollout of the rollout train to production.",
    );
    expect(out).toBeDefined();
    expect(out!).not.toContain("rollout rollout");
  });

  it("truncates very long rollout completions to <= 120 chars with ellipsis", () => {
    const longSubject = "extremely-long-subject-".repeat(10);
    const longTarget = "extremely-long-target-".repeat(10);
    const out = inferNextStepFromBlocker(
      `blocked: pending rollout of ${longSubject} to ${longTarget}.`,
    );
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(120);
    expect(out!.endsWith("…")).toBe(true);
  });
});
