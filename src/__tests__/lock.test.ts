import { describe, it, expect, vi } from "vitest";
import {
  acquireLock,
  extendLock,
  releaseLock,
  writeStalenessBacklog,
  ensureConsolidationLockTable,
  ensureStalenessBacklogTable,
} from "../lifecycle/semion/lock.js";

type MockDb = { query: ReturnType<typeof vi.fn> };

// acquireLock relies on the UNIQUE idx_cl_key index as the contention arbiter:
// reap expired lease, CREATE the new one — a live lease makes the CREATE throw
// an idx_cl_key rejection. (The old transaction/RETURN-parsing pattern never
// detected contention through normalizeResults — Rúnir-x46j.)

function makeDb(transactionResults: unknown[]): MockDb {
  return { query: vi.fn().mockResolvedValue(transactionResults) };
}

describe("acquireLock", () => {
  it("returns a holder ID when lock is acquired (no existing lock)", async () => {
    const db = makeDb([[], [{ id: "consolidation_locks:new-record" }]]);
    const holder = await acquireLock(db as any, "user1::user", 60);
    expect(holder).not.toBeNull();
    expect(typeof holder).toBe("string");
  });

  it("returns null when the unique index rejects the CREATE (lock already held)", async () => {
    const db = {
      query: vi.fn().mockRejectedValue(
        new Error("InternalError: Database index `idx_cl_key` already contains 'user1::user', with record `consolidation_locks:abc`"),
      ),
    };
    const holder = await acquireLock(db as any, "user1::user", 60);
    expect(holder).toBeNull();
  });

  it("rethrows non-contention DB failures instead of masquerading as contention", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("ConnectionUnavailable: socket closed")) };
    await expect(acquireLock(db as any, "user1::user", 60)).rejects.toThrow("ConnectionUnavailable");
  });

  it("calls db.query with ttl inlined as literal (not a bound param)", async () => {
    const db = makeDb([[], [{ id: "consolidation_locks:new-record" }]]);
    await acquireLock(db as any, "user1::session", 300);
    expect(db.query).toHaveBeenCalledOnce();
    const [queryStr, params] = db.query.mock.calls[0];
    expect(queryStr).toContain("CREATE consolidation_locks");
    expect(queryStr).toMatch(/300s/);
    expect(queryStr).toContain("DELETE consolidation_locks WHERE lock_key = $key AND expires_at <= time::now()");
    expect(params).toHaveProperty("key", "user1::session");
    expect(params).toHaveProperty("holder");
    expect(params).not.toHaveProperty("ttl");
  });
});

describe("extendLock", () => {
  it("extends the lease and returns true when the holder still owns the lock", async () => {
    const db = makeDb([[{ id: "consolidation_locks:row" }]]);
    const extended = await extendLock(db as any, "user1::user", "holder-uuid", 300);
    expect(extended).toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("UPDATE consolidation_locks");
    expect(sql).toContain("expires_at = time::now() + 300s");
    expect(sql).toContain("lock_key = $key AND holder = $holder");
    expect(params).toEqual({ key: "user1::user", holder: "holder-uuid" });
  });

  it("returns false when the lease row no longer exists (expired and reaped)", async () => {
    const db = makeDb([[]]);
    const extended = await extendLock(db as any, "user1::user", "holder-uuid", 300);
    expect(extended).toBe(false);
  });

  it("floors fractional TTLs and clamps to at least 1s", async () => {
    const db = makeDb([[]]);
    await extendLock(db as any, "k", "h", 0.4);
    expect(db.query.mock.calls[0][0]).toContain("+ 1s");
  });
});

describe("releaseLock", () => {
  it("calls db.query to delete the lock record", async () => {
    const db = makeDb([[]]);
    await releaseLock(db as any, "user1::user", "holder-uuid");
    expect(db.query).toHaveBeenCalledOnce();
    const [queryStr, params] = db.query.mock.calls[0];
    expect(queryStr).toContain("DELETE");
    expect(params).toHaveProperty("key", "user1::user");
    expect(params).toHaveProperty("holder", "holder-uuid");
  });
});

describe("writeStalenessBacklog", () => {
  it("creates a staleness backlog entry", async () => {
    const db = makeDb([[]]);
    await writeStalenessBacklog(db as any, "user1", "user", "sess-1", [
      { text: "fact1", confidence: 0.9, replacementMemoryId: "m1" },
    ]);
    expect(db.query).toHaveBeenCalledOnce();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("CREATE staleness_backlog");
    expect(params.userId).toBe("user1");
    expect(params.scope).toBe("user");
    expect(params.sessionId).toBe("sess-1");
    expect(params.facts).toHaveLength(1);
  });

  it("handles undefined sessionId (sets null)", async () => {
    const db = makeDb([[]]);
    await writeStalenessBacklog(db as any, "user1", "user", undefined, []);
    const params = db.query.mock.calls[0][1];
    expect(params.sessionId).toBeNull();
  });
});

describe("ensureConsolidationLockTable", () => {
  it("defines table, fields, and index", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;
    await ensureConsolidationLockTable(db);
    expect(db.query).toHaveBeenCalledTimes(6);
    const calls = db.query.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("DEFINE TABLE"))).toBe(true);
    expect(calls.some((s: string) => s.includes("lock_key"))).toBe(true);
    expect(calls.some((s: string) => s.includes("holder"))).toBe(true);
    expect(calls.some((s: string) => s.includes("expires_at"))).toBe(true);
    expect(calls.some((s: string) => s.includes("idx_cl_key"))).toBe(true);
  });
});

describe("ensureStalenessBacklogTable", () => {
  it("defines table, fields, and index", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) } as any;
    await ensureStalenessBacklogTable(db);
    expect(db.query).toHaveBeenCalledTimes(8);
    const calls = db.query.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((s: string) => s.includes("DEFINE TABLE"))).toBe(true);
    expect(calls.some((s: string) => s.includes("user_id"))).toBe(true);
    expect(calls.some((s: string) => s.includes("facts"))).toBe(true);
    expect(calls.some((s: string) => s.includes("status"))).toBe(true);
    expect(calls.some((s: string) => s.includes("idx_sb_status"))).toBe(true);
  });
});
