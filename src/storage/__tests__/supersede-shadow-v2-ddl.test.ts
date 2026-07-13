import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SurrealClient,
  ensureSupersedeShadowTable,
  logSupersedeShadow,
} from "../surreal/surreal-store.js";
import {
  SUPERSEDE_SHADOW_SCHEMA_VERSION,
  SHADOW_FIELD_WOULD_NOMINATION_BLOCKED,
  SHADOW_FIELD_REFERENT_VERDICT,
  SHADOW_FIELD_REFERENT_PROOF,
  SHADOW_FIELD_INCOMING_TEXT_FULL,
  SHADOW_FIELD_INCOMING_TAGS_JSON,
  SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON,
} from "../surreal/shadow-schema.js";

// Rúnir-pn1l.13.4 (U5) — supersede_shadow_v2 real-DB DDL smoke.
//
// ARCHEION lesson: SurrealQL parse/type errors are invisible to stubbed db.query mocks.
// This test executes the REAL `ensureSupersedeShadowTable` v2 DDL and a REAL
// `logSupersedeShadow` carrying the three new v2 columns against the NATIVE SurrealDB
// (127.0.0.1:8000, ns=main, isolated TEST database), per AGENTS.md Test Dependencies.
// It self-skips (never fails) if the DB is unreachable — the default fast lane runs it
// when the native DB is up (the normal local/CI state here).

const TEST_DB = "supersede_shadow_v2_ddl_test";

function makeDb(): SurrealClient {
  return new SurrealClient({
    // AGENTS.md: connect over 127.0.0.1 (NOT localhost) to the native install.
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
    await db.query("INFO FOR DB;"); // throws if unreachable
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await db.query("REMOVE TABLE IF EXISTS supersede_shadow;").catch(() => {});
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

describe("supersede_shadow v2 DDL (real native-DB smoke)", () => {
  it("exports the v2 schema version marker", () => {
    expect(SUPERSEDE_SHADOW_SCHEMA_VERSION).toBe("supersede_shadow_v2");
  });

  it("ensureSupersedeShadowTable defines the v2 referent columns and accepts writes carrying them", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // 1. Real DDL — creates the SCHEMAFULL table + v2 option<string> columns.
    //    A parse or type error here throws (unlike a stubbed mock), failing the test.
    await ensureSupersedeShadowTable(db);
    // 2. Idempotent — DEFINE ... IF NOT EXISTS.
    await ensureSupersedeShadowTable(db);

    // 3. Confirm the DDL defined the three v2 fields via INFO FOR TABLE. The SurrealDB JS
    //    client's result nesting for INFO varies by version, so locate the `fields` map
    //    defensively (it maps each field name → its rendered DEFINE statement). The
    //    round-trip in steps 4-6 is the load-bearing proof (a SCHEMAFULL table REJECTS a
    //    write to an undefined field); this introspection is a best-effort corroboration.
    const info = await db.query<any>("INFO FOR TABLE supersede_shadow;");
    const infoRoot: any = info?.[0];
    const fields = (infoRoot?.fields ?? infoRoot?.[0]?.fields ?? {}) as Record<string, unknown>;
    const allDefns = JSON.stringify(fields).toLowerCase();
    for (const f of [
      SHADOW_FIELD_WOULD_NOMINATION_BLOCKED,
      SHADOW_FIELD_REFERENT_VERDICT,
      SHADOW_FIELD_REFERENT_PROOF,
      // Rúnir-pn1l.13.6 — item A/B additive columns (same generation, no schema-version bump).
      SHADOW_FIELD_INCOMING_TEXT_FULL,
      SHADOW_FIELD_INCOMING_TAGS_JSON,
      SHADOW_FIELD_CANDIDATE_SNAPSHOT_JSON,
    ]) {
      expect(allDefns, `v2 field ${f} present in INFO FOR TABLE`).toContain(f);
    }
    expect(allDefns, "v2 fields typed option<string>").toContain("string");

    // 4. Real logSupersedeShadow (fire-and-forget) with the v2 columns POPULATED —
    //    a proven F1 retirement row.
    await logSupersedeShadow(db, {
      appliedMemoryId: "mem-v2-proven",
      userId: "smoke-user",
      scope: "user",
      sessionId: "sess-v2",
      source: "memory_store",
      appliedOutcome: "supersede",
      baselineOutcome: "create",
      wouldOutcome: "supersede",
      diverged: true,
      liveFlags: { cueGate: false, temporalGuard: false, keepBothGuard: false, addSkipGuard: false, judgeGate: false },
      wouldMatchedId: "cand-v2",
      wouldCosine: 0.9,
      wouldSignal: "deterministic_text",
      wouldReason: "superseded via deterministic_text",
      wouldBand: "correction-supersede",
      baselineMatchedId: null,
      baselineBand: "create",
      incomingTextTrunc: "port setting: 8800 override",
      wouldNominationBlocked: null,
      referentVerdict: "proven",
      referentProof: "key:factKey",
      // Rúnir-pn1l.13.6 — item A/B new columns.
      incomingTextFull: "port setting: 8800 override (full untruncated incoming text for replay)",
      incomingTagsJson: JSON.stringify(["project:atlas", "role:tech-lead"]),
      candidateSnapshotJson: JSON.stringify({
        id: "cand-v2",
        l2: "port setting: 7700 default",
        tags: ["project:atlas"],
        factKey: "config:port-setting-abc",
        noemaClaimKey: null,
        atomicFact: { subject: "Runir service", predicate: "uses_port", value: "7700" },
      }),
    });

    // 5. Real logSupersedeShadow with a BLOCKED nomination (v2 blocked column populated,
    //    verdict/proof absent → written as NONE).
    await logSupersedeShadow(db, {
      appliedMemoryId: null,
      userId: "smoke-user",
      scope: "user",
      sessionId: "sess-v2",
      source: "memory_store",
      appliedOutcome: "create",
      baselineOutcome: "create",
      wouldOutcome: "create",
      diverged: false,
      liveFlags: { cueGate: false, temporalGuard: false, keepBothGuard: false, addSkipGuard: false, judgeGate: false },
      wouldMatchedId: null,
      wouldCosine: null,
      wouldSignal: null,
      wouldReason: "no compatible supersede target",
      wouldBand: "create",
      baselineMatchedId: null,
      baselineBand: "create",
      incomingTextTrunc: "config value: beta mode",
      wouldNominationBlocked: "deterministic_text:unproven",
      referentVerdict: null,
      referentProof: null,
    });

    // 6. Read back — the v2 columns survive a real round-trip (proves the writes were
    //    accepted, not silently swallowed by the fire-and-forget .catch).
    const provenRows = await db.query<any>(
      "SELECT referent_verdict, referent_proof, would_nomination_blocked, incoming_text_full, incoming_tags_json, candidate_snapshot_json FROM supersede_shadow WHERE referent_verdict = 'proven';",
    );
    const proven = (provenRows[0] ?? [])[0];
    expect(proven, "proven row round-tripped").toBeTruthy();
    expect(proven.referent_verdict).toBe("proven");
    expect(proven.referent_proof).toBe("key:factKey");
    // Absent v2 field on this row is NONE → undefined in the JS client.
    expect(proven.would_nomination_blocked == null).toBe(true);
    // Rúnir-pn1l.13.6 — item A/B new columns round-trip a REAL SurrealQL write/read,
    // not just a mock (a SCHEMAFULL type/parse error would throw here, not silently pass).
    expect(proven.incoming_text_full).toBe(
      "port setting: 8800 override (full untruncated incoming text for replay)",
    );
    expect(JSON.parse(proven.incoming_tags_json)).toEqual(["project:atlas", "role:tech-lead"]);
    const roundTrippedSnapshot = JSON.parse(proven.candidate_snapshot_json);
    expect(roundTrippedSnapshot.l2).toBe("port setting: 7700 default");
    expect(roundTrippedSnapshot.factKey).toBe("config:port-setting-abc");
    expect(roundTrippedSnapshot.atomicFact).toEqual({
      subject: "Runir service",
      predicate: "uses_port",
      value: "7700",
    });

    // The second row (blocked-nomination) never set the new item A/B params — confirm they
    // survive as NONE/undefined, not a coerced empty string or a thrown type error.
    const blockedFieldsRows = await db.query<any>(
      "SELECT incoming_text_full, incoming_tags_json, candidate_snapshot_json FROM supersede_shadow WHERE would_nomination_blocked = 'deterministic_text:unproven';",
    );
    const blockedFields = (blockedFieldsRows[0] ?? [])[0];
    expect(blockedFields, "blocked-nomination row round-tripped").toBeTruthy();
    expect(blockedFields.incoming_text_full == null).toBe(true);
    expect(blockedFields.incoming_tags_json == null).toBe(true);
    expect(blockedFields.candidate_snapshot_json == null).toBe(true);

    const blockedRows = await db.query<any>(
      "SELECT would_nomination_blocked, referent_verdict FROM supersede_shadow WHERE would_nomination_blocked = 'deterministic_text:unproven';",
    );
    const blocked = (blockedRows[0] ?? [])[0];
    expect(blocked, "blocked-nomination row round-tripped").toBeTruthy();
    expect(blocked.would_nomination_blocked).toBe("deterministic_text:unproven");
    expect(blocked.referent_verdict == null).toBe(true);
  });
});
