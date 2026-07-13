import { describe, expect, it } from "vitest";
import {
  parseRecallResponse,
  parseSessionOpener,
} from "../recall/recall-contract.js";

describe("recall-contract", () => {
  it("parses the structured session opener success variant", () => {
    const parsed = parseRecallResponse({
      prependContext: "<relevant-memories>session_opener</relevant-memories>",
      count: 2,
      retrievalTraceId: "trace-1",
      continuitySource: "deterministic",
      sessionOpener: {
        intent: "continue_previous_work",
        confidence: "high",
        scope: {
          project: "runir",
          area: "src/session-opener.ts",
          path: "/Users/brooks/Code/runir",
        },
        status: "active",
        focus: ["Implement the Zod schema layer"],
        state: ["sessionOpener already returns structured JSON"],
        env: ["service listening on :7700"],
        next: ["Wire the client wrappers"],
        directives: [],
        evidenceTitles: ["Project State / Current Status"],
        warnings: ["path_fallback_used"],
        evidence: {
          projectState: {
            id: "ps-1",
            role: "project_state",
            title: "Project State / Current Status",
            summary: "Current work is session opener contract hardening.",
            updatedAt: "2026-04-02T11:49:24.882Z",
            path: "/Users/brooks/Code/runir",
          },
          handoff: [],
          active: [],
          recentWork: [],
          supplemental: [],
        },
      },
    });

    expect("sessionOpener" in parsed).toBe(true);
    if (!("sessionOpener" in parsed) || !parsed.sessionOpener) {
      throw new Error("expected success variant with sessionOpener");
    }
    expect(parsed.sessionOpener.scope.path).toBe("/Users/brooks/Code/runir");
    expect(parsed.sessionOpener.warnings).toEqual(["path_fallback_used"]);
    expect(parsed.retrievalTraceId).toBe("trace-1");
  });

  it("parses warning and error variants without a session opener", () => {
    expect(parseRecallResponse({ prependContext: null, count: 0, warning: "embedder offline" })).toEqual({
      prependContext: null,
      count: 0,
      warning: "embedder offline",
    });

    expect(parseRecallResponse({ prependContext: null, count: 0, error: "database unavailable" })).toEqual({
      prependContext: null,
      count: 0,
      error: "database unavailable",
    });
  });

  it("rejects unknown keys on the response envelope", () => {
    expect(() => parseRecallResponse({
      prependContext: null,
      count: 0,
      warning: "embedder offline",
      extra: true,
    })).toThrow(/unrecognized key/i);
  });

  it("rejects invalid session opener warnings", () => {
    expect(() => parseSessionOpener({
      intent: "continue_previous_work",
      confidence: "high",
      scope: {},
      status: "active",
      focus: [],
      state: [],
      env: [],
      next: [],
      directives: [],
      evidenceTitles: [],
      warnings: ["not_real"],
      evidence: {
        handoff: [],
        active: [],
        recentWork: [],
        supplemental: [],
      },
    })).toThrow(/invalid option/i);
  });
});
