import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensurePhase2Schema } from "../storage/surreal/phase2-store.js";
import { ensureSessionTurnSchema } from "../storage/surreal/session-turn-store.js";
import { ensureSourceTurnLinkSchema } from "../storage/surreal/source-turn-link-store.js";
import { scoreExactQaCandidate } from "../domain/memory/exact-qa.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";
import { inventory, verifyInventory } from "../../scripts/source-layer/privacy-inventory.js";
import { applyScrub, type ScrubDb } from "../../scripts/source-layer/scrub.js";
import { ownedVaultFiles } from "../../scripts/source-layer/vault-ownership.js";

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
  it("migrates an unproven source turn with datetime retention under production indexes, then replays unchanged", async (ctx) => {
    if (!available) return ctx.skip();
    const database = `schema${suffix}`;
    const indexed = new SurrealClient({ url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
      username: process.env.SURREAL_USER ?? "root", password: process.env.SURREAL_PASS ?? "root",
      namespace: identity.namespace, database });
    const target = { namespace: identity.namespace, database };
    const backupPath = join(dir, "indexed-backup.surql");
    await writeFile(backupPath, "synthetic", { mode: 0o600 });
    try {
      await ensurePhase2Schema(indexed);
      await ensureSessionTurnSchema(indexed);
      await ensureSourceTurnLinkSchema(indexed);
      await indexed.query(`CREATE type::record('semiote', 'indexed') CONTENT {
        user_id: $userId, session_id: 'synthetic-session', created_at: time::now(), updated_at: time::now(),
        payload: { l0: 'synthetic heading', l1: 'synthetic summary', l2: 'synthetic fact',
          raw_source_text: 'synthetic source', rawSpan: { text: 'synthetic source' } },
        embedding: $embedding, text_norm: 'synthetic fact'
      };`, { userId: "u".repeat(67), embedding: Array(768).fill(0.01) });
      // The pre-fix bound ISO string reproduces the real statement-3 abort.
      await expect(indexed.queryTransaction(`
        UPDATE type::record('semiote', 'indexed') SET source_turn_link_state = 'temporary';
        IF false { UPDATE type::record('semiote', 'indexed') SET text_norm = 'temporary'; };
        IF true { CREATE type::record('session_turn', 'bad-retention') CONTENT {
          user_id: $userId, session_id: 'synthetic-session', role: 'user', content: '',
          created_at: time::now(), retain_until: $retainUntil
        }; };`, { userId: "u".repeat(67), retainUntil: new Date(Date.now() + 365 * 86400_000).toISOString() }))
        .rejects.toMatchObject({ statementIndex: 3 });
      expect((await indexed.query("SELECT * FROM type::record('session_turn', 'bad-retention');"))[0]).toHaveLength(0);
      const before = await inventory(indexed, target);
      const opts = { identity: target, inventoryHash: before.hash, inventoryCreatedAt: new Date().toISOString(),
        backupPath, checkpointPath: join(dir, "indexed-checkpoint.json"), hmacKey: "synthetic-hmac-key",
        confirmed: true, embed: async () => Array(768).fill(0.01) };
      const after = await applyScrub(indexed, opts);
      expect(verifyInventory(after)).toBe(true);
      const turn = (await indexed.query<{ retention_class: string; retain_until?: unknown }>(
        "SELECT retention_class, retain_until FROM session_turn;"))[0][0];
      expect(turn.retention_class).toBe("unlinked");
      expect(turn.retain_until).toBeDefined();
      const replay = await applyScrub(indexed, { ...opts, inventoryHash: after.hash,
        inventoryCreatedAt: new Date().toISOString(), checkpointPath: join(dir, "indexed-replay.json") });
      expect(replay.hash).toBe(after.hash);
    } finally {
      await indexed.query(`REMOVE DATABASE ${database};`).catch(() => undefined);
      await indexed.close();
    }
  });

  it("reports the root statement of a synthetic failed transaction", async (ctx) => {
    if (!available) return ctx.skip();
    await db.query("DEFINE TABLE scrub_tx_probe SCHEMALESS; DEFINE FIELD required ON TABLE scrub_tx_probe TYPE string; CREATE type::record('scrub_tx_probe', 'row') SET required = 'synthetic';");
    try {
      await expect(db.queryTransaction(`UPDATE type::record('scrub_tx_probe', 'row') SET required = 'temporary';
        UPDATE type::record('scrub_tx_probe', 'row') SET required = NONE;`)).rejects.toMatchObject({ statementIndex: 2 });
      const row = (await db.query<{ required: string }>("SELECT required FROM type::record('scrub_tx_probe', 'row');"))[0][0];
      expect(row.required).toBe("synthetic");
    } finally { await db.query("REMOVE TABLE scrub_tx_probe;"); }
  });

  it("resolves signed Markdown IDs through record point lookups", async (ctx) => {
    if (!available) return ctx.skip();
    const { mkdir } = await import("node:fs/promises");
    const vault = join(dir, "point-lookup-vault");
    await mkdir(vault);
    const frontmatter = (id: string) => `---\nid: ${id}\ncategory: profile\ntier: durable\ntags: []\nconfidence: 1\nscope: user\ncreatedAt: now\nupdatedAt: now\nactive: true\nwriteSource: capture\n---\nsynthetic`;
    await writeFile(join(vault, "owned.md"), frontmatter("vault-lookup"));
    await writeFile(join(vault, "forged.md"), frontmatter("missing-lookup"));
    await db.query("CREATE type::record('semiote', 'vault-lookup') CONTENT { user_id: 'synthetic' };");
    try {
      const result = await ownedVaultFiles(db, vault);
      expect(result.files).toEqual([join(vault, "owned.md")]);
      expect(result.ownerFilesSkipped).toBe(1);
    } finally { await db.query("REMOVE TABLE semiote;"); }
  });

  it("preserves derived values for source-only rows and removes unredactable fields and names", async (ctx) => {
    if (!available) return ctx.skip();
    const { mkdir, readFile, stat } = await import("node:fs/promises");
    const vault = join(dir, "correctness-vault");
    await mkdir(vault);
    const unsafe = "Authorization: Basic AAAAAAAAAAAAAAAA";
    const originalName = `${unsafe}.md`;
    const owned = join(vault, originalName);
    const owner = join(vault, "owner.md");
    const frontmatter = `---\nid: ownedfix6\ncategory: profile\ntier: durable\ntags: []\nconfidence: 1\nscope: user\ncreatedAt: now\nupdatedAt: now\nactive: true\nwriteSource: capture\n---\nsynthetic`;
    await writeFile(owned, frontmatter);
    await writeFile(owner, unsafe);
    const ownerBefore = { bytes: await readFile(owner), mtime: (await stat(owner)).mtimeMs };
    const backupPath = join(dir, "fix6-backup.surql");
    const vaultBackupPath = join(dir, "fix6-vault.tar");
    const checkpointPath = join(dir, "fix6-checkpoint.json");
    await writeFile(backupPath, "synthetic", { mode: 0o600 });
    await writeFile(vaultBackupPath, "synthetic", { mode: 0o600 });
    await db.query(`
      DEFINE TABLE session_turn SCHEMALESS;
      DEFINE TABLE session_turn_chunk SCHEMALESS;
      DEFINE TABLE noema SCHEMALESS;
      CREATE type::record('semiote', 'rawonlyfix6') CONTENT { user_id: 'synthetic', session_id: 's',
        payload: { client: 'synthetic', raw_source_text: 'ordinary source', l2: 'clean fact' }, text_norm: 'original norm', embedding: [0.77] };
      CREATE type::record('semiote', 'excerptfix6') CONTENT { payload: { l2: 'useful fact\\nSource:\\nprivate excerpt' }, text_norm: 'old norm', embedding: [0.55] };
      CREATE type::record('semiote', 'spanfix6') CONTENT { payload: { l2: 'other clean fact', rawSpan: { text: '${unsafe}' } },
        text_norm: 'other original norm', embedding: [0.66] };
      CREATE type::record('semiote', 'rawfailfix6') CONTENT { user_id: 'synthetic', payload: { l2: 'still clean', raw_source_text: '${unsafe}' },
        text_norm: 'kept norm', embedding: [0.33] };
      CREATE type::record('semiote', 'ownedfix6') CONTENT { payload: { l2: 'synthetic' }, text_norm: 'synthetic', embedding: [0.44] };
      CREATE type::record('noema', 'canonicalfix6') CONTENT { canonical_text: 'clean canonical',
        canonical: { l0: '${secret}' }, canonical_norm: 'kept canonical norm', embedding: [0.88] };
    `);
    try {
      const before = await inventory(db, identity, vault);
      expect(before.fields["semiote.text_norm"].wouldChange).toBe(1);
      expect(before.fields["semiote.embedding"].wouldChange).toBe(1);
      expect(before.fields["vault.filename"].assertionFailures).toBe(1);
      let embedCalls = 0;
      const after = await applyScrub(db, { identity, inventoryHash: before.hash, inventoryCreatedAt: new Date().toISOString(),
        backupPath, vaultBackupPath, checkpointPath, vaultRoot: vault, hmacKey: "synthetic-hmac-key", confirmed: true,
        embed: async () => [++embedCalls, 0.25] });
      expect(verifyInventory(after)).toBe(true);
      expect(embedCalls).toBe(1);
      const rows = (await db.query<any>("SELECT * FROM semiote;"))[0];
      const find = (id: string) => rows.find((row: any) => String(row.id).includes(id));
      expect(find("rawonlyfix6")).toMatchObject({ text_norm: "original norm", embedding: [0.77] });
      expect(find("rawonlyfix6").payload.raw_source_text).toBeUndefined();
      expect(find("excerptfix6")).toMatchObject({ text_norm: "useful fact", embedding: [1, 0.25] });
      expect(find("spanfix6").payload.rawSpan).toBeUndefined();
      expect(find("rawfailfix6")).toMatchObject({ text_norm: "kept norm", embedding: [0.33] });
      expect(find("rawfailfix6").payload.raw_source_text).toBeUndefined();
      const noema = (await db.query<any>("SELECT * FROM type::record('noema', 'canonicalfix6');"))[0][0];
      expect(noema).toMatchObject({ canonical_norm: "kept canonical norm", embedding: [0.88] });
      const safeName = `runir-redacted-${createHash("sha256").update(originalName).digest("hex").slice(0, 12)}.md`;
      expect(await readFile(join(vault, safeName), "utf8")).toBe(frontmatter);
      const checkpoint = await readFile(checkpointPath, "utf8");
      expect(checkpoint).not.toContain(originalName);
      expect(checkpoint).toContain(createHash("sha256").update(originalName).digest("hex"));
      expect(JSON.parse(checkpoint).counts).toMatchObject({ semiote: { rows_reembedded: 1, removed_unredactable: 2 },
        vault: { files_renamed: 1, removed_unredactable: 1 } });
      expect(await readFile(owner)).toEqual(ownerBefore.bytes);
      expect((await stat(owner)).mtimeMs).toBe(ownerBefore.mtime);
    } finally { await db.query("REMOVE TABLE semiote; REMOVE TABLE noema; REMOVE TABLE session_turn; REMOVE TABLE session_turn_chunk;"); }
  });

  it("scrubs every store, keeps spans, resumes, verifies and reruns unchanged", async (ctx) => {
    if (!available) return ctx.skip();
    const vault = join(dir, "vault");
    const { mkdir, readFile, stat } = await import("node:fs/promises");
    await mkdir(vault);
    await mkdir(join(vault, "02 Areas"));
    await mkdir(join(vault, "99 Meta", "02 Areas", "profile"), { recursive: true });
    const personal = join(vault, "02 Areas", "personal.md");
    const forged = join(vault, "02 Areas", "forged.md");
    const exported = join(vault, "02 Areas", "exported.md");
    const meta = join(vault, "99 Meta", "02 Areas", "profile", "items.json");
    const personalMeta = join(vault, "99 Meta", "02 Areas", "items.json");
    const frontmatter = (id: string) => `---\nid: ${id}\ncategory: profile\ntier: durable\ntags: []\nconfidence: 0.9\nscope: user\ncreatedAt: 2026-09-25\nupdatedAt: 2026-09-25\nactive: true\nwriteSource: capture\n---\n`;
    await writeFile(personal, `Personal note ${secret}`);
    await writeFile(forged, `${frontmatter("not-in-db")}Forged ${secret}`);
    await writeFile(exported, `${frontmatter("fact1")}Exported ${secret}`);
    await writeFile(meta, JSON.stringify({ text: secret }));
    await writeFile(personalMeta, JSON.stringify({ personal: secret }));
    const personalBefore = { bytes: await readFile(personal), mtime: (await stat(personal)).mtimeMs };
    const forgedBefore = { bytes: await readFile(forged), mtime: (await stat(forged)).mtimeMs };
    const personalMetaBefore = { bytes: await readFile(personalMeta), mtime: (await stat(personalMeta)).mtimeMs };
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
    expect(before.rows.vault_files).toBe(2);
    expect(before.rows.owner_files_skipped).toBe(3);
    expect(before.fields["vault.file"].wouldChange).toBe(2);
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
    expect(await readFile(exported, "utf8")).not.toContain(secret);
    expect(await readFile(meta, "utf8")).not.toContain(secret);
    expect(await readFile(personal)).toEqual(personalBefore.bytes);
    expect((await stat(personal)).mtimeMs).toBe(personalBefore.mtime);
    expect(await readFile(forged)).toEqual(forgedBefore.bytes);
    expect((await stat(forged)).mtimeMs).toBe(forgedBefore.mtime);
    expect(await readFile(personalMeta)).toEqual(personalMetaBefore.bytes);
    expect((await stat(personalMeta)).mtimeMs).toBe(personalMetaBefore.mtime);
    expect((await inventory(db, identity, vault)).rows.owner_files_skipped).toBe(3);
    expect(values[5].some((row: any) => row.turn_id === "old2" && String(row.content).startsWith("header only "))).toBe(true);
    const again = await applyScrub(db, options);
    expect(again.hash).toBe(after.hash);
    // A fresh checkpoint must verify already-migrated rows without issuing
    // no-op transactions or changing the inventory hash.
    let replayTransactions = 0;
    const replayDb: ScrubDb = { query: db.query.bind(db), queryTransaction: async (sql, vars) => {
      replayTransactions++;
      return db.queryTransaction(sql, vars);
    } };
    const replay = await applyScrub(replayDb, { ...options, inventoryHash: again.hash,
      inventoryCreatedAt: new Date().toISOString(), checkpointPath: join(dir, "replay-checkpoint.json") });
    expect(replay.hash).toBe(again.hash);
    expect(replayTransactions).toBe(0);
    const replayCheckpoint = JSON.parse(await readFile(join(dir, "replay-checkpoint.json"), "utf8"));
    expect(Object.values(replayCheckpoint.counts).every((counts: any) => counts.rows_rewritten === 0 && counts.rows_reembedded === 0)).toBe(true);
    await db.query("UPDATE type::record('rejection_log', 'reject1') SET candidate_text = $text;", { text: secret });
    expect(verifyInventory(await inventory(db, identity, vault))).toBe(false);
    await db.query("UPDATE type::record('noema', 'claim1') SET canonical.text = $text, canonical.stableClaim.subject = $text, canonical.stableClaim.predicate = $text, canonical.stableClaim.value = $text, stable_claim.predicate = $text, stable_claim.value = $text, canonical.factKey = $text, fact_key = $text, fact_key_seed = $text, canonical_norm = $text, embedding = [0.9, 0.9];",
      { text: secret });
    await db.query("UPDATE type::record('semiote', 'fact1') SET text_norm = $text;", { text: secret });
    const planted = await inventory(db, identity, vault, options.embed);
    for (const field of ["noema.canonical.text", "noema.canonical.stableClaim.subject", "noema.canonical.stableClaim.predicate",
      "noema.canonical.stableClaim.value", "noema.stable_claim.predicate", "noema.stable_claim.value", "noema.canonical.factKey",
      "noema.fact_key", "noema.fact_key_seed"])
      expect(planted.fields[field].wouldChange).toBeGreaterThan(0);
    for (const field of ["noema.canonical_norm", "semiote.text_norm", "noema.embedding"])
      expect(planted.fields[field].wouldChange).toBe(0);
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
