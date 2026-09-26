import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEmbeddingProvider } from "../../src/shared/config.js";
import { RedactionAssertionError, SOURCE_REDACTION_VERSION, redactFactText, redactSourceTurn } from "../../src/shared/source-redaction.js";
import { chunkSourceTurn, prepareSourceTurn, sourceKeyFingerprint } from "../../src/capture/source-turn-identity.js";
import type { SurrealClient } from "../../src/storage/surreal/surreal-store.js";
import { embeddingForStore } from "../../src/storage/surreal/memory-crud-store.js";
import { FIELDS, TABLES, fieldValue, inspectField, inventory, readPage, scrubFieldValue, verifyInventory, type Inventory, type PrivacyRow, type PrivacyTable } from "./privacy-inventory.js";
import { ownedVaultFiles } from "./vault-ownership.js";

export type ScrubDb = Pick<SurrealClient, "query" | "queryTransaction">;
export type Embed = (text: string) => Promise<number[]>;
const fixedApplyErrors = new Set([
  "unknown command", "SURREAL_NS and SURREAL_DB required", "--vault is required",
  "apply requires --backup", "apply requires --vault-backup", "inventory target mismatch",
  "apply requires --confirm", "apply requires an inventory hash", "inventory is not fresh",
  "backup and checkpoint paths required", "vault backup required", "source HMAC key required",
  "backup must be outside repository and .styrir", "backup must be a private file (mode 0600)",
  "batch size must be 1..100", "source HMAC key fingerprint mismatch", "inventory hash changed",
  "checkpoint identity/version mismatch", "post-apply privacy verification failed",
  "source turn collision", "legacy payload parse failed", "legacy payload shape invalid",
  "legacy source user missing", "legacy payload parse failure",
  "vault has no Rúnir-owned files; --allow-empty-vault required",
  "existing turn chunks must verify clean before header removal",
  "batch verification row count mismatch",
  "batch verification source remains", "batch verification old turn content remains",
  "batch verification redaction failed", "batch verification norm mismatch",
  "batch verification embedding mismatch", "batch verification source link mismatch",
  "vault file is not UTF-8", "redacted vault filename collision", "vault read-back verification failed",
]);

export function formatScrubFailure(error: unknown): string {
  if (error instanceof Error && fixedApplyErrors.has(error.message)) return error.message;
  let root = error;
  while (root instanceof Error && root.cause instanceof Error) root = root.cause;
  const name = root instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(root.name) ? root.name : "Error";
  const message = root instanceof Error ? root.message : String(root);
  const schemaNames = message
    .replace(/\bfield [`'"]([A-Za-z_][A-Za-z0-9_.]*)[`'"] of [`'"]([A-Za-z_][A-Za-z0-9_]*)[`'"]/g,
      "field $1 of $2")
    .replace(/\bExpected [`'"]([A-Za-z_][A-Za-z0-9_<>|]*)[`'"]/g, "Expected $1");
  const masked = schemaNames
    .replace(/(?<![A-Za-z0-9])'[^']*'|"[^"]*"|`[^`]*`/gs, "[quoted]")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*:(?:⟨[^⟩]*⟩|`[^`]*`|[^\s,;)}\]]+)/g, "[record]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{16,}\b/g, "[hex]")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "[value]")
    .replace(/[\r\n]+/g, " ");
  const index = error instanceof Error && "statementIndex" in error && typeof error.statementIndex === "number" && Number.isInteger(error.statementIndex)
    ? ` statement index ${error.statementIndex}` : "";
  return `${name}${index}: ${masked.slice(0, 500)}`;
}
export type ScrubOptions = {
  identity: { namespace: string; database: string };
  inventoryHash: string;
  inventoryCreatedAt: string;
  backupPath: string;
  vaultBackupPath?: string;
  checkpointPath: string;
  vaultRoot?: string;
  allowEmptyVault?: boolean;
  hmacKey: string;
  embed?: Embed;
  batchSize?: number;
  confirmed: boolean;
};
type TableCounts = { rows_rewritten: number; rows_reembedded: number; removed_unredactable: number; files_renamed: number };
type Checkpoint = { version: number; namespace: string; database: string; inventoryHash: string; tableIndex: number; cursor: string; vaultDone: boolean;
  counts?: Record<string, TableCounts>; renamed?: Array<{ oldHash: string; newHash: string }> };
const emptyCounts = (): TableCounts => ({ rows_rewritten: 0, rows_reembedded: 0, removed_unredactable: 0, files_renamed: 0 });
const NORM = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const idOf = (row: PrivacyRow, table: PrivacyTable): string => String((row.id as { id?: unknown })?.id ?? row.id).replace(new RegExp(`^${table}:`), "");

export function validateApplyOptions(options: ScrubOptions, now = Date.now()): void {
  if (!options.confirmed) throw new Error("apply requires --confirm");
  if (!/^[a-f0-9]{64}$/.test(options.inventoryHash)) throw new Error("apply requires an inventory hash");
  if (!Number.isFinite(Date.parse(options.inventoryCreatedAt)) || now - Date.parse(options.inventoryCreatedAt) > 60 * 60 * 1000 || Date.parse(options.inventoryCreatedAt) > now) throw new Error("inventory is not fresh");
  if (!options.backupPath || !options.checkpointPath) throw new Error("backup and checkpoint paths required");
  if (options.vaultRoot && !options.vaultBackupPath) throw new Error("vault backup required");
  if (!options.hmacKey) throw new Error("source HMAC key required");
  if (!Number.isInteger(options.batchSize ?? 100) || (options.batchSize ?? 100) < 1 || (options.batchSize ?? 100) > 100) throw new Error("batch size must be 1..100");
}

export async function validateBackup(path: string): Promise<void> {
  const target = await realpath(path);
  const repo = await realpath(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const inside = (root: string) => { const rel = relative(root, target); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../") && !rel.startsWith("..\\") && !rel.startsWith("/")); };
  if (inside(repo) || inside(join(repo, ".styrir"))) throw new Error("backup must be outside repository and .styrir");
  const info = await stat(target);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("backup must be a private file (mode 0600)");
}

async function saveCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.next`, JSON.stringify(checkpoint), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(`${path}.next`, path);
}

async function loadCheckpoint(path: string): Promise<Checkpoint | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as Checkpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function factPayload(row: PrivacyRow, removed: () => void): PrivacyRow {
  let payload = row.payload;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); }
    catch { throw new Error("legacy payload parse failed"); }
  }
  if (payload == null) payload = {};
  if (typeof payload !== "object" || Array.isArray(payload)) throw new Error("legacy payload shape invalid");
  return scrubFieldValue("semiote", "payload", payload, removed) as PrivacyRow;
}

function sourceMigration(row: PrivacyRow, hmacKey: string) {
  const raw = row.payload?.raw_source_text;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const userId = String(row.user_id ?? row.payload?.userId ?? "");
  if (!userId) throw new Error("legacy source user missing");
  const client = String(row.payload?.client ?? "legacy_payload");
  const sessionId = String(row.session_id ?? row.payload?.sessionId ?? "legacy_payload");
  const sourceScope = row.scope ?? row.payload?.scope;
  const scope = ["user", "session", "project", "team"].includes(sourceScope) ? sourceScope : "user";
  const created = row.created_at ?? row.payload?.createdAt;
  const createdProven = Boolean(created && !Number.isNaN(Date.parse(String(created))));
  const occurredAt = createdProven ? new Date(String(created)).toISOString() : new Date(0).toISOString();
  const turn = prepareSourceTurn({ userId, client, sessionId, role: "user", content: raw,
    occurredAt, scope, teamId: row.team_id ?? row.payload?.teamId,
    projectKey: row.project_key ?? row.payload?.projectKey, path: row.path ?? row.payload?.path }, hmacKey);
  return { ...turn, identityQuality: "legacy_payload" as const,
    proven: createdProven && Boolean(row.payload?.client && (row.session_id || row.payload?.sessionId))
      && (!row.source_turn_id || row.source_turn_hmac === turn.contentHmac) };
}

type RowResult = { changedText: boolean; norm?: string; embedding?: number[] };
type BatchResult = { rows: Map<string, RowResult>; counts: TableCounts };
async function updateBatch(db: ScrubDb, table: PrivacyTable, page: PrivacyRow[], embed: Embed, hmacKey: string): Promise<BatchResult> {
  const counts = emptyCounts();
  const rows = new Map<string, RowResult>();
  for (const row of page) {
    const id = idOf(row, table);
    let changedText = false;
    let expectedNorm: string | undefined;
    let expectedEmbedding: number[] | undefined;
    const removed = () => { counts.removed_unredactable++; };
    if (table === "semiote" || table === "memories") {
      const payload = factPayload(row, removed);
      const text = String(payload.l2 ?? payload.data ?? "");
      const originalPayload = typeof row.payload === "string" ? JSON.parse(row.payload) as PrivacyRow : row.payload;
      const previousText = String(originalPayload?.l2 ?? originalPayload?.data ?? "");
      changedText = text !== previousText;
      const norm = changedText ? NORM(text) : undefined;
      let embedding: number[] | undefined;
      if (changedText) {
        try { embedding = text ? await embed(text) : undefined; } catch { embedding = undefined; }
        if (!embedding?.length) embedding = undefined;
        if (embedding) counts.rows_reembedded++;
        expectedNorm = norm;
        expectedEmbedding = embedding;
      }
      let migration: ReturnType<typeof sourceMigration>;
      if (table === "semiote") {
        try { migration = sourceMigration(row, hmacKey); }
        catch (error) { if (!(error instanceof RedactionAssertionError)) throw error; removed(); }
      }
      const existingTurn = migration ? (await db.query<PrivacyRow>(
        "SELECT user_id, content_hmac, key_fingerprint FROM type::record('session_turn', $id);", { id: migration.id }))[0]?.[0] : undefined;
      if (existingTurn && (existingTurn.user_id !== migration?.userId || existingTurn.content_hmac !== migration?.contentHmac
        || existingTurn.key_fingerprint !== migration?.keyFingerprint)) throw new Error("source turn collision");
      const chunks = migration ? chunkSourceTurn(migration.content) : [];
      const retainUntil = migration ? new Date(Math.max(Date.parse(migration.occurredAt), Date.now()) + 365 * 24 * 3600 * 1000).toISOString() : undefined;
      if (typeof row.payload === "string" || JSON.stringify(payload) !== JSON.stringify(originalPayload) || migration) await db.queryTransaction(`
        UPDATE type::record('${table}', $id) SET payload = $payload${table === "semiote" ? `,
          source_turn_id = $linkId, source_turn_hmac = $linkHmac,
          source_turn_key_fingerprint = $linkFingerprint,
          source_turn_link_state = $linkState,
          source_turn_redaction_version = $linkVersion` : ""};
        IF $textChanged { UPDATE type::record('${table}', $id) SET text_norm = $norm, embedding = $embedding ?? NONE; };
        IF $createTurn {
          CREATE type::record('session_turn', $turnId) CONTENT {
            user_id: $userId, client: $client, session_id: $sessionId, session_epoch: $epoch,
            turn_key: $turnKey, role: 'user', content: '', content_hmac: $hmac,
            key_fingerprint: $fingerprint, redaction_version: $version, source_format: 1,
            occurred_at: <datetime>$occurredAt, created_at: time::now(), last_seen_at: time::now(),
            identity_quality: 'legacy_payload', scope: $scope, team_id: $teamId,
            project_key: $projectKey, path: $path, retention_class: $retention,
            retain_until: $retainUntil, content_length: $contentLength,
            original_bytes: $originalBytes, chunk_count: $chunkCount, truncated: $truncated
          };
          FOR $chunk IN $chunks {
            CREATE type::record('session_turn_chunk', $chunk.id) CONTENT {
              user_id: $userId, turn_id: $turnId, chunk_index: $chunk.index,
              content: $chunk.content, text_norm: $chunk.norm
            };
          };
        };
        IF $linkProven {
          UPSERT type::record('source_turn_evidence', $evidenceId) CONTENT {
            user_id: $userId, fact_id: $id, turn_id: $turnId, scope: $scope,
            content_hmac: $hmac, key_fingerprint: $fingerprint,
            link_state: 'linked', non_equivalent: true
          };
        };`, {
        id, payload, norm, embedding: embeddingForStore(embedding), textChanged: changedText, createTurn: Boolean(migration && !existingTurn),
        linkId: migration?.id ?? row.source_turn_id ?? undefined,
        linkHmac: migration?.contentHmac ?? row.source_turn_hmac ?? undefined,
        linkFingerprint: migration?.keyFingerprint ?? row.source_turn_key_fingerprint ?? undefined,
        linkState: migration ? "legacy" : row.source_turn_link_state ?? undefined,
        linkVersion: migration ? SOURCE_REDACTION_VERSION : row.source_turn_redaction_version ?? undefined,
        turnId: migration?.id, userId: migration?.userId, client: migration?.client,
        linkProven: migration?.proven ?? false,
        evidenceId: migration ? createHash("sha256").update(JSON.stringify([migration.userId, id, migration.id])).digest("hex") : undefined,
        sessionId: migration?.sessionId, epoch: migration?.sessionEpoch, turnKey: migration?.turnKey,
        hmac: migration?.contentHmac, fingerprint: migration?.keyFingerprint, version: SOURCE_REDACTION_VERSION,
        occurredAt: migration?.occurredAt, scope: migration?.scope,
        teamId: migration?.teamId, projectKey: migration?.projectKey, path: migration?.path,
        retention: migration?.proven ? "linked" : "unlinked", retainUntil: migration && !migration.proven && retainUntil ? new Date(retainUntil) : undefined,
        contentLength: migration?.content.length, originalBytes: migration?.originalBytes,
        chunkCount: chunks.length, truncated: migration?.truncated,
        chunks: chunks.map((content, index) => ({ id: `${migration?.id}_${index}`, content, index, norm: content.toLowerCase() })),
      });
      if (typeof row.payload === "string" || JSON.stringify(payload) !== JSON.stringify(originalPayload) || changedText || migration) counts.rows_rewritten++;
    } else if (table === "noema") {
      const canonical = scrubFieldValue("noema", "canonical_text", String(row.canonical_text ?? ""), removed) as string | undefined;
      changedText = canonical !== String(row.canonical_text ?? "");
      const norm = changedText ? NORM(canonical ?? "") : undefined;
      let embedding: number[] | undefined;
      if (changedText) {
        try { embedding = canonical ? await embed(canonical) : undefined; } catch { embedding = undefined; }
        if (!embedding?.length) embedding = undefined;
        if (embedding) counts.rows_reembedded++;
        expectedNorm = norm;
        expectedEmbedding = embedding;
      }
      const payload = row.payload && typeof row.payload === "object" ? scrubFieldValue("noema", "payload", row.payload, removed) : row.payload;
      const canonicalObject = row.canonical && typeof row.canonical === "object" ? { ...row.canonical } : row.canonical;
      if (canonicalObject && typeof canonicalObject === "object") for (const key of ["text", "l0", "l1", "factKey"]) {
        if (typeof canonicalObject[key] === "string") canonicalObject[key] = scrubFieldValue("noema", `canonical.${key}`, canonicalObject[key], removed);
      }
      if (canonicalObject?.stableClaim && typeof canonicalObject.stableClaim === "object") {
        canonicalObject.stableClaim = { ...canonicalObject.stableClaim };
        for (const key of ["subject", "predicate", "value"]) {
          if (typeof canonicalObject.stableClaim[key] === "string") canonicalObject.stableClaim[key] = scrubFieldValue("noema", `canonical.stableClaim.${key}`, canonicalObject.stableClaim[key], removed);
        }
      }
      const stableClaim = row.stable_claim && typeof row.stable_claim === "object" ? { ...row.stable_claim } : row.stable_claim;
      if (stableClaim && typeof stableClaim === "object") for (const key of ["subject", "predicate", "value"]) {
        if (typeof stableClaim[key] === "string") stableClaim[key] = scrubFieldValue("noema", `stable_claim.${key}`, stableClaim[key], removed);
      }
      const factKey = typeof row.fact_key === "string" ? scrubFieldValue("noema", "fact_key", row.fact_key, removed) : row.fact_key;
      const factKeySeed = typeof row.fact_key_seed === "string" ? scrubFieldValue("noema", "fact_key_seed", row.fact_key_seed, removed) : row.fact_key_seed;
      if (changedText || JSON.stringify([payload, canonicalObject, stableClaim, factKey, factKeySeed])
        !== JSON.stringify([row.payload, row.canonical, row.stable_claim, row.fact_key, row.fact_key_seed])) await db.queryTransaction(`UPDATE type::record('noema', $id) SET canonical_text = $canonical ?? NONE, payload = $payload,
        canonical = $canonicalObject, stable_claim = $stableClaim, fact_key = $factKey, fact_key_seed = $factKeySeed;
        IF $textChanged { UPDATE type::record('noema', $id) SET canonical_norm = $norm, embedding = $embedding ?? NONE; };`,
        { id, canonical, norm, embedding: embeddingForStore(embedding), textChanged: changedText, payload, canonicalObject, stableClaim, factKey, factKeySeed });
      if (FIELDS.noema.some((field) => field !== "canonical_norm" && field !== "embedding"
        && inspectField("noema", field, fieldValue(row, field)).wouldChange > 0)) counts.rows_rewritten++;
    } else if (table === "rejection_log") {
      if (inspectField(table, "candidate_text", row.candidate_text).wouldChange) {
        await db.queryTransaction("UPDATE type::record('rejection_log', $id) SET candidate_text = $text ?? NONE;", { id, text: scrubFieldValue(table, "candidate_text", row.candidate_text, removed) });
        counts.rows_rewritten++;
      }
    } else if (table === "retrieval_trace") {
      if (FIELDS.retrieval_trace.some((field) => inspectField(table, field, fieldValue(row, field)).wouldChange)) await db.queryTransaction(`UPDATE type::record('retrieval_trace', $id) SET prompt = '', answer = '',
        prepend_context = NONE, capture_receipt = $receipt, synthesis = $synthesis;`,
        { id, receipt: scrubFieldValue(table, "capture_receipt", row.capture_receipt),
          synthesis: scrubFieldValue(table, "synthesis", row.synthesis) });
      if (FIELDS.retrieval_trace.some((field) => inspectField(table, field, fieldValue(row, field)).wouldChange)) counts.rows_rewritten++;
    } else if (table === "session_turn") {
      if (!row.content) continue;
      counts.rows_rewritten++;
      const chunks = (await db.query<PrivacyRow>("SELECT id, content, text_norm, chunk_index FROM session_turn_chunk WHERE turn_id = $id ORDER BY chunk_index;", { id }))[0] ?? [];
      if (chunks.some((chunk) => inspectField("session_turn_chunk", "content", chunk.content).wouldChange > 0
        || inspectField("session_turn_chunk", "text_norm", chunk.text_norm).wouldChange > 0
        || chunk.text_norm !== String(chunk.content ?? "").toLowerCase()))
        throw new Error("existing turn chunks must verify clean before header removal");
      const content = redactSourceTurn(String(row.content ?? ""));
      const newChunks = chunks.length || !row.content ? [] : chunkSourceTurn(content);
      await db.queryTransaction(`
        FOR $chunk IN $chunks {
          CREATE type::record('session_turn_chunk', $chunk.id) CONTENT {
            user_id: $userId, turn_id: $id, chunk_index: $chunk.index, content: $chunk.content, text_norm: $chunk.norm
          };
        };
        UPDATE type::record('session_turn', $id) SET content = '', redaction_version = $version;`,
        { id, userId: row.user_id, version: SOURCE_REDACTION_VERSION,
          chunks: newChunks.map((part, index) => ({ id: `${id}_${index}`, content: part, index, norm: part.toLowerCase() })) });
    } else if (table === "session_turn_chunk") {
      const content = redactSourceTurn(String(row.content ?? ""));
      changedText = true;
      expectedNorm = content.toLowerCase();
      if (content !== row.content || content.toLowerCase() !== row.text_norm) await db.queryTransaction(
        "UPDATE type::record('session_turn_chunk', $id) SET content = $content, text_norm = $norm;",
        { id, content, norm: content.toLowerCase() });
      if (content !== row.content || content.toLowerCase() !== row.text_norm) counts.rows_rewritten++;
    }
    rows.set(id, { changedText, norm: expectedNorm, embedding: expectedEmbedding });
  }
  return { rows, counts };
}

export async function applyScrub(db: ScrubDb, options: ScrubOptions): Promise<Inventory> {
  validateApplyOptions(options);
  await validateBackup(options.backupPath);
  if (options.vaultRoot) await validateBackup(options.vaultBackupPath!);
  const existingKeyRows = (await db.query<{ key_fingerprint?: string }>(
    "SELECT key_fingerprint FROM session_turn WHERE content_hmac != NONE GROUP BY key_fingerprint;"))[0] ?? [];
  const configuredKey = sourceKeyFingerprint(options.hmacKey);
  if (existingKeyRows.some((row) => row.key_fingerprint !== configuredKey)) throw new Error("source HMAC key fingerprint mismatch");
  const current = await inventory(db, options.identity, options.vaultRoot);
  process.stdout.write(`${JSON.stringify({ vault_files_owned: current.rows.vault_files, owner_files_skipped: current.rows.owner_files_skipped })}\n`);
  if (options.vaultRoot && current.rows.vault_files === 0 && !options.allowEmptyVault) throw new Error("vault has no Rúnir-owned files; --allow-empty-vault required");
  if (current.rows["memories.payload.parse_failures"] > 0) throw new Error("legacy payload parse failure");
  let checkpoint = await loadCheckpoint(options.checkpointPath);
  if (!checkpoint) {
    if (current.hash !== options.inventoryHash) throw new Error("inventory hash changed");
    checkpoint = { version: SOURCE_REDACTION_VERSION, ...options.identity, inventoryHash: options.inventoryHash,
      tableIndex: 0, cursor: "", vaultDone: false, counts: {}, renamed: [] };
    await saveCheckpoint(options.checkpointPath, checkpoint);
  } else if (checkpoint.inventoryHash !== options.inventoryHash || checkpoint.namespace !== options.identity.namespace || checkpoint.database !== options.identity.database || checkpoint.version !== SOURCE_REDACTION_VERSION) {
    throw new Error("checkpoint identity/version mismatch");
  }
  const embed = options.embed ?? ((text: string) => resolveEmbeddingProvider().embedDocument(text));
  for (let i = checkpoint.tableIndex; i < TABLES.length; i++) {
    const table = TABLES[i];
    let cursor = i === checkpoint.tableIndex ? checkpoint.cursor : "";
    while (true) {
      const page = await readPage(db, table, cursor, options.batchSize ?? 100);
      if (!page.length) break;
      const batch = await updateBatch(db, table, page, embed, options.hmacKey);
      // Re-read every processed record before advancing the durable cursor.
      const ids = page.map((row) => idOf(row, table));
      const verified = (await db.query<PrivacyRow>(`SELECT * FROM ${table} WHERE record::id(id) IN $ids;`, { ids }))[0] ?? [];
      if (verified.length !== page.length) throw new Error("batch verification row count mismatch");
      for (const row of verified) for (const field of FIELDS[table]) {
        const value = fieldValue(row, field);
        if (field === "embedding" || field === "text_norm" || field === "canonical_norm") continue;
        if (field === "payload.raw_source_text" && value !== undefined && value !== null) throw new Error("batch verification source remains");
        if (table === "session_turn" && field === "content" && value) throw new Error("batch verification old turn content remains");
        const state = inspectField(table, field, value);
        if (state.wouldChange || state.assertionFailures) throw new Error("batch verification redaction failed");
      }
      for (const row of verified) {
        const expected = batch.rows.get(idOf(row, table));
        if (!expected?.changedText) continue;
        const source = table === "noema" ? String(row.canonical_text ?? "")
          : table === "semiote" || table === "memories" ? String(row.payload?.l2 ?? row.payload?.data ?? "")
            : table === "session_turn_chunk" ? String(row.content ?? "") : undefined;
        if (source === undefined) continue;
        const norm = expected.norm ?? (table === "session_turn_chunk" ? source.toLowerCase() : NORM(source));
        const storedNorm = table === "noema" ? row.canonical_norm : row.text_norm;
        if (storedNorm !== norm) throw new Error("batch verification norm mismatch");
        if (table === "session_turn_chunk") continue;
        const stored = Array.isArray(row.embedding) && row.embedding.length ? row.embedding : undefined;
        if (JSON.stringify(stored) !== JSON.stringify(expected.embedding)) throw new Error("batch verification embedding mismatch");
      }
      if (table === "semiote") for (const row of verified) {
        if (row.source_turn_link_state !== "legacy") continue;
        const turn = (await db.query<PrivacyRow>(
          "SELECT content, content_hmac, key_fingerprint FROM type::record('session_turn', $id);",
          { id: row.source_turn_id }))[0]?.[0];
        if (!turn || turn.content !== "" || turn.content_hmac !== row.source_turn_hmac
          || turn.key_fingerprint !== row.source_turn_key_fingerprint) throw new Error("batch verification source link mismatch");
      }
      cursor = ids.at(-1)!;
      const prior = checkpoint.counts?.[table] ?? emptyCounts();
      checkpoint.counts = { ...checkpoint.counts, [table]: {
        rows_rewritten: prior.rows_rewritten + batch.counts.rows_rewritten,
        rows_reembedded: prior.rows_reembedded + batch.counts.rows_reembedded,
        removed_unredactable: prior.removed_unredactable + batch.counts.removed_unredactable,
        files_renamed: prior.files_renamed + batch.counts.files_renamed,
      } };
      checkpoint = { ...checkpoint, tableIndex: i, cursor };
      await saveCheckpoint(options.checkpointPath, checkpoint);
    }
    checkpoint = { ...checkpoint, tableIndex: i + 1, cursor: "" };
    await saveCheckpoint(options.checkpointPath, checkpoint);
  }
  if (options.vaultRoot && !checkpoint.vaultDone) {
    const vault = await ownedVaultFiles(db, options.vaultRoot);
    for (const file of vault.files) {
      let before: string;
      try { before = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file)); }
      catch { throw new Error("vault file is not UTF-8"); }
      const after = redactFactText(before);
      let nextName: string;
      let unredactableName = false;
      try { nextName = redactFactText(basename(file)); }
      catch {
        unredactableName = true;
        const pathHash = createHash("sha256").update(relative(options.vaultRoot, file)).digest("hex");
        nextName = `runir-redacted-${pathHash.slice(0, 12)}.md`;
      }
      if (after !== before || nextName !== basename(file)) {
        const next = `${file}.source-layer-next`;
        const target = join(dirname(file), nextName);
        if (target !== file) {
          try { await stat(target); throw new Error("redacted vault filename collision"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const handle = await open(next, "w", 0o600);
        try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
        const readBack = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(next));
        if (readBack !== after || inspectField("semiote", "payload.l2", readBack).wouldChange
          || inspectField("semiote", "payload.l2", nextName).wouldChange) throw new Error("vault read-back verification failed");
        await rename(next, target);
        if (target !== file) await (await import("node:fs/promises")).unlink(file);
        const prior = checkpoint.counts?.vault ?? emptyCounts();
        checkpoint.counts = { ...checkpoint.counts, vault: { ...prior, rows_rewritten: prior.rows_rewritten + 1,
          files_renamed: prior.files_renamed + Number(target !== file), removed_unredactable: prior.removed_unredactable + Number(unredactableName) } };
        if (target !== file) checkpoint.renamed = [...checkpoint.renamed ?? [], {
          oldHash: createHash("sha256").update(relative(options.vaultRoot, file)).digest("hex"),
          newHash: createHash("sha256").update(relative(options.vaultRoot, target)).digest("hex"),
        }];
        await saveCheckpoint(options.checkpointPath, checkpoint);
      }
    }
    checkpoint = { ...checkpoint, vaultDone: true };
    await saveCheckpoint(options.checkpointPath, checkpoint);
  }
  const after = await inventory(db, options.identity, options.vaultRoot);
  if (!verifyInventory(after)) throw new Error("post-apply privacy verification failed");
  const report = Object.fromEntries([...TABLES, "vault"].map((table) => [table, checkpoint.counts?.[table] ?? emptyCounts()]));
  process.stdout.write(`${JSON.stringify({ apply_counts: report })}\n`);
  return after;
}

export function countOnlyInventoryHash(result: Inventory): string {
  return createHash("sha256").update(result.hash).digest("hex");
}
