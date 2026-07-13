import { describe, it, expect, vi, afterEach } from "vitest";
import {
  deleteExpiredConsolidationLogs,
  resolveConsolidationLogRetentionDays,
} from "../lifecycle/semion/consolidation.js";

// #3 ADOPT-NOW: consolidation_log retention. The skipped_no_sessions spam-writer is
// gone; this forward-looking sweep keeps the run-history table bounded WITHOUT pruning
// any user's latest sweep (the row getMemoryHealth reads via consolidation_state).
// (The live NOTINSIDE-exemption semantics are validated separately against a real DB;
// these unit tests pin the function's count→delete contract + clamp.)

afterEach(() => {
  delete process.env.RUNIR_CONSOLIDATION_LOG_RETENTION_DAYS;
});

describe("resolveConsolidationLogRetentionDays", () => {
  it("defaults to 90 and honors a positive env override", () => {
    expect(resolveConsolidationLogRetentionDays()).toBe(90);
    process.env.RUNIR_CONSOLIDATION_LOG_RETENTION_DAYS = "30";
    expect(resolveConsolidationLogRetentionDays()).toBe(30);
  });

  it("ignores non-positive or junk overrides", () => {
    process.env.RUNIR_CONSOLIDATION_LOG_RETENTION_DAYS = "0";
    expect(resolveConsolidationLogRetentionDays()).toBe(90);
    process.env.RUNIR_CONSOLIDATION_LOG_RETENTION_DAYS = "later";
    expect(resolveConsolidationLogRetentionDays()).toBe(90);
  });
});

describe("deleteExpiredConsolidationLogs", () => {
  it("counts then deletes rows past the cutoff, exempting each user's latest sweep", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce([[{ n: 5 }]]) // count
        .mockResolvedValueOnce([[]]), // delete
    };
    const swept = await deleteExpiredConsolidationLogs(db as never, 90);
    expect(swept).toBe(5);
    expect(db.query).toHaveBeenCalledTimes(2);
    for (const call of db.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toContain("completed_at < <datetime>$cutoff");
      // per-user latest-sweep exemption (Codex Q5: not a single global latest)
      expect(sql).toContain("sweep_id NOTINSIDE");
      expect(sql).toContain("consolidation_state");
      expect(sql).toContain("last_sweep_id != NONE");
      expect((call[1] as Record<string, unknown>).cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(String(db.query.mock.calls[1][0])).toContain("DELETE consolidation_log");
  });

  it("skips the DELETE entirely when nothing is expired", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce([[{ n: 0 }]]) };
    const swept = await deleteExpiredConsolidationLogs(db as never, 90);
    expect(swept).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("clamps retention to at least 1 day", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce([[{ n: 0 }]]) };
    await deleteExpiredConsolidationLogs(db as never, 0.2);
    const cutoff = Date.parse((db.query.mock.calls[0][1] as { cutoff: string }).cutoff);
    // cutoff must be ~1 day ago, not in the future
    expect(Date.now() - cutoff).toBeGreaterThan(0.9 * 86_400_000);
  });
});
