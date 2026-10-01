import { afterEach, expect, it, vi } from "vitest";
import { extractMemories, normalizeExtractedFact } from "./capture.js";

afterEach(() => vi.unstubAllGlobals());

it("carries only the corrected valid source index through normalization", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{
    message: { content: JSON.stringify({ facts: [
      { l2: "The compiler setting is stable and documented.", confidence: 0.99, source_turn_index: 0 },
      { l2: "An unindexed model fact remains available.", confidence: 0.99 },
    ] }) },
  }] }) })));
  const facts = await extractMemories([{ role: "user", content: "The compiler setting is stable." }],
    "test prompt", "stub-key");
  expect(facts).toHaveLength(2);
  expect(facts[0]?.sourceTurnIndex).toBe(0);
  expect(facts[0]?.rawSpan?.sourceTurnIndex).toBe(0);
  expect(normalizeExtractedFact(facts[0]!)).toHaveProperty("sourceTurnIndex", 0);
  expect(facts[1]?.sourceTurnIndex).toBeUndefined();
});
