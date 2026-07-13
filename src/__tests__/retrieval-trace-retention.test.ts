import { describe, it, expect, vi, afterEach } from "vitest";
import { deleteExpiredRetrievalTraces, resolveTraceRetentionDays } from "../storage/surreal/phase2-store.js";

// Rúnir-x41m.9: retrieval_trace retention — verbatim stays uncapped, the
// growth lever is row retention; feedback-bearing rows are never swept.

afterEach(() => {
  delete process.env.RUNIR_TRACE_RETENTION_DAYS;
});

describe("resolveTraceRetentionDays", () => {
  it("defaults to 90 and honors a positive env override", () => {
    expect(resolveTraceRetentionDays()).toBe(90);
    process.env.RUNIR_TRACE_RETENTION_DAYS = "14";
    expect(resolveTraceRetentionDays()).toBe(14);
  });

  it("ignores non-positive or junk overrides", () => {
    process.env.RUNIR_TRACE_RETENTION_DAYS = "0";
    expect(resolveTraceRetentionDays()).toBe(90);
    process.env.RUNIR_TRACE_RETENTION_DAYS = "soon";
    expect(resolveTraceRetentionDays()).toBe(90);
  });
});

describe("deleteExpiredRetrievalTraces", () => {
  it("counts then deletes only unrated, unanswered rows past the cutoff", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ n: 7 }]]) // count
        .mockResolvedValueOnce([[]]),        // delete
    };
    const swept = await deleteExpiredRetrievalTraces(db as any, 90);
    expect(swept).toBe(7);
    expect(db.query).toHaveBeenCalledTimes(2);
    for (const call of db.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toContain("rating = NONE");
      expect(sql).toContain("answer = NONE");
      expect(sql).toContain("created_at < <datetime>$cutoff");
      expect((call[1] as Record<string, unknown>).cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(String(db.query.mock.calls[1][0])).toContain("DELETE retrieval_trace");
  });

  it("skips the DELETE entirely when nothing is expired", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce([[{ n: 0 }]]) };
    const swept = await deleteExpiredRetrievalTraces(db as any, 90);
    expect(swept).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("clamps retention to at least 1 day", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce([[{ n: 0 }]]) };
    await deleteExpiredRetrievalTraces(db as any, 0.2);
    const cutoff = Date.parse((db.query.mock.calls[0][1] as { cutoff: string }).cutoff);
    // cutoff must be ~1 day ago, not in the future
    expect(Date.now() - cutoff).toBeGreaterThan(0.9 * 86_400_000);
  });
});
