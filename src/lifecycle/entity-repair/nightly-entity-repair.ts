// Nightly demand-driven entity repair (Rúnir-b40x.4) — Tier 1 of the nightly
// enrichment program.
//
// The recall entity leg persists every FAILED mention (retrieval_trace
// .entity_misses, b40x.2). This job aggregates yesterday's failures —
// frequency-ranked REAL demand, not speculative re-scanning — and dispatches
// each to the cheapest repair that would have made the query succeed:
//
//   already_resolved  — resolves now (fixed since; e.g. by promotion)        → verify only
//   session_scoped    — exists as a session stub; user-scope lookup misses   → promoteSessionEntities
//   alias_added       — exactly one user canonical is a prefix-relative      → add the mention as alias
//   reextracted       — absent, but the day's raw turns contain the mention  → targeted extractEntities
//                       on just those turns through the EXISTING arbitration
//   no_evidence       — not in the day's text either                         → junk/filler-word suggestion
//                       (report-only: ranking-profile edits stay user-owned)
//   links_filtered    — entity matched but its linked memories were filtered → report-only (scope semantics)
//
// VERIFICATION IS THE POINT: after repairs, every processed mention is
// re-resolved (name+alias, user scope) and the per-mention before/after lands
// in an entity_repair_run report row — improvement by construction, not hope.
//
// Bounded by design: top maxMentions per run, maxReextractions LLM calls
// (gemini-flash-lite via the gateway ≈ $1e-5/call).

import type { SurrealClient } from "../../storage/surreal/surreal-store";
import { extractId } from "../../storage/surreal/surreal-store";
import {
  addEntityAliases,
  findEntitiesByAliases,
  findEntitiesByNames,
} from "../../entities/entity-store";
import { extractEntities } from "../../entities/entity-extractor";
import { arbitrateEntity } from "../../entities/entity-arbitrator";
import { promoteSessionEntities } from "../../lifecycle/semion/entity-consolidation";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export type RepairClass =
  | "already_resolved"
  | "session_scoped"
  | "alias_added"
  | "reextracted"
  | "no_evidence"
  | "links_filtered";

export type RepairItem = {
  mention: string;
  missCount: number;
  reasons: string[];
  class: RepairClass;
  detail?: string;
  resolvedAfter: boolean;
};

export type EntityRepairReport = {
  userId: string;
  ranAt: string;
  windowSince: string;
  missTraceCount: number;
  uniqueMentions: number;
  processed: number;
  items: RepairItem[];
  junkSuggestions: string[];
  promotionRan: boolean;
  resolvedAfterCount: number;
};

export type EntityRepairLimits = {
  maxMentions: number;
  maxReextractions: number;
};

const DEFAULT_LIMITS: EntityRepairLimits = { maxMentions: 12, maxReextractions: 6 };

export async function ensureEntityRepairSchema(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS entity_repair_run SCHEMALESS;");
  await db.query(`
    DEFINE FIELD IF NOT EXISTS user_id ON TABLE entity_repair_run TYPE string;
    DEFINE FIELD IF NOT EXISTS ran_at ON TABLE entity_repair_run TYPE datetime;
    DEFINE INDEX IF NOT EXISTS idx_entity_repair_user_ran ON TABLE entity_repair_run COLUMNS user_id, ran_at;
  `);
}

type AggregatedMiss = { mention: string; count: number; reasons: Set<string> };

/** Frequency-ranked unique failed mentions from the window's retrieval traces. */
export async function aggregateEntityMisses(
  db: SurrealClient,
  userId: string,
  sinceIso: string,
): Promise<{ traceCount: number; misses: AggregatedMiss[] }> {
  const result = await db.query<any>(
    `SELECT entity_misses FROM retrieval_trace
      WHERE user_id = $userId AND created_at >= <datetime>$sinceIso AND entity_misses != NONE;`,
    { userId, sinceIso },
  );
  const rows = (result[0] ?? []) as Array<{ entity_misses?: Array<{ mention: string; normalized: string; reason: string }> }>;
  const byNormalized = new Map<string, AggregatedMiss>();
  for (const row of rows) {
    for (const miss of row.entity_misses ?? []) {
      const key = miss.normalized;
      if (!key || key.length < 3) continue;
      const entry = byNormalized.get(key) ?? { mention: key, count: 0, reasons: new Set<string>() };
      entry.count += 1;
      entry.reasons.add(miss.reason);
      byNormalized.set(key, entry);
    }
  }
  const misses = [...byNormalized.values()].sort((a, b) => b.count - a.count);
  return { traceCount: rows.length, misses };
}

async function resolvesAtUserScope(db: SurrealClient, mention: string, userId: string): Promise<boolean> {
  const [byName, byAlias] = await Promise.all([
    findEntitiesByNames(db, [mention], userId, "user"),
    findEntitiesByAliases(db, [mention], userId, "user"),
  ]);
  return byName.length > 0 || byAlias.length > 0;
}

async function existsAsSessionStub(db: SurrealClient, mention: string, userId: string): Promise<boolean> {
  const [byName, byAlias] = await Promise.all([
    findEntitiesByNames(db, [mention], userId, "session"),
    findEntitiesByAliases(db, [mention], userId, "session"),
  ]);
  return byName.length > 0 || byAlias.length > 0;
}

/** Conservative alias candidate: EXACTLY ONE user canonical whose nameNorm is a
 *  prefix-relative of the mention, where BOTH strings are >= 4 chars AND the
 *  shorter is at least half the longer. One junk alias poisons matching
 *  forever — prefer no_evidence over a speculative attach. The length-ratio
 *  guard exists because the first live run attached "current status" as an
 *  alias of the entity "C": a 1-char nameNorm makes prefix matching trivially
 *  true ("surreal"→"surrealdb" 0.78 and "bramblefort"→"bramblefort migration" 0.52 pass; "c"→"current status" 0.07 and "status"→"status project" 0.43 die). */
async function findUniqueAliasCandidate(
  db: SurrealClient,
  mention: string,
  userId: string,
): Promise<{ entityId: string; canonicalName: string } | null> {
  if (mention.length < 4) return null;
  const result = await db.query<any>(
    `SELECT id, canonicalName, nameNorm FROM entities
      WHERE userId = $userId AND scope = 'user'
      AND string::len(nameNorm) >= 4
      AND (string::starts_with(nameNorm, $mention) OR string::starts_with($mention, nameNorm));`,
    { userId, mention },
  );
  const rows = (result[0] ?? []) as Array<{ id: unknown; canonicalName: string; nameNorm: string }>;
  const real = rows.filter((r) => {
    if (r.nameNorm === mention) return false;
    const shorter = Math.min(r.nameNorm.length, mention.length);
    const longer = Math.max(r.nameNorm.length, mention.length);
    return shorter / longer >= 0.5;
  });
  if (real.length !== 1) return null;
  return { entityId: extractId(real[0].id), canonicalName: real[0].canonicalName };
}

type TurnHit = { session_id: string; turn_index: number; content: string };

async function findMentionInTurns(
  db: SurrealClient,
  mention: string,
  userId: string,
  sinceIso: string,
): Promise<TurnHit[]> {
  const result = await db.query<any>(
    `SELECT session_id, turn_index, content FROM session_turn
      WHERE user_id = $userId AND created_at >= <datetime>$sinceIso
      AND string::contains(string::lowercase(content), $mention)
      ORDER BY session_id, turn_index LIMIT 3;`,
    { userId, mention, sinceIso },
  );
  return (result[0] ?? []) as TurnHit[];
}

export async function runNightlyEntityRepair(deps: {
  db: SurrealClient;
  userId: string;
  apiKey: string;
  sinceIso?: string;
  limits?: Partial<EntityRepairLimits>;
  sourceProject?: string;
  logger?: (msg: string) => void;
}): Promise<EntityRepairReport> {
  const { db, userId, apiKey, logger } = deps;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const sinceIso = deps.sinceIso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const ranAt = new Date().toISOString();

  const { traceCount, misses } = await aggregateEntityMisses(db, userId, sinceIso);
  const top = misses.slice(0, limits.maxMentions);
  logger?.(`entity-repair: ${userId} window>=${sinceIso} traces=${traceCount} uniqueMentions=${misses.length} processing=${top.length}`);

  const items: RepairItem[] = [];
  let reextractionsUsed = 0;
  let anySessionStub = false;

  // Pass 1: classify + cheap repairs (alias adds; mark stubs for promotion).
  for (const miss of top) {
    const reasons = [...miss.reasons];
    if (reasons.every((r) => r !== "no_entity_match")) {
      items.push({ mention: miss.mention, missCount: miss.count, reasons, class: "links_filtered", resolvedAfter: false });
      continue;
    }
    if (await resolvesAtUserScope(db, miss.mention, userId)) {
      items.push({ mention: miss.mention, missCount: miss.count, reasons, class: "already_resolved", resolvedAfter: true });
      continue;
    }
    if (await existsAsSessionStub(db, miss.mention, userId)) {
      anySessionStub = true;
      items.push({ mention: miss.mention, missCount: miss.count, reasons, class: "session_scoped", resolvedAfter: false });
      continue;
    }
    const aliasCandidate = await findUniqueAliasCandidate(db, miss.mention, userId);
    if (aliasCandidate) {
      await addEntityAliases(db, aliasCandidate.entityId, [miss.mention]);
      items.push({
        mention: miss.mention, missCount: miss.count, reasons,
        class: "alias_added", detail: `→ ${aliasCandidate.canonicalName}`, resolvedAfter: false,
      });
      continue;
    }
    const turnHits = await findMentionInTurns(db, miss.mention, userId, sinceIso);
    if (turnHits.length > 0 && reextractionsUsed < limits.maxReextractions) {
      reextractionsUsed += 1;
      const window = turnHits.map((t) => ({ role: "user" as const, content: t.content.slice(0, 4000) }));
      try {
        const mentions = await extractEntities(window, apiKey);
        let upserted = 0;
        for (const m of mentions) {
          try {
            await arbitrateEntity(db, m, userId, "session", turnHits[0].session_id, deps.sourceProject ?? "entity-repair");
            upserted += 1;
          } catch (err) {
            logger?.(`entity-repair: arbitrate failed for ${m.name}: ${String(err).slice(0, 120)}`);
          }
        }
        if (upserted > 0) anySessionStub = true;
        items.push({
          mention: miss.mention, missCount: miss.count, reasons,
          class: "reextracted", detail: `${mentions.length} entities from ${turnHits.length} turn(s)`, resolvedAfter: false,
        });
      } catch (err) {
        items.push({
          mention: miss.mention, missCount: miss.count, reasons,
          class: "no_evidence", detail: `re-extract failed: ${String(err).slice(0, 100)}`, resolvedAfter: false,
        });
      }
      continue;
    }
    items.push({ mention: miss.mention, missCount: miss.count, reasons, class: "no_evidence", resolvedAfter: false });
  }

  // Pass 2: one idempotent promotion sweep covers every session-scoped stub
  // (the pre-existing ones AND the just-re-extracted ones).
  let promotionRan = false;
  if (anySessionStub) {
    try {
      await promoteSessionEntities(db, userId);
      promotionRan = true;
    } catch (err) {
      logger?.(`entity-repair: promotion sweep failed: ${String(err).slice(0, 160)}`);
    }
  }

  // Pass 3: verification — the report's load-bearing column.
  for (const item of items) {
    if (item.class === "links_filtered") continue;
    item.resolvedAfter = await resolvesAtUserScope(db, item.mention, userId);
  }

  const junkSuggestions = items
    .filter((i) => i.class === "no_evidence" && i.missCount >= 3)
    .map((i) => i.mention);

  const report: EntityRepairReport = {
    userId,
    ranAt,
    windowSince: sinceIso,
    missTraceCount: traceCount,
    uniqueMentions: misses.length,
    processed: items.length,
    items,
    junkSuggestions,
    promotionRan,
    resolvedAfterCount: items.filter((i) => i.resolvedAfter).length,
  };

  try {
    await db.query(
      `CREATE type::record('entity_repair_run', $id) CONTENT {
         user_id: $userId, ran_at: <datetime>$ranAt, window_since: <datetime>$windowSince,
         miss_trace_count: $missTraceCount, unique_mentions: $uniqueMentions,
         processed: $processed, items: $items, junk_suggestions: $junkSuggestions,
         promotion_ran: $promotionRan, resolved_after_count: $resolvedAfterCount
       };`,
      {
        id: randomUUID(), userId, ranAt, windowSince: sinceIso,
        missTraceCount: traceCount, uniqueMentions: misses.length,
        processed: items.length, items, junkSuggestions,
        promotionRan, resolvedAfterCount: report.resolvedAfterCount,
      },
    );
  } catch (err) {
    logger?.(`entity-repair: report persist failed: ${String(err).slice(0, 160)}`);
  }

  logger?.(`entity-repair: ${userId} done — processed=${items.length} resolvedAfter=${report.resolvedAfterCount} promotion=${promotionRan} junkSuggestions=${junkSuggestions.length}`);
  return report;
}

/** Scheduler gate: runs at most once per ~22h per user, during the configured
 *  night hour (local), only for users with misses in the window. Called from
 *  the hourly consolidation tick; all failures degrade to a log line. */
export async function maybeRunNightlyEntityRepair(
  db: SurrealClient,
  apiKey: string,
  logger?: (msg: string) => void,
): Promise<void> {
  const nightHour = Number(process.env.RUNIR_ENTITY_REPAIR_HOUR ?? "3");
  if (new Date().getHours() !== nightHour) return;
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const usersResult = await db.query<any>(
    `SELECT user_id, count() FROM retrieval_trace
      WHERE created_at >= <datetime>$sinceIso AND entity_misses != NONE
      GROUP BY user_id;`,
    { sinceIso },
  );
  const users = ((usersResult[0] ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  for (const userId of users) {
    const lastRun = await db.query<any>(
      `SELECT ran_at FROM entity_repair_run WHERE user_id = $userId ORDER BY ran_at DESC LIMIT 1;`,
      { userId },
    );
    const last = ((lastRun[0] ?? []) as Array<{ ran_at: string }>)[0]?.ran_at;
    if (last && Date.now() - Date.parse(String(last)) < 22 * 3600 * 1000) continue;
    try {
      await runNightlyEntityRepair({ db, userId, apiKey, sinceIso, logger });
    } catch (err) {
      logger?.(`entity-repair: nightly run failed for ${userId}: ${String(err).slice(0, 160)}`);
    }
    // Tier 2 (b40x.5): the LangExtract deep sweep over the user's raw day
    // turns. OPT-IN (RUNIR_LANGEXTRACT_SWEEP=1) and only when its venv exists
    // — the service must never depend on the Python environment being healthy.
    runLangextractSweep(userId, logger);
  }
}

/** Fire-and-forget spawn of the Tier-2 deep sweep (scripts/nightly/
 *  langextract_entity_sweep.py). Inherits the service env (gateway key,
 *  SURREAL_*, MAINTENANCE_SECRET). 15-minute hard kill. */
export function runLangextractSweep(userId: string, logger?: (msg: string) => void): void {
  if (process.env.RUNIR_LANGEXTRACT_SWEEP !== "1") return;
  const repoRoot = process.cwd();
  const python = resolvePath(repoRoot, ".omx/langextract-venv/bin/python");
  const script = resolvePath(repoRoot, "scripts/nightly/langextract_entity_sweep.py");
  if (!existsSync(python) || !existsSync(script)) {
    logger?.(`entity-repair: langextract sweep skipped — venv or script missing (${python})`);
    return;
  }
  execFile(python, [script, "--user-id", userId], { timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      logger?.(`entity-repair: langextract sweep failed for ${userId}: ${String(err).slice(0, 160)} ${String(stderr).slice(0, 200)}`);
      return;
    }
    const tail = stdout.trim().split("\n").slice(-3).join(" | ");
    logger?.(`entity-repair: langextract sweep done for ${userId}: ${tail.slice(0, 300)}`);
  });
}
