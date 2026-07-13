import { describe, it, expect } from "vitest";
import { scoreText, compressTexts, compressMessages } from "../capture/continuity/session-compressor.js";
import type { CaptureMessage } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// scoreText
// ---------------------------------------------------------------------------

describe("scoreText", () => {
  it("scores empty text as 0.0", () => {
    const result = scoreText("", 0);
    expect(result.score).toBe(0.0);
    expect(result.reason).toBe("empty");
  });

  it("scores whitespace-only text as 0.0", () => {
    const result = scoreText("   \n  ", 0);
    expect(result.score).toBe(0.0);
    expect(result.reason).toBe("empty");
  });

  it("scores tool_call indicators as 1.0", () => {
    expect(scoreText("tool_use: memory_store", 0).score).toBe(1.0);
    expect(scoreText("tool_use: memory_store", 0).reason).toBe("tool_call");
  });

  it("scores tool_result as 1.0", () => {
    expect(scoreText("tool_result: success", 0).score).toBe(1.0);
  });

  it("scores function_call as 1.0", () => {
    expect(scoreText("function_call to do something", 0).score).toBe(1.0);
  });

  it("scores correction indicators as 0.95", () => {
    expect(scoreText("No, that's wrong", 0).score).toBe(0.95);
    expect(scoreText("No, that's wrong", 0).reason).toBe("correction");
  });

  it("scores 'actually' as correction", () => {
    expect(scoreText("Actually I meant something else", 0).score).toBe(0.95);
  });

  it("scores CJK corrections", () => {
    expect(scoreText("不对，应该是这样", 0).score).toBe(0.95);
  });

  it("scores decision indicators as 0.85", () => {
    expect(scoreText("Let's go with option A", 0).score).toBe(0.85);
    expect(scoreText("Let's go with option A", 0).reason).toBe("decision");
  });

  it("scores 'confirmed' as decision", () => {
    expect(scoreText("Confirmed, we'll use that approach", 0).score).toBe(0.85);
  });

  it("scores CJK decisions", () => {
    expect(scoreText("决定用这个方案", 0).score).toBe(0.85);
  });

  it("scores acknowledgments as 0.1", () => {
    expect(scoreText("ok", 0).score).toBe(0.1);
    expect(scoreText("ok", 0).reason).toBe("acknowledgment");
    expect(scoreText("thanks", 0).score).toBe(0.1);
    expect(scoreText("got it", 0).score).toBe(0.1);
    expect(scoreText("sure", 0).score).toBe(0.1);
    expect(scoreText("👍", 0).score).toBe(0.1);
  });

  it("scores CJK acknowledgments", () => {
    expect(scoreText("好的", 0).score).toBe(0.1);
    expect(scoreText("收到", 0).score).toBe(0.1);
  });

  it("scores substantive content as 0.7", () => {
    const longText = "This is a substantive piece of text that explains a complex concept about software architecture and design patterns in great detail.";
    expect(scoreText(longText, 0).score).toBe(0.7);
    expect(scoreText(longText, 0).reason).toBe("substantive");
  });

  it("uses CJK threshold (30 chars) for substantive", () => {
    // 31 CJK characters — should be substantive
    const cjk = "这是一段很长的中文文本用来测试是否能被正确识别为有实质性内容的消息段落";
    expect(cjk.length).toBeGreaterThan(30);
    expect(scoreText(cjk, 0).score).toBe(0.7);
    expect(scoreText(cjk, 0).reason).toBe("substantive");
  });

  it("scores XML-wrapped content as 0.3", () => {
    const xml = "<system-prompt>Some long system prompt text that is wrapped in XML tags and is fairly verbose for testing</system-prompt>";
    expect(scoreText(xml, 0).score).toBe(0.3);
    expect(scoreText(xml, 0).reason).toBe("system_xml");
  });

  it("scores short questions as 0.5", () => {
    expect(scoreText("What version?", 0).score).toBe(0.5);
    expect(scoreText("What version?", 0).reason).toBe("short_question");
  });

  it("scores CJK question mark as short_question", () => {
    expect(scoreText("哪个？", 0).score).toBe(0.5);
  });

  it("scores short statements as 0.4", () => {
    expect(scoreText("Using TypeScript", 0).score).toBe(0.4);
    expect(scoreText("Using TypeScript", 0).reason).toBe("short_statement");
  });

  it("preserves original index", () => {
    const result = scoreText("hello", 42);
    expect(result.index).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// compressTexts
// ---------------------------------------------------------------------------

describe("compressTexts", () => {
  it("returns empty result for empty input", () => {
    const result = compressTexts([], 1000);
    expect(result.texts).toEqual([]);
    expect(result.dropped).toBe(0);
    expect(result.totalChars).toBe(0);
  });

  it("returns all texts when under budget", () => {
    const texts = ["Hello", "World", "Foo"];
    const result = compressTexts(texts, 100000);
    expect(result.texts).toEqual(texts);
    expect(result.dropped).toBe(0);
  });

  it("drops low-signal texts when over budget", () => {
    const texts = [
      "tool_use: memory_store called with data",  // 1.0 tool_call
      "ok",                                         // 0.1 acknowledgment
      "sure",                                       // 0.1 acknowledgment
      "thanks",                                     // 0.1 acknowledgment
      "No, that's wrong, fix it please now",        // 0.95 correction
    ];
    // Budget large enough for first + last but not all
    const budget = texts[0].length + texts[4].length + 10;
    const result = compressTexts(texts, budget);
    // Should keep first (tool_call), last (correction), and drop acks
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.texts[0]).toBe(texts[0]); // first preserved
    expect(result.texts[result.texts.length - 1]).toBe(texts[texts.length - 1]); // last preserved
  });

  it("preserves first and last texts", () => {
    const texts = ["First message", "Middle message that is acknowledgment ok", "Last message"];
    const budget = texts[0].length + texts[2].length + 1;
    const result = compressTexts(texts, budget);
    expect(result.texts[0]).toBe("First message");
    expect(result.texts[result.texts.length - 1]).toBe("Last message");
  });

  it("keeps tool-call pairs together", () => {
    const texts = [
      "Start of conversation with lots of text",
      "tool_use: memory_store with some data here",   // tool_call at index 1
      "tool_result: success with stored data here",    // paired at index 2
      "ok",
      "End of conversation with more text here",
    ];
    // Budget enough for first, last, and the pair
    const budget = texts[0].length + texts[1].length + texts[2].length + texts[4].length + 10;
    const result = compressTexts(texts, budget);
    // Both tool_call and its result should be present
    const hasToolCall = result.texts.some(t => t.includes("tool_use"));
    const hasToolResult = result.texts.some(t => t.includes("tool_result"));
    expect(hasToolCall).toBe(true);
    expect(hasToolResult).toBe(true);
  });

  it("maintains chronological order in output", () => {
    const texts = [
      "First",
      "tool_use: important tool call data here",
      "Middle acknowledgment ok sure",
      "No, actually that's wrong fix it",
      "Last message here",
    ];
    const budget = 200;
    const result = compressTexts(texts, budget);
    // Verify chronological order by checking original indices
    const origIndices = result.texts.map(t => texts.indexOf(t));
    for (let i = 1; i < origIndices.length; i++) {
      expect(origIndices[i]).toBeGreaterThan(origIndices[i - 1]);
    }
  });

  it("scores all texts even when under budget", () => {
    const texts = ["Hello world"];
    const result = compressTexts(texts, 100000);
    expect(result.scored.length).toBe(1);
    expect(result.scored[0].score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// compressMessages (CaptureMessage[] adapter)
// ---------------------------------------------------------------------------

describe("compressMessages", () => {
  it("returns all messages when under budget", () => {
    const messages: CaptureMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = compressMessages(messages, 100000);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("compresses messages over budget", () => {
    const messages: CaptureMessage[] = [
      { role: "user", content: "Tell me about the architecture of this system in great detail" },
      { role: "assistant", content: "ok" },
      { role: "assistant", content: "sure" },
      { role: "assistant", content: "thanks" },
      { role: "user", content: "No, that's wrong. The system uses microservices, fix it" },
    ];
    const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
    const result = compressMessages(messages, Math.floor(totalChars * 0.5));
    expect(result.length).toBeLessThan(messages.length);
  });

  it("preserves role information", () => {
    const messages: CaptureMessage[] = [
      { role: "user", content: "First user message" },
      { role: "assistant", content: "First assistant response that is quite long and substantive with details" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "Last assistant message with more content here" },
    ];
    const result = compressMessages(messages, 100000);
    expect(result.every(m => typeof m.role === "string")).toBe(true);
    expect(result.every(m => typeof m.content === "string")).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(compressMessages([], 1000)).toEqual([]);
  });
});
