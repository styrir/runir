import { cosineSimilarity } from "../../shared/cosine.js";
import type { MemoryCategory } from "../../domain/memory/types.js";

export type CompactableEntry = {
  id: string;
  text: string;
  embedding: number[];
  confidence: number;
  category: MemoryCategory;
  tags: string[];
  lineageRootId?: string;
};

export type CompactionConfig = {
  enabled: boolean;
  minAgeDays: number;
  similarityThreshold: number;
  minClusterSize: number;
  maxMemoriesToScan: number;
  dryRun: boolean;
  cooldownHours: number;
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: !!process.env.COMPACTION_ENABLED && process.env.COMPACTION_ENABLED !== "false",
  minAgeDays: 7,
  similarityThreshold: parseFloat(process.env.COMPACTION_SIMILARITY_THRESHOLD ?? "0.88"),
  minClusterSize: 2,
  maxMemoriesToScan: 200,
  dryRun: false,
  cooldownHours: parseFloat(process.env.COMPACTION_COOLDOWN_HOURS ?? "24"),
};

/**
 * Greedy cosine expansion clustering.
 * Seeds by highest confidence, expands cluster with entries having cosine >= threshold.
 */
export function buildClusters(
  entries: CompactableEntry[],
  threshold: number,
  minClusterSize: number,
): CompactableEntry[][] {
  const sorted = [...entries].sort((a, b) => b.confidence - a.confidence);
  const assigned = new Set<string>();
  const clusters: CompactableEntry[][] = [];

  for (const seed of sorted) {
    if (assigned.has(seed.id)) continue;
    const cluster: CompactableEntry[] = [seed];
    assigned.add(seed.id);

    for (const candidate of sorted) {
      if (assigned.has(candidate.id)) continue;
      const sim = cosineSimilarity(seed.embedding, candidate.embedding);
      if (sim >= threshold) {
        cluster.push(candidate);
        assigned.add(candidate.id);
      }
    }

    if (cluster.length >= minClusterSize) {
      clusters.push(cluster);
    } else {
      // Release non-qualifying entries
      for (const entry of cluster) {
        if (entry.id !== seed.id) assigned.delete(entry.id);
      }
      assigned.delete(seed.id);
    }
  }

  return clusters;
}

/**
 * Builds a merged entry from cluster members.
 * - Deduplicated line content
 * - Max confidence
 * - Plurality category
 * - Union tags
 */
export function buildMergedEntry(members: CompactableEntry[]): {
  text: string;
  confidence: number;
  category: MemoryCategory;
  tags: string[];
  sourceIds: string[];
} {
  // Deduplicate lines
  const seenLines = new Set<string>();
  const lines: string[] = [];
  for (const m of members) {
    for (const line of m.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !seenLines.has(trimmed.toLowerCase())) {
        seenLines.add(trimmed.toLowerCase());
        lines.push(trimmed);
      }
    }
  }

  // Max confidence
  const confidence = Math.max(...members.map((m) => m.confidence));

  // Plurality category
  const catCounts = new Map<MemoryCategory, number>();
  for (const m of members) {
    catCounts.set(m.category, (catCounts.get(m.category) ?? 0) + 1);
  }
  let category: MemoryCategory = members[0]!.category;
  let maxCount = 0;
  for (const [cat, count] of catCounts) {
    if (count > maxCount) {
      maxCount = count;
      category = cat;
    }
  }

  // Union tags (deduplicated)
  const tagSet = new Set<string>();
  for (const m of members) {
    for (const t of m.tags) tagSet.add(t);
  }

  return {
    text: lines.join("\n"),
    confidence,
    category,
    tags: Array.from(tagSet),
    sourceIds: members.map((m) => m.id),
  };
}

type CompactionDb = {
  query<T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T[][]>;
};

type CompactionEmbedder = {
  embedDocument(text: string): Promise<number[]>;
};

export type CompactionStats = {
  scanned: number;
  clustersFound: number;
  memoriesMerged: number;
  memoriesCreated: number;
  dryRun: boolean;
};

/**
 * Fetches active memories older than cutoff for compaction.
 */
export async function fetchForCompaction(
  db: CompactionDb,
  userId: string,
  cutoffIso: string,
  limit: number,
): Promise<Array<{ id: string; text: string; embedding: number[]; confidence: number; category: MemoryCategory; tags: string[]; lineageRootId?: string }>> {
  const results = await db.query<any>(
    `SELECT id, embedding, payload, created_at FROM memories
     WHERE payload.userId = $userId
     AND (active = NONE OR active = true)
     AND created_at < <datetime>$cutoff
     AND embedding != NONE
     ORDER BY created_at ASC
     LIMIT $limit;`,
    { userId, cutoff: cutoffIso, limit },
  );
  const rows = results[0] ?? [];
  return rows.map((r: any) => {
    const idStr = typeof r.id === "object" && r.id !== null && "id" in r.id ? String(r.id.id) : String(r.id).replace(/^[^:]+:/, "");
    return {
      id: idStr,
      text: r.payload?.data ?? "",
      embedding: Array.isArray(r.embedding) ? r.embedding : [],
      confidence: r.payload?.confidence ?? 0.5,
      category: r.payload?.category ?? "cases",
      tags: Array.isArray(r.payload?.tags) ? r.payload.tags : [],
      lineageRootId: r.payload?.lineageRootId,
    };
  });
}

/**
 * Soft-inactivates source memories for compaction (NO hard delete).
 */
async function softInactivateForCompaction(
  db: CompactionDb,
  sourceIds: string[],
  mergedId: string,
  userId: string,
): Promise<void> {
  const now = new Date().toISOString();
  for (const id of sourceIds) {
    await db.query(
      `UPDATE type::record('memories', $id) SET
         active = false,
         inactive_at = <datetime>$now,
         inactive_reason = $reason,
         superseded_by = $mergedId,
         payload.active = false,
         payload.inactiveAt = $now,
         payload.inactiveReason = $reason,
         payload.supersededById = $mergedId,
         payload.updatedAt = $now,
         updated_at = <datetime>$now
       WHERE payload.userId = $userId;`,
      { id, now, reason: "compacted", mergedId, userId },
    );
  }
}

/**
 * Checks cooldown: returns true if compaction was run within cooldownHours.
 */
async function isCooldownActive(
  db: CompactionDb,
  userId: string,
  cooldownHours: number,
): Promise<boolean> {
  const results = await db.query<any>(
    `SELECT lastRunAt FROM compaction_state WHERE id = type::record('compaction_state', $userId);`,
    { userId },
  );
  const rows = results[0] ?? [];
  if (rows.length === 0) return false;
  const lastRunAt = rows[0]?.lastRunAt;
  if (!lastRunAt) return false;
  const elapsed = Date.now() - new Date(lastRunAt).getTime();
  return elapsed < cooldownHours * 3600 * 1000;
}

async function updateCooldown(db: CompactionDb, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `UPSERT type::record('compaction_state', $userId) CONTENT { lastRunAt: $now };`,
    { userId, now },
  );
}

/**
 * Main compaction runner. Catches all errors internally — never throws.
 * Fire-and-forget safe.
 */
export async function runCompaction(
  db: CompactionDb,
  embedder: CompactionEmbedder,
  config: CompactionConfig,
  userId: string,
  logger: { warn: (msg: string) => void },
): Promise<CompactionStats | null> {
  try {
    if (!config.enabled) return null;

    if (await isCooldownActive(db, userId, config.cooldownHours)) {
      logger.warn(`memory-compactor: cooldown active for user ${userId}, skipping`);
      return null;
    }

    const cutoff = new Date(Date.now() - config.minAgeDays * 24 * 3600 * 1000).toISOString();
    const entries = await fetchForCompaction(db, userId, cutoff, config.maxMemoriesToScan);

    if (entries.length < config.minClusterSize) {
      logger.warn(`memory-compactor: only ${entries.length} entries for user ${userId}, skipping`);
      return { scanned: entries.length, clustersFound: 0, memoriesMerged: 0, memoriesCreated: 0, dryRun: config.dryRun };
    }

    const clusters = buildClusters(entries, config.similarityThreshold, config.minClusterSize);
    const stats: CompactionStats = {
      scanned: entries.length,
      clustersFound: clusters.length,
      memoriesMerged: 0,
      memoriesCreated: 0,
      dryRun: config.dryRun,
    };

    for (const cluster of clusters) {
      const merged = buildMergedEntry(cluster);

      if (config.dryRun) {
        stats.memoriesMerged += cluster.length;
        stats.memoriesCreated += 1;
        continue;
      }

      // Embed the merged text
      const mergedEmbedding = await embedder.embedDocument(merged.text);
      const mergedId = `compacted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      // Determine lineage root from first source
      const firstSource = cluster[0]!;
      const lineageRootId = firstSource.lineageRootId ?? firstSource.id;

      // Create merged memory
      await db.query(
        `UPSERT type::record('memories', $id) CONTENT {
           embedding: $embedding,
           payload: $payload,
           text_norm: $textNorm,
           created_at: <datetime>$now,
           updated_at: <datetime>$now,
           user_id: $userId,
           scope: "user",
           active: true,
           supersedes: $supersedesId,
           lineage_root_id: $lineageRootId
         };`,
        {
          id: mergedId,
          embedding: mergedEmbedding,
          payload: {
            data: merged.text,
            userId,
            category: merged.category,
            confidence: merged.confidence,
            tags: merged.tags,
            writeSource: "capture",
            source: "memory-hybrid",
            scope: "user",
            createdAt: now,
            updatedAt: now,
            active: true,
            supersedesId: firstSource.id,
            lineageRootId,
          },
          textNorm: merged.text.toLowerCase().trim(),
          now,
          userId,
          supersedesId: firstSource.id,
          lineageRootId,
        },
      );

      // Soft-inactivate sources
      await softInactivateForCompaction(db, merged.sourceIds, mergedId, userId);

      stats.memoriesMerged += cluster.length;
      stats.memoriesCreated += 1;
    }

    await updateCooldown(db, userId);

    logger.warn(`memory-compactor: user=${userId} scanned=${stats.scanned} clusters=${stats.clustersFound} merged=${stats.memoriesMerged} created=${stats.memoriesCreated} dryRun=${stats.dryRun}`);
    return stats;
  } catch (err) {
    logger.warn(`memory-compactor: error for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
