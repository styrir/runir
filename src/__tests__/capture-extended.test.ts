import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractMemories,
  segmentAndSummarize,
  batchDedupFacts,
  normalizeCaptureMessages,
  stripPlatformMetadata,
  isNoisyFact,
  isValidCategory,
  resolveTier,
  djb2Hash,
  deriveFactKey,
  normalizeTags,
  canonicalizeFactKey,
  normalizeExtractedFact,
  resolveCapturePrompt,
} from "../capture/extraction/capture.js";
import type { ExtractedFact, RawExtractedFact } from "../domain/memory/types.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── extractMemories — error paths ────────────────────────────────────────────

describe("extractMemories — error paths", () => {
  it("returns empty on fetch network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
    const facts = await extractMemories([{ role: "user", content: "hi" }], "prompt", "key");
    expect(facts).toEqual([]);
  });

  it("returns empty on AbortError (timeout)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const facts = await extractMemories([{ role: "user", content: "hi" }], "prompt", "key");
    expect(facts).toEqual([]);
  });

  it("returns empty on invalid JSON response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json" } }] }),
    } as Response);
    const facts = await extractMemories([{ role: "user", content: "hi" }], "prompt", "key");
    expect(facts).toEqual([]);
  });

  it("returns empty when facts is not array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: "not array" }) } }] }),
    } as Response);
    const facts = await extractMemories([{ role: "user", content: "hi" }], "prompt", "key");
    expect(facts).toEqual([]);
  });

  it("handles markdown-fenced JSON response", async () => {
    const payload = JSON.stringify({ facts: [{ l2: "a fact about testing software", confidence: 0.9 }] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "```json\n" + payload + "\n```" } }] }),
    } as Response);
    const facts = await extractMemories([{ role: "user", content: "hi" }], "prompt", "key");
    expect(facts).toHaveLength(1);
  });

  it("calls onReject for low-confidence facts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ facts: [{ l2: "low conf fact", confidence: 0.3 }] }) } }],
      }),
    } as Response);
    const onReject = vi.fn();
    await extractMemories([{ role: "user", content: "hi" }], "prompt", "key", undefined, onReject);
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ confidence: 0.3 }), "low-confidence");
  });

  it("uses custom model and timeout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }),
    } as Response);
    await extractMemories([{ role: "user", content: "hi" }], "prompt", "key", undefined, undefined, {
      timeoutMs: 5000,
      model: "custom-model",
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.model).toBe("custom-model");
  });
});

// ── segmentAndSummarize ──────────────────────────────────────────────────────

describe("segmentAndSummarize", () => {
  it("returns topics from valid LLM response", async () => {
    const topics = [{ title: "Topic 1", summary: "Summary 1" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics }) } }] }),
    } as Response);

    const result = await segmentAndSummarize([{ role: "user", content: "hello" }], "key");
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0].title).toBe("Topic 1");
  });

  it("returns empty topics on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const logger = vi.fn();
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key", logger);
    expect(result.topics).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("fetch error"));
  });

  it("returns empty topics on AbortError", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(err);
    const logger = vi.fn();
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key", logger);
    expect(result.topics).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("aborted"));
  });

  it("returns empty topics on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "error",
    } as Response);
    const logger = vi.fn();
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key", logger);
    expect(result.topics).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("returns empty topics on invalid JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "not json at all",
    } as Response);
    const logger = vi.fn();
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key", logger);
    expect(result.topics).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("JSON parse failure"));
  });

  it("returns empty topics when choices are missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [] }),
    } as Response);
    const logger = vi.fn();
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key", logger);
    expect(result.topics).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("missing choices"));
  });

  it("returns empty topics on invalid content JSON", async () => {
    // Use input unrepairable by jsonrepair so the logger is called with the
    // "content JSON parse failure" message (mismatched braces + unterminated string).
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: '}{topics"' } }] }),
    } as Response);
    const logger = vi.fn();
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key", logger);
    expect(result.topics).toEqual([]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("content JSON parse failure"));
  });

  it("handles markdown-fenced JSON in content", async () => {
    const topics = [{ title: "T1", summary: "S1" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "```json\n" + JSON.stringify({ topics }) + "\n```" } }],
      }),
    } as Response);

    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key");
    expect(result.topics).toHaveLength(1);
  });

  it("returns empty when parsed topics is not array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ topics: "not array" }) } }],
      }),
    } as Response);
    const result = await segmentAndSummarize([{ role: "user", content: "hi" }], "key");
    expect(result.topics).toEqual([]);
  });

  it("truncates long transcripts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [] }) } }] }),
    } as Response);
    const logger = vi.fn();
    const longMsg = [{ role: "user" as const, content: "x".repeat(500000) }];
    await segmentAndSummarize(longMsg, "key", logger);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("truncated"));
  });
});

// ── batchDedupFacts ──────────────────────────────────────────────────────────

describe("batchDedupFacts", () => {
  const makeFact = (l2: string, confidence: number): ExtractedFact => ({
    l2,
    l0: l2,
    l1: `- ${l2}`,
    confidence,
    category: "cases",
    tier: "working",
    tags: [],
    factKey: `cases:${l2}`,
  });

  it("returns single fact unchanged", async () => {
    const facts = [makeFact("hello", 0.9)];
    const result = await batchDedupFacts(facts, async () => [1, 0]);
    expect(result).toHaveLength(1);
  });

  it("returns empty unchanged", async () => {
    const result = await batchDedupFacts([], async () => [1, 0]);
    expect(result).toEqual([]);
  });

  it("deduplicates identical embeddings, keeping higher confidence", async () => {
    const facts = [makeFact("a", 0.9), makeFact("b", 0.7)];
    // Same embeddings → cosine = 1.0 → dedup
    const result = await batchDedupFacts(facts, async () => [1, 0], 0.85);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });

  it("keeps both facts when embeddings are orthogonal", async () => {
    let call = 0;
    const embed = async () => {
      call++;
      return call % 2 === 1 ? [1, 0] : [0, 1];
    };
    const facts = [makeFact("a", 0.9), makeFact("b", 0.8)];
    const result = await batchDedupFacts(facts, embed, 0.85);
    expect(result).toHaveLength(2);
  });

  it("removes lower-confidence when i has lower confidence", async () => {
    const facts = [makeFact("a", 0.5), makeFact("b", 0.9)];
    const result = await batchDedupFacts(facts, async () => [1, 0], 0.85);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });
});

// ── resolveCapturePrompt ─────────────────────────────────────────────────────

describe("resolveCapturePrompt", () => {
  it("returns custom prompt when provided", () => {
    expect(resolveCapturePrompt("custom")).toBe("custom");
  });

  it("returns default prompt when custom is undefined", () => {
    const result = resolveCapturePrompt(undefined);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(10);
  });

  it("returns default prompt for empty string", () => {
    const result = resolveCapturePrompt("");
    expect(result).toBeTruthy();
  });

  it("appends reset continuity addendum for session-end mode", () => {
    const result = resolveCapturePrompt(undefined, { mode: "session-end" });
    expect(result).toContain("SESSION RESET CONTEXT");
    expect(result).toContain("Active work context");
  });

  it("appends reset addendum to custom prompt for session-end mode", () => {
    const result = resolveCapturePrompt("custom", { mode: "session-end" });
    expect(result).toContain("custom");
    expect(result).toContain("SESSION RESET CONTEXT");
  });
});

// extractTopicTags tests removed with the function (Rúnir-y5on/Rúnir-sq3s):
// its only prod caller was the deleted /hooks/session-end topic write loop.

// ── normalizeCaptureMessages — edge cases ────────────────────────────────────

describe("normalizeCaptureMessages — edge cases", () => {
  it("handles array content blocks", () => {
    const msgs = normalizeCaptureMessages([
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("hello");
    expect(msgs[0].content).toContain("world");
  });

  it("skips non-user/assistant roles", () => {
    const msgs = normalizeCaptureMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hello user message" },
    ]);
    expect(msgs).toHaveLength(1);
  });

  it("strips relevant-memories blocks", () => {
    const msgs = normalizeCaptureMessages([
      { role: "user", content: "hello <relevant-memories>mem</relevant-memories> world" },
    ]);
    expect(msgs[0].content).not.toContain("relevant-memories");
  });

  it("applies limit parameter", () => {
    const msgs = normalizeCaptureMessages([
      { role: "user", content: "first message in the conversation" },
      { role: "user", content: "second message in the conversation" },
      { role: "user", content: "third message in the conversation" },
    ], 2);
    expect(msgs).toHaveLength(2);
  });

  it("skips null/undefined messages", () => {
    const msgs = normalizeCaptureMessages([null, undefined, { role: "user", content: "valid message here" }]);
    expect(msgs).toHaveLength(1);
  });

  it("skips messages with empty content", () => {
    const msgs = normalizeCaptureMessages([{ role: "user", content: "" }]);
    expect(msgs).toHaveLength(0);
  });
});

// ── stripPlatformMetadata ────────────────────────────────────────────────────

describe("stripPlatformMetadata", () => {
  it("strips sentinel blocks", () => {
    const text = "Hello\nConversation info (untrusted metadata):\nSome metadata\n\nReal content here";
    const result = stripPlatformMetadata(text);
    expect(result).not.toContain("Conversation info");
  });

  it("strips addressing prefixes", () => {
    expect(stripPlatformMetadata("@user hello world")).toBe("hello world");
    expect(stripPlatformMetadata("<@123> hello world")).toBe("hello world");
  });

  it("strips session reset prefix", () => {
    const text = "A new session was started via /new or /reset. Hello";
    expect(stripPlatformMetadata(text)).not.toContain("/new or /reset");
  });

  it("strips system event lines", () => {
    const text = "Hello\nSystem: [tool] Exec completed successfully\nWorld";
    const result = stripPlatformMetadata(text);
    expect(result).not.toContain("Exec completed");
  });
});

// ── normalizeTags ────────────────────────────────────────────────────────────

describe("normalizeTags", () => {
  it("normalizes and deduplicates tags", () => {
    expect(normalizeTags(["Hello", " world ", ""])).toEqual(["hello", "world"]);
  });

  it("returns empty for non-array", () => {
    expect(normalizeTags("not array")).toEqual([]);
  });

  it("limits to 10 tags", () => {
    const many = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    expect(normalizeTags(many)).toHaveLength(10);
  });
});

// ── isValidCategory ──────────────────────────────────────────────────────────

describe("isValidCategory", () => {
  it("validates known categories", () => {
    expect(isValidCategory("profile")).toBe(true);
    expect(isValidCategory("cases")).toBe(true);
    expect(isValidCategory("unknown")).toBe(false);
    expect(isValidCategory(42)).toBe(false);
  });
});

// ── resolveTier ──────────────────────────────────────────────────────────────

describe("resolveTier", () => {
  it("returns durable for profile", () => {
    expect(resolveTier("profile", 0.1)).toBe("durable");
  });

  it("returns durable for preferences", () => {
    expect(resolveTier("preferences", 0.1)).toBe("durable");
  });

  it("returns ephemeral for low confidence", () => {
    expect(resolveTier("cases", 0.3)).toBe("ephemeral");
  });

  it("returns durable for high confidence cases", () => {
    expect(resolveTier("cases", 0.95)).toBe("durable");
  });

  it("returns durable for high confidence events", () => {
    expect(resolveTier("events", 0.95)).toBe("durable");
  });

  it("returns working for mid confidence", () => {
    expect(resolveTier("cases", 0.7)).toBe("working");
  });
});

// ── canonicalizeFactKey ──────────────────────────────────────────────────────

describe("canonicalizeFactKey", () => {
  it("canonicalizes name patterns to profile:name", () => {
    const fact: ExtractedFact = {
      l2: "My name is Alice", l0: "name is alice",
      l1: "- name", confidence: 0.9, category: "profile",
      tier: "durable", tags: [], factKey: "profile:original",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:name");
  });

  it("leaves non-profile/preferences unchanged", () => {
    const fact: ExtractedFact = {
      l2: "event", l0: "event", l1: "- event",
      confidence: 0.9, category: "events", tier: "working",
      tags: [], factKey: "events:original",
    };
    expect(canonicalizeFactKey(fact).factKey).toBe("events:original");
  });
});

// ── djb2Hash ─────────────────────────────────────────────────────────────────

describe("djb2Hash", () => {
  it("returns consistent hash", () => {
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
    expect(djb2Hash("hello")).not.toBe(djb2Hash("world"));
  });
});

// ── deriveFactKey ────────────────────────────────────────────────────────────

describe("deriveFactKey", () => {
  it("generates key with slug and hash", () => {
    const key = deriveFactKey("profile", "user prefers dark mode");
    expect(key).toMatch(/^profile:.+-[0-9a-f]{6}$/);
  });

  it("falls back to hash only for non-ASCII", () => {
    const key = deriveFactKey("profile", "用户 偏好");
    expect(key).toMatch(/^profile:[0-9a-f]{6}$/);
  });
});
