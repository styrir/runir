// Live-DB tests for F4 (detector reads the durable last_closed_at field) and
// F5 (index verification via live EXPLAIN) of Rúnir-78sy.13.
//
// fetchRecentlyEndedSessions' rewritten WHERE (last_closed_at > cutoff, no
// status filter) and the new idx_runir_session_user_last_closed /
// idx_runir_session_user_status_seen indexes are bespoke SurrealQL — parse
// errors and planner index selection are invisible to a mocked db.query
// (repo lesson, SurrealDB planner findings doc). Exercised against the real
// native SurrealDB on 127.0.0.1:8000, isolated TEST_DB namespace, matching
// the continuity-gaps-handoff-cue-repro.test.ts / runir-session-store-repro
// conventions. Skips cleanly when no local SurrealDB is reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureRunirSessionTable, resolveRunirSession } from "../storage/surreal/runir-session-store.js";
import { fetchRecentlyEndedSessions } from "../lifecycle/semion/continuity-gaps.js";
import { runSessionIdleJanitorStep } from "../lifecycle/semion/session-janitor.js";
import type { ProjectEnrollmentRecord } from "../domain/memory/continuity.js";

const TEST_DB = "continuity_gaps_78sy13_durable_close_repro_test";
const USER = "_78sy13_durable_close_user";
const WORKSPACE_FP = "78sy13durbclz0000000wsfp";

function makeDb(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

function makeEnrollment(overrides: Partial<ProjectEnrollmentRecord> = {}): ProjectEnrollmentRecord {
  return {
    id: "project_enrollment_durable_close",
    userId: USER,
    workspaceId: "-",
    projectKey: "project:durable-close",
    source: "manual",
    enrolledAt: "2026-07-01T00:00:00.000Z",
    repoRootFingerprint: WORKSPACE_FP,
    ...overrides,
  };
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

describe("F4: fetchRecentlyEndedSessions keys on the durable last_closed_at (live DB)", () => {
  // Each test uses its OWN distinguishing workspaceFingerprint (+ matching
  // enrollment binding). NOTE (F17, the exact mechanism this bead is about):
  // buildRunirSessionResolverKey drops nativeSessionId from the resolver key
  // whenever ANY stable workspace identity (projectKey/workspaceFingerprint/
  // hostId) is present — reusing the SAME projectKey+workspaceFingerprint
  // across tests with different nativeSessionIds would silently collapse
  // them onto ONE row (caught live while writing this file: three "distinct"
  // sessions all resolved to the first test's row until this was fixed).

  it("MATCHES a row that closed and then REACTIVATED (status back to active, closed_at cleared) — this is the fix", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}reactivated`;

    const closeTs = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close",
      nativeSessionId: "sess-reactivated",
      workspaceFingerprint: wf,
      status: "closed",
      closedAt: closeTs,
      now: closeTs,
    });
    // Reactivate — the pre-F4 query (status='closed' AND closed_at>cutoff)
    // would now MISS this row entirely (status is 'active', closed_at is
    // cleared). The F4 query must still find it via last_closed_at.
    const reactivatedTs = new Date(Date.now() - 1800_000).toISOString(); // 30m ago
    const reactivated = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close",
      nativeSessionId: "sess-reactivated",
      workspaceFingerprint: wf,
      status: "active",
      now: reactivatedTs,
    });
    expect(reactivated.status).toBe("active");
    expect(reactivated.closedAt).toBeUndefined();

    const cutoffIso = new Date(Date.now() - 24 * 3600_000).toISOString(); // 24h lookback
    const results = await fetchRecentlyEndedSessions(db, USER, makeEnrollment({ repoRootFingerprint: wf }), cutoffIso, 20);
    const found = results.find((r) => r.id === reactivated.id);
    expect(found).toBeTruthy();
    expect(found?.closedAt).toBe(closeTs); // mapped from last_closed_at
  });

  it("EXCLUDES a row whose last_closed_at is OLDER than the cutoff (aged out of window)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}agedout`;

    const oldCloseTs = new Date(Date.now() - 200 * 3600_000).toISOString(); // 200h ago
    const aged = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close",
      nativeSessionId: "sess-aged-out",
      workspaceFingerprint: wf,
      status: "closed",
      closedAt: oldCloseTs,
      now: oldCloseTs,
    });

    const cutoffIso = new Date(Date.now() - 168 * 3600_000).toISOString(); // 168h default lookback
    const results = await fetchRecentlyEndedSessions(db, USER, makeEnrollment({ repoRootFingerprint: wf }), cutoffIso, 20);
    expect(results.find((r) => r.id === aged.id)).toBeUndefined();
  });

  it("EXCLUDES a row that has NEVER been closed (last_closed_at absent) — absent never matches a range predicate", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}neverclosed`;

    const neverClosed = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close",
      nativeSessionId: "sess-never-closed",
      workspaceFingerprint: wf,
      status: "active",
      now: new Date().toISOString(),
    });

    const cutoffIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const results = await fetchRecentlyEndedSessions(db, USER, makeEnrollment({ repoRootFingerprint: wf }), cutoffIso, 20);
    expect(results.find((r) => r.id === neverClosed.id)).toBeUndefined();
  });

  it("ORDER BY last_closed_at DESC: most recently closed comes first", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Both rows share ONE workspaceFingerprint here deliberately (they must
    // both be visible to a SINGLE fetchRecentlyEndedSessions call so the
    // ordering between them can be asserted) — but since they share the
    // resolver key's stable-workspace-identity fields entirely (userId,
    // projectKey, clientKind, workspaceFingerprint, hostId all identical),
    // they would ALSO collapse onto one row. Vary projectKey per row instead
    // so each gets a genuinely distinct resolver key while both still bind to
    // this describe's enrollment via workspace_fingerprint (the OR-condition
    // in fetchRecentlyEndedSessions' WHERE covers project_key OR
    // workspace_fingerprint, so sharing wf alone is sufficient for both to
    // match the SAME enrollment).
    const wf = `${WORKSPACE_FP}ordertest`;
    const earlyClose = new Date(Date.now() - 5000).toISOString();
    const lateClose = new Date(Date.now() - 1000).toISOString();
    const early = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close-order-early",
      nativeSessionId: "sess-order-early",
      workspaceFingerprint: wf,
      status: "closed",
      closedAt: earlyClose,
      now: earlyClose,
    });
    const late = await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close-order-late",
      nativeSessionId: "sess-order-late",
      workspaceFingerprint: wf,
      status: "closed",
      closedAt: lateClose,
      now: lateClose,
    });
    expect(early.id).not.toBe(late.id); // sanity: genuinely two distinct rows

    const cutoffIso = new Date(Date.now() - 3600_000).toISOString();
    const results = await fetchRecentlyEndedSessions(db, USER, makeEnrollment({ repoRootFingerprint: wf }), cutoffIso, 20);
    const earlyIdx = results.findIndex((r) => r.id === early.id);
    const lateIdx = results.findIndex((r) => r.id === late.id);
    expect(earlyIdx).toBeGreaterThanOrEqual(0);
    expect(lateIdx).toBeGreaterThanOrEqual(0);
    expect(lateIdx).toBeLessThan(earlyIdx); // late (more recent) sorts first
  });
});

// ── F5: live EXPLAIN — assert actual index NAMES appear in the plan ─────────
// Codex MINOR #5 probed: IndexScan is chosen with range/binding terms as
// residual filters (not a pure index-only scan) — the assertion must check
// for the index NAME appearing in the plan, with binding-condition decoys
// (other users/projects) so it is not vacuous (a plan that scans everything
// regardless of index would still "work" functionally but prove nothing about
// index usage).

describe("F5: live EXPLAIN — new indexes are actually used, not table-scanned", () => {
  it("fetchRecentlyEndedSessions' query plan uses idx_runir_session_user_last_closed (with binding decoys from other users)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Binding-condition decoys: rows for OTHER users/workspaces so the
    // assertion isn't vacuously true on an otherwise-empty table.
    const decoyTs = new Date(Date.now() - 3600_000).toISOString();
    await resolveRunirSession(db, {
      userId: "_78sy13_decoy_user_1",
      projectKey: "project:decoy",
      nativeSessionId: "sess-decoy-1",
      workspaceFingerprint: "decoyfp0000000000000001",
      status: "closed",
      closedAt: decoyTs,
      now: decoyTs,
    });
    await resolveRunirSession(db, {
      userId: "_78sy13_decoy_user_2",
      projectKey: "project:decoy",
      nativeSessionId: "sess-decoy-2",
      workspaceFingerprint: "decoyfp0000000000000002",
      status: "closed",
      closedAt: decoyTs,
      now: decoyTs,
    });
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:durable-close",
      nativeSessionId: "sess-explain-target",
      workspaceFingerprint: WORKSPACE_FP,
      status: "closed",
      closedAt: decoyTs,
      now: decoyTs,
    });

    const cutoffIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const explainResults = await db.query<Record<string, unknown>>(
      `SELECT id, last_closed_at, close_reason FROM runir_session
         WHERE user_id = $userId AND last_closed_at > <datetime>$cutoff
         AND (project_key IN $projectKeys OR workspace_fingerprint = $wf)
         ORDER BY last_closed_at DESC
         LIMIT $cap
         EXPLAIN;`,
      { userId: USER, cutoff: cutoffIso, projectKeys: [], wf: WORKSPACE_FP, cap: 20 },
    );
    const planText = JSON.stringify(explainResults);
    expect(planText).toContain("idx_runir_session_user_last_closed");
  });

  it("the janitor's WHERE shape (user_id, status, last_seen_at) uses idx_runir_session_user_status_seen (with binding decoys)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const idleTs = new Date(Date.now() - 20 * 3600_000).toISOString();
    // Decoy: another user with an active row in the same idle window.
    await resolveRunirSession(db, {
      userId: "_78sy13_decoy_user_janitor",
      projectKey: "project:decoy-janitor",
      nativeSessionId: "sess-decoy-janitor",
      status: "active",
      now: idleTs,
    });
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:janitor-explain",
      nativeSessionId: "sess-janitor-explain-target",
      status: "active",
      now: idleTs,
    });

    const cutoffIso = new Date(Date.now() - 12 * 3600_000).toISOString();
    const explainResults = await db.query<Record<string, unknown>>(
      `SELECT id FROM runir_session
         WHERE user_id = $userId AND status = 'active' AND last_seen_at < <datetime>$cutoff
         EXPLAIN;`,
      { userId: USER, cutoff: cutoffIso },
    );
    const planText = JSON.stringify(explainResults);
    expect(planText).toContain("idx_runir_session_user_status_seen");
  });
});

// ── Evidence-binding window truncation (Builder obligation #1, item 6) ──────
// After the janitor closes a zombie, selectBoundSessionId (via
// fetchAnchoredCandidateSessions) must stop binding evidence that occurs
// AFTER last_seen_at — the window [opened_at, closed_at] truncates there. A
// reactivated row (closed_at cleared again) must re-bind to "now".

describe("Evidence-binding window truncation after janitor close + rebind after reactivation (live DB)", () => {
  it("truncates the binding window at closed_at after the janitor closes an idle row, then re-widens to now after reactivation", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const { bindEvidenceToSession } = await import("../storage/surreal/continuity-evidence-store.js");

    const wf = `${WORKSPACE_FP}evidencewin`;
    const openedAt = new Date(Date.now() - 10 * 3600_000).toISOString(); // opened 10h ago
    const idleSinceForJanitor = new Date(Date.now() - 5 * 3600_000).toISOString(); // last activity 5h ago

    // Row is opened, then goes idle (last_seen_at 5h ago) but was NEVER
    // explicitly closed — the janitor is the one that will close it. BOTH
    // calls pass the SAME workspaceFingerprint from the start so they
    // resolve to the SAME row (opened_at preserved from the first call,
    // heartbeated by the second) — passing wf only on the second call would
    // silently create a SECOND row instead (different resolver key), losing
    // the original opened_at entirely.
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:evidence-window",
      nativeSessionId: "sess-evidence-window",
      workspaceFingerprint: wf,
      status: "active",
      now: openedAt,
    });
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:evidence-window",
      nativeSessionId: "sess-evidence-window",
      workspaceFingerprint: wf,
      status: "active",
      now: idleSinceForJanitor,
    });

    // BEFORE the janitor runs: the row is still open (closed_at NONE) —
    // evidence occurring "now" (well after last_seen_at) still binds.
    const nowIsh = new Date(Date.now() - 60_000).toISOString();
    const boundBefore = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, nowIsh);
    expect(boundBefore).toBeTruthy();

    // Janitor closes it (idle threshold well under 5h).
    process.env.RUNIR_SESSION_IDLE_CLOSE_H = "1";
    await runSessionIdleJanitorStep(db, USER);
    delete process.env.RUNIR_SESSION_IDLE_CLOSE_H;

    // AFTER the janitor close: the window truncates at last_seen_at
    // (idleSinceForJanitor, 5h ago). Evidence occurring "now" (well after
    // that) must no longer bind to this session.
    const boundAfterClose = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, nowIsh);
    expect(boundAfterClose).toBeUndefined();

    // But evidence occurring WITHIN the now-truncated window (before the
    // idle cutoff) still binds.
    const withinTruncatedWindow = new Date(Date.parse(idleSinceForJanitor) - 3600_000).toISOString(); // 1h before idle point, still after openedAt
    const boundWithinWindow = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, withinTruncatedWindow);
    expect(boundWithinWindow).toBeTruthy();

    // Reactivate (opener/recall/capture hardcodes status:"active" on resume)
    // — closed_at clears, so the window re-widens to [opened_at, now] again.
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: "project:evidence-window",
      nativeSessionId: "sess-evidence-window",
      workspaceFingerprint: wf,
      status: "active",
      now: new Date().toISOString(),
    });
    const boundAfterReactivate = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, nowIsh);
    expect(boundAfterReactivate).toBeTruthy();
  });
});
