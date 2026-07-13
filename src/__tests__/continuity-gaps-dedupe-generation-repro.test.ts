// Live-DB test for F7 (missing_handoff dedupeKey gains a close generation,
// Rúnir-78sy.13, Codex MAJOR #2).
//
// Exercises the FULL runGapDetectionStep pipeline end-to-end against the
// real native SurrealDB (runir_session, semiote, project_enrollment,
// project_continuity_state, continuity_gap, continuity_gap_build_state) —
// the dedupe-generation lifecycle (dismiss gen1 → new close fires gen2 →
// reconciliation supersedes the old generation → aged-out-of-window gaps
// survive untouched) spans multiple stores and cannot be proven by a mocked
// db.query. Isolated TEST_DB namespace, matching the continuity-*-repro.test
// conventions. Skips cleanly when no local SurrealDB is reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureRunirSessionTable, resolveRunirSession } from "../storage/surreal/runir-session-store.js";
import { ensurePhase2Schema } from "../storage/surreal/phase2-store.js";
import {
  ensureProjectContinuityStateTable,
  ensureProjectEnrollmentTable,
  compareAndSwapProjectContinuityState,
  upsertProjectEnrollment,
} from "../storage/surreal/continuity-state-store.js";
import {
  ensureContinuityGapBuildStateTable,
  ensureContinuityGapTable,
  getContinuityGaps,
  setGapStatus,
  upsertContinuityGap,
} from "../storage/surreal/continuity-gap-store.js";
import { runGapDetectionStep } from "../lifecycle/semion/continuity-gaps.js";

const TEST_DB = "continuity_gaps_78sy13_dedupe_gen_repro_test";
const USER = "_78sy13_dedupe_gen_user";
const WORKSPACE_FP = "78sy13dedupegen0000wsfp1";
const PROJECT_KEY = "project:dedupe-gen";

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
  await db.query(
    "REMOVE TABLE IF EXISTS runir_session; REMOVE TABLE IF EXISTS semiote; REMOVE TABLE IF EXISTS project_enrollment; REMOVE TABLE IF EXISTS project_continuity_state; REMOVE TABLE IF EXISTS continuity_gap; REMOVE TABLE IF EXISTS continuity_gap_build_state;",
  );
  await ensureRunirSessionTable(db);
  await ensurePhase2Schema(db);
  await ensureProjectEnrollmentTable(db);
  await ensureProjectContinuityStateTable(db);
  await ensureContinuityGapTable(db);
  await ensureContinuityGapBuildStateTable(db);

  // One enrollment + one continuity state row for the whole file — the
  // detector's rolling-kind detectors (unfiled_intent/started_unfinished)
  // are irrelevant here (empty lists → they never fire), isolating the test
  // to missing_handoff only.
  await upsertProjectEnrollment(db, {
    userId: USER,
    workspaceId: "-",
    projectKey: PROJECT_KEY,
    source: "manual",
    repoRootFingerprint: WORKSPACE_FP,
  });
  const stateResult = await compareAndSwapProjectContinuityState(db, {
    userId: USER,
    workspaceId: "-",
    projectKey: PROJECT_KEY,
    currentFocus: [],
    latestProgress: [],
    nextSteps: [],
    blockers: [],
    openLoops: [],
    unfiledIntentions: [],
    pendingVerification: [],
    recentlyChangedArtifacts: [],
    likelyStaleBeads: [],
    activeAgentRuns: [],
    sourceEvidenceRefs: [],
    confidence: 0.7,
    sourceSessionIds: [],
    supportingSemioteIds: [],
    expectedVersion: 0,
  });
  if ("ok" in stateResult && stateResult.ok === false) {
    throw new Error("test setup: continuity state CAS failed unexpectedly");
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => undefined);
    await db.close().catch(() => undefined);
  }
});

/** Creates an active semiote row bound to a session so sessionDidWork()
 *  returns true for it (no session_handoff role/cue text, so
 *  sessionHasHandoff() returns false — the missing_handoff-firing shape). */
async function createDidWorkSemiote(sessionId: string): Promise<void> {
  await db.query(
    `CREATE semiote SET
       user_id = $userId,
       runir_session_id = $sessionId,
       payload = {},
       text_norm = 'unrelated captured fact, no handoff phrasing here',
       created_at = time::now(),
       updated_at = time::now();`,
    { userId: USER, sessionId },
  );
}

/** Closes (or creates-closed) a runir_session row, returning its id.
 *
 * IMPORTANT (the exact F17 mechanism this bead fixes — caught live while
 * writing this file): fetchRecentlyEndedSessions binds candidate sessions via
 * deriveContinuityBindingKeys(enrollment) → buildBindingConditions, which for
 * THIS test file's enrollment (repoRootFingerprint=WORKSPACE_FP, no
 * projectId/repoRemote) produces ONLY `workspace_fingerprint = $wf` with
 * $wf = WORKSPACE_FP — so every session the detector must find in this file
 * needs workspace_fingerprint EXACTLY EQUAL to the fixed WORKSPACE_FP, not a
 * per-test-unique suffixed one (an earlier draft of this file used a
 * per-test-suffixed fingerprint and every fetchRecentlyEndedSessions call
 * silently returned zero rows).
 *
 * To keep each test's session on its OWN row (not collapsed together — see
 * buildRunirSessionResolverKey: nativeSessionId is dropped from the resolver
 * key whenever projectKey/workspaceFingerprint/hostId is present), each
 * caller varies `sessionScopeKey` (used as the resolver's projectKey) instead
 * of the workspaceFingerprint. The session's STORED project_key column value
 * is irrelevant to the detector's binding (which never checks project_key
 * equality against PROJECT_KEY here, only workspace_fingerprint), so varying
 * it per test-session is safe and does not change which enrollment/state the
 * gap gets written against (that's threaded through PROJECT_KEY/state
 * directly by the detector, independent of the session row's own
 * project_key). */
interface ClosedSession {
  id: string;
  /**
   * The ACTUAL last_closed_at the DB holds after this write — read back via
   * resolveRunirSession's own RETURN AFTER (F1), not the JS ISO string passed
   * in. SurrealDB's datetime round-trip can silently strip a trailing-zero
   * millisecond digit (e.g. an input ending in "...250Z" round-trips as
   * "...25Z") — caught live while writing this file: a naive assertion
   * comparing `missing_handoff:${id}:${closedAtInputString}` against the
   * detector's actual dedupeKey (built from a FRESH SELECT of the same
   * stored value fetchRecentlyEndedSessions reads back) flaked roughly
   * 1-in-10 runs, exactly when the millisecond happened to end in 0.
   * Production code never makes this mistake (missingHandoffGap always
   * builds the key from a value already read back from the DB) — this is a
   * test-only comparison hazard, but real enough to document.
   *
   * IMPORTANT: resolveRunirSession's own OWN returned lastClosedAt is NOT
   * sufficient either on a fresh CREATE (verified live while writing this
   * file: the CREATE branch returns the raw un-round-tripped input string,
   * since a CREATE never re-reads from the DB — only the UPDATE branch's
   * RETURN AFTER re-reads). Repeated SELECTs of the SAME already-stored
   * value ARE stable (verified live: 5 consecutive SELECTs of one stored
   * datetime always produced the identical truncated string) — so
   * closeSession always does an explicit fresh SELECT after the write,
   * guaranteeing its returned lastClosedAt is byte-identical to whatever
   * fetchRecentlyEndedSessions will read for the SAME row.
   */
  lastClosedAt: string;
}

async function closeSession(sessionScopeKey: string, nativeSessionId: string, closedAt: string): Promise<ClosedSession> {
  const session = await resolveRunirSession(db, {
    userId: USER,
    projectKey: sessionScopeKey,
    nativeSessionId,
    workspaceFingerprint: WORKSPACE_FP,
    status: "closed",
    closedAt,
    now: closedAt,
  });
  const rows = await db.query<{ last_closed_at: unknown }>(
    "SELECT last_closed_at FROM type::record('runir_session', $id);",
    { id: session.id },
  );
  const lastClosedAt = rows[0]?.[0]?.last_closed_at;
  if (lastClosedAt == null) throw new Error("test setup: closeSession expected last_closed_at to be persisted");
  return { id: session.id, lastClosedAt: String(lastClosedAt) };
}

describe("F7: missing_handoff dedupeKey close-generation lifecycle (live DB, full runGapDetectionStep)", () => {
  it("same close → ONE gap; dismiss it; a NEW close on the same row → a NEW gap fires (different generation); reconciliation supersedes the old generation", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const sessionScopeKey = "project:dedupe-gen-lifecycle-scope";
    const nativeSessionId = "sess-dedupe-gen-lifecycle";

    // ── Generation 1: close #1 ──────────────────────────────────────────
    const closeTs1 = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    const closed1 = await closeSession(sessionScopeKey, nativeSessionId, closeTs1);
    const sessionId = closed1.id;
    await createDidWorkSemiote(sessionId);

    const run1 = await runGapDetectionStep({ db, userId: USER });
    expect(run1.detected).toBeGreaterThanOrEqual(1);

    const gapsAfterRun1 = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["new", "active"]);
    const gen1Gaps = gapsAfterRun1.filter((g) => g.kind === "missing_handoff" && g.dedupeKey.startsWith(`missing_handoff:${sessionId}:`));
    expect(gen1Gaps.length).toBe(1);
    const gen1DedupeKey = gen1Gaps[0].dedupeKey;
    // Compared against the ACTUAL round-tripped lastClosedAt (not the raw JS
    // input string) — see ClosedSession's doc comment for why.
    expect(gen1DedupeKey).toBe(`missing_handoff:${sessionId}:${closed1.lastClosedAt}`);

    // Re-running the SAME tick again (same close, same generation) must
    // UPSERT the SAME row, not create a second gap — the generation suffix
    // makes re-evaluation of an unchanged close idempotent.
    await runGapDetectionStep({ db, userId: USER });
    const gapsAfterRun1Again = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["new", "active"]);
    const gen1GapsAgain = gapsAfterRun1Again.filter((g) => g.kind === "missing_handoff" && g.dedupeKey === gen1DedupeKey);
    expect(gen1GapsAgain.length).toBe(1); // still exactly one row, not two

    // ── Dismiss the generation-1 gap (sticky — never reverted by a same-key re-detect) ──
    await setGapStatus(db, gen1Gaps[0].id, "dismissed");
    const afterDismiss = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["dismissed"]);
    expect(afterDismiss.some((g) => g.id === gen1Gaps[0].id)).toBe(true);

    // A re-run of the SAME generation (same close, unchanged) must NOT
    // resurrect the dismissed gap — dismissed is sticky.
    await runGapDetectionStep({ db, userId: USER });
    const stillDismissed = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["dismissed"]);
    expect(stillDismissed.some((g) => g.id === gen1Gaps[0].id)).toBe(true);
    const notResurrected = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["new", "active"]);
    expect(notResurrected.some((g) => g.dedupeKey === gen1DedupeKey)).toBe(false);

    // ── Generation 2: a NEW close on the SAME row (reactivate then close again LATER) ──
    const reactivateTs = new Date(Date.now() - 1800_000).toISOString(); // 30m ago
    await resolveRunirSession(db, {
      userId: USER,
      projectKey: sessionScopeKey,
      nativeSessionId,
      workspaceFingerprint: WORKSPACE_FP,
      status: "active",
      now: reactivateTs,
    });
    const closeTs2 = new Date(Date.now() - 600_000).toISOString(); // 10m ago — LATER than closeTs1
    const closed2 = await closeSession(sessionScopeKey, nativeSessionId, closeTs2);
    expect(closed2.id).toBe(sessionId); // same underlying row

    const run2 = await runGapDetectionStep({ db, userId: USER });
    expect(run2.detected).toBeGreaterThanOrEqual(1);

    const gapsAfterRun2 = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["new", "active"]);
    const gen2Gaps = gapsAfterRun2.filter((g) => g.kind === "missing_handoff" && g.dedupeKey === `missing_handoff:${sessionId}:${closed2.lastClosedAt}`);
    // The generation-2 gap fires as a NEW key — dismissing generation 1 did
    // NOT suppress this later close's eligibility (the bug F7 fixes: before
    // this change, a shared per-scope row could only ever produce ONE
    // missing-handoff gap for its lifetime once dismissed).
    expect(gen2Gaps.length).toBe(1);
    expect(gen2Gaps[0].status).toBe("new");
    // Generation 2's key must differ from generation 1's — a genuinely NEW
    // dedupeKey, not an accidental re-collision.
    expect(gen2Gaps[0].dedupeKey).not.toBe(gen1DedupeKey);

    // The dismissed generation-1 gap remains dismissed (untouched, not
    // resurrected by the new generation's detection/reconciliation pass).
    const stillDismissedAfterGen2 = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["dismissed"]);
    expect(stillDismissedAfterGen2.some((g) => g.id === gen1Gaps[0].id)).toBe(true);
  });

  it("aged-out-of-window generation gaps are UNTOUCHED by reconciliation (78sy.7 window-aware semantics preserved under F7)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const sessionScopeKey = "project:dedupe-gen-agedout-scope";
    const nativeSessionId = "sess-dedupe-gen-aged-out";

    // Close this session FAR outside the default 168h lookback so it is
    // NEVER evaluated by fetchRecentlyEndedSessions (aged out of window).
    const veryOldCloseTs = new Date(Date.now() - 500 * 3600_000).toISOString();
    const closed = await closeSession(sessionScopeKey, nativeSessionId, veryOldCloseTs);
    await createDidWorkSemiote(closed.id);

    // Manually seed an "active" missing_handoff gap for this aged-out
    // generation directly via the store (simulating a gap that was created
    // when this session was still within the lookback window, then aged out
    // on a later run) — write it via the SAME upsert path the detector uses
    // so the shape matches exactly. Uses the ACTUAL round-tripped
    // lastClosedAt (see ClosedSession) so the seeded key matches what the
    // detector itself would have produced.
    const agedDedupeKey = `missing_handoff:${closed.id}:${closed.lastClosedAt}`;
    await upsertContinuityGap(db, {
      userId: USER,
      workspaceId: "-",
      projectKey: PROJECT_KEY,
      kind: "missing_handoff",
      title: "seeded aged-out gap",
      summary: "seeded for the aged-out-of-window reconciliation test",
      recommendation: "n/a",
      relatedWorkItems: [],
      evidence: [],
      score: 0.1,
      confidence: "developing",
      status: "new",
      dedupeKey: agedDedupeKey,
    });

    // Run detection — this session is far outside the lookback window, so
    // fetchRecentlyEndedSessions never returns it, so it is never in
    // evaluatedSessionIds, so the F7 eligibility predicate (prefix-matched
    // against evaluated session ids) must NOT mark this gap eligible for
    // supersession — it merely aged out, it was not resolved.
    await runGapDetectionStep({ db, userId: USER });

    const gapsAfter = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["new", "active"]);
    const agedGap = gapsAfter.find((g) => g.dedupeKey === agedDedupeKey);
    expect(agedGap).toBeTruthy(); // SURVIVES — not superseded
    expect(agedGap?.status).not.toBe("superseded");
  });

  it("legacy un-suffixed dedupeKey (pre-F7 row) is tolerated: same-session generation-suffixed close still supersedes it, no crash", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const sessionScopeKey = "project:dedupe-gen-legacy-scope";
    const nativeSessionId = "sess-dedupe-gen-legacy";

    const closeTs = new Date(Date.now() - 3600_000).toISOString();
    const closed = await closeSession(sessionScopeKey, nativeSessionId, closeTs);
    await createDidWorkSemiote(closed.id);

    // Seed a LEGACY un-suffixed gap for this session (simulating a row
    // written before the F7 generation-suffix landed).
    const legacyDedupeKey = `missing_handoff:${closed.id}`;
    await upsertContinuityGap(
      db,
      {
        userId: USER,
        workspaceId: "-",
        projectKey: PROJECT_KEY,
        kind: "missing_handoff",
        title: "seeded legacy (pre-F7) gap",
        summary: "seeded to prove legacy un-suffixed keys are tolerated by the eligibility predicate",
        recommendation: "n/a",
        relatedWorkItems: [],
        evidence: [],
        score: 0.1,
        confidence: "developing",
        status: "new",
        dedupeKey: legacyDedupeKey,
      },
    );

    // Run detection: sessionId IS within the lookback window and IS
    // evaluated this run (createDidWorkSemiote made it "did work", no
    // handoff present) — the detector fires a NEW generation-suffixed gap,
    // and reconciliation must recognize the LEGACY key belongs to the SAME
    // evaluated session (same-session tolerance) and supersede it — without
    // crashing on the missing generation suffix.
    await expect(runGapDetectionStep({ db, userId: USER })).resolves.toBeTruthy();

    const gapsAfter = await getContinuityGaps(db, USER, "-", PROJECT_KEY, ["new", "active", "superseded"]);
    const legacyGap = gapsAfter.find((g) => g.dedupeKey === legacyDedupeKey);
    const newGenGap = gapsAfter.find((g) => g.dedupeKey === `missing_handoff:${closed.id}:${closed.lastClosedAt}`);
    expect(legacyGap).toBeTruthy();
    expect(legacyGap?.status).toBe("superseded"); // legacy key superseded by the new generation firing
    expect(newGenGap).toBeTruthy();
    expect(newGenGap?.status === "new" || newGenGap?.status === "active").toBe(true);
  });
});
