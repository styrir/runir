import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureSessionTurnSchema, upsertSourceTurn } from "../storage/surreal/session-turn-store.js";
import { ensureSourceTurnLinkSchema } from "../storage/surreal/source-turn-link-store.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";
import { runNightlyEntityRepair } from "../lifecycle/entity-repair/nightly-entity-repair.js";

const mocks = vi.hoisted(() => ({
  extractEntities: vi.fn(),
  promoteSessionEntities: vi.fn(),
}));
vi.mock("../entities/entity-store", () => ({
  findEntitiesByNames: vi.fn().mockResolvedValue([]),
  findEntitiesByAliases: vi.fn().mockResolvedValue([]),
}));
vi.mock("../entities/entity-extractor", () => ({ extractEntities: mocks.extractEntities }));
vi.mock("../lifecycle/semion/entity-consolidation", () => ({ promoteSessionEntities: mocks.promoteSessionEntities }));

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `runir277repair${suffix}`;
const database = `repair${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe live SQL target");
let db: SurrealClient;
let connected = false;

beforeAll(async () => {
  const slow = process.env.RUNIR_TEST_SLOW_LANE === "1";
  const url = slow
    ? process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000"
    : process.env.SURREAL_URL ?? "http://127.0.0.1:8000";
  if (slow) {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    if (!health?.ok) throw new Error("slow lane SurrealDB unreachable");
  }
  db = new SurrealClient({ url, username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root", namespace, database });
  try { await db.query("INFO FOR DB;"); connected = true; }
  catch { if (slow) throw new Error("slow lane SurrealDB unreachable"); }
});

afterAll(async () => {
  if (connected) await db.query(`REMOVE NAMESPACE ${namespace};`);
  await db?.close().catch(() => undefined);
});

it("runs nightly repair through the live ordered chunk query", async (ctx) => {
  if (!connected) return ctx.skip();
  await ensureSessionTurnSchema(db);
  await ensureSourceTurnLinkSchema(db);
  await db.query("DEFINE TABLE entities SCHEMALESS;");
  const userId = "synthetic-repair-user";
  const content = `bramblefort ${"middle ".repeat(1300)}final-chunk`;
  const turn = prepareSourceTurn({ userId, client: "pi", sessionId: "synthetic-session",
    sessionEpoch: "epoch", turnKey: "turn", turnIndex: 0, role: "user", content,
    occurredAt: new Date().toISOString(), scope: "user" }, "synthetic-repair-hmac-key");
  expect(await upsertSourceTurn(db, turn)).toBe("created");
  const orderedChunks = (await db.query<{ chunk_index: number; content: string }>(
    `SELECT content, chunk_index FROM session_turn_chunk WHERE user_id = $userId
      AND turn_id = $turnId ORDER BY chunk_index;`, { userId, turnId: turn.id },
  ))[0] ?? [];
  expect(orderedChunks.length).toBeGreaterThan(1);
  expect(orderedChunks.map((chunk) => chunk.chunk_index)).toEqual(orderedChunks.map((_, index) => index));
  expect(orderedChunks.map((chunk) => chunk.content).join("")).toBe(content);
  await db.query("CREATE retrieval_trace:repair SET user_id = $userId, created_at = time::now(), entity_misses = $misses;",
    { userId, misses: [{ mention: "bramblefort", normalized: "bramblefort", reason: "no_entity_match" }] });
  mocks.extractEntities.mockResolvedValue([]);
  const report = await runNightlyEntityRepair({ db, userId, apiKey: "synthetic-unused-key" });
  expect(report.items[0]?.class).toBe("reextracted");
  expect(mocks.extractEntities).toHaveBeenCalledOnce();
  expect(mocks.extractEntities.mock.calls[0]?.[0]).toEqual([{ role: "user", content: content.slice(0, 4000) }]);
});
