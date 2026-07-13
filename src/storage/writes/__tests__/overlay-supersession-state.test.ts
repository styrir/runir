import { describe, expect, it } from "vitest";
import {
  buildOverlayKey,
  decideOverlayOutcome,
  shouldEngageOverlay,
} from "../overlay-supersession.js";

describe("overlay-supersession state machine — 4 outcomes match ArbitrationOutcome", () => {
  it("outcome 'create' when no existing record on the lock key", () => {
    const decision = decideOverlayOutcome({
      factKey: "preference:editor",
      continuitySubjectKey: "user:alice",
      existing: undefined,
      incomingText: "Use VS Code",
    });
    expect(decision.outcome).toBe("create");
  });

  it("outcome 'skip' on exact normalized text match", () => {
    const decision = decideOverlayOutcome({
      factKey: "preference:editor",
      continuitySubjectKey: "user:alice",
      existing: { id: "mem-1", text: "Use VS Code" },
      incomingText: "use   vs code",
    });
    expect(decision.outcome).toBe("skip");
    if (decision.outcome === "skip") {
      expect(decision.matchedId).toBe("mem-1");
    }
  });

  it("outcome 'merge-update' on text containment", () => {
    const decision = decideOverlayOutcome({
      factKey: "preference:editor",
      continuitySubjectKey: "user:alice",
      existing: { id: "mem-1", text: "Use VS Code" },
      incomingText: "Use VS Code with the Vim keymap",
    });
    expect(decision.outcome).toBe("merge-update");
    if (decision.outcome === "merge-update") {
      expect(decision.mergeWithId).toBe("mem-1");
    }
  });

  it("outcome 'supersede' on conflicting text", () => {
    const decision = decideOverlayOutcome({
      factKey: "preference:editor",
      continuitySubjectKey: "user:alice",
      existing: { id: "mem-1", text: "Use VS Code" },
      incomingText: "Use Sublime Text",
    });
    expect(decision.outcome).toBe("supersede");
    if (decision.outcome === "supersede") {
      expect(decision.supersedesId).toBe("mem-1");
    }
  });
});

describe("overlay-supersession lock key — (factKey, continuitySubjectKey)", () => {
  it("buildOverlayKey returns the tuple when both fields are present", () => {
    expect(buildOverlayKey("fact-1", "subject-1")).toEqual({
      factKey: "fact-1",
      continuitySubjectKey: "subject-1",
    });
  });

  it("shouldEngageOverlay is true only when both fields are populated", () => {
    expect(shouldEngageOverlay("fact-1", "subject-1")).toBe(true);
    expect(shouldEngageOverlay(null, "subject-1")).toBe(false);
    expect(shouldEngageOverlay("fact-1", null)).toBe(false);
    expect(shouldEngageOverlay(null, null)).toBe(false);
  });

  it("disengaged overlay (nullable lock key) returns 'create' with bypass reason", () => {
    const decision = decideOverlayOutcome({
      factKey: null,
      continuitySubjectKey: "subject-1",
      existing: { id: "mem-1", text: "anything" },
      incomingText: "anything else",
    });
    expect(decision.outcome).toBe("create");
    expect(decision.reason).toContain("overlay disengaged");
  });
});
