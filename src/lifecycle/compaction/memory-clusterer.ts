/**
 * memory-clusterer.ts — Code-6q9
 * Groups related memories into topic clusters using entity co-occurrence (primary)
 * and cosine embedding similarity (fallback). Stores cluster assignments in memory_clusters.
 */

import { createHash } from "node:crypto";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import { cosineSimilarity } from "../../shared/cosine.js";

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

const DEFAULT_JACCARD_THRESHOLD = 0.3;
const DEFAULT_COSINE_THRESHOLD = 0.82;
const DEFAULT_MIN_SHARED_ENTITIES = 2;

function getJaccardThreshold(): number {
  const v = parseFloat(process.env.CLUSTER_JACCARD_THRESHOLD ?? "");
  return Number.isFinite(v) ? v : DEFAULT_JACCARD_THRESHOLD;
}

function getCosineThreshold(): number {
  const v = parseFloat(process.env.CLUSTER_COSINE_THRESHOLD ?? "");
  return Number.isFinite(v) ? v : DEFAULT_COSINE_THRESHOLD;
}

function getMinSharedEntities(): number {
  const v = parseInt(process.env.CLUSTER_MIN_SHARED_ENTITIES ?? "", 10);
  return Number.isFinite(v) ? v : DEFAULT_MIN_SHARED_ENTITIES;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClusterResult = {
  totalClusters: number;
  entityClusters: number;
  cosineClusters: number;
  singletons: number;
  upserted: number;
  inserted: number;
  durationMs: number;
};

export type MemoryCluster = {
  id?: string;
  fingerprintId: string;
  label: string;
  memoryIds: string[];
  entityIds: string[];
  size: number;
  method: "entity_cooccurrence" | "cosine_fallback" | "singleton";
  synthesisId?: string;
  createdAt?: string;
  updatedAt?: string;
};

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------

export function jaccard(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Founding fingerprint
// ---------------------------------------------------------------------------

export function computeClusterFingerprint(memoryIds: string[]): string {
  const sorted = [...memoryIds].sort().join(",");
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Union-Find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) {
      this.parent.set(x, this.find(p));
    }
    return this.parent.get(x)!;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) {
      this.parent.set(rx, ry);
    }
  }

  getGroups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const g = groups.get(root) ?? [];
      g.push(id);
      groups.set(root, g);
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// Build memory->entity map
// ---------------------------------------------------------------------------

export async function buildEntityMap(
  db: SurrealClient,
): Promise<Map<string, Set<string>>> {
  const results = await db.query<any>(
    `SELECT in AS entityId, out AS memoryId FROM entity_edges WHERE kind = "mentioned_in"`,
  );
  const rows = results[0] ?? [];
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const memId = typeof row.memoryId === "object" && row.memoryId !== null
      ? String((row.memoryId as any).id ?? row.memoryId)
      : String(row.memoryId ?? "");
    const entId = typeof row.entityId === "object" && row.entityId !== null
      ? String((row.entityId as any).id ?? row.entityId)
      : String(row.entityId ?? "");
    if (!memId || !entId) continue;
    const existing = map.get(memId) ?? new Set<string>();
    existing.add(entId);
    map.set(memId, existing);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Build co-occurrence graph and find clusters
// ---------------------------------------------------------------------------

export function buildCooccurrenceGraph(
  entityMap: Map<string, Set<string>>,
): Map<string, Map<string, number>> {
  // Build inverted index: entityId -> Set<memoryId>
  const inverted = new Map<string, Set<string>>();
  for (const [memId, entities] of entityMap) {
    for (const entId of entities) {
      const s = inverted.get(entId) ?? new Set<string>();
      s.add(memId);
      inverted.set(entId, s);
    }
  }

  // Build edges: memoryPair -> jaccard
  const edges = new Map<string, Map<string, number>>();
  for (const memories of inverted.values()) {
    const mems = [...memories];
    for (let i = 0; i < mems.length; i++) {
      for (let j = i + 1; j < mems.length; j++) {
        const m1 = mems[i]!;
        const m2 = mems[j]!;
        if (!edges.has(m1)) edges.set(m1, new Map());
        if (!edges.has(m2)) edges.set(m2, new Map());
        // Only compute jaccard once per pair
        if (!edges.get(m1)!.has(m2)) {
          const sim = jaccard(entityMap.get(m1)!, entityMap.get(m2)!);
          edges.get(m1)!.set(m2, sim);
          edges.get(m2)!.set(m1, sim);
        }
      }
    }
  }
  return edges;
}

export function findClusters(
  entityMap: Map<string, Set<string>>,
  jaccardThreshold: number,
  minSharedEntities: number,
): MemoryCluster[] {
  const edges = buildCooccurrenceGraph(entityMap);
  const uf = new UnionFind();

  // Initialize all nodes
  for (const memId of entityMap.keys()) {
    uf.find(memId);
  }

  for (const [m1, neighbors] of edges) {
    for (const [m2, sim] of neighbors) {
      const shared = (() => {
        let count = 0;
        const s1 = entityMap.get(m1) ?? new Set<string>();
        const s2 = entityMap.get(m2) ?? new Set<string>();
        for (const e of s1) { if (s2.has(e)) count++; }
        return count;
      })();
      if (shared >= minSharedEntities && sim > jaccardThreshold) {
        uf.union(m1, m2);
      }
    }
  }

  const groups = uf.getGroups();
  const clusters: MemoryCluster[] = [];

  for (const [, members] of groups) {
    if (members.length < 2) continue; // singletons handled separately

    // Collect union of entity IDs
    const entityIds = new Set<string>();
    for (const memId of members) {
      for (const entId of entityMap.get(memId) ?? new Set()) {
        entityIds.add(entId);
      }
    }

    // Label: top 3 shared entity names (use IDs as proxy since we don't have names here)
    const label = [...entityIds].slice(0, 3).join(", ");

    clusters.push({
      fingerprintId: computeClusterFingerprint(members),
      label,
      memoryIds: [...members].sort(),
      entityIds: [...entityIds],
      size: members.length,
      method: "entity_cooccurrence",
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Cosine fallback clusters
// ---------------------------------------------------------------------------

export async function cosineFallbackClusters(
  db: SurrealClient,
  orphanIds: string[],
  entityMap: Map<string, Set<string>>,
  cosineThreshold: number,
): Promise<MemoryCluster[]> {
  if (orphanIds.length === 0) return [];

  const results = await db.query<any>(
    `SELECT id, embedding FROM memories WHERE id IN $orphanIds AND embedding IS NOT NULL`,
    { orphanIds },
  );
  const rows = results[0] ?? [];

  type EmbRow = { id: string; embedding: number[] };
  const embRows: EmbRow[] = rows.map((r: any) => ({
    id: typeof r.id === "object" && r.id !== null
      ? String((r.id as any).id ?? r.id)
      : String(r.id ?? ""),
    embedding: r.embedding ?? [],
  })).filter((r: EmbRow) => r.embedding.length > 0);

  const uf = new UnionFind();
  for (const r of embRows) uf.find(r.id);

  for (let i = 0; i < embRows.length; i++) {
    for (let j = i + 1; j < embRows.length; j++) {
      const a = embRows[i]!;
      const b = embRows[j]!;
      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim < cosineThreshold) continue;

      // Require at least 1 shared entity
      const ea = entityMap.get(a.id) ?? new Set<string>();
      const eb = entityMap.get(b.id) ?? new Set<string>();
      let shared = 0;
      for (const e of ea) { if (eb.has(e)) { shared++; break; } }
      if (shared === 0) continue;

      uf.union(a.id, b.id);
    }
  }

  const groups = uf.getGroups();
  const clusters: MemoryCluster[] = [];

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const entityIds = new Set<string>();
    for (const memId of members) {
      for (const entId of entityMap.get(memId) ?? new Set()) {
        entityIds.add(entId);
      }
    }
    clusters.push({
      fingerprintId: computeClusterFingerprint(members),
      label: members.slice(0, 3).join(", "),
      memoryIds: [...members].sort(),
      entityIds: [...entityIds],
      size: members.length,
      method: "cosine_fallback",
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Reconcile with existing clusters
// ---------------------------------------------------------------------------

export async function reconcileWithExisting(
  db: SurrealClient,
  candidateMemoryIds: string[],
): Promise<MemoryCluster | null> {
  // Query clusters that contain any of the candidate memory IDs
  const results = await db.query<any>(
    `SELECT * FROM memory_clusters WHERE memoryIds CONTAINSANY $ids`,
    { ids: candidateMemoryIds },
  );
  const existing: MemoryCluster[] = results[0] ?? [];
  if (existing.length === 0) return null;

  // Find the cluster with the highest overlap
  let best: MemoryCluster | null = null;
  let bestOverlap = 0;

  for (const cluster of existing) {
    const existingSet = new Set<string>(cluster.memoryIds ?? []);
    const candidateSet = new Set<string>(candidateMemoryIds);
    let overlap = 0;
    for (const id of candidateSet) {
      if (existingSet.has(id)) overlap++;
    }
    const overlapRatio = overlap / candidateSet.size;
    if (overlapRatio >= 0.5 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = cluster;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Upsert cluster
// ---------------------------------------------------------------------------

export async function upsertCluster(
  db: SurrealClient,
  cluster: MemoryCluster,
): Promise<{ action: "inserted" | "upserted" }> {
  const existing = await reconcileWithExisting(db, cluster.memoryIds);

  if (existing?.id) {
    // Merge: union of memory IDs and entity IDs, keep existing fingerprintId and synthesisId
    const mergedMemIds = [...new Set([...existing.memoryIds, ...cluster.memoryIds])].sort();
    const mergedEntIds = [...new Set([...existing.entityIds, ...cluster.entityIds])];
    await db.query(
      `UPDATE $id SET
         memoryIds = $memoryIds,
         entityIds = $entityIds,
         size = $size,
         label = $label,
         method = $method`,
      {
        id: existing.id,
        memoryIds: mergedMemIds,
        entityIds: mergedEntIds,
        size: mergedMemIds.length,
        label: cluster.label || existing.label,
        method: cluster.method,
      },
    );
    return { action: "upserted" };
  }

  // Insert new cluster
  await db.query(
    `CREATE memory_clusters CONTENT {
       fingerprintId: $fingerprintId,
       label: $label,
       memoryIds: $memoryIds,
       entityIds: $entityIds,
       size: $size,
       method: $method,
       synthesisId: NONE,
       createdAt: time::now(),
       updatedAt: time::now()
     }`,
    {
      fingerprintId: cluster.fingerprintId,
      label: cluster.label,
      memoryIds: cluster.memoryIds,
      entityIds: cluster.entityIds,
      size: cluster.size,
      method: cluster.method,
    },
  );
  return { action: "inserted" };
}

// ---------------------------------------------------------------------------
// Persist all clusters
// ---------------------------------------------------------------------------

async function persistClusters(
  db: SurrealClient,
  clusters: MemoryCluster[],
): Promise<{ upserted: number; inserted: number }> {
  let upserted = 0;
  let inserted = 0;
  for (const cluster of clusters) {
    const { action } = await upsertCluster(db, cluster);
    if (action === "inserted") inserted++;
    else upserted++;
  }
  return { upserted, inserted };
}

// ---------------------------------------------------------------------------
// Collect orphan memories
// ---------------------------------------------------------------------------

export async function collectOrphanMemories(
  db: SurrealClient,
  clusteredIds: Set<string>,
): Promise<string[]> {
  const results = await db.query<any>(
    `SELECT id FROM memories WHERE (active = NONE OR active = true)`,
  );
  const rows = results[0] ?? [];
  const orphans: string[] = [];
  for (const row of rows) {
    const id = typeof row.id === "object" && row.id !== null
      ? String((row.id as any).id ?? row.id)
      : String(row.id ?? "");
    if (!clusteredIds.has(id)) orphans.push(id);
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runClustering(
  db: SurrealClient,
): Promise<ClusterResult> {
  const startMs = Date.now();
  const jaccardThreshold = getJaccardThreshold();
  const cosineThreshold = getCosineThreshold();
  const minSharedEntities = getMinSharedEntities();

  // Step 1: Build entity map
  const entityMap = await buildEntityMap(db);

  // Step 2: Entity co-occurrence clustering
  const entityClusters = findClusters(entityMap, jaccardThreshold, minSharedEntities);

  // Track clustered memory IDs
  const clusteredIds = new Set<string>();
  for (const c of entityClusters) {
    for (const id of c.memoryIds) clusteredIds.add(id);
  }

  // Step 3: Cosine fallback for orphans
  const orphanIds = await collectOrphanMemories(db, clusteredIds);
  const cosineClusters = await cosineFallbackClusters(db, orphanIds, entityMap, cosineThreshold);

  for (const c of cosineClusters) {
    for (const id of c.memoryIds) clusteredIds.add(id);
  }

  // Step 4: Singletons — remaining unclustered
  const allOrphans = orphanIds.filter(id => !new Set(cosineClusters.flatMap(c => c.memoryIds)).has(id));
  const singletonClusters: MemoryCluster[] = allOrphans.map(id => ({
    fingerprintId: computeClusterFingerprint([id]),
    label: id.slice(0, 12),
    memoryIds: [id],
    entityIds: [...(entityMap.get(id) ?? [])],
    size: 1,
    method: "singleton" as const,
  }));

  const allClusters = [...entityClusters, ...cosineClusters, ...singletonClusters];

  // Step 5: Persist
  const { upserted, inserted } = await persistClusters(db, allClusters);

  return {
    totalClusters: allClusters.length,
    entityClusters: entityClusters.length,
    cosineClusters: cosineClusters.length,
    singletons: singletonClusters.length,
    upserted,
    inserted,
    durationMs: Date.now() - startMs,
  };
}
