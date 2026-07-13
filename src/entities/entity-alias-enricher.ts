/**
 * entity-alias-enricher.ts — Code-c7bj
 * Enriches entity records with LLM-generated aliases via OpenRouter/Gemini Flash.
 * Only enriches when entity.aliases is empty or null.
 */

import { extractId } from "../storage/surreal/surreal-store.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import type { EntityRecord } from "../domain/memory/types.js";
import type { EntityKind } from "../domain/memory/types.js";
import { callLlmGateway, stripJsonFences } from "../shared/llm-gateway-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// flash-lite per the 2026-06-11 model A/B (Rúnir-d4xz): wins the JSON-out
// enrichment task class, 2-4x faster, cheaper. ENRICH_MODEL overrides.
const DEFAULT_ALIAS_MODEL = "vertex/gemini-3.1-flash-lite@us";

function getAliasModel(): string {
  return process.env.ENRICH_MODEL ?? DEFAULT_ALIAS_MODEL;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AliasEnrichmentInput = {
  canonicalName: string;
  kind: EntityKind | string;
  description?: string;
};

export type AliasEnrichmentResult = {
  processed: number;
  enriched: number;
  failed: number;
  errors: string[];
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildAliasEnrichmentPrompt(entity: AliasEnrichmentInput): string {
  const descLine = entity.description
    ? `\nDescription: ${entity.description}`
    : "";

  return `You are an entity alias enrichment system for a personal knowledge base.

Given an entity name, kind, and optional description, return 2-5 common aliases, abbreviations, or alternate names that a user might use to refer to this entity. Use world knowledge — not just what appears in the description.

Examples:
- "SurrealDB" (kind: concept) → {"aliases": ["SRDB", "Surreal", "Surreal DB"]}
- "William Shakespeare" (kind: person) → {"aliases": ["Shakespeare", "The Bard", "Will Shakespeare"]}
- "OpenAI" (kind: organization) → {"aliases": ["OAI"]}
- "Personal Knowledge Management" (kind: concept) → {"aliases": ["PKM"]}
- "PostgreSQL" (kind: concept) → {"aliases": ["Postgres", "PG", "psql"]}

Entity name: ${entity.canonicalName}
Entity kind: ${entity.kind}${descLine}

Respond with ONLY valid JSON in this format: {"aliases": ["...", "..."]}
No markdown fences. No explanation. No extra fields.`;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callAliasLLM(prompt: string, apiKey: string): Promise<string[]> {
  const model = getAliasModel();
  // Shared gateway client (imaf.8): owns the timeout the old bare fetch
  // lacked and json_object mode. Errors still throw — caller policy unchanged.
  const content = await callLlmGateway({
    model,
    apiKey,
    jsonMode: true,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = JSON.parse(stripJsonFences(content)) as Record<string, unknown>;

  if (!Array.isArray(parsed.aliases)) return [];
  return (parsed.aliases as unknown[])
    .filter((a): a is string => typeof a === "string")
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

// ---------------------------------------------------------------------------
// Per-entity enrichment
// ---------------------------------------------------------------------------

/**
 * Persists an enrichment result. Exported separately so the real-DB schema
 * test can exercise the EXACT statement the enricher writes against
 * ensureEntityTables (the SCHEMAFULL `entities` table silently rejected the
 * whole UPDATE before `aliases_enriched_at` was defined — runaway paid loop,
 * discovered-from Rúnir-o75n.4).
 *
 * An empty `aliases` list still stamps `aliases_enriched_at` (attempted
 * marker, no alias mutation) so the next run does not re-pay the LLM for an
 * entity the model genuinely has no aliases for.
 */
export async function persistEnrichedAliases(
  db: SurrealClient,
  entityId: EntityRecord["id"],
  aliases: string[],
): Promise<void> {
  // extractId: entity.id can arrive as a RecordId OBJECT or a prefixed
  // string — feeding either through one-arg type::record targets a
  // phantom id (imaf.8 / same class as imaf.12 and 5jiw).
  const id = extractId(entityId ?? "");

  if (aliases.length === 0) {
    await db.query(
      `UPDATE type::record('entities', $id) SET
         aliases_enriched_at = time::now()`,
      { id },
    );
    return;
  }

  const aliasesNorm = aliases.map(a => a.toLowerCase().trim());
  await db.query(
    `UPDATE type::record('entities', $id) SET
       aliases = $aliases,
       aliasesNorm = $aliasesNorm,
       aliases_enriched_at = time::now()`,
    { id, aliases, aliasesNorm },
  );
}

export async function enrichEntityAliases(
  db: SurrealClient,
  entity: EntityRecord,
  apiKey: string,
): Promise<void> {
  // Guard: skip if already has aliases
  if (entity.aliases && entity.aliases.length > 0) return;
  // Guard: already attempted + persisted (covers the LLM-returned-empty case
  // where aliases stay [] — without this every run re-pays for the entity).
  if (entity.aliases_enriched_at) return;

  const prompt = buildAliasEnrichmentPrompt({
    canonicalName: entity.canonicalName,
    kind: entity.kind,
    description: entity.description,
  });

  const aliases = await callAliasLLM(prompt, apiKey);

  await persistEnrichedAliases(db, entity.id, aliases);
}

// ---------------------------------------------------------------------------
// Batch orchestrator
// ---------------------------------------------------------------------------

export async function runEntityAliasEnrichment(
  db: SurrealClient,
  apiKey: string,
): Promise<AliasEnrichmentResult> {
  const startMs = Date.now();
  const errors: string[] = [];
  let processed = 0;
  let enriched = 0;
  let failed = 0;

  if (!apiKey) {
    process.stderr.write("[entity-alias-enricher] OPENROUTER_API_KEY not set, skipping alias enrichment\n");
    return { processed: 0, enriched: 0, failed: 0, errors: [], durationMs: 0 };
  }

  // Fetch entities with empty aliases
  let entities: EntityRecord[] = [];
  try {
    const results = await db.query<any>(
      `SELECT * FROM entities WHERE aliases IS NONE OR array::len(aliases) = 0`,
    );
    entities = (results[0] ?? []) as EntityRecord[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to fetch entities: ${msg}`);
    return { processed: 0, enriched: 0, failed: 1, errors, durationMs: Date.now() - startMs };
  }

  for (const entity of entities) {
    processed++;
    try {
      await enrichEntityAliases(db, entity, apiKey);
      // We can't easily check if enriched happened without re-query, but track via non-empty input
      enriched++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Entity ${entity.canonicalName}: ${msg}`);
      process.stderr.write(`[entity-alias-enricher] Failed to enrich ${entity.canonicalName}: ${msg}\n`);
    }
  }

  return {
    processed,
    enriched,
    failed,
    errors,
    durationMs: Date.now() - startMs,
  };
}
