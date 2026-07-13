import { describe, it, expect } from "vitest";
import { isNoisyFact } from "../capture/extraction/capture.js";

describe("isNoisyFact", () => {
  // Should reject — noisy
  it("rejects agent denial: 'I don't have information about that'", () => {
    expect(isNoisyFact("I don't have information about that")).toBe(true);
  });

  it("rejects agent denial: 'I cannot access that data'", () => {
    expect(isNoisyFact("I cannot access that data")).toBe(true);
  });

  it("rejects 'as an AI' statements", () => {
    expect(isNoisyFact("As an AI, I can help with that")).toBe(true);
  });

  it("rejects 'as a language model' statements", () => {
    expect(isNoisyFact("As a language model, I have limitations")).toBe(true);
  });

  it("rejects meta-questions about memory", () => {
    expect(isNoisyFact("Do you remember what we discussed?")).toBe(true);
  });

  it("rejects 'can you recall' questions", () => {
    expect(isNoisyFact("Can you recall my preferences?")).toBe(true);
  });

  it("rejects pure acknowledgments", () => {
    expect(isNoisyFact("ok")).toBe(true);
    expect(isNoisyFact("Got it")).toBe(true);
    expect(isNoisyFact("thanks!")).toBe(true);
    expect(isNoisyFact("understood")).toBe(true);
    expect(isNoisyFact("Sure.")).toBe(true);
    expect(isNoisyFact("Noted")).toBe(true);
  });

  it("rejects tool artifacts", () => {
    expect(isNoisyFact("[tool call] something")).toBe(true);
    expect(isNoisyFact("[tool result] data")).toBe(true);
    expect(isNoisyFact("[tool error] failed")).toBe(true);
  });

  it("rejects diagnostic literals", () => {
    expect(isNoisyFact("true")).toBe(true);
    expect(isNoisyFact("null")).toBe(true);
    expect(isNoisyFact("undefined")).toBe(true);
    expect(isNoisyFact("NaN")).toBe(true);
  });

  it("rejects facts shorter than 10 chars", () => {
    expect(isNoisyFact("hi")).toBe(true);
    expect(isNoisyFact("  short  ")).toBe(true);
  });

  // Should accept — real technical facts
  it("accepts: 'User prefers dark mode in VS Code'", () => {
    expect(isNoisyFact("User prefers dark mode in VS Code")).toBe(false);
  });

  it("accepts: 'The SurrealDB RELATE statement requires both source and target to exist'", () => {
    expect(isNoisyFact("The SurrealDB RELATE statement requires both source and target to exist")).toBe(false);
  });

  it("accepts: 'Project uses Hono framework with Bun runtime'", () => {
    expect(isNoisyFact("Project uses Hono framework with Bun runtime")).toBe(false);
  });

  it("accepts: 'API key is stored in OPENROUTER_API_KEY env var'", () => {
    expect(isNoisyFact("API key is stored in OPENROUTER_API_KEY env var")).toBe(false);
  });

  it("accepts longer technical descriptions", () => {
    expect(isNoisyFact("The TOCTOU bug is in the update path between vector search and LLM decision")).toBe(false);
  });
});
