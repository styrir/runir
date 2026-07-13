import { describe, it, expect } from "vitest";
import { shouldSkipRetrieval, normalizeQuery } from "../recall/intent/adaptive-retrieval.js";

describe("shouldSkipRetrieval", () => {
  // --- Should SKIP (return true) ---

  it("skips greeting: 'hi'", () => {
    expect(shouldSkipRetrieval("hi")).toBe(true);
  });

  it("skips greeting: 'hello there'", () => {
    expect(shouldSkipRetrieval("hello there")).toBe(true);
  });

  it("skips greeting: 'hey'", () => {
    expect(shouldSkipRetrieval("hey")).toBe(true);
  });

  it("skips slash command: '/help'", () => {
    expect(shouldSkipRetrieval("/help")).toBe(true);
  });

  it("skips slash command: '/reset'", () => {
    expect(shouldSkipRetrieval("/reset")).toBe(true);
  });

  it("skips affirmation: 'ok'", () => {
    expect(shouldSkipRetrieval("ok")).toBe(true);
  });

  it("skips affirmation: 'thanks'", () => {
    expect(shouldSkipRetrieval("thanks")).toBe(true);
  });

  it("skips affirmation: 'got it'", () => {
    expect(shouldSkipRetrieval("got it")).toBe(true);
  });

  it("skips HEARTBEAT", () => {
    expect(shouldSkipRetrieval("HEARTBEAT")).toBe(true);
  });

  it("skips emoji-only input: '👍'", () => {
    expect(shouldSkipRetrieval("👍")).toBe(true);
  });

  it("skips emoji-only input: '😂🔥'", () => {
    expect(shouldSkipRetrieval("😂🔥")).toBe(true);
  });

  it("skips short input under 5 chars: 'abc'", () => {
    expect(shouldSkipRetrieval("abc")).toBe(true);
  });

  it("skips short input under 5 chars: 'no'", () => {
    expect(shouldSkipRetrieval("no")).toBe(true);
  });

  it("skips empty string", () => {
    expect(shouldSkipRetrieval("")).toBe(true);
  });

  it("skips shell command: 'ls -la'", () => {
    expect(shouldSkipRetrieval("ls -la")).toBe(true);
  });

  it("skips system message: '[System]'", () => {
    expect(shouldSkipRetrieval("[System] connected")).toBe(true);
  });

  it("skips ping: 'ping'", () => {
    expect(shouldSkipRetrieval("ping")).toBe(true);
  });

  // --- Should NOT skip (return false) — memory intent ---

  it("does not skip memory intent: 'do you remember my API key?'", () => {
    expect(shouldSkipRetrieval("do you remember my API key?")).toBe(false);
  });

  it("does not skip memory intent: 'what do you know about TypeScript?'", () => {
    expect(shouldSkipRetrieval("what do you know about TypeScript?")).toBe(false);
  });

  it("does not skip memory intent: 'recall my database config'", () => {
    expect(shouldSkipRetrieval("recall my database config")).toBe(false);
  });

  it("does not skip memory intent: 'save this for later'", () => {
    expect(shouldSkipRetrieval("save this for later")).toBe(false);
  });

  it("does not skip memory intent: 'forget this fact'", () => {
    expect(shouldSkipRetrieval("forget this fact")).toBe(false);
  });

  it("does not skip memory intent: 'what did I say about Docker?'", () => {
    expect(shouldSkipRetrieval("what did I say about Docker?")).toBe(false);
  });

  // --- Should NOT skip — substantive queries ---

  it("does not skip substantive query: 'How do I configure nginx reverse proxy?'", () => {
    expect(shouldSkipRetrieval("How do I configure nginx reverse proxy?")).toBe(false);
  });

  it("does not skip substantive query: 'explain the difference between TCP and UDP'", () => {
    expect(shouldSkipRetrieval("explain the difference between TCP and UDP")).toBe(false);
  });

  // --- normalizeQuery strips metadata ---

  it("skips after stripping OpenClaw metadata header", () => {
    const input = "Conversation info (untrusted metadata):\nuser: test\n\nhi";
    expect(shouldSkipRetrieval(input)).toBe(true);
  });

  it("skips after stripping timestamp prefix", () => {
    expect(shouldSkipRetrieval("[2026-03-28T10:00:00Z] ok")).toBe(true);
  });

  // --- Custom minLength ---

  it("respects custom minLength parameter", () => {
    // "abcde" is 5 chars, under minLength=10 → skip
    expect(shouldSkipRetrieval("abcde", 10)).toBe(true);
    // 20-char string passes both minLength=10 and CJK-aware content check (15)
    expect(shouldSkipRetrieval("abcdefghij1234567890", 10)).toBe(false);
  });

  // --- CJK content length check ---

  it("skips short CJK input under 6 chars", () => {
    // 5 CJK chars — under the CJK min of 6, but passes general minLength of 5
    expect(shouldSkipRetrieval("東京は美し")).toBe(true);
  });

  it("does not skip CJK input at 6+ chars", () => {
    expect(shouldSkipRetrieval("東京は美しい都市です")).toBe(false);
  });
});

describe("normalizeQuery", () => {
  it("strips sentinel at end of string with no trailing blank line", () => {
    // Sentinel at end with no \n\n following — triggers the else branch (line 59)
    const input = "Some prefix text\nConversation info (untrusted metadata):\nuser: test data";
    const result = normalizeQuery(input);
    expect(result).toBe("Some prefix text");
    expect(result).not.toContain("untrusted metadata");
  });

  it("strips cron wrapper prefix", () => {
    const input = "Cron job (every 5m): check the deploy status";
    expect(normalizeQuery(input)).toBe("check the deploy status");
  });

  it("strips ISO timestamp prefix", () => {
    const input = "[2026-03-28T10:00:00Z] actual query here";
    expect(normalizeQuery(input)).toBe("actual query here");
  });

  it("strips sentinel with blank line after it", () => {
    const input = "Conversation info (untrusted metadata):\nuser: test\n\nactual query";
    expect(normalizeQuery(input)).toBe("actual query");
  });

  it("handles multiple sentinels", () => {
    const input = "Sender (untrusted metadata):\nfoo\n\nThread starter (untrusted, for context):\nbar\n\nhello world";
    const result = normalizeQuery(input);
    expect(result).toBe("hello world");
  });
});
