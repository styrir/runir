import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMemories, perCategoryThreshold } from "../capture/extraction/capture.js";
import { CONFIDENCE_THRESHOLD } from "../domain/memory/types.js";
import type { RawExtractedFact } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Per-category confidence floor unit tests
// ---------------------------------------------------------------------------

describe("perCategoryThreshold — floor values", () => {
  it("preferences/profile floor is 0.7 (equals CONFIDENCE_THRESHOLD)", () => {
    expect(perCategoryThreshold("preferences")).toBe(0.7);
    expect(perCategoryThreshold("profile")).toBe(0.7);
  });

  it("entities/patterns floor is 0.8", () => {
    expect(perCategoryThreshold("entities")).toBe(0.8);
    expect(perCategoryThreshold("patterns")).toBe(0.8);
  });

  it("events/cases floor is 0.85", () => {
    expect(perCategoryThreshold("events")).toBe(0.85);
    expect(perCategoryThreshold("cases")).toBe(0.85);
  });

  it("undefined category floor is 0 (defers to global CONFIDENCE_THRESHOLD)", () => {
    // Note: undefined-category floor defers to CONFIDENCE_THRESHOLD (0.7), not 0.95 as written
    // in plan §P2. See JSDoc on perCategoryThreshold for back-compat reasoning.
    expect(perCategoryThreshold(undefined)).toBe(0);
  });

  it("unrecognized string category floor is 0.95 (strict floor)", () => {
    expect(perCategoryThreshold("unknown")).toBe(0.95);
  });

  it("effective floor (after Math.max with CONFIDENCE_THRESHOLD) is never below 0.7", () => {
    // undefined category returns 0 but Math.max(CONFIDENCE_THRESHOLD, 0) = CONFIDENCE_THRESHOLD
    const allCategories = ["preferences", "profile", "entities", "patterns", "events", "cases", undefined, "unknown"];
    for (const cat of allCategories) {
      const floor = Math.max(CONFIDENCE_THRESHOLD, perCategoryThreshold(cat));
      expect(floor).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    }
  });
});

// ---------------------------------------------------------------------------
// Mocked-LLM gate test: extractMemories with a synthetic LLM response
//
// The per-category threshold gate lives at capture.ts:452-458.
// END-TO-END prompt+threshold behavior (whether the LLM actually emits the
// right categories) is verified by the 6-scenario regression matrix at smoke time
// (harness/scenarios/families/10-explanation-vs-fact/).
// ---------------------------------------------------------------------------

const MIXED_RAW_FACTS: RawExtractedFact[] = [
  // PASS: 0.72 >= max(0.7, 0.7) for preferences
  { l2: "User prefers TypeScript with strict mode", category: "preferences", confidence: 0.72 },
  // FAIL: 0.78 < max(0.7, 0.8) for patterns
  { l2: "TCP uses 3-way handshake", category: "patterns", confidence: 0.78 },
  // PASS: 0.82 >= max(0.7, 0.8) for entities
  { l2: "Project blocked on staging deploy", category: "entities", confidence: 0.82 },
  // PASS: 0.86 >= max(0.7, 0.85) for events
  { l2: "User shipped v2.1 yesterday", category: "events", confidence: 0.86 },
  // FAIL: 0.80 < max(0.7, 0.85) for events
  { l2: "User shipped v2.2 today", category: "events", confidence: 0.80 },
  // FAIL: 0.92 < max(0.7, 0.95) for unrecognized string category
  { l2: "Some weird fact", category: "unknown" as any, confidence: 0.92 },
];

function makeLLMResponse(facts: RawExtractedFact[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ facts }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("extractMemories — per-category confidence gate (mocked LLM)", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(makeLLMResponse(MIXED_RAW_FACTS));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes only the 3 facts that clear their per-category floor", async () => {
    const rejected: Array<{ raw: RawExtractedFact; reason: string }> = [];
    const results = await extractMemories(
      [{ role: "user", content: "test conversation" }],
      "test-prompt",
      "test-api-key",
      undefined,
      (raw, reason) => rejected.push({ raw, reason }),
    );

    // 3 facts pass the gate
    expect(results).toHaveLength(3);
    const l2s = results.map((f) => f.l2);
    expect(l2s).toContain("User prefers TypeScript with strict mode");
    expect(l2s).toContain("Project blocked on staging deploy");
    // The deterministic temporal resolver appends the resolved absolute date to
    // facts containing a relative phrase, so match on substring, not equality.
    expect(l2s.some((t) => t.includes("User shipped v2.1 yesterday"))).toBe(true);

    // 3 facts are rejected via onReject callback
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reason === "low-confidence")).toBe(true);
    const rejectedL2s = rejected.map((r) => r.raw.l2);
    expect(rejectedL2s).toContain("TCP uses 3-way handshake");
    // "today" gets a resolved date appended before onReject fires — substring.
    expect(rejectedL2s.some((t) => t.includes("User shipped v2.2 today"))).toBe(true);
    expect(rejectedL2s).toContain("Some weird fact");
  });

  it("rejects a preferences fact below CONFIDENCE_THRESHOLD even though the category floor is 0.7", async () => {
    const belowFloorFact: RawExtractedFact = {
      l2: "User prefers dark mode or something",
      category: "preferences",
      confidence: 0.65, // below CONFIDENCE_THRESHOLD (0.7)
    };
    fetchMock.mockResolvedValueOnce(makeLLMResponse([belowFloorFact]));

    const rejected: Array<{ raw: RawExtractedFact; reason: string }> = [];
    const results = await extractMemories(
      [{ role: "user", content: "test" }],
      "test-prompt",
      "test-api-key",
      undefined,
      (raw, reason) => rejected.push({ raw, reason }),
    );

    expect(results).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("low-confidence");
  });

  it("accepted facts carry the correct normalized category and tier", async () => {
    const results = await extractMemories(
      [{ role: "user", content: "test conversation" }],
      "test-prompt",
      "test-api-key",
    );

    const prefFact = results.find((f) => f.l2 === "User prefers TypeScript with strict mode");
    expect(prefFact).toBeDefined();
    expect(prefFact!.category).toBe("preferences");
    expect(prefFact!.tier).toBe("durable"); // preferences always resolve to durable

    const entityFact = results.find((f) => f.l2 === "Project blocked on staging deploy");
    expect(entityFact).toBeDefined();
    expect(entityFact!.category).toBe("entities");
    expect(entityFact!.confidence).toBe(0.82);
  });
});
