// Live-DB tests for the durable last_closed_at field (Rúnir-78sy.13, F1).
//
// Mock-db tests in runir-session-store.test.ts cover the CALL SHAPE (SQL
// substrings, param objects). This file proves the actual DB BEHAVIOR the F1
// race rule depends on — SurrealQL parse errors and monotone-guard logic are
// invisible to a mocked db.query (repo lesson, SurrealDB planner findings) —
// against the real native SurrealDB on 127.0.0.1:8000, isolated TEST_DB
// namespace, matching the continuity-*-repro.test.ts conventions. Skips
// cleanly when no local SurrealDB is reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureRunirSessionTable, resolveRunirSession } from "../storage/surreal/runir-session-store.js";

const TEST_DB = "runir_session_78sy13_repro_test";
const USER = "_78sy13_repro_user";

function makeDb(): SurrealClient {
  return new SurrealClient({
    // 127.0.0.1 (IPv4), not localhost — the native install binds IPv4 only.
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

let db: SurrealClient;
let dbAvailable = false;

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await db.query("REMOVE TABLE IF EXISTS runir_session;").catch(() => undefined);
  await ensureRunirSessionTable(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => undefined);
    await db.close().catch(() => undefined);
  }
});

// ── Schema content-pin (mock db, always runs — no live DB dependency) ───────

describe("ensureRunirSessionTable schema (F1/F5 content-pin)", () => {
  it("defines last_closed_at as option<datetime> and both new indexes", async () => {
    const calls: string[] = [];
    const mockDb = { query: async (sql: string) => { calls.push(sql); return [[]]; } } as any;
    await ensureRunirSessionTable(mockDb);
    const joined = calls.join("\n");
    expect(joined).toContain("DEFINE FIELD IF NOT EXISTS last_closed_at ON TABLE runir_session TYPE option<datetime>;");
    expect(joined).toContain("DEFINE INDEX IF NOT EXISTS idx_runir_session_user_last_closed ON TABLE runir_session COLUMNS user_id, last_closed_at;");
    expect(joined).toContain("DEFINE INDEX IF NOT EXISTS idx_runir_session_user_status_seen ON TABLE runir_session COLUMNS user_id, status, last_seen_at;");
    // Legacy index stays (harmless, per brief).
    expect(joined).toContain("DEFINE INDEX IF NOT EXISTS idx_runir_session_user_status_closed ON TABLE runir_session COLUMNS user_id, status, closed_at;");
  });
});

// ── Live-DB behavior ──────────────────────────────────────────────────────────

describe("F1: last_closed_at preserve-through-reactivation + monotone advance (live DB)", () => {
  it("close then reactivate: closed_at/close_reason clear (unchanged semantics) but last_closed_at SURVIVES", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const t0 = "2026-07-01T08:00:00.000Z";
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:preserve",
      nativeSessionId: "sess-preserve-1",
      status: "active",
      now: t0,
    });

    const t1 = "2026-07-01T09:00:00.000Z";
    const closed = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:preserve",
      nativeSessionId: "sess-preserve-1",
      status: "closed",
      closeReason: "session_end",
      closedAt: t1,
      now: t1,
    });
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBe(t1);
    expect(closed.closeReason).toBe("session_end");
    expect(closed.lastClosedAt).toBe(t1);

    // Reactivate (the 8dc426e directive: every opener/recall/capture call
    // hardcodes status:"active" on resume) — closed_at/close_reason CLEAR
    // (Addendum A: a live consumer, selectBoundSessionId, depends on this),
    // but last_closed_at must NOT be cleared.
    const t2 = "2026-07-01T10:00:00.000Z";
    const reactivated = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:preserve",
      nativeSessionId: "sess-preserve-1",
      status: "active",
      now: t2,
    });
    expect(reactivated.status).toBe("active");
    expect(reactivated.closedAt).toBeUndefined();
    expect(reactivated.closeReason).toBeUndefined();
    expect(reactivated.lastClosedAt).toBe(t1); // SURVIVES reactivation

    // Confirm directly against the row, not just the returned object (the
    // returned object could theoretically diverge from what's persisted).
    const rows = await db.query<{ status: string; closed_at?: unknown; close_reason?: unknown; last_closed_at?: unknown }>(
      "SELECT status, closed_at, close_reason, last_closed_at FROM runir_session WHERE resolver_key = $rk;",
      { rk: reactivated.resolverKey },
    );
    const row = rows[0]?.[0];
    expect(row?.status).toBe("active");
    expect(row?.closed_at).toBeUndefined();
    expect(row?.close_reason).toBeUndefined();
    expect(String(row?.last_closed_at)).toContain("2026-07-01T09:00:00");
  });

  it("second close OVERWRITES last_closed_at (monotone advance to the newer close)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const t0 = "2026-07-01T08:00:00.000Z";
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:second-close",
      nativeSessionId: "sess-second-close",
      status: "active",
      now: t0,
    });

    const closeA = "2026-07-01T09:00:00.000Z";
    const firstClose = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:second-close",
      nativeSessionId: "sess-second-close",
      status: "closed",
      closedAt: closeA,
      now: closeA,
    });
    expect(firstClose.lastClosedAt).toBe(closeA);

    // Reactivate then close again LATER — last_closed_at must advance to the
    // newer close (closeB), not be stuck at the first close.
    const t1 = "2026-07-01T09:30:00.000Z";
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:second-close",
      nativeSessionId: "sess-second-close",
      status: "active",
      now: t1,
    });

    const closeB = "2026-07-01T11:00:00.000Z";
    const secondClose = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:second-close",
      nativeSessionId: "sess-second-close",
      status: "closed",
      closedAt: closeB,
      now: closeB,
    });
    expect(secondClose.lastClosedAt).toBe(closeB);
    expect(secondClose.closedAt).toBe(closeB);
  });

  it("RACE SHAPE: a stale non-closed resolve computed BEFORE a close lands must NOT clobber last_closed_at when it writes AFTER", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Simulates the exact interleave the F1 race rule guards: two concurrent
    // resolveRunirSession calls both read the row while it is still active
    // (or before any close has happened), then apply their writes out of
    // order — the CLOSE write happens first, then a NON-CLOSED write (from
    // the call that read a stale, pre-close view) lands second. Because the
    // non-closed UPDATE's SET clause OMITS last_closed_at entirely (rather
    // than writing back a stale value it read), the close's stamp survives
    // regardless of write order.
    const t0 = "2026-07-01T08:00:00.000Z";
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:race",
      nativeSessionId: "sess-race-1",
      status: "active",
      now: t0,
    });

    // Call A: a close lands first (e.g. a session-end POST).
    const closeTs = "2026-07-01T09:00:00.000Z";
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:race",
      nativeSessionId: "sess-race-1",
      status: "closed",
      closedAt: closeTs,
      now: closeTs,
    });

    // Call B: a non-closed resolve (e.g. a capture/opener heartbeat) that
    // reflects a call whose OWN read happened before it knew about the
    // close — modeled here simply as "the next active resolve after the
    // close", which is exactly the reactivate path every hook already
    // performs. The critical assertion is not about read timing per se
    // (resolveRunirSession is read-modify-write on ONE row per call, so a
    // literal concurrent interleave is a DB-level race outside JS's control)
    // but about the WRITE SHAPE: this call's SET clause must never include
    // last_closed_at at all when nextStatus !== 'closed'.
    const afterCloseTs = "2026-07-01T09:05:00.000Z";
    const nonClosedResolve = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:race",
      nativeSessionId: "sess-race-1",
      status: "active",
      now: afterCloseTs,
    });
    // last_closed_at must still reflect the close — untouched by the
    // non-closed resolve.
    expect(nonClosedResolve.lastClosedAt).toBe(closeTs);

    const rows = await db.query<{ last_closed_at?: unknown }>(
      "SELECT last_closed_at FROM runir_session WHERE resolver_key = $rk;",
      { rk: nonClosedResolve.resolverKey },
    );
    expect(String(rows[0]?.[0]?.last_closed_at)).toContain("2026-07-01T09:00:00");
  });

  it("CREATE path: a session created already-closed (status:'closed' with no prior row) sets last_closed_at directly", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const closeTs = "2026-07-02T00:00:00.000Z";
    const created = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:create-closed",
      nativeSessionId: "sess-create-closed",
      status: "closed",
      closedAt: closeTs,
      now: closeTs,
    });
    expect(created.status).toBe("closed");
    expect(created.closedAt).toBe(closeTs);
    expect(created.lastClosedAt).toBe(closeTs);

    const rows = await db.query<{ last_closed_at?: unknown }>(
      "SELECT last_closed_at FROM runir_session WHERE resolver_key = $rk;",
      { rk: created.resolverKey },
    );
    expect(String(rows[0]?.[0]?.last_closed_at)).toContain("2026-07-02T00:00:00");
  });

  it("a freshly-created ACTIVE session has NO last_closed_at (absent, not a zero-date)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const created = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:fresh-active",
      nativeSessionId: "sess-fresh-active",
      status: "active",
      now: "2026-07-02T01:00:00.000Z",
    });
    expect(created.lastClosedAt).toBeUndefined();

    const rows = await db.query<{ last_closed_at?: unknown }>(
      "SELECT last_closed_at FROM runir_session WHERE resolver_key = $rk;",
      { rk: created.resolverKey },
    );
    expect(rows[0]?.[0]?.last_closed_at).toBeUndefined();
  });
});
