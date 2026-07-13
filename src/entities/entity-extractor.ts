import type { CaptureMessage, EntityMention } from "../domain/memory/types.js";
import { extractorJsonMode } from "../capture/extraction/capture.js";
import { recordCounter, recordPipelineDrop } from "../obs/counters.js";
import { resolveLlmBaseUrl, resolveLlmTimeoutMs } from "../shared/config.js";

export const ENTITY_EXTRACTION_PROMPT = `You are an Entity Recognition System. Given a conversation, extract all named entities mentioned or discussed.

For each entity, provide:
- name: The canonical form of the entity name (proper capitalization, full name preferred)
- kind: One of: "person", "org", "concept", "location", "event"
- context: A 1-2 sentence snippet from the conversation showing where this entity was mentioned
- confidence: Float 0.0-1.0 scoring how certain you are this is a real, distinct entity
- description: A concise 1-sentence description of the entity as understood from the conversation. What IS this entity? (e.g., "A multi-model database with graph, document, and vector capabilities")
- aliases: Array of alternate names, abbreviations, or version-specific names observed in the conversation for this entity. Return [] if no aliases observed — never omit this field.

KIND GUIDELINES:
- person: Named individuals (e.g., "Ben Shapiro", "the user's manager Sarah")
- org: Companies, teams, governments, institutions (e.g., "OpenAI", "the EU")
- concept: Ideas, narratives, technologies, policies, products (e.g., "GraphQL", "the Great Replacement narrative", "Kubernetes")
  - For concepts, also include "subtype": one of "narrative", "topic", "technology", "policy", "product"
- location: Named places (e.g., "San Francisco", "AWS us-east-1")
- event: Named events with temporal bounds (e.g., "2024 US Election", "Sprint 14 retro")

CONFIDENCE SCORING:
- 0.9-1.0: Explicitly named, unambiguous entity
- 0.7-0.89: Clearly referenced with minor inference (e.g., pronoun resolved from context)
- 0.5-0.69: Implicit or inferred entity
- Below 0.5: Too vague — do NOT include

RULES:
1. Extract entities from BOTH user and assistant messages.
2. Use the most specific canonical name available ("OpenAI" not "the company", "React" not "the framework").
3. Do NOT extract generic common nouns ("the database", "a server") unless they have a specific proper name.
4. Merge duplicate mentions — if "JS" and "JavaScript" both appear, return one entity with the canonical name "JavaScript" and aliases ["JS"].
5. For person entities, include handles[] if social media handles or usernames are mentioned.
6. For org entities, include orgType if discernible (e.g., "company", "government", "nonprofit").
7. Detect the language of the conversation and use entity names in their original language when they are proper nouns.

TEMPORAL NORMALIZATION:
The current date/time is: {SESSION_TIMESTAMP}
For event entities, convert relative dates to ISO format (same rules as fact extraction).

OUTPUT FORMAT:
Return ONLY valid JSON: {"entities": [{"name": "...", "kind": "...", "context": "...", "confidence": N.N, "description": "...", "aliases": [...], ...}, ...]}
- Do NOT wrap in markdown code fences.
- Do NOT return text outside the JSON.
- An empty or entity-free conversation returns {"entities": []}

FEW-SHOT EXAMPLE:

Input: "We migrated from PostgreSQL to SurrealDB because we needed graph traversal with RELATE. The SurrealDB JS SDK had some RecordId parsing issues with v3."
Output: {"entities": [{"name": "SurrealDB", "kind": "concept", "subtype": "technology", "context": "Migrated from PostgreSQL to SurrealDB because we needed graph traversal with RELATE.", "confidence": 0.95, "description": "A multi-model database with graph, document, and vector capabilities", "aliases": ["SurrealDB 3.x", "SurrealDB JS SDK"]}, {"name": "PostgreSQL", "kind": "concept", "subtype": "technology", "context": "We migrated from PostgreSQL to SurrealDB", "confidence": 0.9, "description": "A relational database management system", "aliases": []}, {"name": "RecordId", "kind": "concept", "subtype": "technology", "context": "SurrealDB JS SDK had some RecordId parsing issues with v3", "confidence": 0.85, "description": "SurrealDB's typed record identifier class in the JS SDK", "aliases": []}]}`;

const CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_ENTITY_MODEL = "openai/gpt-5.4-mini";

/**
 * Resolve the entity-extraction model: RUNIR_ENTITY_MODEL > RUNIR_EXTRACTOR_MODEL >
 * default. Entity extraction FOLLOWS the main extractor by default so a single env
 * switch moves both lanes and the drop/coercion counter labels stay truthful (the
 * old hardcoded const kept stamping "openai/gpt-5.4-mini" on metrics after the
 * extractor moved to the local haiku proxy — the proxy's unknown-model fallback
 * masked it). RUNIR_ENTITY_MODEL exists for a deliberate observer/actor split.
 */
export function resolveEntityModel(): string {
  const own = process.env.RUNIR_ENTITY_MODEL;
  if (typeof own === "string" && own.length > 0) return own;
  const extractor = process.env.RUNIR_EXTRACTOR_MODEL;
  if (typeof extractor === "string" && extractor.length > 0) return extractor;
  return DEFAULT_ENTITY_MODEL;
}

/**
 * Coerce an unknown LLM-supplied confidence value to a finite number in [0,1].
 *
 * Pattern mirrors phase2-store.ts clamp01 — single ingestion-boundary guard so
 * ALL downstream code (arbitrator, consolidation, entity-store) receives a
 * guaranteed [0,1] finite float and never re-validates.
 *
 * Fallback 0.5 is INTENTIONAL: it sits below CONFIDENCE_THRESHOLD (0.7), so
 * an entity whose confidence the model couldn't express numerically is DROPPED
 * — conservative by design (entities domain owns this export).
 */
export function coerceConfidence01(value: unknown, fallback = 0.5): number {
  // Number(null) → 0 (finite) which is wrong — treat null/undefined as absent.
  if (value == null) return fallback;
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, safe));
}

/** Record a dropped entity-extraction batch on the structured-stderr counter
 *  seam so silent capture loss is observable in prod (extractEntities is a
 *  one-shot session-end path: a parse/HTTP failure loses the whole session's
 *  entity graph + linking with no signal). Fully guarded — observability must
 *  not break the always-returns-[] contract. */
function recordEntityDrop(reason: string, model: string): void {
  // imaf.9: unified counter — metric=capture_batch_dropped stage=entity scope=batch
  recordPipelineDrop("entity", "batch", reason, model);
}

/** Extracts named entities from normalized messages through OpenRouter.
 *  Contract: always returns EntityMention[], never throws (iter-4 hardening). */
export async function extractEntities(
  messages: CaptureMessage[],
  apiKey: string,
  sessionTimestamp?: string,
  timeoutMs?: number,
): Promise<EntityMention[]> {
  const ts = sessionTimestamp ?? new Date().toISOString();
  const promptWithTimestamp = ENTITY_EXTRACTION_PROMPT.replace("{SESSION_TIMESTAMP}", ts);

  const conversation = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const model = resolveEntityModel();
  // AbortController with a configurable timeout (mirrors extractMemories): a
  // stalled provider must not hang the synchronous /hooks/capture +
  // /hooks/session-end path that awaits extractEntities. (Rúnir-imaf.4)
  const effectiveTimeout = timeoutMs ?? resolveLlmTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  let response: Response;
  try {
    response = await fetch(`${resolveLlmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: promptWithTimestamp },
          {
            role: "user",
            content: `Extract entities from this conversation:\n\n${conversation}`,
          },
        ],
        max_tokens: 4096,
        temperature: 0,
        // JSON mode (gated to openai/*, no require_parameters) — same recipe as
        // extractMemories: the prompt already mandates {"entities":[...]}, so
        // json_object forces an unfenced parseable object. See extractorJsonMode().
        ...(extractorJsonMode(model) ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (err) {
    // The fetch was previously unwrapped — a network/abort error threw out of
    // extractEntities, violating the always-returns-[] contract.
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`memory-hybrid: extractEntities fetch aborted (${effectiveTimeout}ms timeout)`);
      recordEntityDrop("timeout", model);
    } else {
      console.warn(`memory-hybrid: extractEntities fetch error: ${err instanceof Error ? err.message : String(err)}`);
      recordEntityDrop("fetch_error", model);
    }
    return [];
  }
  if (!response.ok) {
    clearTimeout(timer);
    recordEntityDrop("http_not_ok", model);
    return [];
  }
  // Wrap response.json(): a non-JSON HTTP body would otherwise throw. The timer
  // stays active THROUGH the body read — a provider can send headers then stall
  // the body, and Node rejects response.json() with AbortError on abort (imaf.4).
  let data: any;
  try {
    data = await response.json();
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`memory-hybrid: extractEntities body read aborted (${effectiveTimeout}ms timeout)`);
      recordEntityDrop("timeout", model);
    } else {
      console.warn(`memory-hybrid: extractEntities response.json() failed: ${err instanceof Error ? err.message : String(err)}`);
      recordEntityDrop("http_json_error", model);
    }
    return [];
  }
  clearTimeout(timer);
  // data?. (not data.): a null JSON body (JSON.parse("null")) would throw on .choices.
  const rawContent = data?.choices?.[0]?.message?.content;
  const text: string = typeof rawContent === "string" ? rawContent : "";
  try {
    let jsonText = text;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    const parsed = JSON.parse(jsonText) as { entities?: EntityMention[] };
    if (!parsed || !Array.isArray(parsed.entities)) {
      recordEntityDrop("bad_root_shape", model);
      return [];
    }

    const passed: EntityMention[] = [];
    for (const entity of parsed.entities) {
      // Guard null/non-object elements: a null entity throws on `.confidence`
      // (collapsing the whole batch via the outer catch); a primitive
      // (number/string/boolean) doesn't throw on read but is malformed and would
      // otherwise be pushed as a garbage EntityMention. Skip both, keep the valid
      // siblings (iter-2 per-fact lesson).
      if (!entity || typeof entity !== "object") {
        continue;
      }
      // Coerce confidence ONCE at the ingestion boundary. Any non-numeric value
      // (string "0.9", "high", null, undefined, NaN, out-of-range) is normalised
      // to a finite float in [0,1] here; all downstream code trusts by contract.
      // Fallback 0.5 < CONFIDENCE_THRESHOLD → malformed entities are DROPPED.
      const rawConf = entity.confidence;
      entity.confidence = coerceConfidence01(rawConf);
      if (rawConf !== entity.confidence) {
        recordCounter("entity_confidence_coerced", 1, {
          labels: { model: /^[^\s=]+$/.test(model) ? model : "unknown" },
        });
      }
      if (entity.confidence < CONFIDENCE_THRESHOLD) {
        continue;
      }
      passed.push(entity);
    }
    return passed;
  } catch {
    recordEntityDrop("parse_error", model);
    return [];
  }
}
