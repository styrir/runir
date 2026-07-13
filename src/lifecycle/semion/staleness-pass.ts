import { extractId, SurrealClient, supersedeMemory } from "../../storage/surreal/surreal-store.js";
import { wouldCreateCycle } from "./dag-guard.js";
import { deriveStatementKey } from "../../storage/writes/write-arbitrator.js";
import type { MemoryRecordTable, MemoryScope, SimilarCandidate } from "../../domain/memory/types.js";
import { PRIMARY_MEMORY_TABLE } from "../../domain/memory/types.js";
import { extractorJsonMode } from "../../capture/extraction/capture.js";
import { recordPipelineDrop } from "../../obs/counters.js";
import { resolveLlmBaseUrl, resolveLlmTimeoutMs } from "../../shared/config.js";

// flash-lite per the 2026-06-12 user decision: the d4xz A/B showed flash-lite
// wins the service task class, and the last gpt-5.4-mini service role was
// retired (live staleness-prompt smoke verified before deploy).
// RUNIR_STALENESS_MODEL overrides.
function getStalenessModel(): string {
  return process.env.RUNIR_STALENESS_MODEL ?? "vertex/gemini-3.1-flash-lite@us";
}

/** Record a staleness LLM-call failure on the structured-stderr counter seam.
 *  A failed call returns 0 supersessions — indistinguishable on the surface
 *  from "genuinely nothing stale" — so stale/contradicted memories silently
 *  remain active and queryable. Fully guarded; observability must not throw. */
function recordStalenessDrop(reason: string, model: string): void {
  // imaf.9: unified counter — stage=staleness; malformed_entry is the one
  // per-ELEMENT drop (a unit inside an otherwise-valid reply), the rest lose
  // the whole batch.
  recordPipelineDrop("staleness", reason === "malformed_entry" ? "element" : "batch", reason, model);
}

interface StalenessFact {
  text: string;
  confidence: number;
  replacementMemoryId: string;
}

interface StalenessPassOpts {
  db: SurrealClient;
  userId: string;
  scope: MemoryScope;
  sessionId?: string;
  facts: StalenessFact[];
  apiKey: string;
  embedText: (text: string) => Promise<number[]>;
  logger?: (msg: string) => void;
  // Rúnir-ekos B4: defaults to the current-era table, never the legacy one.
  tableName?: MemoryRecordTable;
}

interface Candidate {
  id: string;
  text: string;
  userId: string;
  scope: string;
}

interface StaleEntry {
  existingId: string;
  reason: string;
  supersededByNewFactIndex: number;
}

function normalizeCandidateId(rawId: unknown): string {
  return extractId(rawId)
    .replace(/[⟨⟩]/g, "")
    .trim();
}

function buildExcludeClause(excludeIds: string[], tableName: MemoryRecordTable): string {
  const normalizedIds = Array.from(new Set(
    excludeIds
      .map((id) => normalizeCandidateId(id))
      .filter(Boolean),
  ));
  if (normalizedIds.length === 0) return "";

  const recordIds = normalizedIds.map((id) =>
    `type::record('${tableName}', '${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`,
  ).join(", ");
  return `AND id NOT IN [${recordIds}]`;
}

function parseStalenessEntries(text: string): StaleEntry[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0]?.trim(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { stale?: StaleEntry[] };
      if (Array.isArray(parsed.stale)) return parsed.stale;
    } catch {
      // Try the next extraction strategy.
    }
  }

  return null;
}

// ── Tier 1: BM25 candidate search ─────────────────────────────────────
async function bm25Search(
  db: SurrealClient,
  fact: StalenessFact,
  userId: string,
  scope: MemoryScope,
  excludeIds: string[],
  tableName: MemoryRecordTable,
): Promise<Candidate[]> {
  const subjectKey = deriveStatementKey(fact.text).split(/\s+/).slice(0, 8).join(" ");
  const uniqueTokens = Array.from(new Set(subjectKey.toLowerCase().split(/\s+/).filter(Boolean)));

  if (uniqueTokens.length < 2) return [];

  const fulltextQuery = uniqueTokens
    .map((token) => `"${token.replace(/"/g, "\\\"")}"`)
    .join(" OR ");
  const escapedQuery = fulltextQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const excludeClause = buildExcludeClause(excludeIds, tableName);

  const sql = `SELECT id, text_norm AS text, payload.userId AS userId, payload.scope AS scope
    FROM ${tableName}
    WHERE text_norm @0@ '${escapedQuery}'
    AND payload.userId = $userId
    AND payload.scope = $scope
    AND (active = NONE OR active = true)
    ${excludeClause}
    LIMIT 10`;

  const results = await db.query<Candidate>(sql, { userId, scope });
  return (results[0] ?? []).map((candidate) => ({
    ...candidate,
    id: normalizeCandidateId(candidate.id),
  }));
}

// ── Tier 2: Vector similarity fallback ─────────────────────────────────
async function vectorSearch(
  db: SurrealClient,
  fact: StalenessFact,
  userId: string,
  scope: MemoryScope,
  excludeIds: string[],
  embedText: (text: string) => Promise<number[]>,
  tableName: MemoryRecordTable,
): Promise<Candidate[]> {
  const embedding = await embedText(fact.text);

  const excludeClause = buildExcludeClause(excludeIds, tableName);

  const sql = `SELECT id, text_norm AS text, payload.userId AS userId, payload.scope AS scope,
      vector::similarity::cosine(embedding, $embedding) AS score
    FROM ${tableName}
    WHERE payload.userId = $userId
    AND payload.scope = $scope
    AND (active = NONE OR active = true)
    ${excludeClause}
    AND vector::similarity::cosine(embedding, $embedding) >= 0.75
    ORDER BY score DESC
    LIMIT 10`;

  const results = await db.query<Candidate>(sql, { userId, scope, embedding });
  return (results[0] ?? []).map((candidate) => ({
    ...candidate,
    id: normalizeCandidateId(candidate.id),
  }));
}

// ── Core staleness logic (no lock) ─────────────────────────────────────
export async function runStalenessCoreNoLock(
  opts: StalenessPassOpts,
): Promise<{ checked: number; superseded: number }> {
  const { db, userId, scope, facts, apiKey, embedText, logger } = opts;
  const tableName = opts.tableName ?? PRIMARY_MEMORY_TABLE;

  // Global scope is consolidation-only
  if (scope === "global") {
    return { checked: 0, superseded: 0 };
  }

  // Collect candidates across all facts
  const allCandidates = new Map<string, Candidate>();
  const excludeIds = facts
    .map((f) => f.replacementMemoryId)
    .filter(Boolean);

  for (const fact of facts) {
    // Tier 1: BM25
    const bm25Results = await bm25Search(db, fact, userId, scope, excludeIds, tableName);

    if (bm25Results.length === 0) {
      // Tier 2: Vector fallback
      const vectorResults = await vectorSearch(
        db, fact, userId, scope, excludeIds, embedText, tableName,
      );
      for (const c of vectorResults) {
        allCandidates.set(c.id, c);
      }
    } else {
      for (const c of bm25Results) {
        allCandidates.set(c.id, c);
      }
    }
  }

  const candidates = Array.from(allCandidates.values());

  if (candidates.length === 0) {
    logger?.("memory-hybrid: staleness pass found 0 candidates — skipping LLM");
    return { checked: 0, superseded: 0 };
  }

  // ── LLM staleness query ──────────────────────────────────────────────
  const newFactsBlock = facts
    .map((f, i) => `[N${i}] ${f.text}`)
    .join("\n");
  const existingBlock = candidates
    .map((c, i) => `[E${i}] (id: ${c.id}) ${c.text}`)
    .join("\n");

  const prompt = `You are a memory staleness detector. Given a set of NEW facts and a set of EXISTING memories, determine which existing memories are now stale, outdated, or contradicted by the new facts.

NEW FACTS:
${newFactsBlock}

EXISTING MEMORIES:
${existingBlock}

For each existing memory that is now stale, return its id and the index of the new fact that makes it stale. Return ONLY valid JSON:
{"stale": [{"existingId": "...", "reason": "...", "supersededByNewFactIndex": 0}, ...]}

If no existing memories are stale, return {"stale": []}.`;

  let response: Response;
  // Abort timer (imaf.8 follow-through): the bare fetch could hang the whole
  // staleness pass; an abort rejects the fetch and lands on the existing
  // fetch_error drop path. Timer always cleared.
  const controller = new AbortController();
  const fetchTimer = setTimeout(() => controller.abort(), resolveLlmTimeoutMs());
  try {
    response = await fetch(`${resolveLlmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getStalenessModel(),
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
        // JSON mode (gated to openai/*, no require_parameters): the prompt
        // mandates {"stale":[...]}, so json_object forces an unfenced parseable
        // object. See extractorJsonMode().
        ...(extractorJsonMode(getStalenessModel()) ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // The fetch was previously unwrapped — a network/abort error threw out of
    // the staleness pass; a failure leaves stale/contradicted memories active.
    logger?.(`memory-hybrid: staleness LLM fetch error: ${err instanceof Error ? err.message : String(err)}`);
    recordStalenessDrop("fetch_error", getStalenessModel());
    return { checked: candidates.length, superseded: 0 };
  } finally {
    clearTimeout(fetchTimer);
  }

  if (!response.ok) {
    logger?.(`memory-hybrid: staleness LLM call failed (${response.status})`);
    recordStalenessDrop("http_not_ok", getStalenessModel());
    return { checked: candidates.length, superseded: 0 };
  }

  // Wrap response.json(): a non-JSON HTTP body would otherwise throw.
  let body: {
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ type: string; text: string }>;
  } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch (err) {
    logger?.(`memory-hybrid: staleness response.json() failed: ${err instanceof Error ? err.message : String(err)}`);
    recordStalenessDrop("http_json_error", getStalenessModel());
    return { checked: candidates.length, superseded: 0 };
  }
  // body?. : a null JSON body (JSON.parse("null")) would throw on .choices.
  // Coerce to a string: a non-string `content` (provider schema drift) flows
  // past `?? "{}"` (which only catches null/undefined) and would make
  // parseStalenessEntries' text.trim() throw out of the staleness pass. A
  // non-string coerces to "{}" → parseStalenessEntries → null → invalid_json.
  const rawContent = body?.choices?.[0]?.message?.content ?? body?.content?.[0]?.text;
  const text = typeof rawContent === "string" ? rawContent : "{}";

  const staleEntries = parseStalenessEntries(text);
  if (staleEntries === null) {
    logger?.("memory-hybrid: staleness LLM returned invalid JSON");
    recordStalenessDrop("invalid_json", getStalenessModel());
    return { checked: candidates.length, superseded: 0 };
  }

  // ── Process stale entries ────────────────────────────────────────────
  let superseded = 0;

  for (const entry of staleEntries) {
    // Per-entry isolation: a null/non-object entry from valid JSON (e.g.
    // {"stale":[null]}) would throw on `entry.supersededByNewFactIndex` and
    // escape the staleness pass. Skip malformed entries, keep the valid ones.
    if (!entry || typeof entry !== "object") {
      logger?.("memory-hybrid: staleness skipping malformed (non-object) entry");
      recordStalenessDrop("malformed_entry", getStalenessModel());
      continue;
    }
    // Validate the index as a real array index BEFORE facts[...]: a non-integer
    // like "length"/"map"/"__proto__" from valid JSON resolves to a truthy ARRAY
    // PROPERTY (not a fact), passes the `!fact` check, and then `fact.text` is
    // undefined → reaches upsertMemory which throws "text must be non-empty".
    const idx = entry.supersededByNewFactIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= facts.length) {
      logger?.(`memory-hybrid: staleness entry references invalid fact index ${String(idx)}`);
      recordStalenessDrop("malformed_entry", getStalenessModel());
      continue;
    }
    // existingId must be a string: a non-string (e.g. ["old-1"]) stringifies to a
    // valid id for the candidate lookup but the RAW value reaches the final DB
    // write ({ id: entry.existingId }) and throws. Require string up front so
    // every downstream use (lookup + write) is safe.
    if (typeof entry.existingId !== "string") {
      logger?.("memory-hybrid: staleness entry has a non-string existingId");
      recordStalenessDrop("malformed_entry", getStalenessModel());
      continue;
    }
    const fact = facts[idx];
    if (!fact) {
      logger?.(`memory-hybrid: staleness entry references invalid fact index ${idx}`);
      continue;
    }

    const normalizedExistingId = normalizeCandidateId(entry.existingId);
    const candidate = candidates.find((c) => c.id === normalizedExistingId);
    if (!candidate) {
      logger?.(`memory-hybrid: staleness entry references unknown candidate ${entry.existingId}`);
      continue;
    }

    // Cycle check
    const replacementId = normalizeCandidateId(fact.replacementMemoryId || crypto.randomUUID());
    if (candidate.id === replacementId) {
      logger?.(`memory-hybrid: skipping self-staleness candidate ${candidate.id}`);
      continue;
    }
    // Rúnir-ekos B-LIVE-2: thread the enclosing function's locally-resolved
    // tableName — the default param on wouldCreateCycle falls back to the
    // legacy "memories" table, which would make the pre-supersede DAG
    // cycle-guard silently walk the wrong table's supersedes chain.
    const cycleDetected = await wouldCreateCycle(db as any, replacementId, candidate.id, userId, tableName);
    if (cycleDetected) {
      logger?.(`memory-hybrid: skipping supersede — cycle detected for ${candidate.id}`);
      continue;
    }

    // Build SimilarCandidate from candidate
    const previous: SimilarCandidate = {
      id: candidate.id,
      l2: candidate.text,
      similarity: 1.0,
      createdAt: new Date().toISOString(),
    };

    const embedding = await embedText(fact.text);

    try {
      await supersedeMemory(
        db,
        previous,
        {
          id: replacementId,
          l2: fact.text,
          userId,
          embedding,
          scope,
          sessionId: opts.sessionId,
          writeSource: "agent_end",
        },
        "llm-generated",
        true,
        "retroactive-staleness",
        tableName,
        { staleSince: new Date().toISOString(), contradictedBy: replacementId },
      );
    } catch (err) {
      logger?.(`memory-hybrid: staleness supersede failed for ${candidate.id}: ${String(err)}`);
      continue;
    }

    superseded++;
  }

  return { checked: candidates.length, superseded };
}

// ── Public entry point with lock wrapper ───────────────────────────────
export async function runStalenessPass(
  opts: StalenessPassOpts,
): Promise<{ checked: number; superseded: number }> {
  const { acquireLock, releaseLock, writeStalenessBacklog } = await import("./lock.js");
  const STALENESS_LOCK_TTL_S = 60;
  const lockKey = `${opts.userId}::${opts.scope}`;

  const holder = await acquireLock(opts.db, lockKey, STALENESS_LOCK_TTL_S);
  if (holder === null) {
    opts.logger?.(`memory-hybrid: staleness pass skipped — lock held for ${lockKey}`);
    await writeStalenessBacklog(opts.db, opts.userId, opts.scope, opts.sessionId, opts.facts);
    return { checked: 0, superseded: 0 };
  }

  try {
    return await runStalenessCoreNoLock(opts);
  } finally {
    await releaseLock(opts.db, lockKey, holder);
  }
}
