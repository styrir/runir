import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import type { Bm25CorpusStats, MemoryScope } from "../../domain/memory/types.js";
import { PRIMARY_MEMORY_TABLE } from "../../domain/memory/types.js";
import { exactValueTokens } from "../../domain/memory/exact-qa.js";
import { deleteExpiredRetrievalTraces, promoteSemioteToNoema, resolveTraceRetentionDays } from "../../storage/surreal/phase2-store.js";
import { deleteExpiredSessionTurns, resolveTurnRetentionDays } from "../../storage/surreal/session-turn-store.js";
import { maybeRunNightlyEntityRepair } from "../entity-repair/nightly-entity-repair.js";

export async function ensureConsolidationLogTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS consolidation_log SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE consolidation_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS scope ON TABLE consolidation_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS completed_at ON TABLE consolidation_log TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS deduped_count ON TABLE consolidation_log TYPE int;");
  await db.query("DEFINE FIELD IF NOT EXISTS archived_count ON TABLE consolidation_log TYPE int;");
  await db.query("DEFINE FIELD IF NOT EXISTS backlog_replayed_count ON TABLE consolidation_log TYPE int;");
  await db.query("DEFINE FIELD IF NOT EXISTS run_status ON TABLE consolidation_log TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS error_message ON TABLE consolidation_log TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS sweep_id ON TABLE consolidation_log TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS decay_pruned_count ON TABLE consolidation_log TYPE option<int>;");
  await db.query("DEFINE FIELD IF NOT EXISTS promoted_count ON TABLE consolidation_log TYPE option<int>;");
  await db.query("DEFINE FIELD IF NOT EXISTS continuity_built_count ON TABLE consolidation_log TYPE option<int>;");
  await db.query("DEFINE FIELD IF NOT EXISTS continuity_gaps_count ON TABLE consolidation_log TYPE option<int>;");
  await db.query("DEFINE INDEX IF NOT EXISTS idx_clog_user_scope ON TABLE consolidation_log COLUMNS user_id, scope;");
  await db.query("DEFINE INDEX IF NOT EXISTS idx_clog_completed_at ON TABLE consolidation_log COLUMNS completed_at;");
}

/**
 * consolidation_log retention (#3 ADOPT-NOW). The skipped_no_sessions spam-writer is
 * already gone from source; ongoing growth is just the sparse real-run rows. Retention
 * is RUNIR_CONSOLIDATION_LOG_RETENTION_DAYS (default 90). The sweep EXEMPTS each user's
 * latest sweep — the row getMemoryHealth reads via consolidation_state.last_sweep_id — so
 * a quiet/measurement tenant's only sweep is never pruned regardless of age (Codex Q5:
 * per-user, not a single global latest). NOTE: this forward-looking sweep does NOT clear
 * the historical skipped_no_sessions backlog (those rows are within the retention window);
 * that is a one-time run_status-scoped prune handled separately.
 */
export function resolveConsolidationLogRetentionDays(): number {
  const raw = process.env.RUNIR_CONSOLIDATION_LOG_RETENTION_DAYS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90;
}

export async function deleteExpiredConsolidationLogs(
  db: SurrealClient,
  retentionDays: number,
): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  // Keep, per user, the sweep getMemoryHealth reads — never prune a sweep_id that is
  // any user's current consolidation_state.last_sweep_id, regardless of age.
  const keptClause =
    "sweep_id NOTINSIDE (SELECT VALUE last_sweep_id FROM consolidation_state WHERE last_sweep_id != NONE)";
  const countResults = await db.query<{ n: number }>(
    `SELECT count() AS n FROM consolidation_log
     WHERE completed_at < <datetime>$cutoff AND ${keptClause}
     GROUP ALL;`,
    { cutoff },
  );
  const expired = countResults[0]?.[0]?.n ?? 0;
  if (expired === 0) return 0;
  await db.query(
    `DELETE consolidation_log
     WHERE completed_at < <datetime>$cutoff AND ${keptClause};`,
    { cutoff },
  );
  return expired;
}

export async function ensureConsolidationStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS consolidation_state SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE consolidation_state TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS last_run_at ON TABLE consolidation_state TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS session_count_at_last_run ON TABLE consolidation_state TYPE int;");
  await db.query("DEFINE FIELD IF NOT EXISTS last_sweep_id ON TABLE consolidation_state TYPE option<string>;");
  await db.query("DEFINE INDEX IF NOT EXISTS idx_cs_user ON TABLE consolidation_state COLUMNS user_id UNIQUE;");
}

// Note: ensureStalenessBacklogTable is in lock.ts — re-export it here for convenience
export { ensureStalenessBacklogTable } from "./lock.js";

/**
 * Per-(user, scope) dedup watermark (Rúnir-x46j). `swept_through` is the
 * verbatim payload timestamp (ISO string, JS-written, fixed 3-digit millis)
 * of the last candidate the dedup sweep fully processed. Stored as a string
 * and compared lexicographically app-side against payload.updatedAt/createdAt
 * — a datetime round-trip through SurrealDB would change the fractional
 * precision and break the prefix comparison.
 */
export async function ensureDedupStateTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS dedup_state SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE dedup_state TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS scope ON TABLE dedup_state TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS swept_through ON TABLE dedup_state TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS updated_at ON TABLE dedup_state TYPE datetime;");
  await db.query("DEFINE INDEX IF NOT EXISTS idx_ds_user_scope ON TABLE dedup_state COLUMNS user_id, scope UNIQUE;");
}

async function readDedupWatermark(db: SurrealClient, userId: string, scope: string): Promise<string | null> {
  const results = await db.query<{ swept_through: string }>(
    "SELECT swept_through FROM dedup_state WHERE user_id = $userId AND scope = $scope LIMIT 1;",
    { userId, scope },
  );
  const row = results[0]?.[0];
  return typeof row?.swept_through === "string" && row.swept_through.length > 0 ? row.swept_through : null;
}

async function writeDedupWatermark(db: SurrealClient, userId: string, scope: string, sweptThrough: string): Promise<void> {
  await db.query(
    `UPSERT dedup_state SET
       user_id = $userId,
       scope = $scope,
       swept_through = $sweptThrough,
       updated_at = time::now()
     WHERE user_id = $userId AND scope = $scope;`,
    { userId, scope, sweptThrough },
  );
}

/**
 * Runs the full consolidation pipeline for a single userId/scope pair.
 * Operations: dedup sweep → soft-archive → backlog replay → BM25 stats invalidation → log.
 * Acquires the consolidation lock before operating. Skips on contention.
 */
export async function runConsolidationForScope(
  db: SurrealClient,
  userId: string,
  scope: MemoryScope,
  embedText: (text: string) => Promise<number[]>,
  statsCache: Map<string, Bm25CorpusStats>,
  apiKey: string,
  logger?: (msg: string) => void,
  sweepId?: string,
): Promise<{ deduped: number; archived: number; backlogReplayed: number; decayPruned: number; promoted: number; status: "completed" | "skipped_lock" | "failed" }> {
  const { acquireLock, releaseLock, extendLock } = await import("./lock.js");
  const { runStalenessCoreNoLock } = await import("./staleness-pass.js");
  const { fetchAllActiveMemoriesForScope, softArchiveInactiveOlderThan, supersedeMemory } = await import("../../storage/surreal/surreal-store.js");

  const CONSOLIDATION_LOCK_TTL_S = parseInt(process.env.CONSOLIDATION_LOCK_TTL_S ?? "300");
  const lockKey = `${userId}::${scope}`;

  const holder = await acquireLock(db, lockKey, CONSOLIDATION_LOCK_TTL_S);
  if (holder === null) {
    logger?.(`memory-hybrid: consolidation skipped — lock held for ${lockKey}`);
    await logConsolidationRun(db, userId, scope, 0, 0, 0, "skipped_lock", undefined, undefined, undefined, sweepId);
    return { deduped: 0, archived: 0, backlogReplayed: 0, decayPruned: 0, promoted: 0, status: "skipped_lock" };
  }

  // Heartbeat (Rúnir-x46j): extend the lease at TTL/3 so a run longer than
  // the TTL keeps its lock — the fixed 300s lease used to expire mid-run and
  // the hourly tick started overlapping passes on the same tenant. unref'd so
  // it never holds the process open.
  const heartbeatMs = Math.max(1000, Math.floor((CONSOLIDATION_LOCK_TTL_S * 1000) / 3));
  const heartbeat = setInterval(() => {
    extendLock(db, lockKey, holder, CONSOLIDATION_LOCK_TTL_S)
      .then((extended) => {
        if (!extended) logger?.(`memory-hybrid: consolidation lock lease lost for ${lockKey} — continuing without overlap protection`);
      })
      .catch((err) => logger?.(`memory-hybrid: consolidation lock heartbeat error for ${lockKey}: ${String(err)}`));
  }, heartbeatMs);
  heartbeat.unref?.();

  let deduped = 0;
  let archived = 0;
  let backlogReplayed = 0;
  let decayPruned = 0;
  let promoted = 0;
  let continuityBuilt = 0;
  let gapsDetected = 0;

  try {
    // ── Step 1: Dedup sweep (Rúnir-x46j rewrite) ─────────────────────────────
    // The original sweep recomputed embeddings inside an O(n²) pair loop and
    // had no bound, so a user-scope run at dogfooding scale (~2.4k active
    // semiotes ≈ millions of serial Ollama calls) never completed, eligibility
    // never cleared, and every boot restarted the grind from scratch. Now:
    // embeddings come from the stored rows (embedText is only a per-row
    // fallback), only rows written since the per-(user,scope) dedup watermark
    // are candidates — each compared against the full active set in memory —
    // and the candidate loop is time-budgeted. The watermark advances exactly
    // through the fully processed candidates, so an exhausted budget still
    // LANDS a completed run and the next run resumes where this one stopped.
    const DEDUP_BUDGET_MS = parseInt(process.env.CONSOLIDATION_DEDUP_BUDGET_MS ?? "120000");
    // Single-query snapshot, NOT paginated: a live capture-path supersede
    // during a paged walk left-shifts rows past a LIMIT/START page boundary
    // (the active filter applies before START), silently dropping them from
    // the snapshot — and the watermark below would then exclude them from
    // every future sweep. One statement = one transaction = atomic snapshot.
    const SNAPSHOT_LIMIT = parseInt(process.env.CONSOLIDATION_DEDUP_SNAPSHOT_LIMIT ?? "100000");
    const allMemories: Array<{ id: string; l2: string; similarity: number; createdAt: string; updatedAt?: string; scope?: string; embedding?: number[] }> =
      await fetchAllActiveMemoriesForScope(db, userId, scope, SNAPSHOT_LIMIT, 0, PRIMARY_MEMORY_TABLE);
    if (allMemories.length >= SNAPSHOT_LIMIT) {
      logger?.(`memory-hybrid: dedup snapshot for ${userId}::${scope} TRUNCATED at ${SNAPSHOT_LIMIT} rows — raise CONSOLIDATION_DEDUP_SNAPSHOT_LIMIT`);
    }

    // Resolve every row to a comparable vector ONCE. Stored embeddings win;
    // embedText covers rows without one; rows that still fail are excluded
    // from dedup (nothing to compare) but counted for the log line.
    const vectors = new Map<string, number[]>();
    let fallbackEmbedded = 0;
    let unembeddable = 0;
    for (const mem of allMemories) {
      if (Array.isArray(mem.embedding) && mem.embedding.length > 0) {
        vectors.set(mem.id, mem.embedding);
        continue;
      }
      try {
        const computed = await embedText(mem.l2);
        if (Array.isArray(computed) && computed.length > 0) {
          vectors.set(mem.id, computed);
          fallbackEmbedded++;
        } else {
          unembeddable++;
        }
      } catch (err) {
        unembeddable++;
        logger?.(`memory-hybrid: consolidation dedup embed fallback failed for ${mem.id}: ${String(err)}`);
      }
    }

    const writtenAt = (m: { createdAt: string; updatedAt?: string }): string => m.updatedAt ?? m.createdAt;
    const watermark = await readDedupWatermark(db, userId, scope);
    const candidates = allMemories
      .filter((m) => watermark === null || writtenAt(m) > watermark)
      .sort((a, b) => (writtenAt(a) < writtenAt(b) ? -1 : writtenAt(a) > writtenAt(b) ? 1 : 0));

    const dedupedIds = new Set<string>();
    const deadline = Date.now() + DEDUP_BUDGET_MS;
    // writtenAt of the first candidate NOT fully swept (budget-stopped, or a
    // merge attempt failed). The watermark may only advance to timestamps
    // strictly below this — a failed merge must be retried by a future run.
    let firstUnsweptW: string | null = null;
    let processedCandidates = 0;
    let failedCandidates = 0;
    let budgetExhausted = false;

    for (const candidate of candidates) {
      if (Date.now() >= deadline) {
        budgetExhausted = true;
        if (firstUnsweptW === null) firstUnsweptW = writtenAt(candidate);
        break;
      }
      // Yield between candidates so live recall queries interleave with the
      // sweep instead of queueing behind a long synchronous cosine loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const candidateVec = vectors.get(candidate.id);
      let candidateFailed = false;
      if (candidateVec && !dedupedIds.has(candidate.id)) {
        for (const other of allMemories) {
          if (other.id === candidate.id || dedupedIds.has(other.id)) continue;
          const otherVec = vectors.get(other.id);
          if (!otherVec) continue;
          const cosine = cosineSimilarity(candidateVec, otherVec);
          if (cosine < 0.90) continue;
          // Keep newer, supersede older — same rule as the original pair sweep.
          const older = candidate.createdAt <= other.createdAt ? candidate : other;
          const newer = older === candidate ? other : candidate;
          const newerVec = older === candidate ? otherVec : candidateVec;
          // dnpp guard — VALUE PRESERVATION: the survivor must carry every
          // value token (numbers, caps codes, paths, versions) of the row it
          // replaces. 0.90 cosine is not identity for short template-y claims:
          // live, "reply with exactly the word READY" was deactivated as a
          // duplicate of "...PONG", and per-service port facts merged across
          // services. Distinct facts and value-conflicting updates never merge
          // here (conflicting updates are the write arbitrator's job, with
          // supersedence provenance); a compound that subsumes a single fact's
          // values may still absorb it.
          const olderValues = exactValueTokens(older.l2 ?? "");
          if (olderValues.size > 0) {
            const newerValues = exactValueTokens(newer.l2 ?? "");
            let preserved = true;
            for (const v of olderValues) {
              if (!newerValues.has(v)) { preserved = false; break; }
            }
            if (!preserved) continue;
          }
          try {
            await supersedeMemory(
              db,
              { id: older.id, l2: older.l2, similarity: cosine, createdAt: older.createdAt, scope: older.scope as MemoryScope | undefined },
              {
                id: newer.id,
                l2: newer.l2,
                userId,
                embedding: newerVec,
                metadata: { inactive_reason: "consolidation-dedup" },
                scope: scope,
                writeSource: "session_summary",
              },
              "llm-generated",
              true, // isInternalCaller
              "superseded",
              PRIMARY_MEMORY_TABLE,
            );
            dedupedIds.add(older.id);
            deduped++;
          } catch (err) {
            candidateFailed = true;
            logger?.(`memory-hybrid: consolidation dedup error: ${String(err)}`);
          }
          // A superseded candidate is inactive — stop comparing against it.
          if (dedupedIds.has(candidate.id)) break;
        }
      }
      processedCandidates++;
      if (candidateFailed) {
        failedCandidates++;
        if (firstUnsweptW === null) firstUnsweptW = writtenAt(candidate);
      }
    }

    // Tie-safe advance: park the watermark at the largest candidate timestamp
    // STRICTLY below the first unswept candidate's. Parking ON a timestamp
    // that still has unswept members (same-millisecond cohorts are routine —
    // runPromotionPass stamps one shared updatedAt per pass) would let the
    // strict '>' candidate filter drop them forever. Candidates re-included
    // this way were already swept successfully, so re-processing is a no-op.
    let sweptThrough: string | null = null;
    for (const candidate of candidates) {
      const w = writtenAt(candidate);
      if (firstUnsweptW !== null && w >= firstUnsweptW) break;
      sweptThrough = w;
    }

    if (sweptThrough !== null) {
      await writeDedupWatermark(db, userId, scope, sweptThrough);
    }
    if (candidates.length > 0 || fallbackEmbedded > 0 || unembeddable > 0) {
      logger?.(
        `memory-hybrid: dedup sweep for ${userId}::${scope}: active=${allMemories.length} candidates=${candidates.length} processed=${processedCandidates} merged=${deduped} failed=${failedCandidates} budget_exhausted=${budgetExhausted} fallback_embedded=${fallbackEmbedded} unembeddable=${unembeddable}`,
      );
    }

    // Step 2: Soft-archive inactive memories older than 90 days
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    archived = await softArchiveInactiveOlderThan(db, userId, scope, cutoff, PRIMARY_MEMORY_TABLE);

    // Step 3: Replay staleness backlog
    const backlogResults = await db.query<{
      id: string;
      facts: Array<{ text: string; confidence: number; replacementMemoryId: string }>;
      session_id: string | null;
    }>(
      `SELECT id, facts, session_id FROM staleness_backlog
       WHERE user_id = $userId AND scope = $scope AND status = 'pending';`,
      { userId, scope },
    );
    const backlogEntries = backlogResults[0] ?? [];

    for (const entry of backlogEntries) {
      try {
        await runStalenessCoreNoLock({
          db,
          userId,
          scope,
          sessionId: entry.session_id ?? undefined,
          facts: entry.facts,
          apiKey,
          embedText,
          logger,
          tableName: PRIMARY_MEMORY_TABLE,
        });
        await db.query(
          "UPDATE $id SET status = 'replayed';",
          { id: entry.id },
        );
        backlogReplayed++;
      } catch (err) {
        logger?.(`memory-hybrid: backlog replay error for ${entry.id}: ${String(err)}`);
        await db.query(
          "UPDATE $id SET status = 'failed';",
          { id: entry.id },
        );
      }
    }

    // ── Step 3.4: Stored-memory staleness pass (D1 relocation — Rúnir-y5on/Rúnir-sq3s) ──
    // /hooks/session-end no longer runs any LLM pass (extraction is turn-based-
    // only via /hooks/capture), so the retroactive staleness check that used to
    // ride session-end relocated HERE — reachable from BOTH the scheduled tick
    // (runEligibleUsers → runForUser) and POST /hooks/maintenance (forced run).
    // Stored-memory mode: instead of a session's freshly-extracted facts, the
    // NEW-facts side is the stored semiotes written since the last dedup sweep
    // (the Step-1 `candidates` list, minus rows the sweep just merged away),
    // capped to the newest CONSOLIDATION_STALENESS_RECENT_LIMIT rows.
    // Exactly-once boundary (Codex re-review finding #1): feed ONLY the swept
    // prefix — rows with writtenAt <= sweptThrough, i.e. the rows the dedup
    // watermark just advanced past. A partial sweep (budget-exhausted or
    // failed-merge) parks the watermark BEFORE firstUnsweptW; feeding the
    // unswept tail now would re-feed the same rows on the next run (they stay
    // ahead of the watermark). Unswept rows are fed by whichever future run
    // sweeps them. Runs under the consolidation lock → the no-lock core.
    const STALENESS_RECENT_LIMIT = parseInt(process.env.CONSOLIDATION_STALENESS_RECENT_LIMIT ?? "25");
    if (scope !== "global" && STALENESS_RECENT_LIMIT > 0 && sweptThrough !== null) {
      // `candidates` is sorted ascending by writtenAt — the newest rows are at
      // the tail. Guard l2 defensively: legacy rows can lack a payload text.
      const stalenessBoundary = sweptThrough;
      const recentFacts = candidates
        .filter((m) =>
          !dedupedIds.has(m.id)
          && typeof m.l2 === "string" && m.l2.trim().length > 0
          && writtenAt(m) <= stalenessBoundary)
        .slice(-STALENESS_RECENT_LIMIT)
        .map((m) => ({ text: m.l2, confidence: 1, replacementMemoryId: m.id }));
      if (recentFacts.length > 0) {
        try {
          const stalenessResult = await runStalenessCoreNoLock({
            db,
            userId,
            scope,
            facts: recentFacts,
            apiKey,
            embedText,
            logger,
            // EXPLICIT table (y5on gotcha): the staleness helpers default to
            // the legacy "memories" table; the live store is "semiote"
            // (=== PRIMARY_MEMORY_TABLE).
            tableName: "semiote",
          });
          if (stalenessResult && (stalenessResult.checked > 0 || stalenessResult.superseded > 0)) {
            logger?.(`memory-hybrid: stored-memory staleness pass for ${userId}::${scope}: facts=${recentFacts.length} checked=${stalenessResult.checked} superseded=${stalenessResult.superseded}`);
          }
        } catch (err) {
          // Staleness is best-effort maintenance — never fail the whole
          // consolidation run over it.
          logger?.(`memory-hybrid: stored-memory staleness pass error for ${userId}::${scope}: ${String(err)}`);
        }
      }
    }

    // Step 3.5: Entity consolidation — only runs on the "user" scope pass
    if (scope === "user") {
      try {
        const { promoteSessionEntities } = await import("./entity-consolidation.js");
        const entityResult = await promoteSessionEntities(db, userId, logger);
        logger?.(`memory-hybrid: entity consolidation for ${userId}: promoted=${entityResult.promoted}, merged=${entityResult.merged}`);
      } catch (err) {
        logger?.(`memory-hybrid: entity consolidation error for ${userId}: ${String(err)}`);
      }
    }

    // Step 4: Decay scoring and tier promotion (MIM-70)
    const { runDecayPass, runPromotionPass } = await import("./decay-pass.js");
    const decayResult = await runDecayPass(db, userId, scope, { tableName: PRIMARY_MEMORY_TABLE });
    const promoResult = await runPromotionPass(db, userId, scope, { tableName: PRIMARY_MEMORY_TABLE });
    decayPruned += decayResult.pruned;
    promoted += promoResult.promoted_to_working + promoResult.promoted_to_durable;
    logger?.(`memory-hybrid: decay pass for ${userId}::${scope}: scored=${decayResult.scored} pruned=${decayResult.pruned}`);
    logger?.(`memory-hybrid: promotion pass for ${userId}::${scope}: to_working=${promoResult.promoted_to_working} to_durable=${promoResult.promoted_to_durable}`);

    const promotableResults = await db.query<any>(
      `SELECT * FROM ${PRIMARY_MEMORY_TABLE}
       WHERE payload.userId = $userId
       AND payload.scope = $scope
       AND (active = NONE OR active = true);`,
      { userId, scope },
    );
    let noemaPromoted = 0;
    for (const row of promotableResults[0] ?? []) {
      const promotion = await promoteSemioteToNoema(db, row, embedText);
      if (promotion.promoted) noemaPromoted++;
    }
    if (noemaPromoted > 0) {
      logger?.(`memory-hybrid: noema promotion for ${userId}::${scope}: promoted=${noemaPromoted}`);
    }

    // Step 4.5: Continuity builder (Rúnir-78sy.3) — only on the "user" scope
    // pass (like Step 3.5 entity consolidation). Placed AFTER decay/promotion so
    // it reads post-promotion state, before the Step 5 BM25 invalidation. Own
    // try/catch degrading to a logger line: a builder failure NEVER fails the
    // consolidation run. Runs under the already-held consolidation lock; reads
    // enrolled projects + evidence, writes project_continuity_state via CAS.
    if (scope === "user") {
      try {
        const { runContinuityBuildStep } = await import("./continuity-build.js");
        const continuityResult = await runContinuityBuildStep({ db, userId, apiKey, logger });
        continuityBuilt = continuityResult.built;
        if (continuityResult.projectsConsidered > 0) {
          logger?.(`memory-hybrid: continuity build for ${userId}: considered=${continuityResult.projectsConsidered} built=${continuityResult.built} fallbacks=${continuityResult.fallbacks}`);
        }
      } catch (err) {
        logger?.(`memory-hybrid: continuity build error for ${userId}: ${String(err)}`);
      }
    }

    // Step 4.55: Idle-session janitor (Rúnir-78sy.13, F3) — only on the "user"
    // scope pass, BEFORE Step 4.6 so newly-closed rows are evaluated for gaps
    // in the SAME tick. Universal fallback closer: /hooks/session-end (F2)
    // only fires for clients that register a SessionEnd hook AND successfully
    // POST it; this step catches everything else (crash/kill, clients with no
    // session-end path — codex, hermes, pi). Own try/catch degrading to a
    // logger line: a janitor failure NEVER fails the consolidation run. Runs
    // under the already-held per-user lock; consolidation-scoped, NOT a
    // universal table cleanup (a user never eligible for consolidation keeps
    // zombie rows, same as it never gets gap detection).
    if (scope === "user") {
      try {
        const { runSessionIdleJanitorStep } = await import("./session-janitor.js");
        const janitorResult = await runSessionIdleJanitorStep(db, userId, logger);
        if (janitorResult.closed > 0) {
          logger?.(`memory-hybrid: idle-session janitor closed ${janitorResult.closed} session(s) for ${userId}`);
        }
      } catch (err) {
        logger?.(`memory-hybrid: idle-session janitor error for ${userId}: ${String(err)}`);
      }
    }

    // Step 4.6: Continuity-gap detection (Rúnir-78sy.4) — only on the "user"
    // scope pass, immediately after Step 4.5 so it reads the freshly-built
    // project_continuity_state. DETERMINISTIC (no LLM). Own try/catch degrading
    // to a logger line: a detector failure NEVER fails the consolidation run.
    // Runs under the already-held lock; detects + reconciles continuity_gap rows
    // and stamps the per-project gap-evaluation cursor.
    if (scope === "user") {
      try {
        const { runGapDetectionStep } = await import("./continuity-gaps.js");
        const gapResult = await runGapDetectionStep({ db, userId, logger });
        gapsDetected = gapResult.detected;
        if (gapResult.projectsConsidered > 0) {
          logger?.(
            `memory-hybrid: gap detection for ${userId}: considered=${gapResult.projectsConsidered} detected=${gapResult.detected} superseded=${gapResult.superseded} skipped=${gapResult.projectsSkipped}`,
          );
        }
      } catch (err) {
        logger?.(`memory-hybrid: gap detection error for ${userId}: ${String(err)}`);
      }
    }

    // Step 5: BM25 stats invalidation
    statsCache.delete(userId);
    statsCache.delete(`semiote:${userId}`);
    statsCache.delete(`memories:${userId}`);

    // Step 6: Log completion
    await logConsolidationRun(db, userId, scope, deduped, archived, backlogReplayed, "completed", undefined, decayPruned, promoted, sweepId, continuityBuilt, gapsDetected);

    return { deduped, archived, backlogReplayed, decayPruned, promoted, status: "completed" };
  } catch (err) {
    logger?.(`memory-hybrid: consolidation failed for ${userId}::${scope}: ${String(err)}`);
    await logConsolidationRun(db, userId, scope, deduped, archived, backlogReplayed, "failed", String(err), decayPruned, promoted, sweepId, continuityBuilt, gapsDetected);
    return { deduped, archived, backlogReplayed, decayPruned, promoted, status: "failed" };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(db, lockKey, holder);
  }
}

async function logConsolidationRun(
  db: SurrealClient,
  userId: string,
  scope: string,
  deduped: number,
  archived: number,
  backlogReplayed: number,
  status: "completed" | "skipped_lock" | "skipped_no_sessions" | "failed",
  errorMessage?: string,
  decayPruned?: number,
  promoted?: number,
  sweepId?: string,
  continuityBuilt?: number,
  gapsDetected?: number,
): Promise<void> {
  const assignments = [
    "user_id = $userId",
    "scope = $scope",
    "completed_at = time::now()",
    "deduped_count = $deduped",
    "archived_count = $archived",
    "backlog_replayed_count = $backlogReplayed",
    "run_status = $status",
  ];
  const params: Record<string, unknown> = {
    userId,
    scope,
    deduped,
    archived,
    backlogReplayed,
    status,
  };

  if (errorMessage !== undefined) {
    assignments.push("error_message = $errorMessage");
    params.errorMessage = errorMessage;
  }
  if (decayPruned !== undefined) {
    assignments.push("decay_pruned_count = $decayPruned");
    params.decayPruned = decayPruned;
  }
  if (promoted !== undefined) {
    assignments.push("promoted_count = $promoted");
    params.promoted = promoted;
  }
  if (sweepId !== undefined) {
    assignments.push("sweep_id = $sweepId");
    params.sweepId = sweepId;
  }
  if (continuityBuilt !== undefined) {
    assignments.push("continuity_built_count = $continuityBuilt");
    params.continuityBuilt = continuityBuilt;
  }
  if (gapsDetected !== undefined) {
    assignments.push("continuity_gaps_count = $gapsDetected");
    params.gapsDetected = gapsDetected;
  }

  await db.query(
    `CREATE consolidation_log SET
       ${assignments.join(",\n       ")};`,
    params,
  );
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Starts the periodic consolidation scheduler.
 * 1. Runs startup catch-up (checks consolidation_state for stale users)
 * 2. Starts setInterval at intervalMs
 * Returns a stop function (clears the interval).
 * The returned Promise resolves after catch-up completes.
 */
export async function startConsolidationScheduler(
  db: SurrealClient,
  embedText: (text: string) => Promise<number[]>,
  statsCache: Map<string, Bm25CorpusStats>,
  intervalMs: number,
  apiKey: string,
  logger?: (msg: string) => void,
): Promise<() => void> {
  const MIN_SESSIONS = parseInt(process.env.CONSOLIDATION_MIN_SESSIONS ?? "5");
  const MIN_HOURS = parseInt(process.env.CONSOLIDATION_MIN_HOURS ?? "24");
  const minMs = MIN_HOURS * 60 * 60 * 1000;

  async function getEligibleUsers(): Promise<string[]> {
    // Get all distinct userIds from memories
    const memResults = await db.query<{ userId: string }>(
      `SELECT payload.userId AS userId FROM ${PRIMARY_MEMORY_TABLE} WHERE payload.userId != NONE GROUP BY payload.userId;`,
    );
    const allUserIds = (memResults[0] ?? []).map((r) => r.userId).filter(Boolean);
    if (allUserIds.length === 0) return [];

    const now = Date.now();
    const eligible: string[] = [];

    for (const userId of allUserIds) {
      // Check consolidation_state
      const stateResults = await db.query<{
        last_run_at: string;
        session_count_at_last_run: number;
      }>(
        "SELECT last_run_at, session_count_at_last_run FROM consolidation_state WHERE user_id = $userId LIMIT 1;",
        { userId },
      );
      const state = stateResults[0]?.[0];
      const lastRunAt = state ? new Date(state.last_run_at).getTime() : 0; // epoch if missing
      if (now - lastRunAt < minMs) continue; // Too recent

      // Check session count since last run
      const lastRunIso = new Date(lastRunAt).toISOString();
      const sessResults = await db.query<{ count: number }>(
        `SELECT count() AS count FROM session_watermarks
         WHERE user_id = $userId AND captured_at > <datetime>$since
         GROUP ALL;`,
        { userId, since: lastRunIso },
      );
      const sessionsSince = sessResults[0]?.[0]?.count ?? 0;
      if (sessionsSince < MIN_SESSIONS) {
        // Logger line, NOT a consolidation_log row: writing a row per
        // ineligible user per tick buried the real run history under
        // thousands of skipped_no_sessions entries (5,482 for one tenant).
        logger?.(`memory-hybrid: consolidation skipped for ${userId} — ${sessionsSince}/${MIN_SESSIONS} new sessions since last run`);
        continue;
      }

      eligible.push(userId);
    }
    return eligible;
  }

  async function runForUser(userId: string): Promise<void> {
    // Generate a sweep ID for this user's maintenance run (MIM-70)
    const sweepId = crypto.randomUUID();
    // Run for session, user, and global scopes
    let anySucceeded = false;
    for (const scope of ["session", "user", "global"] as MemoryScope[]) {
      try {
        const result = await runConsolidationForScope(db, userId, scope, embedText, statsCache, apiKey, logger, sweepId);
        if (result.status === "completed") anySucceeded = true;
      } catch (err) {
        logger?.(`memory-hybrid: consolidation error for ${userId}::${scope}: ${String(err)}`);
      }
    }
    // Only advance consolidation_state if at least one scope succeeded
    if (anySucceeded) {
      const sessCountResults = await db.query<{ count: number }>(
        "SELECT count() AS count FROM session_watermarks WHERE user_id = $userId GROUP ALL;",
        { userId },
      );
      const totalSessions = sessCountResults[0]?.[0]?.count ?? 0;
      await db.query(
        `UPSERT consolidation_state SET
           user_id = $userId,
           last_run_at = time::now(),
           session_count_at_last_run = $count,
           last_sweep_id = $sweepId
         WHERE user_id = $userId;`,
        { userId, count: totalSessions, sweepId },
      );
    }
  }

  // In-flight guards (Rúnir-x46j): the interval fires on wall-clock regardless
  // of whether the previous pass finished, and the startup catch-up used to
  // run BEFORE the interval was installed — a long catch-up therefore silently
  // disabled the hourly tick and the retention/repair jobs that piggyback on
  // it. The consolidation pass is now mutually exclusive with itself (the
  // catch-up counts as a pass), and the maintenance jobs keep their cadence
  // independent of whether the consolidation pass was skipped.
  let consolidationPassInFlight = false;

  async function runEligibleUsers(trigger: "startup catch-up" | "tick"): Promise<void> {
    if (consolidationPassInFlight) {
      logger?.(`memory-hybrid: consolidation ${trigger} pass skipped — previous pass still running`);
      return;
    }
    consolidationPassInFlight = true;
    try {
      const eligible = await getEligibleUsers();
      for (const userId of eligible) {
        await runForUser(userId);
      }
    } catch (err) {
      logger?.(`memory-hybrid: consolidation ${trigger} error: ${String(err)}`);
    } finally {
      consolidationPassInFlight = false;
    }
  }

  let maintenanceTickInFlight = false;

  // Interval installed FIRST (x46j) so retention and entity repair keep their
  // cadence even while the startup catch-up below is still running.
  const timer = setInterval(async () => {
    if (maintenanceTickInFlight) return;
    maintenanceTickInFlight = true;
    try {
      await runEligibleUsers("tick");
      // Session-turn retention sweep (Rúnir-b40x.3): cheap at dogfooding volume
      // (tens of thousands of rows at 30d retention); piggybacks the tick so the
      // raw-turn feed self-prunes without its own scheduler.
      try {
        await deleteExpiredSessionTurns(db, resolveTurnRetentionDays());
      } catch (err) {
        logger?.(`memory-hybrid: session-turn retention sweep error: ${String(err)}`);
      }
      // retrieval_trace retention sweep (Rúnir-x41m.9): 90d default, rows
      // carrying feedback (rating/answer) are labeled data and never swept.
      try {
        const sweptTraces = await deleteExpiredRetrievalTraces(db, resolveTraceRetentionDays());
        if (sweptTraces > 0) {
          logger?.(`memory-hybrid: retrieval-trace retention sweep removed ${sweptTraces} expired unrated traces`);
        }
      } catch (err) {
        logger?.(`memory-hybrid: retrieval-trace retention sweep error: ${String(err)}`);
      }
      // consolidation_log retention sweep (#3): prune run rows older than the window,
      // exempting each user's latest sweep (the row getMemoryHealth reads). Self-pruning
      // so the run-history table does not grow unbounded again.
      try {
        const sweptLogs = await deleteExpiredConsolidationLogs(db, resolveConsolidationLogRetentionDays());
        if (sweptLogs > 0) {
          logger?.(`memory-hybrid: consolidation-log retention sweep removed ${sweptLogs} expired rows`);
        }
      } catch (err) {
        logger?.(`memory-hybrid: consolidation-log retention sweep error: ${String(err)}`);
      }
      // Nightly demand-driven entity repair (Rúnir-b40x.4): self-gated to the
      // configured night hour + once per ~22h per user with recorded misses.
      try {
        await maybeRunNightlyEntityRepair(db, apiKey, logger);
      } catch (err) {
        logger?.(`memory-hybrid: entity-repair gate error: ${String(err)}`);
      }
    } finally {
      maintenanceTickInFlight = false;
    }
  }, intervalMs);

  // Startup catch-up: replay any pending staleness backlog entries unconditionally
  try {
    const pendingBacklog = await db.query<{
      id: string;
      user_id: string;
      scope: string;
      session_id: string | null;
      facts: Array<{ text: string; confidence: number; replacementMemoryId: string }>;
    }>(
      "SELECT id, user_id, scope, session_id, facts FROM staleness_backlog WHERE status = 'pending';",
    );
    const entries = Array.isArray(pendingBacklog) ? (pendingBacklog[0] ?? []) : [];
    for (const entry of entries) {
      try {
        const { acquireLock, releaseLock } = await import("./lock.js");
        const { runStalenessCoreNoLock } = await import("./staleness-pass.js");
        const lockKey = `${entry.user_id}::${entry.scope}`;
        const holder = await acquireLock(db, lockKey, 300);
        if (!holder) {
          logger?.(`memory-hybrid: startup backlog replay skipped — lock held for ${lockKey}`);
          continue;
        }
        try {
          await runStalenessCoreNoLock({
            db,
            userId: entry.user_id,
            scope: entry.scope as MemoryScope,
            sessionId: entry.session_id ?? undefined,
            facts: entry.facts,
            apiKey,
            embedText,
            logger,
            tableName: PRIMARY_MEMORY_TABLE,
          });
          await db.query("UPDATE $id SET status = 'replayed';", { id: entry.id });
        } finally {
          await releaseLock(db, lockKey, holder);
        }
      } catch (err) {
        logger?.(`memory-hybrid: startup backlog replay error: ${String(err)}`);
        await db.query("UPDATE $id SET status = 'failed';", { id: entry.id }).catch(() => {});
      }
    }
  } catch (err) {
    logger?.(`memory-hybrid: startup backlog query error: ${String(err)}`);
  }

  // Startup catch-up: run eligible users (bounded per scope by the dedup
  // budget, so this completes in minutes rather than grinding for hours)
  await runEligibleUsers("startup catch-up");

  // Return stop function
  return () => clearInterval(timer);
}
