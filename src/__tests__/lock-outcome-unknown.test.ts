import { describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock } from "../lifecycle/semion/lock.js";
import { QueryOutcomeUnknownError } from "../storage/surreal/surreal-client.js";

// vk-2995: when the lease CREATE is lost with its connection, acquireLock
// reconciles by reading its own holder token back instead of guessing.

const lost = () => new QueryOutcomeUnknownError(Object.assign(new Error("closed"), { name: "CallTerminatedError" }));

function dbWhereCreateIsLost(leaseCommitted: boolean | "read-fails") {
  let holder: string | undefined;
  return {
    query: vi.fn(async (sql: string, vars?: Record<string, unknown>) => {
      if (sql.includes("CREATE consolidation_locks")) { holder = vars?.holder as string; throw lost(); }
      if (sql.startsWith("SELECT id FROM consolidation_locks")) {
        if (leaseCommitted === "read-fails") throw new Error("read failed");
        return [leaseCommitted && vars?.holder === holder ? [{ id: "consolidation_locks:1" }] : []];
      }
      return [[]];
    }),
  };
}

describe("acquireLock after an outcome-unknown CREATE", () => {
  it("returns the holder when the lease did commit, so the caller releases it", async () => {
    const db = dbWhereCreateIsLost(true);
    const holder = await acquireLock(db as never, "u::s", 60);
    expect(typeof holder).toBe("string");
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("SELECT id FROM consolidation_locks"),
      { key: "u::s", holder });
  });

  it("rethrows when the lease did not commit", async () => {
    await expect(acquireLock(dbWhereCreateIsLost(false) as never, "u::s", 60)).rejects.toBeInstanceOf(QueryOutcomeUnknownError);
  });

  it("rethrows when the read-back fails; the lease, if any, expires after its TTL", async () => {
    await expect(acquireLock(dbWhereCreateIsLost("read-fails") as never, "u::s", 60)).rejects.toBeInstanceOf(QueryOutcomeUnknownError);
  });
});

describe("releaseLock", () => {
  it("marks its holder-scoped DELETE safe to re-send", async () => {
    const db = { query: vi.fn(async () => [[]]) };
    await releaseLock(db as never, "u::s", "h1");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DELETE consolidation_locks"),
      { key: "u::s", holder: "h1" }, { resendSafe: true });
  });
});
