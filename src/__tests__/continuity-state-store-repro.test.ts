// Real-DB integration tests for the continuity-state store (Rúnir-78sy.3).
//
// Exercises the CAS create/update/race paths + the build cursor + enrollment
// upsert against a real SurrealDB in an ISOLATED database. Skipped when no local
// SurrealDB is reachable (the entity-consolidation-repro pattern) — the SCHEMAFULL
// option<T> NONE-literal writes and the CAS guarded-empty-result idiom only
// manifest against a real store (mocked db.query cannot catch them).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  buildProjectContinuityStateRecordId,
  compareAndSwapProjectContinuityState,
  ensureContinuityBuildStateTable,
  ensureProjectContinuityStateTable,
  ensureProjectEnrollmentTable,
  getProjectContinuityState,
  getProjectEnrollment,
  listProjectEnrollments,
  readContinuityBuildCursor,
  upsertProjectEnrollment,
  writeContinuityBuildCursor,
} from "../storage/surreal/continuity-state-store.js";
import type { ProjectContinuityStateWrite } from "../domain/memory/continuity.js";

const TEST_DB = "continuity_78sy3_repro_test";
const USER = "_78sy3_repro_user";

function makeDb(): SurrealClient {
  return new SurrealClient({
    // 127.0.0.1 (IPv4), not localhost — the native install binds IPv4 only; a
    // localhost lookup can resolve to IPv6 and miss it.
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

let db: SurrealClient;
let dbAvailable = false;

function baseWrite(overrides: Partial<ProjectContinuityStateWrite> = {}): ProjectContinuityStateWrite {
  return {
    userId: USER,
    workspaceId: "-",
    projectKey: "project:runir",
    currentFocus: ["focus"],
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
    ...overrides,
  };
}

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
    "REMOVE TABLE IF EXISTS project_continuity_state; REMOVE TABLE IF EXISTS project_enrollment; REMOVE TABLE IF EXISTS continuity_build_state;",
  ).catch(() => {});
  await ensureProjectContinuityStateTable(db);
  await ensureProjectEnrollmentTable(db);
  await ensureContinuityBuildStateTable(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

describe("continuity-state store CAS (Rúnir-78sy.3)", () => {
  it("first CAS write CREATEs at version 1 with valid_at stamped (expectedVersion 0)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const result = await compareAndSwapProjectContinuityState(db, { ...baseWrite(), expectedVersion: 0 });
    expect("ok" in result && result.ok === false).toBe(false);
    if ("version" in result) {
      expect(result.version).toBe(1);
      expect(result.validAt).toBeTruthy();
    }
    const read = await getProjectContinuityState(db, USER, "-", "project:runir");
    expect(read?.version).toBe(1);
    expect(read?.currentFocus).toEqual(["focus"]);
  });

  it("stale expectedVersion returns version_mismatch (no write)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Row is at version 1 from the prior test; expectedVersion 0 must be rejected.
    const result = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ currentFocus: ["should not land"] }),
      expectedVersion: 0,
    });
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("version_mismatch");
      expect(result.currentVersion).toBe(1);
    }
    const read = await getProjectContinuityState(db, USER, "-", "project:runir");
    expect(read?.currentFocus).toEqual(["focus"]); // unchanged
  });

  it("correct expectedVersion UPDATEs and bumps the version", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const result = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ currentFocus: ["v2 focus"], blockers: ["b1"] }),
      expectedVersion: 1,
    });
    expect("version" in result && result.version === 2).toBe(true);
    const read = await getProjectContinuityState(db, USER, "-", "project:runir");
    expect(read?.version).toBe(2);
    expect(read?.currentFocus).toEqual(["v2 focus"]);
    expect(read?.blockers).toEqual(["b1"]);
  });

  it("getProjectContinuityState never bleeds across projects (direct triple, no latest-any)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ projectKey: "project:other", currentFocus: ["other-project"] }),
      expectedVersion: 0,
    });
    const runir = await getProjectContinuityState(db, USER, "-", "project:runir");
    const missing = await getProjectContinuityState(db, USER, "-", "project:does-not-exist");
    expect(runir?.currentFocus).toEqual(["v2 focus"]);
    expect(missing).toBeNull(); // NOT a latest-any fallback to another project's row
  });
});

describe("continuity-state store CAS CREATE-race (Rúnir-78sy.3 F4)", () => {
  // Proves the trickiest CAS path: the pre-read misses (a concurrent writer has
  // not yet been observed), the code takes the CREATE branch, the real CREATE
  // collides on the deterministic record id / composite-unique index, and the
  // .catch re-reads and reports version_mismatch — never index-name matching.
  // Simulated deterministically: a proxy forces ONLY the first pre-read SELECT
  // to return empty, while the row genuinely exists in the DB (seeded at v1), so
  // the real CREATE hits the real duplicate-id rejection.
  it("duplicate-id create race (row exists on re-read) → version_mismatch, currentVersion=1", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const RACE_KEY = "project:cas-race";
    // Seed a genuine row at version 1 via the store (real CREATE path).
    const seeded = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ projectKey: RACE_KEY, currentFocus: ["seeded"] }),
      expectedVersion: 0,
    });
    expect("version" in seeded && seeded.version === 1).toBe(true);

    // Proxy the real client: intercept the FIRST versioned pre-read SELECT and
    // return empty so CAS takes the CREATE branch against an already-present row.
    let preReadsSeen = 0;
    const racedDb = {
      query: (sql: string, vars?: Record<string, unknown>) => {
        if (sql.includes("SELECT id, version FROM project_continuity_state")) {
          preReadsSeen++;
          if (preReadsSeen === 1) {
            // First pre-read misses → forces the CREATE path.
            return Promise.resolve([[]]);
          }
        }
        // Every other query (incl. the .catch re-read and the colliding CREATE)
        // hits the real DB.
        return db.query(sql, vars);
      },
    } as unknown as SurrealClient;

    const result = await compareAndSwapProjectContinuityState(racedDb, {
      ...baseWrite({ projectKey: RACE_KEY, currentFocus: ["should not land"] }),
      expectedVersion: 0,
    });

    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("version_mismatch");
      expect(result.currentVersion).toBe(1);
    }
    // The colliding write never mutated the seeded row.
    const read = await getProjectContinuityState(db, USER, "-", RACE_KEY);
    expect(read?.version).toBe(1);
    expect(read?.currentFocus).toEqual(["seeded"]);
  });
});

describe("continuity-state store source_evidence_refs (Rúnir-78sy.8)", () => {
  // Regression test for the 78sy.8 probe failure: SCHEMAFULL array<object>
  // rejected ANY non-empty source_evidence_refs write ("Found field
  // 'refs[1].at', but no such field exists"). Must FAIL against the old
  // array<object> schema and PASS once the field is retyped to a JSON string.
  it("non-empty sourceEvidenceRefs round-trips through the CAS CREATE path", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const refs = [
      { kind: "semiote", id: "semiote:aaa", at: "2026-07-01T00:00:00.000Z" },
      { kind: "semiote", id: "semiote:bbb", at: "2026-07-02T00:00:00.000Z" },
    ];
    const result = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ projectKey: "project:evidence-refs", sourceEvidenceRefs: refs }),
      expectedVersion: 0,
    });
    expect("ok" in result && result.ok === false).toBe(false);
    if ("version" in result) {
      expect(result.version).toBe(1);
      expect(result.sourceEvidenceRefs).toEqual(refs);
    }
    const read = await getProjectContinuityState(db, USER, "-", "project:evidence-refs");
    expect(read?.sourceEvidenceRefs).toEqual(refs);
  });

  it("non-empty sourceEvidenceRefs round-trips through the CAS UPDATE path (version increments, refs replaced)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const refsV1 = [{ kind: "semiote", id: "semiote:ccc", at: "2026-07-01T00:00:00.000Z" }];
    const seeded = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ projectKey: "project:evidence-refs-update", sourceEvidenceRefs: refsV1 }),
      expectedVersion: 0,
    });
    expect("version" in seeded && seeded.version === 1).toBe(true);

    const refsV2 = [
      { kind: "semiote", id: "semiote:ddd", at: "2026-07-03T00:00:00.000Z" },
      { kind: "semiote", id: "semiote:eee", at: "2026-07-04T00:00:00.000Z" },
    ];
    const updated = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ projectKey: "project:evidence-refs-update", sourceEvidenceRefs: refsV2 }),
      expectedVersion: 1,
    });
    expect("version" in updated && updated.version === 2).toBe(true);
    if ("sourceEvidenceRefs" in updated) {
      expect(updated.sourceEvidenceRefs).toEqual(refsV2);
    }
    const read = await getProjectContinuityState(db, USER, "-", "project:evidence-refs-update");
    expect(read?.version).toBe(2);
    expect(read?.sourceEvidenceRefs).toEqual(refsV2);
  });

  it("legacy array-valued source_evidence_refs rows survive ensure (normalized to '[]') and accept subsequent updates", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Simulate a pre-retype row: retype the field BACK to the legacy
    // array<object> shape, INSERT a row holding a real `[]` array value (as
    // pre-fix rows would have), then re-run ensure (which OVERWRITEs back to
    // TYPE string + runs the idempotent legacy-row normalization) and confirm
    // both an unrelated field update and a CAS update succeed afterward.
    const projectKey = "project:legacy-refs";
    const recordId = buildProjectContinuityStateRecordId(USER, "-", projectKey);
    const now = new Date().toISOString();

    await db.query(
      "DEFINE FIELD OVERWRITE source_evidence_refs ON TABLE project_continuity_state TYPE array<object>;",
    );
    await db.query(
      `CREATE type::record('project_continuity_state', $recordId) SET
         user_id = $userId, workspace_id = $workspaceId, project_key = $projectKey,
         current_focus = [], latest_progress = [], next_steps = [], blockers = [],
         open_loops = [], unfiled_intentions = [], pending_verification = [],
         recently_changed_artifacts = [], likely_stale_beads = [], active_agent_runs = [],
         source_evidence_refs = [],
         confidence = 0.5, source_session_ids = [], supporting_semiote_ids = [],
         version = <int>1, valid_at = <datetime>$now, updated_at = <datetime>$now;`,
      { recordId, userId: USER, workspaceId: "-", projectKey, now },
    );

    // Re-running ensure retypes the field to string and normalizes the legacy
    // `[]` array value in place (idempotent — safe to run again).
    await ensureProjectContinuityStateTable(db);
    await ensureProjectContinuityStateTable(db);

    // Unrelated field update succeeds post-normalization (was previously
    // rejected with "Expected string but found `[]`" per the brief).
    await db.query(
      `UPDATE type::record('project_continuity_state', $recordId) SET current_focus = ['normalized-check'];`,
      { recordId },
    );
    const afterFieldUpdate = await getProjectContinuityState(db, USER, "-", projectKey);
    expect(afterFieldUpdate?.currentFocus).toEqual(["normalized-check"]);
    expect(afterFieldUpdate?.sourceEvidenceRefs).toEqual([]);

    const afterCasUpdate = await compareAndSwapProjectContinuityState(db, {
      ...baseWrite({ projectKey, sourceEvidenceRefs: [{ kind: "semiote", id: "semiote:fff", at: "2026-07-04T00:00:00.000Z" }] }),
      expectedVersion: 1,
    });
    expect("version" in afterCasUpdate && afterCasUpdate.version === 2).toBe(true);
    const read = await getProjectContinuityState(db, USER, "-", projectKey);
    expect(read?.sourceEvidenceRefs).toEqual([{ kind: "semiote", id: "semiote:fff", at: "2026-07-04T00:00:00.000Z" }]);
  });
});

describe("continuity build cursor (Rúnir-78sy.3)", () => {
  it("reads null before any write, then round-trips the verbatim ISO string", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    expect(await readContinuityBuildCursor(db, USER, "-", "project:cursor")).toBeNull();
    const iso = "2026-07-03T12:34:56.789Z";
    await writeContinuityBuildCursor(db, USER, "-", "project:cursor", iso);
    expect(await readContinuityBuildCursor(db, USER, "-", "project:cursor")).toBe(iso);
    // Advancing overwrites in place (single row per triple).
    const iso2 = "2026-07-04T00:00:00.000Z";
    await writeContinuityBuildCursor(db, USER, "-", "project:cursor", iso2);
    expect(await readContinuityBuildCursor(db, USER, "-", "project:cursor")).toBe(iso2);
  });
});

describe("project enrollment upsert (Rúnir-78sy.3)", () => {
  it("upserts idempotently and lists; absent optionals stored as NONE round-trip to undefined", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const row = await upsertProjectEnrollment(db, {
      userId: USER,
      workspaceId: "-",
      projectKey: "project:enroll",
      projectId: "enroll",
      source: "manual",
      // repoRemote / repoRootFingerprint / defaultNamespaceId absent → NONE
    });
    expect(row.projectId).toBe("enroll");
    expect(row.repoRemote).toBeUndefined();
    expect(row.repoRootFingerprint).toBeUndefined();

    // Idempotent re-upsert with a fingerprint now present.
    await upsertProjectEnrollment(db, {
      userId: USER,
      workspaceId: "-",
      projectKey: "project:enroll",
      projectId: "enroll",
      repoRootFingerprint: "deadbeefdeadbeefdeadbeef",
      source: "manual",
    });
    const list = await listProjectEnrollments(db, USER);
    const enroll = list.filter((e) => e.projectKey === "project:enroll");
    expect(enroll).toHaveLength(1); // upsert, not insert
    expect(enroll[0]?.repoRootFingerprint).toBe("deadbeefdeadbeefdeadbeef");
  });

  // Rúnir-78sy.9: getProjectEnrollment is the single-triple point lookup the
  // /hooks/evidence route uses to verify enrollment before accepting pushed
  // evidence — a more direct check than listProjectEnrollments + filter.
  it("getProjectEnrollment point-looks-up ONE (userId, workspaceId, projectKey) triple; returns null when absent", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await upsertProjectEnrollment(db, {
      userId: USER,
      workspaceId: "-",
      projectKey: "project:point-lookup",
      projectId: "point-lookup-id",
      source: "manual",
    });
    const found = await getProjectEnrollment(db, USER, "-", "project:point-lookup");
    expect(found?.projectId).toBe("point-lookup-id");
    expect(found?.projectKey).toBe("project:point-lookup");

    const missing = await getProjectEnrollment(db, USER, "-", "project:never-enrolled");
    expect(missing).toBeNull();
  });
});
