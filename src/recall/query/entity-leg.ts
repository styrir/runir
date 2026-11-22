// Entity retrieval leg: query mentions to entities to their linked memories.
// Split out of memory-query.ts (vk-2996).
import { type MemoryRecordTable } from "../../domain/memory/types";
import { RecordId } from "surrealdb";
import { extractId, type SurrealClient } from "../../storage/surreal/surreal-store";
import type { ScopeFilter } from "./scope-predicate";
import {
  findEntitiesByAliases,
  findEntitiesByNames,
  findEntityByName,
  getSupportingMemoryIdsBatch,
} from "../../entities/entity-store";
import { normalizeEntityName } from "../../entities/entity-arbitrator";
import { EMPTY_PROFILE } from "../policy/ranking-profile.js";
import type { MemoryScope } from "../../domain/memory/types";
import { BM25_STOPWORDS, tokenizeText } from "./query-text.js";
import type { EntityRetrievalTraceMatch, EntityLookupScope, EntityRow } from "./retrieval-types.js";

const MAX_ENTITY_QUERY_CANDIDATES = 16;
const MAX_ENTITY_MATCHES_PER_CANDIDATE = 6;
const MAX_ENTITY_LINKED_IDS_PER_MATCH = 25;
const MAX_ENTITY_ROWS = 50;
// Cap concurrent entity prefetch fan-out: many candidates × matches could otherwise
// fire ~candidates×MAX_ENTITY_MATCHES_PER_CANDIDATE queries at once and overwhelm the
// shared SurrealDB connection. 8-wide keeps the small common case fully parallel while
// bounding the tail (Rúnir-yxwe Part B).
// Entity-mention filler words are tenant data (Rúnir-mmg2): they're tuned against
// the runir tenant's own corpus + LoCoMo fixtures, so they live in a per-tenant
// ranking profile and are passed into entityMentionCandidates as a parameter.
// With no profile (fresh tenant) the set is empty → only generic BM25 stopwords
// filter candidates. See src/recall/policy/ranking-profile.ts.

const MAX_ENTITY_MENTION_TOKENS = 4;

function normalizeLinkedMemoryId(memoryId: string, tableName: MemoryRecordTable): string | null {
  const raw = String(memoryId);
  const withoutTable = raw.startsWith(`${tableName}:`) ? raw.slice(tableName.length + 1) : raw;
  const withoutBrackets = withoutTable.replace(/^⟨/, "").replace(/⟩$/, "");
  return withoutBrackets.length > 0 ? withoutBrackets : null;
}

export function linkedMemoryRecordIds(linkedIds: string[], tableName: MemoryRecordTable): RecordId<string>[] {
  return [...new Set(linkedIds)]
    .map((id) => normalizeLinkedMemoryId(id, tableName))
    .filter((id): id is string => id !== null)
    .map((id) => new RecordId(tableName, id));
}

async function filterLinkedMemoryIds(
  db: SurrealClient,
  userId: string,
  linkedIds: string[],
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
): Promise<string[]> {
  if (linkedIds.length === 0) {
    return [];
  }
  const uniqueRefs = linkedMemoryRecordIds(linkedIds, tableName);
  // SELECT FROM the record list, NOT `FROM ${table} WHERE id IN $ids`: SurrealDB's
  // planner never converts IN-on-id to point gets — it iterates the whole table
  // evaluating `id INSIDE [...]` per row (~307ms on the live 6.7k-row semiote table
  // vs 6ms for FROM $ids). This query runs once per matched entity in the recall
  // entity leg, so the scan form was the leg's dominant remaining cost.
  const result = await db.query<any>(
    `SELECT id FROM $ids
      WHERE payload.userId = $userId
      ${activeFilter}
      ${scopeFilter.whereClause};`,
    { ids: uniqueRefs, userId, ...scopeFilter.vars },
  );
  // Sort restores the table-scan row order the old `WHERE id IN` form produced
  // (storage iteration = ascending record id). FROM $ids returns rows in list
  // order instead, and this ordering feeds entity-leg insertion ranks → RRF —
  // without the sort, replay diverged on legRanks/rrfFusedIds across 5 probes.
  return (result[0] ?? []).map((row: any) => extractId(row.id)).sort();
}

export function entityMentionCandidates(
  queryText: string,
  entityFillerWords: ReadonlySet<string> = EMPTY_PROFILE.entityFillerWords,
): Array<{ mention: string; normalized: string }> {
  const tokens = tokenizeText(queryText).filter((token) => !BM25_STOPWORDS.has(token));
  const originalTokens = queryText.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const candidates: Array<{ mention: string; normalized: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (mention: string) => {
    const normalized = normalizeEntityName(mention);
    if (normalized.length < 3 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ mention, normalized });
  };

  addCandidate(queryText);
  for (const token of originalTokens) {
    const normalizedToken = normalizeEntityName(token);
    if (/^\p{Lu}/u.test(token) && normalizedToken.length >= 3 && !BM25_STOPWORDS.has(normalizedToken) && !entityFillerWords.has(normalizedToken)) {
      addCandidate(token);
    }
  }
  for (let size = Math.min(MAX_ENTITY_MENTION_TOKENS, tokens.length); size >= 1; size--) {
    for (let start = 0; start <= tokens.length - size; start++) {
      const ngramTokens = tokens.slice(start, start + size);
      if (entityFillerWords.has(ngramTokens[0] ?? "") || entityFillerWords.has(ngramTokens[ngramTokens.length - 1] ?? "")) {
        continue;
      }
      addCandidate(ngramTokens.join(" "));
    }
  }

  const multiToken = candidates.filter((candidate) => candidate.normalized.includes(" "));
  const singleToken = candidates.filter((candidate) => !candidate.normalized.includes(" "));
  const tailBigrams = multiToken.filter((candidate) => candidate.normalized.split(" ").length === 2).slice(-4);
  const properNameSingles = singleToken.filter((candidate) => originalTokens.some((token) => {
    const normalizedToken = normalizeEntityName(token);
    return normalizedToken === candidate.normalized && /^\p{Lu}/u.test(token) && !BM25_STOPWORDS.has(normalizedToken) && !entityFillerWords.has(normalizedToken);
  }));
  const prioritized = [...properNameSingles, ...tailBigrams, ...multiToken.slice(0, MAX_ENTITY_QUERY_CANDIDATES)];
  const uniquePrioritized = prioritized.filter((candidate, idx) => prioritized.findIndex((other) => other.normalized === candidate.normalized) === idx);
  return [
    ...uniquePrioritized.slice(0, MAX_ENTITY_QUERY_CANDIDATES),
    ...singleToken.slice(0, Math.max(0, MAX_ENTITY_QUERY_CANDIDATES - uniquePrioritized.length)),
  ];
}

export function entityLookupScopes(scopeFilter: ScopeFilter, currentSessionId?: string): EntityLookupScope[] {
  const scopeVal = scopeFilter.vars.scopeVal;
  if (scopeVal === "team") {
    return [];
  }
  if (scopeVal === "session") {
    return typeof scopeFilter.vars.sessionId === "string"
      ? [{ scope: "session", sessionId: scopeFilter.vars.sessionId }]
      : [];
  }
  if (scopeFilter.vars.sessionScope === "session" && "sessionId" in scopeFilter.vars) {
    return [{ scope: "user" }, { scope: "session", sessionId: String(scopeFilter.vars.sessionId) }];
  }
  return currentSessionId ? [{ scope: "user" }, { scope: "session", sessionId: currentSessionId }] : [{ scope: "user" }, { scope: "session" }];
}

export async function queryEntityLeg(
  db: SurrealClient,
  userId: string,
  queryText: string,
  limit: number,
  scopeFilter: ScopeFilter,
  activeFilter: string,
  tableName: MemoryRecordTable,
  currentSessionId: string | undefined,
  entityFillerWords: ReadonlySet<string>,
): Promise<{ rows: EntityRow[]; ms: number; traceMatches: EntityRetrievalTraceMatch[] }> {
  const t0 = performance.now();
  const traceMatches: EntityRetrievalTraceMatch[] = [];
  const byMemoryId = new Map<string, EntityRow>();
  const candidates = entityMentionCandidates(queryText, entityFillerWords);
  const scopes = entityLookupScopes(scopeFilter, currentSessionId);

  type EntityMatch = { entity: Awaited<ReturnType<typeof findEntityByName>>[number]; matchedBy: "name" | "alias"; scope: MemoryScope };

  // Phase 1 (batched): ONE name query + ONE alias query per scope covers ALL
  // candidates — 4 queries instead of up to 64. Rows are partitioned back to
  // candidates app-side by exact `nameNorm` equality / `aliasesNorm` membership,
  // the same predicates the per-candidate queries evaluated server-side, so the
  // per-candidate match sets, name-before-alias ordering, and session-scope filter
  // are preserved verbatim. The per-candidate N+1 dominated the leg's wall time
  // once the entity graph was populated: each alias lookup residual-filters the
  // whole (userId, scope) slice (~15–18ms live) and all legs share one serialized
  // DB connection, so 32 of them stacked into seconds under concurrent recalls.
  const normalizedCandidates = candidates.map((candidate) => candidate.normalized);
  const scopeBatches = await Promise.all(scopes.map(async (lookupScope) => {
    const [nameRows, aliasRows] = await Promise.all([
      findEntitiesByNames(db, normalizedCandidates, userId, lookupScope.scope),
      findEntitiesByAliases(db, normalizedCandidates, userId, lookupScope.scope),
    ]);
    return { lookupScope, nameRows, aliasRows };
  }));
  const resolved = candidates.map((candidate) => {
    const entityMatches: EntityMatch[] = [];
    for (const { lookupScope, nameRows, aliasRows } of scopeBatches) {
      const byName = nameRows.filter((entity) => entity.nameNorm === candidate.normalized);
      const byAlias = aliasRows.filter((entity) => (entity.aliasesNorm ?? []).includes(candidate.normalized));
      const scopeMatches = [...byName, ...byAlias].filter((entity) =>
        lookupScope.scope !== "session" || lookupScope.sessionId === undefined || entity.sessionId === lookupScope.sessionId,
      );
      entityMatches.push(
        ...scopeMatches.filter((entity) => byName.includes(entity)).map((entity) => ({ entity, matchedBy: "name" as const, scope: lookupScope.scope })),
        ...scopeMatches.filter((entity) => byAlias.includes(entity)).map((entity) => ({ entity, matchedBy: "alias" as const, scope: lookupScope.scope })),
      );
    }
    return { candidate, entityMatches: entityMatches.slice(0, MAX_ENTITY_MATCHES_PER_CANDIDATE) };
  });

  // Phase 2a (imaf.11 #3): TWO batched queries for the whole match set — one
  // edge traversal for every unique entity, one record-list filter over the
  // union — replacing the per-entity N+1 (previously bounded concurrency 8;
  // the serial form was ~74% of the leg's wall time, Rúnir-yxwe Part B).
  // Per-entity results are reconstructed app-side to stay replay-identical:
  // linked order = the entity's own traversal order (the batched FROM-list
  // traversal walks each record's edges exactly like the single form), and
  // filtered = the entity's deduped linked ids ∩ union survivors, sorted
  // ascending — which equals what the per-entity filterLinkedMemoryIds
  // returned (it deduped and sorted). A batch failure marks EVERY entity
  // failed; the merge below still only throws if it actually REACHES one,
  // preserving the original serial-loop degradation contract (Rúnir-yxwe).
  const uniqueEntityIds = new Set<string>();
  for (const { entityMatches } of resolved) {
    for (const m of entityMatches) uniqueEntityIds.add(extractId(m.entity.id));
  }
  const fetched = new Map<string, { linkedCount: number; filtered: string[] } | { error: unknown }>();
  const entityIdList = [...uniqueEntityIds];
  try {
    const supportingByEntity = await getSupportingMemoryIdsBatch(db, entityIdList);
    const linkedByEntity = new Map<string, string[]>();
    for (const entityId of entityIdList) {
      const linked = (supportingByEntity.get(entityId) ?? [])
        .map((memoryId) => normalizeLinkedMemoryId(memoryId, tableName))
        .filter((memoryId): memoryId is string => memoryId !== null)
        .slice(0, MAX_ENTITY_LINKED_IDS_PER_MATCH);
      linkedByEntity.set(entityId, linked);
    }
    const unionIds = [...new Set([...linkedByEntity.values()].flat())];
    const survivors = new Set(
      unionIds.length === 0
        ? []
        : await filterLinkedMemoryIds(db, userId, unionIds, scopeFilter, activeFilter, tableName),
    );
    for (const entityId of entityIdList) {
      const linked = linkedByEntity.get(entityId) ?? [];
      const filtered = [...new Set(linked)].filter((memoryId) => survivors.has(memoryId)).sort();
      fetched.set(entityId, { linkedCount: linked.length, filtered });
    }
  } catch (err) {
    for (const entityId of entityIdList) fetched.set(entityId, { error: err });
  }

  // Phase 2b: deterministic sequential merge — reads from the prefetch map, so it
  // preserves the exact per-candidate seenEntityIds dedup, the MAX_ENTITY_ROWS cap,
  // scoring, and trace reasons of the original serial loop.
  for (const { candidate, entityMatches } of resolved) {
    if (entityMatches.length === 0) {
      traceMatches.push({
        queryMention: candidate.mention,
        normalizedMention: candidate.normalized,
        linkedMemoryIds: [],
        ignoredReason: "no_entity_match",
      });
      continue;
    }
    const seenEntityIds = new Set<string>();
    for (const match of entityMatches) {
      if (byMemoryId.size >= MAX_ENTITY_ROWS) {
        break;
      }
      const entityId = extractId(match.entity.id);
      if (seenEntityIds.has(entityId)) {
        continue;
      }
      seenEntityIds.add(entityId);

      const entry = fetched.get(entityId) ?? { linkedCount: 0, filtered: [] };
      if ("error" in entry) {
        // The original serial loop awaited this fetch inline, so a failure on a
        // processed entity degraded the whole entity leg. Preserve that here.
        throw entry.error;
      }
      const { linkedCount, filtered: filteredLinkedMemoryIds } = entry;
      const scoreChanges: Array<{ memoryId: string; before: number; boost: number; after: number }> = [];
      if (linkedCount === 0 || filteredLinkedMemoryIds.length === 0) {
        traceMatches.push({
          queryMention: candidate.mention,
          normalizedMention: candidate.normalized,
          linkedMemoryIds: [],
          ignoredReason: linkedCount === 0 ? "no_linked_memories" : "linked_memories_filtered",
        });
        continue;
      }

      traceMatches.push({
        queryMention: candidate.mention,
        normalizedMention: candidate.normalized,
        entityId,
        canonicalName: match.entity.canonicalName,
        matchedBy: match.matchedBy,
        scope: match.scope,
        linkedMemoryIds: filteredLinkedMemoryIds,
        scoreChanges,
      });

      for (const memoryId of filteredLinkedMemoryIds) {
        if (!byMemoryId.has(memoryId) && byMemoryId.size >= MAX_ENTITY_ROWS) {
          break;
        }
        const existing = byMemoryId.get(memoryId) ?? {
          id: `${tableName}:${memoryId}`,
          rank: byMemoryId.size + 1,
          score: 0,
          matchedEntities: [],
          linkedMemoryIds: [memoryId],
        };
        const before = existing.score;
        const boost = Math.max(0.1, match.entity.confidence ?? 0.5);
        existing.score += boost;
        existing.matchedEntities.push(match.entity.canonicalName);
        scoreChanges.push({ memoryId, before, boost, after: existing.score });
        byMemoryId.set(memoryId, existing);
      }
    }
  }

  const rows = Array.from(byMemoryId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  return { rows, ms: performance.now() - t0, traceMatches };
}

/** Empty entity-leg result carrying a per-candidate trace marker, shared by the
 *  entity-leg catch (entity_lookup_failed) and the per-leg timeout fallback
 *  (entity_timeout) so a degraded entity leg is observable, not silent (Rúnir-yxwe). */
export function emptyEntityLeg(
  queryText: string,
  reason: string,
  entityFillerWords: ReadonlySet<string>,
): { rows: EntityRow[]; ms: number; traceMatches: EntityRetrievalTraceMatch[] } {
  return {
    rows: [],
    ms: 0,
    traceMatches: entityMentionCandidates(queryText, entityFillerWords).map((candidate) => ({
      queryMention: candidate.mention,
      normalizedMention: candidate.normalized,
      linkedMemoryIds: [],
      ignoredReason: reason,
    })),
  };
}
