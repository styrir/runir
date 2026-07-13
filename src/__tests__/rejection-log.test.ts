import { describe, it, expect, vi } from "vitest";
import { ensureRejectionLogTable, logRejection } from "../storage/surreal/surreal-store.js";

// Mock SurrealClient
function makeMockDb() {
  return {
    query: vi.fn().mockResolvedValue([[]]),
  };
}

describe("ensureRejectionLogTable", () => {
  it("defines the rejection_log table and fields", async () => {
    const db = makeMockDb();
    await ensureRejectionLogTable(db as any);
    const calls = db.query.mock.calls.map((c: any) => c[0]);
    expect(calls.some((sql: string) => sql.includes("rejection_log") && sql.includes("SCHEMAFULL"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("reason"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("candidate_text"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("confidence"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("session_id"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("user_id"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("rejected_at"))).toBe(true);
  });
});

describe("logRejection", () => {
  it("creates a rejection_log record", async () => {
    const db = makeMockDb();
    await logRejection(db as any, {
      reason: "low-confidence",
      candidateText: "Some rejected fact text",
      confidence: 0.3,
      sessionId: "sess-1",
      userId: "user-1",
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, vars] = db.query.mock.calls[0];
    expect(sql).toContain("CREATE rejection_log");
    expect(vars.reason).toBe("low-confidence");
    expect(vars.text).toBe("Some rejected fact text");
    expect(vars.conf).toBe(0.3);
    expect(vars.sid).toBe("sess-1");
    expect(vars.uid).toBe("user-1");
  });

  it("truncates candidate text to 200 chars", async () => {
    const db = makeMockDb();
    const longText = "a".repeat(500);
    await logRejection(db as any, {
      reason: "noise-filter",
      candidateText: longText,
      userId: "user-1",
    });
    const [, vars] = db.query.mock.calls[0];
    expect(vars.text.length).toBe(200);
  });

  it("does not throw on db failure (fire-and-forget)", async () => {
    const db = makeMockDb();
    db.query.mockRejectedValueOnce(new Error("DB down"));
    // Should not throw
    await logRejection(db as any, {
      reason: "low-confidence",
      candidateText: "test",
      userId: "user-1",
    });
  });
});
