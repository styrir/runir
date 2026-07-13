/**
 * memory-enricher.ts — Code-6q9
 * Backfills l0 (title) and l1 (summary) on raw captures via Gemini Flash.
 * Also populates para_hint for PARA placement inference.
 *
 * Rúnir-ekos B6: this module's `tableName: MemoryRecordTable = "memories"`
 * defaults are an intentional legacy surface (admin enrich/backfill
 * routes) — do not flip them to PRIMARY_MEMORY_TABLE. Current-era code
 * elsewhere imports PRIMARY_MEMORY_TABLE from domain/memory/types.js;
 * literal "memories" is reserved for intentional legacy surfaces like
 * this one.
 */

import { RecordId } from "surrealdb";
import type { MemoryRecordTable } from "../../domain/memory/types.js";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import { callLlmGateway, LlmGatewayError, isRetryableLlmGatewayError, stripJsonFences } from "../../shared/llm-gateway-client.js";

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

const DEFAULT_ENRICH_BATCH_SIZE = 50;
// flash-lite per the 2026-06-11 model A/B (Rúnir-d4xz): wins the JSON-out
// enrichment task class, 2-4x faster, cheaper. ENRICH_MODEL overrides.
const DEFAULT_ENRICH_MODEL = "vertex/gemini-3.1-flash-lite@us";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function getEnrichBatchSize(): number {
  const raw = process.env.ENRICH_BATCH_SIZE;
  if (!raw) return DEFAULT_ENRICH_BATCH_SIZE;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_ENRICH_BATCH_SIZE;
}

function getEnrichModel(): string {
  return process.env.ENRICH_MODEL ?? DEFAULT_ENRICH_MODEL;
}

function getMaxRetries(): number {
  const raw = process.env.ENRICH_MAX_RETRIES;
  if (!raw) return DEFAULT_MAX_RETRIES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_MAX_RETRIES;
}

function getRetryDelayMs(): number {
  const raw = process.env.ENRICH_RETRY_DELAY_MS;
  if (!raw) return DEFAULT_RETRY_DELAY_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run async tasks with a concurrency cap. No external deps.
 */
async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();
  for (const task of tasks) {
    const p: Promise<void> = task()
      .then((r) => { results.push(r); })
      .finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnrichmentResult = {
  processed: number;
  enriched: number;
  failed: number;
  errors: string[];
  durationMs: number;
  enrichedIds: string[];
};

export type RawMemoryRow = {
  id: string;
  l2: string;
  l0?: string;
  l1?: string;
  category: string;
  tier: string;
  tags: string[];
  writeSource: string;
  createdAt: string;
  active?: boolean;
  supersededById?: string;
  para_hint?: string;
};

type EnrichmentPayload = {
  l0: string;
  l1: string;
  para_hint: "project" | "area" | "resource" | "archive";
};

// ---------------------------------------------------------------------------
// Fetch unenriched memories
// ---------------------------------------------------------------------------

export async function fetchUnenrichedMemories(
  db: SurrealClient,
  limit: number = DEFAULT_ENRICH_BATCH_SIZE,
  tableName: MemoryRecordTable = "memories",
): Promise<RawMemoryRow[]> {
  const results = await db.query<any>(
    `SELECT id,
       payload.l2 OR payload.data AS l2,
       payload.l0 AS l0,
       payload.l1 AS l1,
       payload.category AS category,
       payload.tier AS tier,
       payload.tags AS tags,
       payload.writeSource AS writeSource,
       payload.createdAt AS createdAt,
       active,
       payload.supersededById AS supersededById,
       payload.para_hint AS para_hint
     FROM ${tableName}
     WHERE (active = NONE OR active = true)
       AND (payload.l0 IS NONE OR payload.l0 = '')
     LIMIT $limit`,
    { limit },
  );
  const rows = results[0] ?? [];
  return rows.map((row: any) => ({
    id: typeof row.id === "object" && row.id !== null
      ? String((row.id as any).id ?? row.id)
      : String(row.id ?? ""),
    l2: row.l2 ?? "",
    l0: row.l0 ?? "",
    l1: row.l1 ?? "",
    category: row.category ?? "cases",
    tier: row.tier ?? "working",
    tags: row.tags ?? [],
    writeSource: row.writeSource ?? "capture",
    createdAt: String(row.createdAt ?? ""),
    active: row.active,
    supersededById: row.supersededById,
    para_hint: row.para_hint,
  }));
}

export async function fetchUnenrichedMemoriesBySession(
  db: SurrealClient,
  sessionId: string,
  limit: number = DEFAULT_ENRICH_BATCH_SIZE,
  tableName: MemoryRecordTable = "memories",
): Promise<RawMemoryRow[]> {
  const results = await db.query<any>(
    `SELECT id,
       payload.l2 OR payload.data AS l2,
       payload.l0 AS l0,
       payload.l1 AS l1,
       payload.category AS category,
       payload.tier AS tier,
       payload.tags AS tags,
       payload.writeSource AS writeSource,
       payload.createdAt AS createdAt,
       active,
       payload.supersededById AS supersededById,
       payload.para_hint AS para_hint
     FROM ${tableName}
     WHERE (active = NONE OR active = true)
       AND (payload.l0 IS NONE OR payload.l0 = '')
       AND payload.sessionId = $sessionId
     LIMIT $limit`,
    { sessionId, limit },
  );
  const rows = results[0] ?? [];
  return rows.map((row: any) => ({
    id: typeof row.id === "object" && row.id !== null
      ? String((row.id as any).id ?? row.id)
      : String(row.id ?? ""),
    l2: row.l2 ?? "",
    l0: row.l0 ?? "",
    l1: row.l1 ?? "",
    category: row.category ?? "cases",
    tier: row.tier ?? "working",
    tags: row.tags ?? [],
    writeSource: row.writeSource ?? "capture",
    createdAt: String(row.createdAt ?? ""),
    active: row.active,
    supersededById: row.supersededById,
    para_hint: row.para_hint,
  }));
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildEnrichmentPrompt(row: RawMemoryRow): string {
  return `You are a memory enrichment system for a developer knowledge base.

Given a raw captured memory, produce a JSON object with exactly these fields:
- "l0": A concise title (5-12 words, noun phrase). Must be specific enough to distinguish from other memories.
- "l1": A 2-3 sentence summary. Self-contained — understandable without reading the raw data.
- "para_hint": One of "project", "area", "resource", "archive". Infer from content:
  - "project": References a named deliverable, ticket ID (e.g., Code-abc), deadline, sprint, or milestone.
    Examples: "Fixed Code-6q9 authentication bug", "Sprint 4 goal: ship vault exporter"
  - "area": Describes YOUR ongoing responsibility, YOUR personal preference, team policy, or domain ownership.
    Must have first-person or ownership signal. NOT for technical facts.
    Examples: "I prefer tabs over spaces", "We always use kebab-case for file names", "I own the database layer"
    NOT area: "SurrealDB always requires type::record() casting" — this is a technical rule, use "resource"
  - "resource": Technical reference, syntax, API patterns, schema definitions, how-to guides, debugging patterns,
    reusable knowledge. Does NOT require a deadline or personal responsibility.
    Examples: "SurrealDB RELATE syntax requires type::record() casting on both sides",
              "Pattern: HTTP-first debugging for SurrealDB WebSocket issues",
              "entity_edges schema: TYPE RELATION FROM entities TO entities | memories"
  - "archive": Explicitly superseded, outdated, or marked inactive

Raw memory category: ${row.category}
Raw memory tier: ${row.tier}
Tags: ${(row.tags ?? []).join(", ")}
Created: ${row.createdAt}

Raw memory content (l2):

${row.l2}
---

Respond with ONLY valid JSON. No markdown fences. No explanation.`;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function callGeminiFlash(
  prompt: string,
  apiKey: string,
): Promise<EnrichmentPayload | null> {
  const model = getEnrichModel();
  const maxRetries = getMaxRetries();
  const retryDelayMs = getRetryDelayMs();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let content: string;
    try {
      // Shared gateway client (imaf.8): owns the AbortController timeout the
      // old bare fetch lacked; retry policy stays here, lane-owned.
      content = await callLlmGateway({
        model,
        apiKey,
        jsonMode: true,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      if (err instanceof LlmGatewayError && (err.kind === "network" || err.kind === "timeout")) {
        // Network-class failure: retry; exhaustion returns null (legacy contract)
        lastError = err;
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        return null;
      }
      if (isRetryableLlmGatewayError(err)) {
        // 429 / 5xx: retry; exhaustion throws (legacy contract)
        lastError = err as Error;
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        break;
      }
      // Non-retryable 4xx / malformed response — fail immediately
      throw err;
    }

    const parsed = JSON.parse(stripJsonFences(content)) as Record<string, string>;

    return {
      l0: String(parsed.l0 ?? ""),
      l1: String(parsed.l1 ?? ""),
      para_hint: (["project", "area", "resource", "archive"].includes(parsed.para_hint)
        ? parsed.para_hint
        : "resource") as EnrichmentPayload["para_hint"],
    };
  }

  // Exhausted retries
  if (lastError) {
    throw lastError;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply enrichment to DB
// ---------------------------------------------------------------------------

export async function applyEnrichment(
  db: SurrealClient,
  id: string,
  payload: EnrichmentPayload,
  tableName: MemoryRecordTable = "memories",
): Promise<void> {
  // Use RecordId directly — avoids type::record($id) failing on hyphenated UUIDs.
  // The id string may be "uuid" or "memories:uuid"; extract just the uuid part.
  const rawUuid = id.includes(":") ? id.split(":")[1] : id;
  const rid = new RecordId(tableName, rawUuid);
  await db.query(
    `UPDATE $rid SET
       payload.l0 = $l0,
       payload.l1 = $l1,
       payload.para_hint = $para_hint,
       enriched_at = time::now()`,
    { rid, l0: payload.l0, l1: payload.l1, para_hint: payload.para_hint },
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runEnrichment(
  db: SurrealClient,
  apiKey: string,
  batchSize?: number,
  progressCallback?: (processed: number, total: number) => void,
  tableName: MemoryRecordTable = "memories",
): Promise<EnrichmentResult> {
  const startMs = Date.now();
  const limit = batchSize ?? getEnrichBatchSize();
  const rows = await fetchUnenrichedMemories(db, limit, tableName);

  let processed = 0;
  let enriched = 0;
  let failed = 0;
  const errors: string[] = [];
  const enrichedIds: string[] = [];

  for (const row of rows) {
    try {
      // If superseded, mark archive without calling LLM
      if (row.supersededById || row.active === false) {
        await applyEnrichment(db, row.id, {
          l0: row.l0 || `Memory ${row.id.slice(0, 8)}`,
          l1: row.l1 || "Superseded memory.",
          para_hint: "archive",
        }, tableName);
        enriched++;
        enrichedIds.push(row.id);
        processed++;
        progressCallback?.(processed, rows.length);
        continue;
      }

      const prompt = buildEnrichmentPrompt(row);
      const payload = await callGeminiFlash(prompt, apiKey);
      if (payload === null) {
        failed++;
        errors.push(`${row.id}: callGeminiFlash returned null after retries`);
      } else {
        await applyEnrichment(db, row.id, payload, tableName);
        enriched++;
        enrichedIds.push(row.id);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${row.id}: ${msg}`);
    }
    processed++;
    progressCallback?.(processed, rows.length);
  }

  return {
    processed: rows.length,
    enriched,
    failed,
    errors,
    durationMs: Date.now() - startMs,
    enrichedIds,
  };
}

export async function runSessionEnrichment(
  db: SurrealClient,
  apiKey: string,
  sessionId: string,
  userId?: string,
  concurrency: number = 5,
  tableName: MemoryRecordTable = "memories",
): Promise<EnrichmentResult> {
  const startMs = Date.now();
  const rows = await fetchUnenrichedMemoriesBySession(db, sessionId, 30, tableName);

  if (rows.length === 0) {
    return { processed: 0, enriched: 0, failed: 0, errors: [], durationMs: Date.now() - startMs, enrichedIds: [] };
  }

  let enriched = 0;
  let failed = 0;
  const errors: string[] = [];
  const enrichedIds: string[] = [];

  const tasks = rows.map((row) => async (): Promise<void> => {
    try {
      // Superseded rows get archive label without LLM call
      if (row.supersededById || row.active === false) {
        await applyEnrichment(db, row.id, {
          l0: row.l0 || `Memory ${row.id.slice(0, 8)}`,
          l1: row.l1 || "Superseded memory.",
          para_hint: "archive",
        }, tableName);
        enriched++;
        enrichedIds.push(row.id);
        return;
      }

      const prompt = buildEnrichmentPrompt(row);
      const payload = await callGeminiFlash(prompt, apiKey);
      if (payload === null) {
        failed++;
        errors.push(`${row.id}: callGeminiFlash returned null after retries`);
      } else {
        await applyEnrichment(db, row.id, payload, tableName);
        enriched++;
        enrichedIds.push(row.id);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${row.id}: ${msg}`);
    }
  });

  await withConcurrencyLimit(tasks, concurrency);

  const durationMs = Date.now() - startMs;
  console.warn(`memory-hybrid: session enrichment done — session=${sessionId} enriched=${enriched} failed=${failed} duration=${durationMs}ms`);

  return { processed: rows.length, enriched, failed, errors, durationMs, enrichedIds };
}
