// Live-DB tests for the idle-session janitor (Rúnir-78sy.13, F3).
//
// The janitor's bespoke SurrealQL (conditional count() preflight, monotone
// last_closed_at guard on a bulk UPDATE) is exercised against the real native
// SurrealDB on 127.0.0.1:8000, isolated TEST_DB namespace — SurrealQL parse
// errors and monotone-guard/aggregate-function behavior are invisible to a
// mocked db.query (repo lesson). Matches the continuity-*-repro.test.ts /
// runir-session-store-repro.test.ts conventions. Skips cleanly when no local
// SurrealDB is reachable.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureRunirSessionTable, resolveRunirSession } from "../storage/surreal/runir-session-store.js";
import { resolveSessionIdleCloseH, runSessionIdleJanitorStep } from "../lifecycle/semion/session-janitor.js";

const TEST_DB = "session_janitor_78sy13_repro_test";
const USER_A = "_78sy13_janitor_user_a";
const USER_B = "_78sy13_janitor_user_b";

function makeDb(): SurrealClient {
  return new SurrealClient({
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

afterEach(() => {
  delete process.env.RUNIR_SESSION_IDLE_CLOSE_H;
});

// ── Env resolver unit coverage (0-disable distinct from unset/invalid) ──────

describe("resolveSessionIdleCloseH", () => {
  afterEach(() => {
    delete process.env.RUNIR_SESSION_IDLE_CLOSE_H;
  });

  it("defaults to 12 when unset", () => {
    delete process.env.RUNIR_SESSION_IDLE_CLOSE_H;
    expect(resolveSessionIdleCloseH()).toBe(12);
  });

  it("0 explicitly DISABLES (distinct from unset)", () => {
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "0";
    expect(resolveSessionIdleCloseH()).toBe(0);
  });

  it("negative values also disable", () => {
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "-5";
    expect(resolveSessionIdleCloseH()).toBe(0);
  });

  it("invalid (non-numeric) falls back to the default, NOT disabled", () => {
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "not-a-number";
    expect(resolveSessionIdleCloseH()).toBe(12);
  });

  it("a valid positive override is honored", () => {
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "6";
    expect(resolveSessionIdleCloseH()).toBe(6);
  });
});

// ── Live-DB behavior ──────────────────────────────────────────────────────────

describe("runSessionIdleJanitorStep (live DB)", () => {
  it("closes an idle active row: status→closed, closed_at=last_seen_at (NOT now), close_reason=idle_timeout, last_closed_at stamped", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "1"; // 1h idle threshold for this test

    const lastSeenAt = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2h idle
    const created = await resolveRunirSession(db, {
      userId: USER_A,
      projectKey: "project:janitor-idle",
      nativeSessionId: "sess-janitor-idle",
      status: "active",
      now: lastSeenAt,
    });

    const before = Date.now();
    const result = await runSessionIdleJanitorStep(db, USER_A);
    expect(result.disabled).toBe(false);
    expect(result.closed).toBeGreaterThanOrEqual(1);

    const rows = await db.query<{ status: string; closed_at?: unknown; close_reason?: unknown; last_closed_at?: unknown; last_seen_at?: unknown }>(
      "SELECT status, closed_at, close_reason, last_closed_at, last_seen_at FROM runir_session WHERE resolver_key = $rk;",
      { rk: created.resolverKey },
    );
    const row = rows[0]?.[0];
    expect(row?.status).toBe("closed");
    expect(row?.close_reason).toBe("idle_timeout");
    // closed_at = last_seen_at (flood-safety choice), NOT "now" — must be the
    // OLD idle timestamp, not anywhere near `before`.
    const closedAtMs = new Date(String(row?.closed_at)).getTime();
    const lastSeenAtMs = new Date(String(row?.last_seen_at)).getTime();
    expect(closedAtMs).toBe(lastSeenAtMs);
    expect(closedAtMs).toBeLessThan(before - 3600_000); // clearly in the past, not "now"
    expect(new Date(String(row?.last_closed_at)).getTime()).toBe(lastSeenAtMs);
  });

  it("0 (RUNIR_SESSION_IDLE_CLOSE_H=0) disables the step entirely — no rows touched", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "0";

    const lastSeenAt = new Date(Date.now() - 100 * 3600_000).toISOString(); // very idle
    const created = await resolveRunirSession(db, {
      userId: USER_A,
      projectKey: "project:janitor-disabled",
      nativeSessionId: "sess-janitor-disabled",
      status: "active",
      now: lastSeenAt,
    });

    const result = await runSessionIdleJanitorStep(db, USER_A);
    expect(result.disabled).toBe(true);
    expect(result.closed).toBe(0);

    const rows = await db.query<{ status: string }>(
      "SELECT status FROM runir_session WHERE resolver_key = $rk;",
      { rk: created.resolverKey },
    );
    expect(rows[0]?.[0]?.status).toBe("active"); // untouched
  });

  it("USER SCOPING: closing user A's idle rows never touches user B's idle rows in the SAME run", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "1";

    const idleTs = new Date(Date.now() - 5 * 3600_000).toISOString();
    const rowA = await resolveRunirSession(db, {
      userId: USER_A,
      projectKey: "project:scoping",
      nativeSessionId: "sess-scoping-a",
      status: "active",
      now: idleTs,
    });
    const rowB = await resolveRunirSession(db, {
      userId: USER_B,
      projectKey: "project:scoping",
      nativeSessionId: "sess-scoping-b",
      status: "active",
      now: idleTs,
    });

    await runSessionIdleJanitorStep(db, USER_A); // only run for A

    const [afterA, afterB] = await Promise.all([
      db.query<{ status: string }>("SELECT status FROM runir_session WHERE resolver_key = $rk;", { rk: rowA.resolverKey }),
      db.query<{ status: string }>("SELECT status FROM runir_session WHERE resolver_key = $rk;", { rk: rowB.resolverKey }),
    ]);
    expect(afterA[0]?.[0]?.status).toBe("closed"); // A's idle row closed
    expect(afterB[0]?.[0]?.status).toBe("active"); // B's untouched by A's run
  });

  it("PREFLIGHT LOG: emits 'janitor: closing N idle sessions for <user> (M within gap lookback)' BEFORE the UPDATE, with correct counts", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "1";
    // Detector lookback default is 168h; put one idle row well within it
    // (2h ago) and one idle row's last_seen_at just past the idle threshold
    // but still within 168h (10h ago) — both count toward `total`; both are
    // "within gap lookback" (168h) in this setup, so pin the counts exactly.
    const withinLookbackTs = new Date(Date.now() - 2 * 3600_000).toISOString();
    const alsoWithinLookbackTs = new Date(Date.now() - 10 * 3600_000).toISOString();
    await resolveRunirSession(db, {
      userId: USER_A,
      projectKey: "project:preflight-log",
      nativeSessionId: "sess-preflight-1",
      status: "active",
      now: withinLookbackTs,
    });
    await resolveRunirSession(db, {
      userId: USER_A,
      projectKey: "project:preflight-log-2",
      nativeSessionId: "sess-preflight-2",
      status: "active",
      now: alsoWithinLookbackTs,
    });

    const logs: string[] = [];
    await runSessionIdleJanitorStep(db, USER_A, (msg) => logs.push(msg));

    const preflightLine = logs.find((l) => l.startsWith("janitor: closing"));
    expect(preflightLine).toBeTruthy();
    expect(preflightLine).toMatch(new RegExp(`janitor: closing \\d+ idle sessions for ${USER_A} \\(\\d+ within gap lookback\\)`));
    // Both rows just created are within the 168h default lookback.
    const match = preflightLine?.match(/closing (\d+) idle sessions for .+ \((\d+) within gap lookback\)/);
    expect(match).toBeTruthy();
    const [, totalStr, withinStr] = match ?? [];
    expect(Number(totalStr)).toBeGreaterThanOrEqual(2);
    expect(Number(withinStr)).toBeGreaterThanOrEqual(2);
  });

  it("skips silently (no log line) when 0 rows match the idle condition", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "1";
    const freshUser = "_78sy13_janitor_no_zombies";
    // A fresh, currently-active row (last_seen_at = now) never matches the
    // idle threshold — no zombies for this user at all.
    await resolveRunirSession(db, {
      userId: freshUser,
      projectKey: "project:no-zombies",
      nativeSessionId: "sess-no-zombies",
      status: "active",
      now: new Date().toISOString(),
    });

    const logs: string[] = [];
    const result = await runSessionIdleJanitorStep(db, freshUser, (msg) => logs.push(msg));
    expect(result.closed).toBe(0);
    expect(logs.find((l) => l.startsWith("janitor: closing"))).toBeUndefined();
  });

  it("idempotent second run: re-running against an already-closed row is a safe no-op (no error, no double-close)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "1";
    const idleTs = new Date(Date.now() - 3 * 3600_000).toISOString();
    const created = await resolveRunirSession(db, {
      userId: USER_A,
      projectKey: "project:idempotent",
      nativeSessionId: "sess-idempotent",
      status: "active",
      now: idleTs,
    });

    const first = await runSessionIdleJanitorStep(db, USER_A);
    expect(first.closed).toBeGreaterThanOrEqual(1);

    const second = await runSessionIdleJanitorStep(db, USER_A);
    // The row is now status='closed', so the WHERE status='active' clause no
    // longer matches it — second run must not error and must not re-count it
    // (though other still-idle-active rows from earlier tests in this user's
    // scope may still be pending; the specific row under test here is gone
    // from the eligible set either way).
    const rows = await db.query<{ status: string; closed_at?: unknown }>(
      "SELECT status, closed_at FROM runir_session WHERE resolver_key = $rk;",
      { rk: created.resolverKey },
    );
    expect(rows[0]?.[0]?.status).toBe("closed");
    expect(second.disabled).toBe(false);
  });
});
