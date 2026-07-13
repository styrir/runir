import { describe, it, expect } from "vitest";

import { formatAtDepth } from "../recall/selection/recall-selection.js";

describe("formatAtDepth (MIM-56)", () => {
  it("l0: returns abstract only, no body text", () => {
    const entry = {
      text: "This is the full body text with many details. Second sentence here.",
      l0: "Short title",
    };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("Short title");
    expect(result).not.toContain("full body text");
  });

  it("l0: falls back to first sentence when no abstract", () => {
    const entry = {
      text: "First sentence. Second sentence. Third sentence.",
    };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("First sentence.");
    expect(result).not.toContain("Second");
  });

  it("l1: prefers stored l1 when available", () => {
    const entry = {
      text: "Sentence one. Sentence two. Sentence three.",
      l0: "Title",
      l1: "Stored structured summary",
    };
    const result = formatAtDepth(entry, "l1");
    expect(result).toBe("Stored structured summary");
  });

  it("l1: returns abstract plus first sentence of body when stored l1 is absent", () => {
    const entry = {
      text: "Sentence one. Sentence two. Sentence three.",
      l0: "Title",
    };
    const result = formatAtDepth(entry, "l1");
    expect(result).toContain("Title");
    expect(result).toContain("Sentence one.");
    expect(result).not.toContain("Sentence two");
  });

  it("l1: does not duplicate when abstract equals first sentence", () => {
    const entry = {
      text: "Same text.",
      l0: "Same text.",
    };
    const result = formatAtDepth(entry, "l1");
    expect(result).toBe("Same text.");
    // Should not have duplication like "Same text.\nSame text."
    expect(result.match(/Same text\./g)?.length).toBe(1);
  });

  it("full: returns complete text unchanged", () => {
    const entry = {
      text: "Full text with all details. Second sentence. Third sentence.",
      l0: "Title",
    };
    const result = formatAtDepth(entry, "full");
    expect(result).toBe(entry.text);
    expect(result).toContain("Third sentence");
  });

  it("CJK l1: splits on CJK sentence boundary not English period", () => {
    const entry = {
      text: "这是第一句。这是第二句。This is English.",
    };
    const result = formatAtDepth(entry, "l1");
    // First sentence should end at 。not at the English period
    expect(result).toContain("这是第一句。");
    // Should not include the second CJK sentence or English
    expect(result).not.toContain("这是第二句");
    expect(result).not.toContain("English");
  });

  it("CJK l0: abstract from CJK text uses 。boundary", () => {
    const entry = {
      text: "人工智能很有趣。还有很多可以学习。",
    };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("人工智能很有趣。");
    expect(result).not.toContain("还有很多");
  });

  it("edge: empty string returns empty string", () => {
    const entry = { text: "" };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("");
  });

  it("l0: empty abstract falls back to the first body sentence", () => {
    const entry = {
      text: "Body sentence. Extra detail.",
      l0: "",
    };

    const result = formatAtDepth(entry, "l0");

    expect(result).toBe("Body sentence.");
    expect(result).not.toContain("Extra detail");
  });

  it("edge: single sentence no terminal punctuation", () => {
    const entry = { text: "no punctuation here" };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("no punctuation here");
  });

  it("edge: null/undefined entry fields handled gracefully", () => {
    const entry = { text: "valid text" } as any;
    // Should not throw when abstract is undefined
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("valid text"); // Falls back to full text (no sentence boundary)
  });

  it("l0: handles exclamation and question marks as sentence boundaries", () => {
    const entry = {
      text: "This is exciting! Second sentence. Third.",
    };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("This is exciting!");
    expect(result).not.toContain("Second");
  });

  it("l0: handles CJK exclamation and question marks", () => {
    const entry = {
      text: "这太棒了！还有更多内容。",
    };
    const result = formatAtDepth(entry, "l0");
    expect(result).toBe("这太棒了！");

    const entry2 = {
      text: "这是问题吗？答案在这里。",
    };
    const result2 = formatAtDepth(entry2, "l0");
    expect(result2).toBe("这是问题吗？");
  });

  it("l1: with stored l1 present prefers the stored structured summary", () => {
    const entry = {
      text: "Full text here. More content.",
      l0: "Abstract line",
      l1: "## Overview\nStructured content",
    };
    const result = formatAtDepth(entry, "l1");
    expect(result).toBe("## Overview\nStructured content");
  });

  it("l1: abstract is returned without a trailing newline when body text is empty", () => {
    const entry = {
      text: "",
      l0: "Abstract only",
    };

    const result = formatAtDepth(entry, "l1");

    expect(result).toBe("Abstract only");
    expect(result).not.toContain("\n");
  });

  it("handles mixed CJK and English text correctly", () => {
    // When English period + space comes first, it splits there
    const entry1 = {
      text: "Hello world. More text here.",
    };
    const result1 = formatAtDepth(entry1, "l0");
    expect(result1).toBe("Hello world.");

    // When CJK comes first (no English period + space before it), CJK boundary wins
    const entry2 = {
      text: "你好世界。Hello world. More text.",
    };
    const result2 = formatAtDepth(entry2, "l0");
    expect(result2).toBe("你好世界。");
  });

  it("uses the earliest sentence boundary across English and CJK punctuation", () => {
    const entry = {
      text: "English first. 然后是中文。More detail.",
    };

    const result = formatAtDepth(entry, "l0");

    expect(result).toBe("English first.");
    expect(result).not.toContain("然后是中文");
  });

  it("l1: abstract different from first sentence both included", () => {
    const entry = {
      text: "The first sentence of the body. Second sentence.",
      l0: "Summary: Key point here",
    };
    const result = formatAtDepth(entry, "l1");
    expect(result).toContain("Summary: Key point here");
    expect(result).toContain("The first sentence of the body.");
    // Should be separated by newline
    expect(result).toBe("Summary: Key point here\nThe first sentence of the body.");
  });
});
