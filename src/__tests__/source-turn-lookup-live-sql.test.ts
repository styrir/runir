import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureSessionTurnSchema, upsertSourceTurn } from "../storage/surreal/session-turn-store.js";
import { ensureSourceTurnLinkSchema, markFactSourceLink, reconcileSourceTurnLinks } from "../storage/surreal/source-turn-link-store.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";
import { lookupLinkedTurns } from "../storage/surreal/source-turn-lookup.js";

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

afterAll(async () => {
  if (connected) await db.query(`REMOVE NAMESPACE ${namespace};`);
  await db?.close().catch(() => undefined);
});

it("reads primary and evidence-only links with tenant, session, team, project and path checks", async (ctx) => {
  if (!available) return ctx.skip();
  await ensureSessionTurnSchema(db);
  await ensureSourceTurnLinkSchema(db);
  await db.query("CREATE semiote:fact SET user_id = 'A', scope = 'session', session_id = 's1', team_id = 'T1', project_key = 'P1', path = 'src/a.ts';");
  const turn = prepareSourceTurn({ userId: "A", client: "pi", sessionId: "s1", sessionEpoch: "e1",
    turnKey: "entry1", role: "user", content: "Synthetic qualifier: only on Tuesday.",
    occurredAt: "2026-01-01T00:00:00Z", scope: "session", teamId: "T1", projectKey: "P1", path: "src/a.ts" }, "synthetic-key");
  await upsertSourceTurn(db, turn);
  await markFactSourceLink(db, "fact", "A", turn, "pending");
  await reconcileSourceTurnLinks(db, turn);
  const query = { userId: "A", scope: "session" as const, sessionId: "s1", teamId: "T1", projectKey: "P1", path: "src/a.ts", factId: "fact", maxChunks: 2 };
  await expect(lookupLinkedTurns(db, { ...query, scope: "all" })).rejects.toThrow("all-scope");
  const linked = await lookupLinkedTurns(db, query);
  expect(linked).toHaveLength(1);
  expect(linked[0]?.link).toBe("primary");
  expect(linked[0]?.chunks).toHaveLength(1);
  expect(linked[0]?.turn.session_epoch).toBe("e1");
  expect(linked[0]?.turn.identity_quality).toBe("native");
  expect(linked[0]?.turn.key_fingerprint).toBe(turn.keyFingerprint);
  for (const change of [{ userId: "B" }, { scope: "user" }, { sessionId: "s2" }, { teamId: "T2" }, { projectKey: "P2" }, { path: "src/b.ts" }] as const)
    expect(await lookupLinkedTurns(db, { ...query, ...change })).toHaveLength(0);
  await db.query("CREATE semiote:evidence SET user_id = 'A', scope = 'session', session_id = 's1', team_id = 'T1', project_key = 'P1', path = 'src/a.ts';");
  await markFactSourceLink(db, "evidence", "A", turn, "pending", true);
  await reconcileSourceTurnLinks(db, turn);
  const evidence = await lookupLinkedTurns(db, { ...query, factId: "evidence" });
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.link).toBe("evidence_only");
  expect(evidence[0]?.nonEquivalent).toBe(true);
  expect(await lookupLinkedTurns(db, { ...query, factId: "evidence", scope: "user" })).toHaveLength(0);
  await db.query("CREATE semiote:forged SET user_id = 'A', scope = 'user';");
  await db.query("CREATE source_turn_evidence:forged SET user_id = 'A', fact_id = 'forged', turn_id = $turnId, scope = 'session', content_hmac = $hmac, key_fingerprint = $fingerprint, link_state = 'linked', non_equivalent = true;",
    { turnId: turn.id, hmac: turn.contentHmac, fingerprint: turn.keyFingerprint });
  expect(await lookupLinkedTurns(db, { ...query, factId: "forged" })).toHaveLength(0);
});
