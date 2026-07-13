import { describe, expect, it } from "vitest";
import {
  buildNoemaCompositionDecisionLog,
  replayNoemaCompositionDecision,
  type BuildNoemaCompositionDecisionLogInput,
} from "../noema/composition-log.js";

const baseInput = {
  runId: "run-001",
  createdAt: "2026-05-14T12:00:00.000Z",
  input: {
    userId: "user-1",
    scope: "user",
    path: "/Users/brooks/Code/runir",
    memoryRole: "preference",
    category: "preference",
    sources: [
      {
        id: "semiote:a",
        text: "User prefers compact Noema recall for stable coding preferences.",
      },
      {
        id: "semiote:b",
        text: "User rejects product answers that pass while visibly red.",
      },
    ],
  },
  prompt: {
    promptName: "noema-composer",
    schemaName: "noema-composition-candidate",
    schemaVersion: "1",
    model: "claude-opus-4.7",
    promptText: "Compose a stable Noema from the supplied Semiotes.",
  },
  bounds: {
    maxLlmCalls: 1,
    attemptedLlmCalls: 1,
  },
  rawModelOutput: JSON.stringify({
    canonicalText: "User prefers compact Noema recall for stable coding preferences.",
  }),
  parsedOutput: {
    canonicalText: "User prefers compact Noema recall for stable coding preferences.",
    claimSubject: "noema recall",
    claimPredicate: "preference",
    status: "active",
    supportSemioteIds: ["semiote:a"],
  },
} satisfies BuildNoemaCompositionDecisionLogInput;

describe("Noema composition decision log", () => {
  it("accepts and logs a bounded model candidate without making the model authoritative", () => {
    const log = buildNoemaCompositionDecisionLog(baseInput);

    expect(log.logVersion).toBe("noema-composition-log-v1");
    expect(log.validation.accepted).toBe(true);
    expect(log.validation.claimContract?.claimKey).toMatch(/^[a-f0-9]{32}$/);
    expect(log.validation.claimContract?.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(log.commitDecision).toMatchObject({
      action: "commit",
      reason: "deterministic_validation_passed",
      supportSemioteIds: ["semiote:a"],
    });
    expect(log.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(log.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(log.rawOutputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(log.parsedOutputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects candidates that exceed the per-run LLM call budget or cite unknown support", () => {
    const log = buildNoemaCompositionDecisionLog({
      ...baseInput,
      bounds: {
        maxLlmCalls: 1,
        attemptedLlmCalls: 2,
      },
      parsedOutput: {
        ...baseInput.parsedOutput,
        supportSemioteIds: ["semiote:missing"],
      },
    });

    expect(log.validation.accepted).toBe(false);
    expect(log.validation.errors).toContain("llm_call_budget_exceeded");
    expect(log.validation.errors).toContain("unknown_support_id:semiote:missing");
    expect(log.commitDecision.action).toBe("no_commit");
  });

  it("records conflicts as deterministic no-commit decisions", () => {
    const log = buildNoemaCompositionDecisionLog({
      ...baseInput,
      parsedOutput: {
        ...baseInput.parsedOutput,
        status: "conflicted",
        conflictsWithNoemaIds: ["noema:old"],
      },
    });

    expect(log.validation.accepted).toBe(true);
    expect(log.validation.warnings).toContain("candidate_conflicts_with_existing_noema");
    expect(log.commitDecision).toMatchObject({
      action: "no_commit",
      reason: "candidate_conflict_detected",
      status: "conflicted",
      conflictsWithNoemaIds: ["noema:old"],
    });
  });

  it("treats active candidates with explicit conflicts as no-commit decisions", () => {
    const log = buildNoemaCompositionDecisionLog({
      ...baseInput,
      parsedOutput: {
        ...baseInput.parsedOutput,
        status: "active",
        conflictsWithNoemaIds: ["noema:active-conflict"],
      },
    });

    expect(log.validation.accepted).toBe(true);
    expect(log.commitDecision).toMatchObject({
      action: "no_commit",
      reason: "candidate_conflict_detected",
      status: "conflicted",
      conflictsWithNoemaIds: ["noema:active-conflict"],
    });
  });

  it("replays captured input and captured output to the same deterministic decision", () => {
    const log = buildNoemaCompositionDecisionLog(baseInput);
    const replay = replayNoemaCompositionDecision(log);

    expect(replay.reproduced).toBe(true);
    expect(replay.replayedDecisionHash).toBe(replay.originalDecisionHash);
    expect(replay.replayedLog.parsedOutputHash).toBe(log.parsedOutputHash);
    expect(replay.replayedLog.commitDecision).toEqual(log.commitDecision);
    expect(replay.replayedLog.validation).toEqual(log.validation);
  });

  it("allows singleton deterministic promotion without an LLM output", () => {
    const log = buildNoemaCompositionDecisionLog({
      ...baseInput,
      bounds: {
        maxLlmCalls: 0,
        attemptedLlmCalls: 0,
      },
      rawModelOutput: undefined,
      parsedOutput: null,
      input: {
        ...baseInput.input,
        allowSingletonDeterministicPromotion: true,
        sources: [baseInput.input.sources[0]],
      },
    });

    expect(log.validation.candidateSource).toBe("singleton_deterministic");
    expect(log.validation.accepted).toBe(true);
    expect(log.commitDecision.action).toBe("commit");
    expect(log.commitDecision.supportSemioteIds).toEqual(["semiote:a"]);
  });
});
