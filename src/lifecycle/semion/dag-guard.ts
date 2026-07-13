import type { MemoryRecordTable } from "../../domain/memory/types.js";
import type { Surreal as SurrealClient } from "surrealdb";

/**
 * Checks whether creating a supersede edge newMemoryId→targetId would create a cycle
 * in the supersession DAG.
 *
 * Walks the supersedes chain from targetId using a visited set.
 * Returns true if a cycle would be created (or if the chain exceeds the corruption ceiling).
 * Returns false if the chain terminates cleanly.
 *
 * Orphaned pointers (references to non-existent records) are logged as corruption
 * but do NOT block the write — returns false in that case.
 */
export async function wouldCreateCycle(
  db: SurrealClient,
  newMemoryId: string,
  targetId: string,
  userId: string,
  tableName: MemoryRecordTable,
): Promise<boolean> {
  const visited = new Set<string>();
  const CORRUPTION_CEILING = 50;
  let currentId: string | null = targetId;
  const chain: string[] = [targetId];

  while (currentId !== null) {
    if (currentId === newMemoryId) {
      chain.push(currentId);
      console.warn(`dag-guard: cycle detected: ${chain.join(" → ")}`);
      return true;
    }

    if (visited.has(currentId)) {
      // Shouldn't happen — guard against infinite loop
      console.warn(`dag-guard: unexpected revisit of ${currentId} in chain: ${chain.join(" → ")}`);
      return true;
    }
    visited.add(currentId);

    if (visited.size >= CORRUPTION_CEILING) {
      console.warn(`dag-guard: corruption ceiling reached (${CORRUPTION_CEILING} hops), chain: ${chain.slice(0, 5).join(" → ")}...`);
      return true;
    }

    let rows: Array<{ supersedes: string | null }>;
    try {
      // type::record, NOT `WHERE id = $id`: binding a bare-string id against a
      // RecordId column never matches, which made this walk a NO-OP for every
      // caller and flooded the log with false "orphaned pointer" warns
      // (Rúnir-xxa9; ids here are bare uuids — the supersedes column stores
      // bare uuids and callers normalize via extractId).
      const result = await db.query<Array<Array<{ supersedes: string | null }>>>(
        `SELECT supersedes FROM type::record('${tableName}', $id) WHERE payload.userId = $userId`,
        { id: currentId, userId },
      );
      rows = result[0] ?? [];
    } catch (err) {
      console.warn(`dag-guard: query error at ${currentId}: ${String(err)}`);
      return false;
    }

    if (rows.length === 0) {
      // Record not found — orphaned pointer
      console.warn(`dag-guard: orphaned supersedes pointer: ${chain[chain.length - 2] ?? targetId} references non-existent ${currentId}`);
      return false;
    }

    const nextId = rows[0].supersedes ?? null;

    if (nextId === null) {
      // Chain terminates cleanly — no cycle
      return false;
    }

    if (nextId === newMemoryId) {
      // Cycle detected — newMemoryId appears in the chain
      chain.push(nextId);
      console.warn(`dag-guard: cycle detected: ${chain.join(" → ")}`);
      return true;
    }

    chain.push(nextId);
    currentId = nextId;
  }

  return false;
}
