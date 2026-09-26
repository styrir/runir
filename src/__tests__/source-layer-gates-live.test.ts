import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureSessionTurnSchema, upsertSourceTurn } from "../storage/surreal/session-turn-store.js";
import { ensureSourceTurnLinkSchema } from "../storage/surreal/source-turn-link-store.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";
import { privacyGate } from "../testing/source-layer/gates/privacy.js";
import { loadSyntheticFixtures } from "../testing/source-layer/fixtures.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `slice4${suffix}`;
const database = `slice4${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe live SQL target");
let db: SurrealClient;
let available = false;
let connected = false;
beforeAll(async () => {
  const url = process.env.RUNIR_TEST_SLOW_LANE === "1"
    ? process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000"
    : process.env.SURREAL_URL ?? "http://127.0.0.1:8000";
  if (process.env.RUNIR_TEST_SLOW_LANE === "1") {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    if (!health?.ok) throw new Error("slow lane SurrealDB unreachable");
  }
  db = new SurrealClient({ url, username: "root", password: "root", namespace, database });
  try { await db.query("INFO FOR DB;"); connected = true; }
  catch { if (process.env.RUNIR_TEST_SLOW_LANE === "1") throw new Error("slow lane SurrealDB unreachable"); }
  available = connected;
});
afterAll(async () => { if (connected) await db.query(`REMOVE NAMESPACE ${namespace};`); await db?.close().catch(() => undefined); });

it("scans live synthetic source rows without values in result", async (ctx) => {
  if (!available) return ctx.skip();
  await ensureSessionTurnSchema(db);
  await ensureSourceTurnLinkSchema(db);
  const { canaries } = await loadSyntheticFixtures();
  const turn = prepareSourceTurn({ userId: "A", client: "claude", sessionId: "s", sessionEpoch: "e",
    turnIndex: 0, role: "user", content: canaries.safe.join("\n"), occurredAt: "2026-01-01T00:00:00Z", scope: "user" }, "synthetic-key");
  await upsertSourceTurn(db, turn);
  await db.query("CREATE semiote:fact SET user_id = 'A', scope = 'user', payload = { l2: 'Synthetic fact' };");
  const result = await privacyGate(db, canaries, { recallJson: {}, logs: "synthetic log", vaultTexts: [] });
  expect(result.status).toBe("pass");
  expect(result.counts).toMatchObject({ turn: 1, chunk: 1, fact: 1, rawSourcePresent: 0, secretHits: 0 });
  expect(JSON.stringify(result).includes(canaries.safe[0])).toBe(false);
});
