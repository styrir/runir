import { describe, expect, it } from "vitest";
import { compressTexts } from "../session-compressor.js";

describe("session compression exact-QA retention", () => {
  it("keeps a short exact answer with its preceding question under pressure", () => {
    const texts = [
      "hello",
      "Can you remind me which port the Runir local service uses?",
      "7700",
      "thanks",
      "bye",
    ];

    const result = compressTexts(texts, 120, { minTexts: 2 });

    expect(result.texts).toContain("Can you remind me which port the Runir local service uses?");
    expect(result.texts).toContain("7700");
    expect(result.scored.find((s) => s.text === "7700")?.reason).toBe("exact_qa_evidence");
  });

  it("keeps list-shaped source evidence instead of treating it as disposable short text", () => {
    const list = "- Alpha: keep raw source\n- Beta: keep exact answer\n- Gamma: preserve order";
    const result = compressTexts(["start", "What were the three decisions?", list, "end"], 130);

    expect(result.texts).toContain(list);
    expect(result.scored.find((s) => s.text === list)?.score).toBeGreaterThan(0.8);
  });
});
