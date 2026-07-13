/**
 * AccessTracker — lightweight in-memory debounce + half-life decay scorer.
 * MIM-54: Unit-testable access tracking without full SurrealDB integration.
 */

export type AccessRecord = {
  accessCount: number;
  lastAccessedAt?: string;  // ISO string
  halfLifeHours?: number;   // default 168 (1 week)
};

export type FlushTarget = {
  query(sql: string, vars?: Record<string, unknown>): Promise<unknown[][]>;
};

/** Accesses within this window count as one event (debounce). */
export const DEBOUNCE_MS = 500;

export const DEFAULT_HALF_LIFE_HOURS = 168; // 1 week

export class AccessTracker {
  constructor(private readonly tableName: "memories" | "semiote" = "semiote") {}

  private pending: Map<string, { count: number; lastMs: number }> = new Map();
  private flushing = false;

  /** Records an access event for a memory ID. Debounced within DEBOUNCE_MS. */
  track(memoryId: string): void {
    const existing = this.pending.get(memoryId);
    const now = Date.now();
    if (existing && now - existing.lastMs < DEBOUNCE_MS) {
      // Within debounce window — update timestamp but do NOT increment count
      existing.lastMs = now;
      return;
    }
    if (existing) {
      existing.count += 1;
      existing.lastMs = now;
    } else {
      this.pending.set(memoryId, { count: 1, lastMs: now });
    }
  }

  /** Flushes pending access counts to DB. Concurrent flush calls are coalesced — only one runs. */
  async flush(db: FlushTarget): Promise<void> {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const snapshot = new Map(this.pending);
    this.pending.clear();
    try {
      const now = new Date().toISOString();
      for (const [id, { count }] of snapshot) {
        await db.query(
          `UPDATE type::record('${this.tableName}', $id) SET payload.accessCount = (payload.accessCount ?? 0) + $count, payload.lastAccessedAt = $now;`,
          { id, count, now },
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Computes a decayed access score using exponential half-life decay.
   * score = accessCount * 0.5^(hoursSinceAccess / halfLifeHours)
   * Returns 0 for malformed inputs (NaN, Infinity, negative).
   */
  static computeAccessScore(record: AccessRecord, nowMs?: number): number {
    const now = nowMs ?? Date.now();
    const { accessCount, lastAccessedAt, halfLifeHours = DEFAULT_HALF_LIFE_HOURS } = record;

    // Guard malformed inputs
    if (!Number.isFinite(accessCount) || accessCount < 0) return 0;
    if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) return 0;

    if (!lastAccessedAt) return 0;
    const lastMs = Date.parse(lastAccessedAt);
    if (Number.isNaN(lastMs)) return 0;

    const hoursSince = (now - lastMs) / 3_600_000;
    if (hoursSince < 0) return 0;

    return accessCount * Math.pow(0.5, hoursSince / halfLifeHours);
  }
}
