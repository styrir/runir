import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SurrealClient,
  ensureSupersedeShadowTable,
  logSupersedeShadow,
} from "../surreal/surreal-store.js";

// Real-DB smoke test for Rúnir-pn1l.13.2 supersede_shadow table.
//
// Gated on RUNIR_TEST_SLOW_LANE=1 (same convention as other integration tests in
// test/integration/). Without the flag the test self-skips — this is an intentional
// opt-in, not a silent availability skip. Per AGENTS.md Test Dependencies: if Docker
// is not running, start it (colima start / open -a Docker) before invoking.
//
// The test:
//   1. ensureSupersedeShadowTable → creates SCHEMAFULL table + index (idempotent)
//   2. direct db.query CREATE → writes a diverged=true record (bypasses fire-and-forget catch)
//   3. SELECT WHERE diverged=true → returns the record
//   4. logSupersedeShadow (fire-and-forget) → does not throw when called

const SLOW_LANE = process.env.RUNIR_TEST_SLOW_LANE === "1";
const TEST_DB = "supersede_shadow_smoke_test";

function makeDb(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

let db: SurrealClient;

beforeAll(async () => {
  if (!SLOW_LANE) return;
  db = makeDb();
  await db.query("INFO FOR DB;"); // throws if DB unreachable — surfaces the error rather than silent-skip
  // Remove the table (and any stale schema) before the test to ensure a clean slate.
  await db.query("REMOVE TABLE IF EXISTS supersede_shadow;").catch(() => {});
});

afterAll(async () => {
  if (!SLOW_LANE) return;
  await db.query("REMOVE TABLE IF EXISTS supersede_shadow;").catch(() => {});
});

// Direct CREATE query using same parameters as logSupersedeShadow but without .catch.
// This validates the schema accepts the write, independently of the fire-and-forget wrapper.
// Uses NONE literals for absent optional fields (SurrealDB rejects null for option<T>).
async function directWrite(db: SurrealClient, params: {
  appliedMemoryId: string | null;
  userId: string;
  scope: string;
  sessionId: string | null;
  source: string;
  appliedOutcome: string;
  baselineOutcome: string;
  wouldOutcome: string;
  diverged: boolean;
  liveFlags: string;
  wouldMatchedId: string | null;
  wouldCosine: number | null;
  wouldSignal: string | null;
  wouldReason: string;
  wouldBand: string | null;
  baselineMatchedId: string | null;
  baselineBand: string | null;
  incomingTextTrunc: string;
}): Promise<void> {
  const sets: string[] = [
    `user_id=$user_id`,
    `scope=$scope`,
    `source=$source`,
    `occurred_at=time::now()`,
    `applied_outcome=$applied_outcome`,
    `baseline_outcome=$baseline_outcome`,
    `would_outcome=$would_outcome`,
    `diverged=$diverged`,
    `live_flags=$live_flags`,
    `would_reason=$would_reason`,
    `incoming_text_trunc=$incoming_text_trunc`,
    `stable_label=NONE`,
    params.appliedMemoryId !== null ? `applied_memory_id=$applied_memory_id` : `applied_memory_id=NONE`,
    params.sessionId !== null ? `session_id=$session_id` : `session_id=NONE`,
    params.wouldMatchedId !== null ? `would_matched_id=$would_matched_id` : `would_matched_id=NONE`,
    params.wouldCosine !== null ? `would_cosine=$would_cosine` : `would_cosine=NONE`,
    params.wouldSignal !== null ? `would_signal=$would_signal` : `would_signal=NONE`,
    params.wouldBand !== null ? `would_band=$would_band` : `would_band=NONE`,
    params.baselineMatchedId !== null ? `baseline_matched_id=$baseline_matched_id` : `baseline_matched_id=NONE`,
    params.baselineBand !== null ? `baseline_band=$baseline_band` : `baseline_band=NONE`,
  ];
  const vars: Record<string, unknown> = {
    user_id: params.userId,
    scope: params.scope,
    source: params.source,
    applied_outcome: params.appliedOutcome,
    baseline_outcome: params.baselineOutcome,
    would_outcome: params.wouldOutcome,
    diverged: params.diverged,
    live_flags: params.liveFlags,
    would_reason: params.wouldReason,
    incoming_text_trunc: params.incomingTextTrunc.slice(0, 200),
  };
  if (params.appliedMemoryId !== null) vars.applied_memory_id = params.appliedMemoryId;
  if (params.sessionId !== null) vars.session_id = params.sessionId;
  if (params.wouldMatchedId !== null) vars.would_matched_id = params.wouldMatchedId;
  if (params.wouldCosine !== null) vars.would_cosine = params.wouldCosine;
  if (params.wouldSignal !== null) vars.would_signal = params.wouldSignal;
  if (params.wouldBand !== null) vars.would_band = params.wouldBand;
  if (params.baselineMatchedId !== null) vars.baseline_matched_id = params.baselineMatchedId;
  if (params.baselineBand !== null) vars.baseline_band = params.baselineBand;
  await db.query(`CREATE supersede_shadow SET ${sets.join(", ")};`, vars);
}

describe("ensureSupersedeShadowTable + logSupersedeShadow (real-DB smoke)", () => {
  it("creates table and writes a diverged=true record (requires RUNIR_TEST_SLOW_LANE=1)", async () => {
    if (!SLOW_LANE) {
      // Intentional opt-in skip — set RUNIR_TEST_SLOW_LANE=1 with Docker Surreal up to run.
      return;
    }

    // 1. Create table (idempotent)
    await ensureSupersedeShadowTable(db);

    // 2. Call again — idempotent (DEFINE IF NOT EXISTS)
    await ensureSupersedeShadowTable(db);

    const liveFlags = JSON.stringify({
      cueGate: false, temporalGuard: false, keepBothGuard: false,
      addSkipGuard: false, judgeGate: false,
    });

    // 3. Write a record with diverged=true via direct query (validates schema, no swallowed errors)
    await directWrite(db, {
      appliedMemoryId: "mem-smoke-001",
      userId: "smoke-user",
      scope: "user",
      sessionId: "sess-smoke-001",
      source: "memory_store",
      appliedOutcome: "skip",
      baselineOutcome: "skip",
      wouldOutcome: "create",
      diverged: true,
      liveFlags,
      wouldMatchedId: null,
      wouldCosine: null,
      wouldSignal: null,
      wouldReason: "no recent duplicate or merge candidate found",
      wouldBand: "create",
      baselineMatchedId: "cand-smoke-001",
      baselineBand: "store-near-dup-skip",
      incomingTextTrunc: "smoke test incoming fact — additive content with novel tokens",
    });

    // 4. Write a record with diverged=false
    await directWrite(db, {
      appliedMemoryId: "mem-smoke-002",
      userId: "smoke-user",
      scope: "user",
      sessionId: "sess-smoke-001",
      source: "memory_store",
      appliedOutcome: "create",
      baselineOutcome: "create",
      wouldOutcome: "create",
      diverged: false,
      liveFlags,
      wouldMatchedId: null,
      wouldCosine: null,
      wouldSignal: null,
      wouldReason: "no recent duplicate or merge candidate found",
      wouldBand: "create",
      baselineMatchedId: null,
      baselineBand: "create",
      incomingTextTrunc: "another smoke test fact",
    });

    // 5. SELECT WHERE diverged=true → must return exactly 1 row
    const rows = await db.query<any>(
      "SELECT * FROM supersede_shadow WHERE diverged = true;",
    );
    const hits: any[] = (rows[0] ?? []);
    expect(hits.length).toBe(1);
    expect(hits[0].applied_outcome).toBe("skip");
    expect(hits[0].would_outcome).toBe("create");
    expect(hits[0].diverged).toBe(true);
    expect(hits[0].user_id).toBe("smoke-user");
    expect(hits[0].would_band).toBe("create");
    expect(hits[0].baseline_band).toBe("store-near-dup-skip");
    // SurrealDB returns NONE fields as undefined in the JS client
    expect(hits[0].stable_label == null).toBe(true);
    // live_flags stored as JSON string
    expect(typeof hits[0].live_flags).toBe("string");
    const lf = JSON.parse(hits[0].live_flags);
    expect(lf.cueGate).toBe(false);

    // 6. SELECT WHERE diverged=false → exactly 1 row
    const nonDiverged = await db.query<any>(
      "SELECT * FROM supersede_shadow WHERE diverged = false;",
    );
    const nonDivergedHits: any[] = (nonDiverged[0] ?? []);
    expect(nonDivergedHits.length).toBe(1);
    expect(nonDivergedHits[0].applied_outcome).toBe("create");

    // 7. logSupersedeShadow (fire-and-forget wrapper) does not throw
    // The write may succeed or silently fail based on schema; we just verify no exception propagates.
    await expect(
      logSupersedeShadow(db, {
        appliedMemoryId: "mem-smoke-003",
        userId: "smoke-user",
        scope: "user",
        sessionId: "sess-smoke-001",
        source: "memory_store",
        appliedOutcome: "create",
        baselineOutcome: "create",
        wouldOutcome: "create",
        diverged: false,
        liveFlags: { cueGate: false, temporalGuard: false, keepBothGuard: false, addSkipGuard: false, judgeGate: false },
        wouldMatchedId: null,
        wouldCosine: null,
        wouldSignal: null,
        wouldReason: "no candidates",
        wouldBand: "create",
        baselineMatchedId: null,
        baselineBand: "create",
        incomingTextTrunc: "fire and forget test",
      }),
    ).resolves.toBeUndefined();
  });
});
