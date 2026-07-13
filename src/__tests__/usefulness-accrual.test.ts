import { describe, it, expect, vi } from "vitest";
import {
  findLastAssistantAnswer,
  buildUsefulnessAccrual,
  pickTraceForSession,
  accrueUsefulnessFromCapture,
  type AccrualCaptureMessage,
  type AccrualTrace,
  type PriorSemioteUsefulness,
  type UsefulnessAccrualDeps,
} from "../lifecycle/semion/usefulness-accrual.js";

function msg(role: string, content: string): AccrualCaptureMessage {
  return { role, content };
}

function priorRow(id: string, memoryText: string, over: Partial<PriorSemioteUsefulness> = {}): PriorSemioteUsefulness {
  return {
    id,
    memoryText,
    statusRetrievedCount: 0,
    statusUsedCount: 0,
    previous: {
      usefulnessAlpha: 2,
      usefulnessBeta: 2,
      usefulnessScore: 0.5,
      retrievedCount: 0,
      usedCount: 0,
      successfulUseCount: 0,
      crossSessionUseCount: 0,
      contradictionCount: 0,
    },
    ...over,
  };
}

// ── ASSISTANT-TURN DETECTION (the single-evaluation trigger) ──────────────────

describe("usefulness-accrual: findLastAssistantAnswer", () => {
  it("returns the assistant text when the LAST turn is the assistant", () => {
    const messages = [msg("user", "where are we?"), msg("assistant", "We landed the ranking plan.")];
    expect(findLastAssistantAnswer(messages)).toBe("We landed the ranking plan.");
  });

  it("returns undefined when the last turn is the user (no answer to evaluate)", () => {
    const messages = [msg("assistant", "earlier reply"), msg("user", "next question")];
    expect(findLastAssistantAnswer(messages)).toBeUndefined();
  });

  it("returns undefined for an empty/whitespace assistant turn", () => {
    expect(findLastAssistantAnswer([msg("assistant", "   ")])).toBeUndefined();
  });

  it("returns undefined for an empty batch", () => {
    expect(findLastAssistantAnswer([])).toBeUndefined();
  });
});

// ── TRACE SELECTION ───────────────────────────────────────────────────────────

describe("usefulness-accrual: pickTraceForSession", () => {
  const traces: AccrualTrace[] = [
    { id: "t3", sessionId: "B", intentLabel: "fact", createdAt: "2026-06-10T03:00:00Z", items: [] },
    { id: "t2", sessionId: "A", intentLabel: "current_status", createdAt: "2026-06-10T02:00:00Z", items: [] },
    { id: "t1", sessionId: "A", intentLabel: "fact", createdAt: "2026-06-10T01:00:00Z", items: [] },
  ];

  it("picks the most recent trace matching the session (list is newest-first)", () => {
    expect(pickTraceForSession(traces, "A")?.id).toBe("t2");
  });

  it("picks the single most recent trace when no session is given", () => {
    expect(pickTraceForSession(traces, undefined)?.id).toBe("t3");
  });

  it("returns undefined when no trace matches the session", () => {
    expect(pickTraceForSession(traces, "Z")).toBeUndefined();
  });
});

// ── COUNTER INTENT-GATING (R3) ────────────────────────────────────────────────

describe("usefulness-accrual: buildUsefulnessAccrual intent gating", () => {
  it("attaches status counters ONLY on status-class intents", () => {
    const rows = [priorRow("m1", "the capture hook writes semiote records")];
    const statusPatch = buildUsefulnessAccrual({
      answer: "the capture hook writes semiote records directly",
      intentLabel: "current_status",
      rows,
    })[0];
    const factPatch = buildUsefulnessAccrual({
      answer: "the capture hook writes semiote records directly",
      intentLabel: "fact",
      rows,
    })[0];

    expect(statusPatch.statusRetrievedCount).toBe(1);
    expect(factPatch.statusRetrievedCount).toBeUndefined();
    expect(factPatch.statusUsedCount).toBeUndefined();
  });

  it("increments status_used_count only when the row was lexically used (overlap)", () => {
    // High overlap → used. status_used_count advances with status_retrieved_count.
    const used = buildUsefulnessAccrual({
      answer: "the capture hook writes semiote records to surrealdb on every turn",
      intentLabel: "session_opener",
      rows: [priorRow("hit", "the capture hook writes semiote records to surrealdb")],
    })[0];
    expect(used.statusRetrievedCount).toBe(1);
    expect(used.statusUsedCount).toBe(1);

    // Zero overlap → shown but never used: retrieved advances, used does NOT.
    const notUsed = buildUsefulnessAccrual({
      answer: "completely unrelated text about gardening and weather",
      intentLabel: "session_opener",
      rows: [priorRow("noise", "the capture hook writes semiote records to surrealdb")],
    })[0];
    expect(notUsed.statusRetrievedCount).toBe(1);
    expect(notUsed.statusUsedCount).toBe(0);
  });

  it("carries forward prior counters (monotonic increment)", () => {
    const patch = buildUsefulnessAccrual({
      answer: "unrelated",
      intentLabel: "current_status",
      rows: [priorRow("m", "scaffolding noise about builder brief", { statusRetrievedCount: 4, statusUsedCount: 0 })],
    })[0];
    expect(patch.statusRetrievedCount).toBe(5); // crosses the default threshold
    expect(patch.statusUsedCount).toBe(0);
  });
});

// ── ORCHESTRATION: single-eval guard + fire-and-forget error isolation ────────

describe("usefulness-accrual: accrueUsefulnessFromCapture", () => {
  function makeDeps(over: Partial<UsefulnessAccrualDeps> = {}): {
    deps: UsefulnessAccrualDeps;
    persist: ReturnType<typeof vi.fn>;
  } {
    const persist = vi.fn().mockResolvedValue(undefined);
    const deps: UsefulnessAccrualDeps = {
      listTraces: vi.fn().mockResolvedValue([
        { id: "t1", sessionId: "S", intentLabel: "current_status", createdAt: "2026-06-10T01:00:00Z", items: [{ id: "m1" }, { id: "m2" }] },
      ] as AccrualTrace[]),
      loadPriorState: vi.fn().mockResolvedValue([priorRow("m1", "alpha"), priorRow("m2", "beta")]),
      persistPatch: persist,
      ...over,
    };
    return { deps, persist };
  }

  it("evaluates the session's most recent trace and persists one patch per item", async () => {
    const { deps, persist } = makeDeps();
    const result = await accrueUsefulnessFromCapture(deps, {
      userId: "owner",
      sessionId: "S",
      messages: [msg("user", "status?"), msg("assistant", "we are working on alpha")],
    });
    expect(result.status).toBe("ok");
    expect(result.traceId).toBe("t1");
    expect(result.evaluated).toBe(2);
    expect(result.statusConditioned).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("does NOTHING when the last turn is not an assistant turn (single-eval guard)", async () => {
    const { deps, persist } = makeDeps();
    const result = await accrueUsefulnessFromCapture(deps, {
      userId: "owner",
      sessionId: "S",
      messages: [msg("assistant", "old"), msg("user", "new question")],
    });
    expect(result.status).toBe("no_assistant_turn");
    expect(result.evaluated).toBe(0);
    expect(deps.listTraces).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns no_trace when the session has no matching retrieval trace", async () => {
    const { deps, persist } = makeDeps({ listTraces: vi.fn().mockResolvedValue([]) });
    const result = await accrueUsefulnessFromCapture(deps, {
      userId: "owner",
      sessionId: "S",
      messages: [msg("assistant", "answer text")],
    });
    expect(result.status).toBe("no_trace");
    expect(persist).not.toHaveBeenCalled();
  });

  it("is FIRE-AND-FORGET safe: a thrown DB error is caught and surfaced as status:error", async () => {
    const { deps, persist } = makeDeps({
      loadPriorState: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await accrueUsefulnessFromCapture(deps, {
      userId: "owner",
      sessionId: "S",
      messages: [msg("assistant", "answer text")],
    });
    expect(result.status).toBe("error");
    expect(result.evaluated).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not status-condition counters when the trace intent is non-status", async () => {
    const { deps } = makeDeps({
      listTraces: vi.fn().mockResolvedValue([
        { id: "t9", sessionId: "S", intentLabel: "fact", createdAt: "2026-06-10T01:00:00Z", items: [{ id: "m1" }] },
      ] as AccrualTrace[]),
      loadPriorState: vi.fn().mockResolvedValue([priorRow("m1", "alpha")]),
    });
    const result = await accrueUsefulnessFromCapture(deps, {
      userId: "owner",
      sessionId: "S",
      messages: [msg("assistant", "answer about alpha")],
    });
    expect(result.status).toBe("ok");
    expect(result.statusConditioned).toBe(false);
  });
});
