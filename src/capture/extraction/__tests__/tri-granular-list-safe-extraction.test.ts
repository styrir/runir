import { describe, expect, it } from "vitest";
import type { RawExtractedFact } from "../../../domain/memory/types.js";
import { normalizeExtractedFact, repairListShapedFact } from "../capture.js";

describe("tri-granular list-safe extraction", () => {
  it("fails soft from flattened list prose to atomic claims plus source spans", () => {
    const raw: RawExtractedFact = {
      l2: "User listed three Runir exact-QA fixes.",
      l0: "Runir exact-QA fixes",
      confidence: 0.95,
      category: "cases",
      source_turn_index: 0,
      raw_source_text: [
        "- Split LoCoMo holdouts before coding",
        "- Preserve raw source spans for exact answers",
        "- Keep answer-distinct list items separate",
      ].join("\n"),
    };

    const repaired = repairListShapedFact(raw);

    expect(repaired.atomicClaims).toHaveLength(3);
    expect(repaired.rawSpans).toHaveLength(3);
    expect(repaired.l1).toContain("- Preserve raw source spans for exact answers");
    expect(repaired.l2).toContain("Exact source list:");
  });

  it("normalizes raw span, atomic fact, event, and atomic claims onto ExtractedFact", () => {
    const fact = normalizeExtractedFact({
      l2: "Runir local service uses port 7700.",
      l0: "Runir local service: port 7700",
      l1: "- Port: 7700",
      confidence: 0.95,
      category: "entities",
      source_turn_index: 2,
      raw_source_text: "The exact port is 7700.",
      atomicFact: { subject: "Runir local service", predicate: "uses_port", value: "7700" },
      event: { actor: "user", action: "stated", object: "Runir port 7700" },
      atomicClaims: [{ subject: "Runir local service", predicate: "port", value: "7700", order: 1 }],
    });

    expect(fact.rawSpan?.text).toBe("The exact port is 7700.");
    expect(fact.atomicFact?.value).toBe("7700");
    expect(fact.event?.action).toBe("stated");
    expect(fact.atomicClaims?.[0]?.value).toBe("7700");
  });
});
