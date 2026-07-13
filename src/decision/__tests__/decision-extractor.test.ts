import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  appendDecisionEventsToTrace,
  extractDecisions,
  RATIONALE_MIN_CHARS,
  type DecisionExtractorInput,
} from "../decision-extractor.js";
import type { RetrievalTrace } from "../../recall/selection/retrieval-trace.js";

const GOLDEN_PATH = path.resolve(process.cwd(), "tests/fixtures/decision/golden.jsonl");

function emptyTrace(): RetrievalTrace {
  return {
    query: "test",
    mode: "hybrid",
    startedAt: 0,
    stages: [],
    finalCount: 0,
    totalMs: 0,
  };
}

describe("decision-extractor — golden corpus", () => {
  const lines = readFileSync(GOLDEN_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  it("loads at least one golden line", () => {
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it("each line carries at least one project_decision", () => {
    for (const line of lines) {
      const row = JSON.parse(line) as { events: { type: string }[] };
      expect(row.events.some((e) => e.type === "project_decision")).toBe(true);
    }
  });

  it("each line carries at least one decision_rationale with text length ≥50", () => {
    for (const line of lines) {
      const row = JSON.parse(line) as { events: Array<{ type: string; text?: string }> };
      const rationales = row.events.filter((e) => e.type === "decision_rationale");
      expect(rationales.length).toBeGreaterThanOrEqual(1);
      for (const r of rationales) {
        expect(typeof r.text).toBe("string");
        expect((r.text ?? "").length).toBeGreaterThanOrEqual(RATIONALE_MIN_CHARS);
      }
    }
  });
});

describe("decision-extractor — extractDecisions heuristic", () => {
  it("emits paired project_decision + decision_rationale when both markers present", () => {
    const input: DecisionExtractorInput = {
      sessionId: "s-test",
      turns: [
        {
          role: "assistant",
          text: "We decided to use SurrealDB because it gives us hybrid BM25+vector under one schema and avoids the second-store overhead",
          ts: "2026-04-27T09:00:00Z",
        },
      ],
    };
    const out = extractDecisions(input);
    const projects = out.events.filter((e) => e.type === "project_decision");
    const rationales = out.events.filter((e) => e.type === "decision_rationale");
    expect(projects.length).toBe(1);
    expect(rationales.length).toBe(1);
    expect(rationales[0].type === "decision_rationale" && rationales[0].text.length >= RATIONALE_MIN_CHARS).toBe(true);
    expect(projects[0].decision_id).toBe(rationales[0].decision_id);
  });

  it("emits no events when no decision marker is present", () => {
    const input: DecisionExtractorInput = {
      sessionId: "s-empty",
      turns: [
        { role: "user", text: "What's the time?" },
        { role: "assistant", text: "Around three in the afternoon." },
      ],
    };
    const out = extractDecisions(input);
    expect(out.events.length).toBe(0);
  });

  it("drops a decision when no rationale of ≥50 chars is available", () => {
    const input: DecisionExtractorInput = {
      sessionId: "s-thin",
      turns: [
        { role: "assistant", text: "We chose A. Done." },
      ],
    };
    const out = extractDecisions(input);
    expect(out.events.length).toBe(0);
  });

  it("borrows the next turn as rationale when same-turn rationale is too short", () => {
    const input: DecisionExtractorInput = {
      sessionId: "s-borrow",
      turns: [
        { role: "assistant", text: "We chose option B." },
        {
          role: "assistant",
          text: "Option B was preferred because the team already owns that codepath and the migration cost is roughly zero",
        },
      ],
    };
    const out = extractDecisions(input);
    const projects = out.events.filter((e) => e.type === "project_decision");
    const rationales = out.events.filter((e) => e.type === "decision_rationale");
    expect(projects.length).toBe(1);
    expect(rationales.length).toBe(1);
    expect(rationales[0].type === "decision_rationale" && rationales[0].text.length >= RATIONALE_MIN_CHARS).toBe(true);
  });
});

describe("decision-extractor — appendDecisionEventsToTrace", () => {
  it("maps each project_decision to a TraceLifecycleEventRecallDecision (additive)", () => {
    const trace = emptyTrace();
    const events = extractDecisions({
      sessionId: "s-map",
      turns: [
        {
          role: "assistant",
          text: "Going with the gRPC streaming option because it amortizes the rerank latency across the recall fanout and keeps the client API stable",
          ts: "2026-04-27T09:30:00Z",
        },
      ],
    }).events;

    const updated = appendDecisionEventsToTrace(trace, events);
    expect(updated.lifecycleEvents).toBeDefined();
    expect(updated.lifecycleEvents!.length).toBe(1);
    const evt = updated.lifecycleEvents![0];
    expect(evt.type).toBe("recall_decision");
    if (evt.type === "recall_decision") {
      expect(evt.decision).toBe("accept");
      expect(evt.entryId.startsWith("dec-s-map-")).toBe(true);
      expect(typeof evt.reason).toBe("string");
      expect((evt.reason ?? "").length).toBeGreaterThanOrEqual(RATIONALE_MIN_CHARS);
    }
  });

  it("preserves any pre-existing lifecycleEvents on the trace", () => {
    const trace: RetrievalTrace = {
      ...emptyTrace(),
      lifecycleEvents: [
        { type: "stage_start", stage: "vector", inputCount: 3, tStartedMs: 1 },
      ],
    };
    const events = extractDecisions({
      sessionId: "s-preserve",
      turns: [
        {
          role: "assistant",
          text: "We decided to keep the legacy stage_start event because removing it would break the 12 frozen consumers and trip Gate 3",
          ts: "2026-04-27T09:40:00Z",
        },
      ],
    }).events;
    const updated = appendDecisionEventsToTrace(trace, events);
    expect(updated.lifecycleEvents!.length).toBe(2);
    expect(updated.lifecycleEvents![0].type).toBe("stage_start");
    expect(updated.lifecycleEvents![1].type).toBe("recall_decision");
  });
});
