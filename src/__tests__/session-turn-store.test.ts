import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordSessionTurns,
  deleteExpiredSessionTurns,
  resolveTurnRetentionDays,
} from "../storage/surreal/session-turn-store.js";

const mockDb = { query: vi.fn() } as any;

describe("recordSessionTurns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never resumes the retired raw session-end write", async () => {
    const written = await recordSessionTurns(mockDb, {
      userId: "u1",
      sessionId: "s1",
      client: "claudecode",
      turns: [
        { turnIndex: 4, role: "user", content: "hello" },
        { turnIndex: 5, role: "assistant", content: "hi" },
      ],
    });
    expect(written).toBe(0);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("short-circuits on empty turn list without a DB call", async () => {
    expect(await recordSessionTurns(mockDb, { userId: "u1", sessionId: "s1", turns: [] })).toBe(0);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("deleteExpiredSessionTurns / resolveTurnRetentionDays", () => {
  const OLD = process.env.RUNIR_TURN_RETENTION_DAYS;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    if (OLD === undefined) delete process.env.RUNIR_TURN_RETENTION_DAYS;
    else process.env.RUNIR_TURN_RETENTION_DAYS = OLD;
    vi.clearAllMocks();
  });

  it("deletes only expired unlinked headers and their chunks", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);
    await deleteExpiredSessionTurns(mockDb, 30);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("DELETE session_turn_chunk WHERE turn_id IN");
    expect(sql).toContain("DELETE session_turn WHERE retention_class = 'unlinked'");
    expect(sql).toContain("retain_until < <datetime>$cutoff");
    const cutoffMs = Date.parse(params.cutoff);
    const expected = Date.now();
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(10_000);
  });

  it("retention env: default 30, positive override honored, garbage falls back", () => {
    delete process.env.RUNIR_TURN_RETENTION_DAYS;
    expect(resolveTurnRetentionDays()).toBe(30);
    process.env.RUNIR_TURN_RETENTION_DAYS = "7";
    expect(resolveTurnRetentionDays()).toBe(7);
    process.env.RUNIR_TURN_RETENTION_DAYS = "banana";
    expect(resolveTurnRetentionDays()).toBe(30);
    process.env.RUNIR_TURN_RETENTION_DAYS = "-2";
    expect(resolveTurnRetentionDays()).toBe(30);
  });
});
