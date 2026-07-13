import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient, extractId } from "../storage/surreal/surreal-store.js";
import {
  ensureEntityTables,
  upsertEntity,
  linkEntityToMemory,
  getSupportingMemoryIds,
  findEntityByName,
} from "../entities/entity-store.js";
import { entityIdSlug } from "../entities/entity-arbitrator.js";
import { promoteSessionEntities } from "../lifecycle/semion/entity-consolidation.js";

// Real-DB integration tests for Rúnir-n7ze.11: the PROMOTE branch of
// promoteSessionEntities is now ONE atomic transaction (upsert canonical +
// edge move + stub delete). Three scenarios:
//   (a) commit — stub + edges promoted correctly
//   (b) rollback — transaction failure leaves stub + edges intact
//   (c) multi-stub resilience — a failing stub is logged, not aborting the pass

const TEST_DB = "promote_entities_txn_test";
const USER = "_promote_entities_txn_user";
const NOW = "2026-01-01T00:00:00.000Z";

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
  await ensureEntityTables(db);
  await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

async function clearGraph(): Promise<void> {
  await db.query("DELETE entity_edges; DELETE entities; DELETE semiote;");
}

/** Helper: bare slug of a session stub */
function sessionSlug(nameNorm: string, kind: string, sessionId: string): string {
  return entityIdSlug(nameNorm, kind, USER, "session", sessionId);
}

/** Helper: bare slug of a user canonical */
function userSlug(nameNorm: string, kind: string): string {
  return entityIdSlug(nameNorm, kind, USER, "user");
}

async function entityExists(slug: string): Promise<boolean> {
  const res = await db.query<{ id: unknown }>(
    "SELECT id FROM type::record('entities', $s);",
    { s: slug },
  );
  return ((res[0] ?? []) as unknown[]).length > 0;
}

async function edgesTouching(slug: string): Promise<Array<{ in: string; out: string }>> {
  const res = await db.query<{ in: unknown; out: unknown }>(
    `SELECT in, out FROM entity_edges
       WHERE in = type::record('entities', $s) OR out = type::record('entities', $s);`,
    { s: slug },
  );
  return (res[0] ?? []).map((e) => ({ in: extractId(e.in), out: extractId(e.out) }));
}

// ── (a) PROMOTE COMMIT ────────────────────────────────────────────────────────

describe("promoteSessionEntities — promote commit (Rúnir-n7ze.11)", () => {
  it("creates user-scope canonical, moves edges onto it, deletes stub", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();

    // Create a session stub with a mentioned_in edge to a memory.
    const stubSlug = sessionSlug("promoteperson", "person", "sess-commit");
    await upsertEntity(db, {
      kind: "person",
      canonicalName: "PromotePerson",
      nameNorm: "promoteperson",
      userId: USER,
      scope: "session",
      sessionId: "sess-commit",
      sourceProject: "n7ze11-test",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      confidence: 0.9,
      aliases: [],
      aliasesNorm: [],
    });
    await db.query(
      "CREATE type::record('semiote', 'mcommit1') SET payload = { userId: $u };",
      { u: USER },
    );
    await linkEntityToMemory(db, stubSlug, "mcommit1", {
      confidence: 0.9,
      sourceProject: "n7ze11-test",
      scope: "session",
      sessionId: "sess-commit",
    });

    // Pre-condition: stub has the edge.
    expect((await getSupportingMemoryIds(db, stubSlug)).length).toBe(1);

    const result = await promoteSessionEntities(db, USER);
    expect(result.promoted).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.failed).toBe(0);

    // User-scoped canonical must exist at the expected record id.
    const canonSlug = userSlug("promoteperson", "person");
    const canonRows = await findEntityByName(db, "promoteperson", "person", USER, "user");
    expect(canonRows.length).toBe(1);
    expect(extractId(canonRows[0].id)).toBe(canonSlug);

    // Stub must be gone.
    expect(await entityExists(stubSlug)).toBe(false);

    // Edges must be on the canonical, not the stub.
    expect(await edgesTouching(stubSlug)).toHaveLength(0);
    const canonSupporting = await getSupportingMemoryIds(db, canonSlug);
    expect(canonSupporting.map((s) => extractId(s))).toContain("mcommit1");
  }, 20000);
});

// ── (b) PROMOTE ROLLBACK ──────────────────────────────────────────────────────

describe("promoteSessionEntities — promote rollback (Rúnir-n7ze.11)", () => {
  it("rolls back entire promote when the transaction fails — stub and edges intact", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();

    const stubSlug = sessionSlug("rollbackperson", "person", "sess-rollback");
    await upsertEntity(db, {
      kind: "person",
      canonicalName: "RollbackPerson",
      nameNorm: "rollbackperson",
      userId: USER,
      scope: "session",
      sessionId: "sess-rollback",
      sourceProject: "n7ze11-test",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      confidence: 0.9,
      aliases: [],
      aliasesNorm: [],
    });
    await db.query(
      "CREATE type::record('semiote', 'mrollback1') SET payload = { userId: $u };",
      { u: USER },
    );
    await linkEntityToMemory(db, stubSlug, "mrollback1", {
      confidence: 0.9,
      sourceProject: "n7ze11-test",
      scope: "session",
      sessionId: "sess-rollback",
    });

    // Force a failure inside the assembled promote transaction by wrapping
    // db.queryTransaction to append THROW — same pattern as merge-entities-transaction.test.ts.
    const orig = db.queryTransaction.bind(db);
    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = (body: string, vars?: Record<string, unknown>) =>
      orig(`${body}\nTHROW "promote rollback probe";`, vars);

    let logs: string[] = [];
    const result = await promoteSessionEntities(db, USER, (msg) => logs.push(msg));

    // Restore
    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = orig;

    // Per-stub resilience: failed=1, not a thrown error.
    expect(result.promoted).toBe(0);
    expect(result.failed).toBe(1);
    // Logger received the failure message.
    expect(logs.some((l) => l.includes("failed"))).toBe(true);

    // Stub still exists — nothing was committed.
    expect(await entityExists(stubSlug)).toBe(true);

    // Edge still on the stub — not moved.
    expect(await edgesTouching(stubSlug)).toHaveLength(1);

    // No user-scope canonical was created.
    const canonSlug = userSlug("rollbackperson", "person");
    expect(await entityExists(canonSlug)).toBe(false);
  }, 20000);
});

// ── (c) MULTI-STUB RESILIENCE ─────────────────────────────────────────────────

describe("promoteSessionEntities — multi-stub resilience (Rúnir-n7ze.11)", () => {
  it("logs + skips a failing stub and still processes the next one", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();

    // Two distinct session stubs.
    const stub1Slug = sessionSlug("failperson", "person", "sess-fail");
    const stub2Slug = sessionSlug("successperson", "person", "sess-success");

    for (const [slug, nameNorm, sessionId] of [
      [stub1Slug, "failperson", "sess-fail"],
      [stub2Slug, "successperson", "sess-success"],
    ] as const) {
      await upsertEntity(db, {
        kind: "person",
        canonicalName: nameNorm === "failperson" ? "FailPerson" : "SuccessPerson",
        nameNorm,
        userId: USER,
        scope: "session",
        sessionId,
        sourceProject: "n7ze11-test",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        confidence: 0.9,
        aliases: [],
        aliasesNorm: [],
      });
    }

    // Make the FIRST queryTransaction call throw (affects stub1), leave the second alone.
    let callCount = 0;
    const orig = db.queryTransaction.bind(db);
    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = (body: string, vars?: Record<string, unknown>) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error("injected failure for stub1"));
      }
      return orig(body, vars);
    };

    let logs: string[] = [];
    const result = await promoteSessionEntities(db, USER, (msg) => logs.push(msg));

    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = orig;

    // The failing stub is counted and the pass continues.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    // The second stub succeeded.
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    // The failure was logged.
    expect(logs.some((l) => l.includes("failed"))).toBe(true);

    // stub2 was promoted to user scope.
    const canon2Rows = await findEntityByName(db, "successperson", "person", USER, "user");
    expect(canon2Rows.length).toBe(1);
    // stub2 session record is gone.
    expect(await entityExists(stub2Slug)).toBe(false);
  }, 20000);
});
