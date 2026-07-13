import { describe, it, expect } from "vitest";
import { normalizeExtractedFact } from "../capture/extraction/capture.js";
import type { RawExtractedFact } from "../domain/memory/types.js";

describe("normalizeExtractedFact", () => {
  const longText = "A".repeat(200);

  it("missing abstract defaults to first 100 chars of text", () => {
    const result = normalizeExtractedFact({ l2: longText, confidence: 0.8 });
    expect(result.l0).toBe(longText.slice(0, 100));
  });

  it("missing overview defaults to '- ' + abstract", () => {
    const result = normalizeExtractedFact({ l2: "Short fact", confidence: 0.8 });
    expect(result.l1).toBe("- " + result.l0);
  });

  it("missing tags -> empty array", () => {
    const result = normalizeExtractedFact({ l2: "Fact", confidence: 0.8 });
    expect(result.tags).toEqual([]);
  });

  it("tags are lowercased and capped at 10", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `Tag${i}`);
    const result = normalizeExtractedFact({ l2: "Fact", confidence: 0.8, tags });
    expect(result.tags).toHaveLength(10);
    expect(result.tags.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("missing category defaults to 'cases'", () => {
    const result = normalizeExtractedFact({ l2: "Fact", confidence: 0.8 });
    expect(result.category).toBe("cases");
  });

  it("invalid category defaults to 'cases'", () => {
    const result = normalizeExtractedFact({ l2: "Fact", confidence: 0.8, category: "bogus" });
    expect(result.category).toBe("cases");
  });

  it("tier is derived from deterministic rules, not LLM", () => {
    // LLM says "durable" but confidence 0.3 + default category "cases" → ephemeral
    const result = normalizeExtractedFact({ l2: "Fact", confidence: 0.3, tier: "durable" });
    expect(result.tier).toBe("ephemeral");
  });

  it("factKey is derived and present", () => {
    const result = normalizeExtractedFact({ l2: "JWT Expiry Fix details", confidence: 0.8 });
    expect(result.factKey).toMatch(/^cases:/);
    expect(result.factKey.length).toBeGreaterThan(7);
  });

  it("normalizes write-time continuity directives without inventing owner", () => {
    const raw: RawExtractedFact = {
      l2: "Continue the rollout, do not edit generated files, ask for credentials, verify CI, and remember the gRPC decision.",
      confidence: 0.9,
      directives: [
        { kind: "action", polarity: "do", status: "open", text: "Continue the rollout", source: "explicit", confidence: 0.9, evidence: "Continue the rollout" },
        { kind: "avoidance", polarity: "do_not", status: "open", text: "edit generated files", source: "explicit", confidence: 0.9, evidence: "do not edit generated files" },
        { kind: "blocker", polarity: "wait_for", status: "blocked", text: "Credentials are missing", target: "credentials", source: "explicit", confidence: 0.9, evidence: "ask for credentials" },
        { kind: "dependency", polarity: "wait_for", status: "blocked", text: "Staging rollout must land", target: "staging rollout", source: "explicit", confidence: 0.9, evidence: "until staging rollout lands" },
        { kind: "question", polarity: "ask", status: "open", text: "Ask which account to use", source: "explicit", confidence: 0.9, evidence: "ask for credentials" },
        { kind: "verification", polarity: "verify", status: "open", text: "CI is green", source: "explicit", confidence: 0.9, evidence: "verify CI" },
        { kind: "decision", polarity: "decide", status: "done", text: "Use gRPC streaming", source: "explicit", confidence: 0.9, evidence: "remember the gRPC decision" },
      ],
    };

    const result = normalizeExtractedFact(raw);

    expect(result.directives?.map((directive) => directive.kind)).toEqual([
      "action",
      "avoidance",
      "blocker",
      "dependency",
      "question",
      "verification",
      "decision",
    ]);
    expect(result.directives?.[0]).not.toHaveProperty("owner");
    expect(result.directives?.[2]).toEqual(expect.objectContaining({
      polarity: "wait_for",
      status: "blocked",
      target: "credentials",
    }));
  });
});
