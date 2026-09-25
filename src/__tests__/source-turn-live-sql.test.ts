import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureSessionTurnSchema, upsertSourceTurn, deleteExpiredSessionTurns, SourceTurnConflictError, SourceKeyMismatchError } from "../storage/surreal/session-turn-store.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";
import { ensureSourceTurnLinkSchema, markFactSourceLink, reconcileSourceTurnLinks, unlinkFactSource, forgetSourceSession, forgetSourceUser } from "../storage/surreal/source-turn-link-store.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `runir277test${suffix}`;
const database = `slice2${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe live SQL target");
let db: SurrealClient;
let available = false;
let connected = false;

beforeAll(async () => {
  const url = process.env.RUNIR_TEST_SLOW_LANE === "1"
    ? process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000"
    : process.env.SURREAL_URL ?? "http://127.0.0.1:8000";
  if (process.env.RUNIR_TEST_SLOW_LANE === "1") {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    if (!response?.ok) throw new Error("slow lane SurrealDB unreachable");
  }
  db = new SurrealClient({ url, username: "root", password: "root", namespace, database });
  try { await db.query("INFO FOR DB;"); connected = true; }
  catch {
    if (process.env.RUNIR_TEST_SLOW_LANE === "1") throw new Error("slow lane SurrealDB unreachable");
    return;
  }
  available = true;
});

afterAll(async () => {
  if (connected) await db.query(`REMOVE NAMESPACE ${namespace};`);
  await db?.close().catch(() => undefined);
});

describe("Slice 2 retained source SurrealQL", () => {
  it("migrates old rows without copying content, enforces new keys, orders chunks and sweeps only expired unlinked rows", async (ctx) => {
    if (!available) return ctx.skip();
    await db.query("DEFINE TABLE session_turn SCHEMALESS; DEFINE INDEX idx_session_turn_unique ON session_turn COLUMNS user_id, session_id, turn_index UNIQUE;");
    await db.query("CREATE session_turn:old SET user_id = 'synthetic', session_id = 'old', turn_index = 0, role = 'user', content = 'legacy synthetic text', created_at = time::now(); CREATE session_turn:old2 SET user_id = 'synthetic', session_id = 'old', turn_index = 1, role = 'assistant', content = 'second legacy synthetic text', created_at = time::now();");
    const beforeIndexes = (await db.query<any>("INFO FOR TABLE session_turn;"))[0]?.[0]?.indexes;
    expect(beforeIndexes).toHaveProperty("idx_session_turn_unique");
    await ensureSessionTurnSchema(db);
    await ensureSessionTurnSchema(db);
    const afterIndexes = (await db.query<any>("INFO FOR TABLE session_turn;"))[0]?.[0]?.indexes;
    expect(afterIndexes).toHaveProperty("idx_session_turn_key");
    expect(afterIndexes).not.toHaveProperty("idx_session_turn_unique");
    await ensureSourceTurnLinkSchema(db);
    const old = await db.query<any>("SELECT content FROM session_turn:old; SELECT * FROM session_turn_chunk;");
    expect(old[0]?.[0]?.content).toBe("legacy synthetic text");
    expect((await db.query<any>("SELECT content FROM session_turn:old2;"))[0]?.[0]?.content).toBe("second legacy synthetic text");
    expect(old[1]).toEqual([]);
    const turn = prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "s", sessionEpoch: "e", turnKey: "branch/a",
      turnIndex: 2, role: "user", content: "x".repeat(9_000), occurredAt: "2024-01-01T00:00:00.000Z", scope: "user",
    }, "synthetic-hmac-key");
    expect(await upsertSourceTurn(db, turn)).toBe("created");
    expect(await upsertSourceTurn(db, turn)).toBe("seen");
    expect((await db.query<any>("SELECT content FROM type::record('session_turn', $id);", { id: turn.id }))[0]?.[0]?.content).toBe("");
    const conflict = prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "s", sessionEpoch: "e", turnKey: "branch/a",
      turnIndex: 2, role: "user", content: "synthetic changed content", occurredAt: "2024-01-01T00:00:00.000Z", scope: "user",
    }, "synthetic-hmac-key");
    await expect(upsertSourceTurn(db, conflict)).rejects.toBeInstanceOf(SourceTurnConflictError);
    const fork = prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "s", sessionEpoch: "e", turnKey: "branch/b",
      turnIndex: 2, role: "assistant", content: "synthetic fork", occurredAt: "2024-01-01T00:00:00.000Z", scope: "user",
    }, "synthetic-hmac-key");
    expect(await upsertSourceTurn(db, fork)).toBe("created");
    const legacyUser = prepareSourceTurn({
      userId: "synthetic", client: "grok", sessionId: "legacy", role: "user",
      content: "synthetic legacy", occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-hmac-key");
    const legacyAssistant = prepareSourceTurn({
      userId: "synthetic", client: "grok", sessionId: "legacy", role: "assistant",
      content: "synthetic legacy", occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-hmac-key");
    expect(await upsertSourceTurn(db, legacyUser)).toBe("created");
    expect(await upsertSourceTurn(db, legacyAssistant)).toBe("created");
    expect(await upsertSourceTurn(db, legacyUser)).toBe("seen");
    const rotated = prepareSourceTurn({
      userId: "synthetic", client: "grok", sessionId: "rotated", role: "user",
      content: "synthetic legacy", occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "different-synthetic-hmac-key");
    await expect(upsertSourceTurn(db, rotated)).rejects.toBeInstanceOf(SourceKeyMismatchError);
    expect((await db.query<any>("SELECT * FROM type::record('session_turn', $id);", { id: rotated.id }))[0]).toHaveLength(0);
    expect((await db.query<any>("SELECT key_fingerprint FROM type::record('session_turn', $id);", { id: legacyUser.id }))[0]?.[0]?.key_fingerprint)
      .toBe(legacyUser.keyFingerprint);
    const rows = await db.query<any>("SELECT * FROM session_turn_chunk WHERE user_id = $userId AND turn_id = $turnId ORDER BY chunk_index;", {
      userId: "synthetic", turnId: turn.id,
    });
    expect(rows[0]?.length).toBeGreaterThan(1);
    expect((rows[0] as Array<{ content: string }>).map((r) => r.content).join("")).toBe(turn.content);
    const repair = await db.query<any>(
      `SELECT turn_id FROM session_turn_chunk WHERE user_id = $userId
       AND string::contains(text_norm, $mention) LIMIT 12;
       SELECT session_id, turn_index FROM type::record('session_turn', $turnId)
       WHERE user_id = $userId AND occurred_at >= <datetime>$sinceIso;`,
      { userId: "synthetic", mention: "xxx", turnId: turn.id, sinceIso: "2023-01-01T00:00:00Z" },
    );
    expect(repair[0]?.length).toBeGreaterThan(0);
    expect(repair[1]?.[0]?.session_id).toBe("s");
    await db.query("CREATE semiote:fact SET user_id = 'synthetic', scope = 'user';");
    await expect(markFactSourceLink(db, "fact", "synthetic", rotated, "pending"))
      .rejects.toBeInstanceOf(SourceKeyMismatchError);
    expect((await db.query<any>("SELECT source_turn_id FROM semiote:fact;"))[0]?.[0]?.source_turn_id).toBeUndefined();
    await markFactSourceLink(db, "fact", "synthetic", { ...turn, contentHmac: "synthetic-wrong-hmac" }, "pending");
    await reconcileSourceTurnLinks(db, turn);
    expect((await db.query<any>("SELECT source_turn_link_state FROM semiote:fact;"))[0]?.[0]?.source_turn_link_state).toBe("pending");
    await markFactSourceLink(db, "fact", "synthetic", turn, "pending");
    await reconcileSourceTurnLinks(db, turn);
    const linked = await db.query<any>("SELECT source_turn_link_state FROM semiote:fact; SELECT retention_class FROM type::record('session_turn', $id);", { id: turn.id });
    expect(linked[0]?.[0]?.source_turn_link_state).toBe("linked");
    expect(linked[1]?.[0]?.retention_class).toBe("linked");
    expect((await db.query<any>("SELECT source_turn_key_fingerprint FROM semiote:fact;"))[0]?.[0]?.source_turn_key_fingerprint)
      .toBe(turn.keyFingerprint);
    await db.query("CREATE semiote:skipped SET user_id = 'synthetic', scope = 'user';");
    await markFactSourceLink(db, "semiote:skipped", "synthetic", turn, "pending", true);
    await reconcileSourceTurnLinks(db, turn);
    expect((await db.query<any>("SELECT non_equivalent, link_state FROM source_turn_evidence WHERE user_id = 'synthetic';"))[0]?.[0])
      .toMatchObject({ non_equivalent: true, link_state: "linked" });
    await deleteExpiredSessionTurns(db, 30);
    expect((await db.query<any>("SELECT * FROM type::record('session_turn', $id);", { id: turn.id }))[0]).toHaveLength(1);
    await unlinkFactSource(db, "synthetic", "semiote:skipped", "2026-09-25T00:00:00.000Z");
    expect((await db.query<any>("SELECT retention_class FROM type::record('session_turn', $id);", { id: turn.id }))[0]?.[0]?.retention_class).toBe("linked");
    await db.query("CREATE semiote:interleaved SET user_id = 'synthetic', scope = 'user';");
    await markFactSourceLink(db, "interleaved", "synthetic", turn, "pending");
    const interleavedDb = new Proxy(db, { get(target, property) {
      if (property !== "query") return Reflect.get(target, property, target);
      return async (sql: string, vars?: Record<string, unknown>) => {
        if (sql.includes("DELETE source_turn_evidence") && sql.includes("$affectedTurnIds")) {
          await reconcileSourceTurnLinks(db, turn);
        }
        return db.query(sql, vars);
      };
    } }) as SurrealClient;
    await unlinkFactSource(interleavedDb, "synthetic", "fact", "2026-09-25T00:00:00.000Z");
    expect((await db.query<any>("SELECT retention_class FROM type::record('session_turn', $id);", { id: turn.id }))[0]?.[0]?.retention_class).toBe("linked");
    await unlinkFactSource(db, "synthetic", "interleaved", "2026-09-25T00:00:00.000Z");
    const unlinked = await db.query<any>("SELECT retention_class, retain_until FROM type::record('session_turn', $id);", { id: turn.id });
    expect(unlinked[0]?.[0]?.retention_class).toBe("unlinked");
    expect(String(unlinked[0]?.[0]?.retain_until)).toContain("2027-09-25");
    await deleteExpiredSessionTurns(db, 30);
    expect((await db.query<any>("SELECT * FROM type::record('session_turn', $id);", { id: turn.id }))[0]).toHaveLength(1);
    await db.query("UPDATE type::record('session_turn', $id) SET retention_class = 'unlinked', retain_until = d'2020-01-01T00:00:00Z';", { id: turn.id });
    await deleteExpiredSessionTurns(db, 30);
    expect((await db.query<any>("SELECT * FROM type::record('session_turn', $id);", { id: turn.id }))[0]).toHaveLength(0);
    expect((await db.query<any>("SELECT * FROM session_turn_chunk WHERE turn_id = $id;", { id: turn.id }))[0]).toHaveLength(0);
    const erased: string[][] = [];
    const tombstone = {
      forgetSession: async () => undefined,
      forgetUser: async () => undefined,
      forget: async (ids: string[]) => { erased.push(ids); },
    };
    await forgetSourceSession(db, "synthetic", "legacy", tombstone);
    expect(erased[0]).toEqual(expect.arrayContaining([legacyUser.id, legacyAssistant.id]));
    expect((await db.query<any>("SELECT * FROM session_turn WHERE user_id = 'synthetic' AND session_id = 'legacy';"))[0]).toHaveLength(0);
    await forgetSourceUser(db, "synthetic", tombstone);
    expect(erased[1]).toContain("old");
    expect((await db.query<any>("SELECT * FROM session_turn_chunk WHERE user_id = 'synthetic';"))[0]).toHaveLength(0);
  });
});
