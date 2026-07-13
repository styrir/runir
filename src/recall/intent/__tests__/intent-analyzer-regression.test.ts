/**
 * Regression corpus: asserts that all 17 canonical QueryIntent labels remain
 * classifiable by analyzeIntent(). Tests are additive-only — no label may be
 * deleted or renamed.
 *
 * Story: Rúnir-yod0.5.1 (US-WB-2.2)
 */

import { describe, expect, it } from "vitest";
import { analyzeIntent } from "../intent-analyzer.js";

describe("intent-analyzer regression corpus (17 canonical labels)", () => {
  it('classifies "let\'s continue where we left off" as session_opener', () => {
    const result = analyzeIntent("let's continue where we left off");
    expect(result.label).toBe("session_opener");
  });

  it('classifies "how should we structure the pipeline data flow" as architecture', () => {
    const result = analyzeIntent("how should we structure the pipeline data flow");
    expect(result.label).toBe("architecture");
  });

  it('classifies "what\'s the next step in this sprint" as workflow_posture', () => {
    const result = analyzeIntent("what's the next step in this sprint");
    expect(result.label).toBe("workflow_posture");
  });

  it('classifies "what is the latest state of the auth service" as latest_state', () => {
    const result = analyzeIntent("what is the latest state of the auth service");
    expect(result.label).toBe("latest_state");
  });

  it('classifies "exact lookup for user record 42" as exact_lookup', () => {
    const result = analyzeIntent("exact lookup for user record 42");
    expect(result.label).toBe("exact_lookup");
  });

  it('classifies "show me the decision trace for the database choice" as decision_trace', () => {
    const result = analyzeIntent("show me the decision trace for the database choice");
    expect(result.label).toBe("decision_trace");
  });

  it('classifies "explore the entire authentication landscape" as exploratory_topic', () => {
    const result = analyzeIntent("explore the entire authentication landscape");
    expect(result.label).toBe("exploratory_topic");
  });

  it('classifies "mixed bag of questions today" as unknown_mixed', () => {
    const result = analyzeIntent("mixed bag of questions today");
    expect(result.label).toBe("unknown_mixed");
  });

  it('classifies "what is my preferred code style for TypeScript" as preference', () => {
    const result = analyzeIntent("what is my preferred code style for TypeScript");
    expect(result.label).toBe("preference");
  });

  it('classifies "why did we choose that approach for retries" as decision', () => {
    const result = analyzeIntent("why did we choose that approach for retries");
    expect(result.label).toBe("decision");
  });

  it('classifies "what are we working on right now" as current_status', () => {
    const result = analyzeIntent("what are we working on right now");
    expect(result.label).toBe("current_status");
  });

  it('classifies "summarize MIM-123 changes" as recent_work', () => {
    const result = analyzeIntent("summarize MIM-123 changes");
    expect(result.label).toBe("recent_work");
  });

  it('classifies "what fields does SearchHit expose" as schema', () => {
    const result = analyzeIntent("what fields does SearchHit expose");
    expect(result.label).toBe("schema");
  });

  it('classifies "this test failure in vitest is blocking the build" as debugging', () => {
    const result = analyzeIntent("this test failure in vitest is blocking the build");
    expect(result.label).toBe("debugging");
  });

  it('classifies "tell me about the authentication module" as entity', () => {
    const result = analyzeIntent("tell me about the authentication module");
    expect(result.label).toBe("entity");
  });

  it('classifies "when did we deploy the last release" as event', () => {
    const result = analyzeIntent("when did we deploy the last release");
    expect(result.label).toBe("event");
  });

  it('classifies a neutral query with no matching keywords as fact (fallback)', () => {
    const result = analyzeIntent("the value returned by that calculation");
    expect(result.label).toBe("fact");
  });

  // Structural invariants
  it("returns confidence 0.8 for pattern-matched labels", () => {
    const result = analyzeIntent("tell me about the cache module");
    expect(result.confidence).toBe(0.8);
  });

  it("returns confidence 0.3 for fact (fallback)", () => {
    const result = analyzeIntent("the value returned by that calculation");
    expect(result.confidence).toBe(0.3);
  });

  it('returns session_opener when hint="opener" regardless of query text', () => {
    const result = analyzeIntent("anything at all", { hint: "opener" });
    expect(result.label).toBe("session_opener");
    expect(result.confidence).toBe(0.95);
  });
});
