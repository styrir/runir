import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordSessionTurns,
  listSessionTurnsSince,
  deleteExpiredSessionTurns,
  resolveTurnRetentionDays,
} from "../storage/surreal/session-turn-store.js";

const mockDb = { query: vi.fn() } as any;

describe("recordSessionTurns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes one row per turn with absolute indices and returns the written count", async () => {
    mockDb.query.mockResolvedValue([[]]);
    const written = await recordSessionTurns(mockDb, {
      userId: "u1",
      sessionId: "s1",
      client: "claudecode",
      turns: [
        { turnIndex: 4, role: "user", content: "hello" },
        { turnIndex: 5, role: "assistant", content: "hi" },
      ],
    });
    expect(written).toBe(2);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("session_turn");
    expect(params).toMatchObject({ userId: "u1", sessionId: "s1", client: "claudecode", turnIndex: 4, role: "user", content: "hello" });
  });

  it("swallows UNIQUE-index rejections silently (watermark overlap / retry idempotency)", async () => {
    const warn = vi.fn();
    mockDb.query
      .mockRejectedValueOnce(new Error("Database index `idx_session_turn_unique` already contains [u1, s1, 4]"))
      .mockResolvedValueOnce([[]]);
    const written = await recordSessionTurns(mockDb, {
      userId: "u1", sessionId: "s1",
      turns: [
        { turnIndex: 4, role: "user", content: "dup" },
        { turnIndex: 5, role: "assistant", content: "new" },
      ],
    }, warn);
    expect(written).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns (but continues) on non-unique write failures and never throws", async () => {
    const warn = vi.fn();
    mockDb.query
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce([[]]);
    const written = await recordSessionTurns(mockDb, {
      userId: "u1", sessionId: "s1",
      turns: [
        { turnIndex: 0, role: "user", content: "a" },
        { turnIndex: 1, role: "assistant", content: "b" },
      ],
    }, warn);
    expect(written).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
  });

  it("short-circuits on empty turn list without a DB call", async () => {
    expect(await recordSessionTurns(mockDb, { userId: "u1", sessionId: "s1", turns: [] })).toBe(0);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("listSessionTurnsSince", () => {
  beforeEach(() => vi.clearAllMocks());

  it("orders by session then turn_index for reassembly", async () => {
    mockDb.query.mockResolvedValueOnce([[{ session_id: "s1", turn_index: 0 }]]);
    await listSessionTurnsSince(mockDb, "u1", "2026-06-10T00:00:00Z");
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("ORDER BY session_id, turn_index");
    expect(params).toMatchObject({ userId: "u1", sinceIso: "2026-06-10T00:00:00Z" });
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

  it("deletes strictly older than the cutoff", async () => {
    mockDb.query.mockResolvedValueOnce([[]]);
    await deleteExpiredSessionTurns(mockDb, 30);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("DELETE session_turn WHERE created_at <");
    const cutoffMs = Date.parse(params.cutoff);
    const expected = Date.now() - 30 * 24 * 3600 * 1000;
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
