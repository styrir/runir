import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StringRecordId } from "surrealdb";
import {
  SurrealClient,
  extractId,
} from "../storage/surreal/surreal-store.js";
import {
  ensureEntityTables,
  reassignEntityEdges,
  composeEdgeReassignment,
} from "../entities/entity-store.js";

// Real-DB proof for the atomic reassignEntityEdges (Rúnir-n7ze.2 / ADOPT-NOW #4.1).
// Isolated per-file database, dropped in afterAll; self-skips with ctx.skip when
// no SurrealDB is reachable.
//
// NOTE on within-batch dedup: entity_edges carries a UNIQUE index on (in,out,kind)
// (idx_ee_unique), so two DISTINCT loser edges can never remap to the same surviving
// (non-self-loop) target — that would require them to be identical pre-remap, which
// the unique index forbids. (A loser↔winner pair, e.g. loser→winner AND winner→loser,
// both collapse to a self-loop and are simply dropped, not folded.) The TS-side
// aggregation in composeEdgeReassignment is therefore defense-in-depth for
// legacy/no-index databases; it is exercised by the mock unit test below, not against
// the live schema. The collision-FOLD case (the winner already holds the target edge)
// IS live-reachable and is the reason a blind "RELATE everything" would violate
// idx_ee_unique — covered by the real-DB tests.

const TEST_DB = "reassign_edges_txn_test";
const USER = "_reassign_edges_txn_user";
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
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

async function clearGraph(): Promise<void> {
  await db.query(`DELETE entity_edges; DELETE entities;`);
}

async function makeEntity(slug: string): Promise<void> {
  await db.query(
    `CREATE type::record('entities', $slug) CONTENT {
       kind: 'concept', canonicalName: $slug, nameNorm: $slug,
       sourceProject: 'txn-test', scope: 'user', userId: $user,
       firstSeenAt: <datetime>$now, lastSeenAt: <datetime>$now,
       createdAt: <datetime>$now, updatedAt: <datetime>$now, confidence: 0.9
     };`,
    { slug, user: USER, now: NOW },
  );
}

async function relate(
  fromSlug: string,
  toSlug: string,
  kind: string,
  weight: number,
  confidence: number,
): Promise<void> {
  await db.query(
    `RELATE $f -> entity_edges -> $t SET
       kind = $k, confidence = $c, weight = $w,
       observedAt = <datetime>$now, lastSeenAt = <datetime>$now,
       sourceProject = 'txn-test', scope = 'user';`,
    {
      f: new StringRecordId(`entities:${fromSlug}`),
      t: new StringRecordId(`entities:${toSlug}`),
      k: kind,
      c: confidence,
      w: weight,
      now: NOW,
    },
  );
}

type EdgeRow = { in: unknown; out: unknown; kind: string; weight?: number; confidence?: number };

async function edgesTouching(slug: string): Promise<EdgeRow[]> {
  const res = await db.query<EdgeRow>(
    `SELECT in, out, kind, weight, confidence FROM entity_edges
       WHERE in = type::record('entities', $s) OR out = type::record('entities', $s);`,
    { s: slug },
  );
  return (res[0] ?? []).map((e) => ({
    in: extractId(e.in),
    out: extractId(e.out),
    kind: e.kind,
    weight: e.weight,
    confidence: e.confidence,
  }));
}

describe("reassignEntityEdges — atomic edge move (Rúnir-n7ze.2)", () => {
  it("moves a loser edge onto the winner and deletes the original (commit)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();
    await makeEntity("winner");
    await makeEntity("loser");
    await makeEntity("nodex");
    await relate("loser", "nodex", "related", 1.0, 0.8);

    await reassignEntityEdges(db, "loser", "winner");

    expect(await edgesTouching("loser")).toHaveLength(0);
    const winnerEdges = await edgesTouching("winner");
    expect(winnerEdges).toHaveLength(1);
    expect(winnerEdges[0]).toMatchObject({
      in: "winner",
      out: "nodex",
      kind: "related",
    });
  }, 20000);

  it("folds into the winner's existing edge instead of violating idx_ee_unique", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();
    await makeEntity("winner");
    await makeEntity("loser");
    await makeEntity("nodey");
    // Winner and loser independently connect to nodey with the same kind.
    await relate("winner", "nodey", "related", 1.0, 0.5);
    await relate("loser", "nodey", "related", 2.0, 0.9);

    await reassignEntityEdges(db, "loser", "winner");

    expect(await edgesTouching("loser")).toHaveLength(0);
    const winnerEdges = await edgesTouching("winner");
    // Exactly ONE winner→nodey edge (folded), not two — a blind RELATE here would
    // have hit the UNIQUE (in,out,kind) index and failed the transaction.
    expect(winnerEdges).toHaveLength(1);
    expect(winnerEdges[0].weight).toBe(3.0); // 1.0 + 2.0
    expect(winnerEdges[0].confidence).toBe(0.9); // max(0.5, 0.9)
  }, 20000);

  it("drops a loser→winner edge as a self-loop (no winner→winner edge)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();
    await makeEntity("winner");
    await makeEntity("loser");
    await relate("loser", "winner", "related", 1.0, 0.7);

    await reassignEntityEdges(db, "loser", "winner");

    expect(await edgesTouching("loser")).toHaveLength(0);
    // The from↔from collapse must NOT create a winner→winner self-loop.
    const winnerEdges = await edgesTouching("winner");
    expect(winnerEdges).toHaveLength(0);
  }, 20000);

  it("rolls back atomically — a mid-transaction failure leaves originals intact", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();
    await makeEntity("winner");
    await makeEntity("loser");
    await makeEntity("nodex");
    await relate("loser", "nodex", "related", 1.0, 0.8);

    // Compose the real fragment, then force a failure at the END of the same tx.
    const { body, vars } = await composeEdgeReassignment(db, "loser", "winner", "r");
    expect(body).not.toBe("");
    await expect(
      db.queryTransaction(`${body}\nTHROW "rollback probe";`, vars),
    ).rejects.toThrow(/transaction failed/);

    // The original loser→nodex edge must still be present; no winner replacement.
    const loserEdges = await edgesTouching("loser");
    expect(loserEdges).toHaveLength(1);
    expect(loserEdges[0]).toMatchObject({ in: "loser", out: "nodex" });
    expect(await edgesTouching("winner")).toHaveLength(0);
  }, 20000);
});

describe("composeEdgeReassignment — TS within-batch dedup (defense-in-depth, mocked)", () => {
  it("folds two same-target loser edges into ONE RELATE + per-edge DELETEs", async () => {
    // Simulates a legacy DB WITHOUT idx_ee_unique where two loser edges could
    // map to the same (in,out,kind) target. Drives composeEdgeReassignment with a
    // mock db: READ 1 returns both edges; READ 2 (collision) returns empty.
    let call = 0;
    const mockDb = {
      query: async () => {
        call += 1;
        if (call === 1) {
          // READ 1 — two loser→nodex/related edges (the legacy duplicate case).
          return [
            [
              {
                id: "entity_edges:e1",
                in: "entities:loser",
                out: "entities:nodex",
                kind: "related",
                confidence: 0.5,
                weight: 1.0,
                observedAt: NOW,
                lastSeenAt: NOW,
                sourceProject: "p",
                scope: "user",
              },
              {
                id: "entity_edges:e2",
                in: "entities:loser",
                out: "entities:nodex",
                kind: "related",
                confidence: 0.9,
                weight: 2.0,
                observedAt: NOW,
                lastSeenAt: NOW,
                sourceProject: "p",
                scope: "user",
              },
            ],
          ];
        }
        // READ 2 — no existing target edge.
        return [[]];
      },
    } as unknown as SurrealClient;

    const { body, vars } = await composeEdgeReassignment(
      mockDb,
      "loser",
      "winner",
      "r",
    );

    const relateCount = (body.match(/RELATE/g) ?? []).length;
    const deleteCount = (body.match(/DELETE/g) ?? []).length;
    expect(relateCount).toBe(1); // ONE folded target, not two
    expect(deleteCount).toBe(2); // both originals deleted
    expect(vars["r0_weight"]).toBe(3.0); // summed
    expect(vars["r0_confidence"]).toBe(0.9); // max
  });
});
