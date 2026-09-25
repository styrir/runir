import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { scoreExactQaCandidate } from "../domain/memory/exact-qa.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";
import { inventory, verifyInventory } from "../../scripts/source-layer/privacy-inventory.js";
import { applyScrub, type ScrubDb } from "../../scripts/source-layer/scrub.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const identity = { namespace: `runir277scrub${suffix}`, database: `scratch${suffix}` };
const secret = "Bearer AAAAAAAAAAAAAAAAAAAAAAAA";
let db: SurrealClient;
let dir: string;
let available = false;
let connected = false;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "runir277-synthetic-"));
  const url = process.env.RUNIR_TEST_SLOW_LANE === "1"
    ? process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000"
    : process.env.SURREAL_URL ?? "http://127.0.0.1:8000";
  if (process.env.RUNIR_TEST_SLOW_LANE === "1") {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    if (!health?.ok) throw new Error("slow lane SurrealDB unreachable");
  }
  db = new SurrealClient({ url, username: process.env.SURREAL_USER ?? "root", password: process.env.SURREAL_PASS ?? "root", ...identity });
  try { await db.query("INFO FOR DB;"); connected = true; available = true; }
  catch { if (process.env.RUNIR_TEST_SLOW_LANE === "1") throw new Error("slow lane SurrealDB unreachable"); }
});

afterAll(async () => {
  if (connected) await db.query(`REMOVE NAMESPACE ${identity.namespace};`);
  await db?.close().catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Slice 3 live SQL scrub", () => {
  it("scrubs every store, keeps spans, resumes, verifies and reruns unchanged", async (ctx) => {
    if (!available) return ctx.skip();
    const vault = join(dir, "vault");
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(vault);
    await writeFile(join(vault, "synthetic.md"), `safe ${secret}`);
    await writeFile(join(vault, `unsafe-${secret}.md`), "synthetic exported text");
    const backupPath = join(dir, "backup.surql");
    const vaultBackupPath = join(dir, "vault.tar");
    await writeFile(backupPath, "synthetic backup placeholder", { mode: 0o600 });
    await writeFile(vaultBackupPath, "synthetic vault backup placeholder", { mode: 0o600 });
    await db.query(`
      DEFINE TABLE semiote SCHEMALESS;
      DEFINE FIELD payload.raw_source_text ON TABLE semiote TYPE option<string>;
      DEFINE FIELD payload.rawSpan ON TABLE semiote TYPE option<object>;
      DEFINE FIELD payload.rawSpans ON TABLE semiote TYPE option<array<object>>;
      DEFINE TABLE session_turn SCHEMALESS;
      DEFINE FIELD content ON TABLE session_turn TYPE string;
      DEFINE TABLE retrieval_trace SCHEMALESS;
      DEFINE FIELD prompt ON TABLE retrieval_trace TYPE string;
      DEFINE FIELD prepend_context ON TABLE retrieval_trace TYPE option<string>;
      DEFINE TABLE noema SCHEMALESS;
      DEFINE FIELD embedding ON TABLE noema TYPE option<array<float>>;
    `);
    await db.query(`
      CREATE type::record('semiote', 'fact1') CONTENT {
        user_id: 'synthetic', session_id: 'session', scope: 'user', created_at: time::now(),
        payload: { userId: 'synthetic', sessionId: 'session', client: 'synthetic',
          raw_source_text: 'source alice@example.com ${secret}',
          rawSpan: { text: 'The exact port is 7700. ${secret}' }, rawSpans: [{ text: 'The exact port is 7700. ${secret}' }],
          l0: 'heading ${secret}', l1: 'summary ${secret}',
          l2: 'fact alice@example.com ${secret}\\nSource:\\nraw excerpt' },
        text_norm: 'old unsafe', embedding: [0.5, 0.5]
      };
      CREATE type::record('memories', 'legacy1') CONTENT {
        payload: { l2: 'legacy ${secret}', raw_source_text: 'source ${secret}' },
        text_norm: 'legacy old', embedding: [0.5, 0.5]
      };
      CREATE type::record('semiote', 'fact2') CONTENT {
        user_id: 'synthetic', session_id: 'session', scope: 'user', created_at: time::now(),
        payload: { userId: 'synthetic', sessionId: 'session', client: 'synthetic',
          raw_source_text: 'source alice@example.com ${secret}', l2: 'second fact ${secret}' },
        text_norm: 'old', embedding: [0.5, 0.5]
      };
      CREATE type::record('semiote', 'ambiguous') CONTENT {
        user_id: 'synthetic', scope: 'user', payload: {
          userId: 'synthetic', raw_source_text: 'ambiguous ${secret}', l2: 'ambiguous fact ${secret}'
        }
      };
      CREATE type::record('noema', 'claim1') CONTENT {
        canonical_text: 'claim ${secret}', canonical: { text: 'claim ${secret}', l0: 'heading ${secret}', l1: 'summary ${secret}',
          factKey: 'fact key ${secret}', stableClaim: { subject: 'nested subject ${secret}', predicate: 'nested predicate ${secret}', value: 'nested value ${secret}' } },
        stable_claim: { subject: 'subject ${secret}', predicate: 'predicate ${secret}', value: 'value ${secret}' },
        fact_key: 'fact key ${secret}', fact_key_seed: 'fact seed ${secret}',
        canonical_norm: 'old', embedding: [0.5, 0.5],
        payload: { l2: 'claim ${secret}' }
      };
      CREATE type::record('noema', 'claimfail') CONTENT {
        canonical_text: 'claim fail ${secret}', canonical_norm: 'old', embedding: [0.5, 0.5]
      };
      CREATE type::record('rejection_log', 'reject1') CONTENT { candidate_text: 'reject ${secret}' };
      CREATE type::record('retrieval_trace', 'trace1') CONTENT {
        prompt: 'question ${secret}', answer: 'answer ${secret}', prepend_context: 'context ${secret}',
        capture_receipt: { retrievalTraceId: 'trace1', sessionId: 'session', memoryIds: ['fact1'], prompt: 'prompt ${secret}' },
        synthesis: { traceId: 'trace1', model: 'synthetic', question: 'question ${secret}' },
        rating: 'helped', feedback_received_at: time::now()
      };
      CREATE type::record('session_turn', 'old1') CONTENT { user_id: 'synthetic', content: 'turn ${secret}' };
      CREATE type::record('session_turn', 'old2') CONTENT { user_id: 'synthetic', content: 'header only ${secret}' };
      CREATE type::record('session_turn_chunk', 'old1_0') CONTENT { user_id: 'synthetic', turn_id: 'old1', content: 'chunk alice@example.com ${secret}', text_norm: 'old' };
    `);
    await expect(db.queryTransaction(`UPDATE type::record('rejection_log', 'reject1') SET candidate_text = 'temporary';
      THROW 'synthetic rollback';`)).rejects.toThrow();
    const rolledBack = (await db.query<any>("SELECT candidate_text FROM type::record('rejection_log', 'reject1');"))[0][0];
    expect(rolledBack.candidate_text).toContain(secret);
    const liveTurn = prepareSourceTurn({ userId: "synthetic", client: "synthetic", sessionId: "session", role: "user",
      content: `source alice@example.com ${secret}`, occurredAt: new Date().toISOString(), scope: "user" }, "synthetic-hmac-key");
    await db.query(`CREATE type::record('session_turn', $id) CONTENT {
      user_id: $userId, content_hmac: $hmac, key_fingerprint: $fingerprint, content: '',
      identity_quality: 'content_only', retention_class: 'unlinked', created_at: <datetime>'2020-01-01T00:00:00Z'
    };`, { id: liveTurn.id, userId: liveTurn.userId, hmac: liveTurn.contentHmac, fingerprint: liveTurn.keyFingerprint });
    await db.query("CREATE type::record('session_turn_chunk', $id) CONTENT { user_id: 'synthetic', turn_id: $turnId, chunk_index: 0, content: $content, text_norm: $norm };",
      { id: `${liveTurn.id}_0`, turnId: liveTurn.id, content: liveTurn.content, norm: liveTurn.content.toLowerCase() });
    const before = await inventory(db, identity, vault);
    expect(before.fields["semiote.payload.raw_source_text"].present).toBe(3);
    expect(before.fields["retrieval_trace.capture_receipt"].wouldChange).toBe(1);
    const options = { identity, inventoryHash: before.hash, inventoryCreatedAt: new Date().toISOString(),
      backupPath, vaultBackupPath, checkpointPath: join(dir, "checkpoint.json"), vaultRoot: vault,
      hmacKey: "synthetic-hmac-key", confirmed: true, embed: async (text: string) => {
        if (text.includes("claim fail")) throw new Error("synthetic embedding failure");
        return [0.1, 0.2];
      } };
    await expect(applyScrub(db, { ...options, inventoryHash: "0".repeat(64), checkpointPath: join(dir, "wrong-checkpoint.json") })).rejects.toThrow("inventory hash changed");
    let calls = 0;
    const interrupted: ScrubDb = { query: db.query.bind(db), queryTransaction: async (sql, vars) => {
      if (++calls === 3) throw new Error("synthetic interruption");
      return db.queryTransaction(sql, vars);
    } };
    await expect(applyScrub(interrupted, options)).rejects.toThrow();
    const after = await applyScrub(db, options);
    expect(verifyInventory(after)).toBe(true);
    const values = await db.query<any>("SELECT * FROM semiote; SELECT * FROM memories; SELECT * FROM noema; SELECT * FROM retrieval_trace; SELECT * FROM session_turn; SELECT * FROM session_turn_chunk; SELECT * FROM source_turn_evidence;");
    expect(JSON.stringify(values)).not.toContain(secret);
    expect(JSON.stringify(values)).not.toContain("raw excerpt");
    const fact = values[0].find((row: any) => String(row.id).includes("fact1"));
    expect(fact.payload.rawSpan.text).toContain("[BEARER_TOKEN_1]");
    expect(fact.payload.rawSpans).toHaveLength(1);
    expect(scoreExactQaCandidate("Which exact port is 7700?", { rawSpan: fact.payload.rawSpan, rawSpans: fact.payload.rawSpans })).toBeGreaterThan(0.5);
    expect(fact.payload.l2).toContain("alice@example.com");
    expect(fact.embedding).toEqual([0.1, 0.2]);
    expect(fact.source_turn_id).toBeTruthy();
    const fact2 = values[0].find((row: any) => String(row.id).includes("fact2"));
    expect(fact2.source_turn_id).toBe(fact.source_turn_id);
    const preserved = values[4].find((row: any) => String(row.id).includes(liveTurn.id));
    expect(preserved.identity_quality).toBe("content_only");
    expect(preserved.retention_class).toBe("unlinked");
    expect(preserved.redaction_version).toBeUndefined();
    expect(String(preserved.created_at)).toContain("2020-01-01");
    const ambiguous = values[0].find((row: any) => String(row.id).includes("ambiguous"));
    expect(ambiguous.source_turn_id).toBeTruthy();
    expect(ambiguous.source_turn_link_state).toBe("legacy");
    const failedNoema = values[2].find((row: any) => String(row.id).includes("claimfail"));
    expect(failedNoema.embedding).toBeFalsy();
    expect(values[3][0].prompt).toBe("");
    expect(values[3][0].answer).toBe("");
    expect(values[3][0].prepend_context).toBeUndefined();
    expect(values[3][0].capture_receipt).not.toHaveProperty("prompt");
    expect(values[4].filter((row: any) => row.identity_quality === "legacy_payload")).toHaveLength(1);
    expect(values[6]).toHaveLength(2);
    expect(values[6].every((row: any) => row.non_equivalent === true && row.link_state === "linked")).toBe(true);
    expect(values[4].some((row: any) => row.identity_quality === "legacy_payload")).toBe(true);
    expect(values[5].some((row: any) => String(row.content).includes("[EMAIL_1]"))).toBe(true);
    expect(await readFile(join(vault, "synthetic.md"), "utf8")).not.toContain(secret);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(vault)).some((name) => name.includes(secret))).toBe(false);
    expect(values[5].some((row: any) => row.turn_id === "old2" && String(row.content).startsWith("header only "))).toBe(true);
    const again = await applyScrub(db, options);
    expect(again.hash).toBe(after.hash);
    await db.query("UPDATE type::record('rejection_log', 'reject1') SET candidate_text = $text;", { text: secret });
    expect(verifyInventory(await inventory(db, identity, vault))).toBe(false);
    await db.query("UPDATE type::record('noema', 'claim1') SET canonical.text = $text, canonical.stableClaim.subject = $text, canonical.stableClaim.predicate = $text, canonical.stableClaim.value = $text, stable_claim.predicate = $text, stable_claim.value = $text, canonical.factKey = $text, fact_key = $text, fact_key_seed = $text, canonical_norm = $text, embedding = [0.9, 0.9];",
      { text: secret });
    await db.query("UPDATE type::record('semiote', 'fact1') SET text_norm = $text;", { text: secret });
    const planted = await inventory(db, identity, vault, options.embed);
    for (const field of ["noema.canonical.text", "noema.canonical.stableClaim.subject", "noema.canonical.stableClaim.predicate",
      "noema.canonical.stableClaim.value", "noema.stable_claim.predicate", "noema.stable_claim.value", "noema.canonical.factKey",
      "noema.fact_key", "noema.fact_key_seed", "noema.canonical_norm", "semiote.text_norm", "noema.embedding"])
      expect(planted.fields[field].wouldChange).toBeGreaterThan(0);
    expect(verifyInventory(planted)).toBe(false);
    const collision = prepareSourceTurn({ userId: "synthetic", client: "synthetic", sessionId: "session", role: "user",
      content: `collision ${secret}`, occurredAt: new Date().toISOString(), scope: "user" }, "synthetic-hmac-key");
    await db.query("CREATE type::record('semiote', 'zcollision') CONTENT { user_id: 'synthetic', session_id: 'session', payload: { client: 'synthetic', raw_source_text: $raw, l2: 'collision fact' } };",
      { raw: `collision ${secret}` });
    await db.query("CREATE type::record('session_turn', $id) CONTENT { user_id: 'synthetic', content: '', content_hmac: 'different-hmac', key_fingerprint: $fingerprint, identity_quality: 'content_only' };",
      { id: collision.id, fingerprint: collision.keyFingerprint });
    const collisionInventory = await inventory(db, identity, vault);
    await expect(applyScrub(db, { ...options, inventoryHash: collisionInventory.hash,
      checkpointPath: join(dir, "collision-checkpoint.json") })).rejects.toThrow("source turn collision");
    const stillRaw = (await db.query<any>("SELECT payload.raw_source_text AS raw FROM type::record('semiote', 'zcollision');"))[0][0];
    expect(stillRaw.raw).toContain(secret);
  });
});
