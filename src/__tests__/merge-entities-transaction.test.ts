import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StringRecordId } from "surrealdb";
import { SurrealClient, extractId } from "../storage/surreal/surreal-store.js";
import { ensureEntityTables, mergeEntities } from "../entities/entity-store.js";

// Real-DB proof that mergeEntities runs as ONE atomic transaction
// (Rúnir-n7ze.3 / ADOPT-NOW #4.2): winner update + edge move + loser-alias union
// + loser delete either all commit or all roll back. Isolated per-file database,
// dropped in afterAll; self-skips when no SurrealDB is reachable.

const TEST_DB = "merge_entities_txn_test";
const USER = "_merge_entities_txn_user";
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

async function makeEntity(
  slug: string,
  opts: { canonicalName?: string; aliases?: string[]; aliasesNorm?: string[] } = {},
): Promise<void> {
  await db.query(
    `CREATE type::record('entities', $slug) CONTENT {
       kind: 'concept', canonicalName: $cn, nameNorm: $slug,
       sourceProject: 'txn-test', scope: 'user', userId: $user,
       firstSeenAt: <datetime>$now, lastSeenAt: <datetime>$now,
       createdAt: <datetime>$now, updatedAt: <datetime>$now, confidence: 0.9,
       aliases: $aliases, aliasesNorm: $aliasesNorm
     };`,
    {
      slug,
      cn: opts.canonicalName ?? slug,
      user: USER,
      now: NOW,
      aliases: opts.aliases ?? [],
      aliasesNorm: opts.aliasesNorm ?? [],
    },
  );
}

async function relate(fromSlug: string, toSlug: string, kind: string): Promise<void> {
  await db.query(
    `RELATE $f -> entity_edges -> $t SET
       kind = $k, confidence = 0.8, weight = 1.0,
       observedAt = <datetime>$now, lastSeenAt = <datetime>$now,
       sourceProject = 'txn-test', scope = 'user';`,
    {
      f: new StringRecordId(`entities:${fromSlug}`),
      t: new StringRecordId(`entities:${toSlug}`),
      k: kind,
      now: NOW,
    },
  );
}

async function getEntity(
  slug: string,
): Promise<{ canonicalName?: string; aliases?: string[] } | undefined> {
  const res = await db.query<{ canonicalName?: string; aliases?: string[] }>(
    `SELECT canonicalName, aliases FROM type::record('entities', $s);`,
    { s: slug },
  );
  return res[0]?.[0];
}

async function edgesTouching(slug: string): Promise<Array<{ in: string; out: string }>> {
  const res = await db.query<{ in: unknown; out: unknown }>(
    `SELECT in, out FROM entity_edges
       WHERE in = type::record('entities', $s) OR out = type::record('entities', $s);`,
    { s: slug },
  );
  return (res[0] ?? []).map((e) => ({ in: extractId(e.in), out: extractId(e.out) }));
}

describe("mergeEntities — atomic merge transaction (Rúnir-n7ze.3)", () => {
  it("commits the winner update, edge move, alias union, and loser delete together", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();
    await makeEntity("winner", { canonicalName: "winner" });
    await makeEntity("loser", {
      canonicalName: "loser",
      aliases: ["loser-alias"],
      aliasesNorm: ["loser_alias"],
    });
    await makeEntity("nodex");
    await relate("loser", "nodex", "related");

    await mergeEntities(db, "winner", "loser", {
      canonicalName: "Merged Winner",
      aliases: ["w-alias"],
      aliasesNorm: ["w_alias"],
    });

    const winner = await getEntity("winner");
    expect(winner?.canonicalName).toBe("Merged Winner");
    // Winner absorbs its own update aliases AND the loser's aliases.
    expect([...(winner?.aliases ?? [])].sort()).toEqual(["loser-alias", "w-alias"]);

    // Loser is gone; its edge was moved onto the winner.
    expect(await getEntity("loser")).toBeUndefined();
    expect(await edgesTouching("loser")).toHaveLength(0);
    const winnerEdges = await edgesTouching("winner");
    expect(winnerEdges).toHaveLength(1);
    expect(winnerEdges[0]).toMatchObject({ in: "winner", out: "nodex" });
  }, 20000);

  it("rolls back the ENTIRE merge when the transaction fails (atomicity)", async (ctx) => {
    if (!dbAvailable) ctx.skip();
    await clearGraph();
    await makeEntity("winner", { canonicalName: "winner" });
    await makeEntity("loser", {
      canonicalName: "loser",
      aliases: ["loser-alias"],
      aliasesNorm: ["loser_alias"],
    });
    await makeEntity("nodex");
    await relate("loser", "nodex", "related");

    // Force a failure at the END of the assembled merge transaction by wrapping
    // queryTransaction to append a THROW — exercises the real composed body.
    const orig = db.queryTransaction.bind(db);
    (db as unknown as {
      queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
    }).queryTransaction = (body: string, vars?: Record<string, unknown>) =>
      orig(`${body}\nTHROW "merge rollback probe";`, vars);

    try {
      await expect(
        mergeEntities(db, "winner", "loser", { canonicalName: "Merged Winner" }),
      ).rejects.toThrow(/transaction failed/);
    } finally {
      (db as unknown as {
        queryTransaction: (b: string, v?: Record<string, unknown>) => Promise<void>;
      }).queryTransaction = orig;
    }

    // NOTHING applied: winner unchanged, loser still present, edge not moved.
    expect((await getEntity("winner"))?.canonicalName).toBe("winner");
    expect(await getEntity("loser")).toBeDefined();
    const loserEdges = await edgesTouching("loser");
    expect(loserEdges).toHaveLength(1);
    expect(loserEdges[0]).toMatchObject({ in: "loser", out: "nodex" });
    expect(await edgesTouching("winner")).toHaveLength(0);
  }, 20000);
});
