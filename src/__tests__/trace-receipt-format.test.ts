import { describe, expect, it } from "vitest";
import { formatTraceList, formatTraceReceipt, type TraceView } from "../recall/trace-receipt-format.js";

const fullTrace: TraceView = {
  id: "trace-9",
  userId: "brooks",
  prompt: "How does the capture hook persist facts?",
  intentLabel: "current_status",
  laneLabel: "status",
  retrievalPath: "hybrid",
  sessionId: "sess-a",
  hexisLabel: "engineering",
  items: [
    { id: "semiote:m1", score: 0.912, memoryRole: "current_status", hexisFit: 0.84, rankingExplanation: ["semantic=0.91", "recency=0.7"] },
    { id: "semiote:m2", score: 0.7 },
  ],
  prependContext: "<relevant-memories>\n- the capture hook writes semiote records directly\n</relevant-memories>",
  answer: "It writes semiote records directly via the capture hook.",
  responseResolution: "explicit_success",
  correctedIds: ["m2"],
  feedbackReceivedAt: "2026-06-01T10:00:00.000Z",
  createdAt: "2026-06-01T09:59:00.000Z",
};

describe("formatTraceReceipt", () => {
  it("renders the full receipt: prompt -> recalled items -> injected text -> answer -> feedback", () => {
    const out = formatTraceReceipt(fullTrace);
    expect(out).toContain("Recall receipt  trace-9");
    expect(out).toContain("intent=current_status");
    expect(out).toContain("How does the capture hook persist facts?");
    expect(out).toContain("recalled 2 memories:");
    expect(out).toContain("[1] score=0.912  role=current_status  fit=0.84  semiote:m1");
    expect(out).toContain("semantic=0.91 · recency=0.7");
    // the verbatim injected context is surfaced
    expect(out).toContain("injected into the model (verbatim):");
    expect(out).toContain("the capture hook writes semiote records directly");
    expect(out).toContain("It writes semiote records directly via the capture hook.");
    expect(out).toContain("resolution: explicit_success");
    expect(out).toContain("corrected:  m2");
  });

  it("marks a trace that has no feedback / no stored injection clearly", () => {
    const bare: TraceView = {
      id: "trace-old",
      prompt: "older prompt",
      intentLabel: "fact",
      laneLabel: "fact",
      retrievalPath: "hybrid",
      items: [],
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    const out = formatTraceReceipt(bare);
    expect(out).toContain("recalled 0 memories:");
    expect(out).toContain("(none)");
    expect(out).toContain("(not stored — trace predates receipt capture, or nothing was injected)");
    expect(out).toContain("(no feedback received yet)");
    expect(out).toContain("resolution: —");
    expect(out).toContain("corrected:  none");
    // an unrated trace surfaces the prompt to rate it
    expect(out).toContain("verdict:  — (not rated");
  });

  it("uses singular 'memory' for a single recalled item", () => {
    const out = formatTraceReceipt({ ...fullTrace, items: [{ id: "semiote:m1", score: 0.9 }] });
    expect(out).toContain("recalled 1 memory:");
  });

  it("renders the human recall-quality rating (verdict, note, timestamp)", () => {
    const out = formatTraceReceipt({
      ...fullTrace,
      rating: "helped",
      ratingNote: "nailed the config detail",
      ratedAt: "2026-06-01T11:00:00.000Z",
    });
    expect(out).toContain("your rating:");
    expect(out).toContain("verdict:  helped");
    expect(out).toContain("note:     nailed the config detail");
    expect(out).toContain("rated:    2026-06-01T11:00:00.000Z");
  });
});

describe("formatTraceList", () => {
  it("summarizes each trace with recall count, answered state, and id", () => {
    const out = formatTraceList(
      [
        fullTrace,
        { id: "trace-1", prompt: "an earlier turn", intentLabel: "fact", retrievalPath: "hybrid", items: [], createdAt: "2026-06-01T08:00:00.000Z" },
      ],
      "brooks",
    );
    expect(out).toContain("Recall receipts for brooks (latest 2, newest first):");
    expect(out).toContain("[current_status/hybrid]  recalled 2  answered");
    expect(out).toContain("[fact/hybrid]  recalled 0  no feedback yet");
    expect(out).toContain("id: trace-9");
    expect(out).toContain("runir traces --id <id>");
  });

  it("truncates long prompts to a single line", () => {
    const longPrompt = "word ".repeat(60).trim();
    const out = formatTraceList([{ ...fullTrace, prompt: longPrompt }], "brooks");
    expect(out).toContain("…");
    // no raw newline leaked from the prompt into the summary line
    expect(out).not.toContain("word\nword");
  });

  it("marks a rated trace with its verdict in the list line", () => {
    const out = formatTraceList([{ ...fullTrace, rating: "hurt" }], "brooks");
    expect(out).toContain("rated:hurt");
  });

  it("returns a helpful empty-state message", () => {
    const out = formatTraceList([], "brooks");
    expect(out).toContain("No recall receipts found for brooks");
  });
});
