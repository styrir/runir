/**
 * Rúnir-h435.1 Unit B — B-6 live SQL: three DDLs + option-NONE branches +
 * supersede_shadow.write_event_id additive column (with and without value).
 *
 * Native SurrealDB 127.0.0.1:8000 only — do NOT start Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SurrealClient,
  ensureSupersedeShadowTable,
  logSupersedeShadow,
} from "../surreal/surreal-store.js";
import {
  ensureAtomicShadowTables,
  createAtomicShadowAttempt,
  createAtomicShadowEvent,
  createAtomicShadowNomination,
  finalizeAtomicShadowAttemptIfComplete,
} from "../surreal/atomic-shadow-store.js";
import {
  ATOMIC_SHADOW_ATTEMPT_TABLE,
  ATOMIC_SHADOW_EVENT_TABLE,
  ATOMIC_SHADOW_NOMINATION_TABLE,
} from "../surreal/shadow-schema.js";

const TEST_DB = "h435_1_unit_b_live_sql_test";

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
    console.log(
      JSON.stringify({
        step: "B-6-live-sql",
        status: "skip",
        detail: "native SurrealDB 127.0.0.1:8000 unreachable — not starting Docker",
      }),
    );
    return;
  }
  await ensureAtomicShadowTables(db);
  await ensureSupersedeShadowTable(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

describe("B-6 live SQL atomic shadow tables + write_event_id", () => {
  it("DDL + INSERT/UPDATE round-trip including every option-field NONE branch", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // computation_failed: all pair/selection/manifest NONE
    const failId = "we-b6-failed";
    await createAtomicShadowAttempt(db, {
      writeEventId: failId,
      activationClass: "computation_failed",
      stratum: "organic",
      frameId: "organic:2026-07-10",
      errorDetail: "test error detail",
    });
    const failRows = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} WHERE write_event_id = $wid;`,
      { wid: failId },
    );
    const fail = (failRows as any)?.[0]?.[0];
    expect(fail.activation_class).toBe("computation_failed");
    expect(fail.pair_key == null || fail.pair_key === undefined).toBe(true);
    expect(fail.selection_hash == null || fail.selection_hash === undefined).toBe(true);
    expect(fail.retired_candidate_id == null || fail.retired_candidate_id === undefined).toBe(
      true,
    );
    expect(
      fail.nomination_manifest_keys == null || fail.nomination_manifest_keys === undefined,
    ).toBe(true);
    expect(fail.finalized).toBe(false);
    expect(fail.error_detail).toBe("test error detail");

    // efficacy_only: pair/selection/retired NONE, manifest present
    const effId = "we-b6-eff";
    await createAtomicShadowAttempt(db, {
      writeEventId: effId,
      activationClass: "efficacy_only",
      nominationManifestKeys: ["n1", "n2"],
      nominationManifestCount: 2,
      stratum: "organic",
      frameId: "organic:2026-07-10",
    });
    const effRows = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} WHERE write_event_id = $wid;`,
      { wid: effId },
    );
    const eff = (effRows as any)?.[0]?.[0];
    expect(eff.activation_class).toBe("efficacy_only");
    expect(eff.pair_key == null || eff.pair_key === undefined).toBe(true);
    expect(JSON.parse(eff.nomination_manifest_keys)).toEqual(["n1", "n2"]);
    expect(eff.nomination_manifest_count).toBe(2);

    // safety_activation + event + nominations + finalize
    const safeId = "we-b6-safe";
    const pairKey = `${safeId}\u0000cand-retired`;
    const { createHash } = await import("node:crypto");
    const selectionHash = createHash("sha256").update(pairKey).digest("hex");
    await createAtomicShadowAttempt(db, {
      writeEventId: safeId,
      activationClass: "safety_activation",
      pairKey,
      selectionHash,
      retiredCandidateId: "cand-retired",
      nominationManifestKeys: ["cand-retired", "cand-other"],
      nominationManifestCount: 2,
      stratum: "replay",
      frameId: "replay:run-xyz",
      replayStepId: "step-uuid-1",
    });
    await createAtomicShadowEvent(db, {
      writeEventId: safeId,
      isolatedOutcome: "supersede",
      isolatedMatchedId: "cand-retired",
      isolatedReferentProof: "key:atomicFactIdentity",
      isolatedGuardKeepBothReason: null, // NONE branch
      isolatedUnresolved: null, // NONE
      incomingSnapshotJson: JSON.stringify({ text: "inc", tags: null }),
      candidateSnapshotJson: null, // NONE branch
      laneClockMs: 1_700_000_000_000,
      appliedOutcome: "create",
      appliedMatchedId: null, // NONE
    });
    await createAtomicShadowNomination(db, {
      writeEventId: safeId,
      nominationCandidateId: "cand-retired",
      candidateSnapshotJson: JSON.stringify({ id: "cand-retired", text: "t" }),
      disposition: "proven-retired",
      // selected_* NONE
    });
    await createAtomicShadowNomination(db, {
      writeEventId: safeId,
      nominationCandidateId: "cand-other",
      candidateSnapshotJson: JSON.stringify({ id: "cand-other", text: "t2" }),
      disposition: "proven-not-selected",
      selectedCandidateId: "cand-retired",
      selectedSignal: "deterministic_text",
    });
    const finalized = await finalizeAtomicShadowAttemptIfComplete(db, safeId, [
      "cand-retired",
      "cand-other",
    ]);
    expect(finalized).toBe(true);
    const attRows = await db.query(
      `SELECT finalized, finalized_at, selection_hash, pair_key FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} WHERE write_event_id = $wid;`,
      { wid: safeId },
    );
    const att = (attRows as any)?.[0]?.[0];
    expect(att.finalized).toBe(true);
    expect(att.finalized_at).toBeTruthy();
    expect(att.selection_hash).toBe(selectionHash);
    expect(att.pair_key).toBe(pairKey);

    // Event NONE branches round-trip
    const evRows = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_EVENT_TABLE} WHERE write_event_id = $wid;`,
      { wid: safeId },
    );
    const ev = (evRows as any)?.[0]?.[0];
    expect(ev.isolated_outcome).toBe("supersede");
    expect(ev.candidate_snapshot_json == null || ev.candidate_snapshot_json === undefined).toBe(
      true,
    );
    expect(ev.isolated_unresolved == null || ev.isolated_unresolved === undefined).toBe(true);

    // Nomination selected NONE branch
    const nomRows = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid AND nomination_candidate_id = 'cand-retired';`,
      { wid: safeId },
    );
    const nom = (nomRows as any)?.[0]?.[0];
    expect(nom.disposition).toBe("proven-retired");
    expect(nom.selected_candidate_id == null || nom.selected_candidate_id === undefined).toBe(
      true,
    );
  });

  it("B-6 additive supersede_shadow.write_event_id — with value and legacy NONE", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // With write_event_id
    await logSupersedeShadow(db, {
      appliedMemoryId: null,
      userId: "u-b6",
      scope: "user",
      source: "memory_store",
      appliedOutcome: "create",
      baselineOutcome: "create",
      wouldOutcome: "supersede",
      diverged: true,
      liveFlags: {
        cueGate: false,
        temporalGuard: false,
        keepBothGuard: false,
        addSkipGuard: false,
        judgeGate: false,
        atomicIdentityProof: false,
      },
      wouldMatchedId: "c1",
      wouldCosine: 0.9,
      wouldSignal: "deterministic_text",
      wouldReason: "test",
      wouldBand: "correction-supersede",
      baselineMatchedId: null,
      baselineBand: null,
      incomingTextTrunc: "hello",
      writeEventId: "we-b6-shadow-with",
    });

    // Legacy-shaped WITHOUT write_event_id
    await logSupersedeShadow(db, {
      appliedMemoryId: null,
      userId: "u-b6",
      scope: "user",
      source: "memory_store",
      appliedOutcome: "create",
      baselineOutcome: "create",
      wouldOutcome: "create",
      diverged: false,
      liveFlags: {
        cueGate: false,
        temporalGuard: false,
        keepBothGuard: false,
        addSkipGuard: false,
        judgeGate: false,
      },
      wouldMatchedId: null,
      wouldCosine: null,
      wouldSignal: null,
      wouldReason: "legacy",
      wouldBand: null,
      baselineMatchedId: null,
      baselineBand: null,
      incomingTextTrunc: "legacy",
    });

    // Allow fire-and-forget settles
    await new Promise((r) => setTimeout(r, 200));

    const withRows = await db.query(
      `SELECT write_event_id, would_reason FROM supersede_shadow WHERE would_reason = 'test';`,
    );
    const withHit = ((withRows as any)?.[0] ?? []).find(
      (r: any) => r.write_event_id === "we-b6-shadow-with",
    );
    expect(withHit).toBeTruthy();

    const legacyRows = await db.query(
      `SELECT write_event_id, would_reason FROM supersede_shadow WHERE would_reason = 'legacy';`,
    );
    const legacyHit = ((legacyRows as any)?.[0] ?? [])[0];
    expect(legacyHit).toBeTruthy();
    // NONE → null/undefined on read
    expect(
      legacyHit.write_event_id == null || legacyHit.write_event_id === undefined,
    ).toBe(true);
  });
});
