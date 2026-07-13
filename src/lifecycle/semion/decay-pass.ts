import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import type { MemoryRecordTable, MemoryScope } from "../../domain/memory/types.js";

// Lambda values by tier (TEMM1E + FSRS literature)
const LAMBDA_EPHEMERAL = Math.LN2 / 3;    // half-life 3h
const LAMBDA_WORKING   = Math.LN2 / 48;   // half-life 48h
const LAMBDA_DURABLE   = Math.LN2 / 672;  // half-life 672h (4 weeks)

function getLambda(tier?: string): number {
  switch (tier) {
    case "ephemeral": return LAMBDA_EPHEMERAL;
    case "durable":   return LAMBDA_DURABLE;
    case "working":
    default:          return LAMBDA_WORKING;
  }
}

/**
 * Computes the decay vitality score for a memory record (0.0–1.0).
 * Returns 1.0 if pinnedAt is set (immune to decay).
 */
export function computeDecayScore(
  memory: {
    tier?: string;
    confidence: number;
    accessCount: number;
    lastAccessedAt?: string;
    createdAt: string;
    pinnedAt?: string;
  },
  now: Date,
): number {
  if (memory.pinnedAt) return 1.0;

  const referenceTime = memory.lastAccessedAt ?? memory.createdAt;
  const hours = (now.getTime() - new Date(referenceTime).getTime()) / 3_600_000;
  const lambda = getLambda(memory.tier);

  const recency = Math.exp(-lambda * hours);
  const access = Math.min(1.0, memory.accessCount / 5);
  const confidence_score = Math.max(0, Math.min(1, memory.confidence));

  return (recency + access + confidence_score) / 3.0;
}

export interface DecayPassReport {
  scored: number;
  pruned: number;
  skipped_durable: number;
  skipped_pinned: number;
  rate_capped: number;
}

/**
 * Runs the decay pass for a userId/scope:
 * - Fetches all active memories
 * - Computes and writes decayScore for each
 * - Soft-inactivates prune-eligible records up to 5% rate cap
 */
export async function runDecayPass(
  db: SurrealClient,
  userId: string,
  scope: MemoryScope,
  opts?: { now?: Date; tableName?: MemoryRecordTable },
): Promise<DecayPassReport> {
  const now = opts?.now ?? new Date();
  const tableName = opts?.tableName ?? "semiote";

  // Fetch all active memories for userId/scope
  const results = await db.query<{
    id: string;
    payload: {
      tier?: string;
      confidence: number;
      accessCount: number;
      lastAccessedAt?: string;
      createdAt: string;
      pinnedAt?: string;
      active?: boolean;
    };
  }>(
    `SELECT id, payload FROM ${tableName}
     WHERE payload.userId = $userId
     AND payload.scope = $scope
     AND (active = NONE OR active = true);`,
    { userId, scope },
  );
  const memories = results[0] ?? [];
  const totalActive = memories.length;

  let scored = 0;
  let pruned = 0;
  let skipped_durable = 0;
  let skipped_pinned = 0;
  let rate_capped = 0;

  // Track prune candidates with their vitality
  const pruneEligible: Array<{ id: string; vitality: number }> = [];

  for (const mem of memories) {
    const p = mem.payload;
    const vitality = computeDecayScore(p, now);

    // Write decayScore back to payload
    await db.query(
      `UPDATE $id SET payload.decayScore = $vitality;`,
      { id: mem.id, vitality },
    );
    scored++;

    // Check prune eligibility (all 5 guards)
    const ageDays = (now.getTime() - new Date(p.createdAt).getTime()) / (24 * 3_600_000);
    const confidenceClamped = Math.max(0, Math.min(1, p.confidence));

    if (p.tier === "durable") {
      skipped_durable++;
      continue;
    }
    if (p.pinnedAt) {
      skipped_pinned++;
      continue;
    }
    if (
      vitality < 0.10 &&
      ageDays > 30 &&
      confidenceClamped < 0.7
    ) {
      pruneEligible.push({ id: mem.id, vitality });
    }
  }

  // Apply 5% rate cap: sort by lowest vitality first, prune up to cap
  const maxPrune = Math.floor(0.05 * totalActive);
  pruneEligible.sort((a, b) => a.vitality - b.vitality);

  const toPrune = pruneEligible.slice(0, maxPrune);
  const capped = pruneEligible.length - toPrune.length;
  rate_capped = capped;

  for (const candidate of toPrune) {
    await db.query(
      `UPDATE $id SET active = false, inactive_reason = 'decay-prune', payload.inactiveReason = 'decay-prune';`,
      { id: candidate.id },
    );
    pruned++;
  }

  return { scored, pruned, skipped_durable, skipped_pinned, rate_capped };
}

/**
 * Runs the promotion pass for a userId/scope:
 * - Ephemeral → Working: (accessCount >= 2 OR clamp(confidence,0,1) >= 0.9) AND age_hours >= 1
 * - Working → Durable: accessCount >= 3 AND clamp(confidence,0,1) >= 0.8 AND age_hours >= 24 AND active = true
 */
export async function runPromotionPass(
  db: SurrealClient,
  userId: string,
  scope: MemoryScope,
  opts?: { now?: Date; tableName?: MemoryRecordTable },
): Promise<{ promoted_to_working: number; promoted_to_durable: number }> {
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const tableName = opts?.tableName ?? "semiote";

  // Fetch all active memories for userId/scope
  const results = await db.query<{
    id: string;
    payload: {
      tier?: string;
      confidence: number;
      accessCount: number;
      createdAt: string;
      active?: boolean;
    };
  }>(
    `SELECT id, payload FROM ${tableName}
     WHERE payload.userId = $userId
     AND payload.scope = $scope
     AND (active = NONE OR active = true);`,
    { userId, scope },
  );
  const memories = results[0] ?? [];

  let promoted_to_working = 0;
  let promoted_to_durable = 0;

  for (const mem of memories) {
    const p = mem.payload;
    const confidenceClamped = Math.max(0, Math.min(1, p.confidence));
    const ageHours = (now.getTime() - new Date(p.createdAt).getTime()) / 3_600_000;

    if (p.tier === "ephemeral") {
      // Ephemeral → Working
      const meetsAccess = p.accessCount >= 2;
      const meetsConfidence = confidenceClamped >= 0.9;
      if ((meetsAccess || meetsConfidence) && ageHours >= 1) {
        await db.query(
          `UPDATE $id SET payload.tier = 'working', payload.updatedAt = $now;`,
          { id: mem.id, now: nowIso },
        );
        promoted_to_working++;
      }
    } else if (p.tier === "working") {
      // Working → Durable
      if (
        p.accessCount >= 3 &&
        confidenceClamped >= 0.8 &&
        ageHours >= 24 &&
        (p.active === true || p.active === undefined)
      ) {
        await db.query(
          `UPDATE $id SET payload.tier = 'durable', payload.updatedAt = $now;`,
          { id: mem.id, now: nowIso },
        );
        promoted_to_durable++;
      }
    }
  }

  return { promoted_to_working, promoted_to_durable };
}
