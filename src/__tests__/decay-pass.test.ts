import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeDecayScore, runDecayPass, runPromotionPass } from "../lifecycle/semion/decay-pass.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import type { MemoryScope } from "../domain/memory/types.js";

// ─── computeDecayScore tests ───────────────────────────────────────────────

describe("computeDecayScore", () => {
  const LN2 = Math.LN2;
  const LAMBDA_EPHEMERAL = LN2 / 3;
  const LAMBDA_WORKING = LN2 / 48;
  const LAMBDA_DURABLE = LN2 / 672;

  it("returns 1.0 for pinnedAt records regardless of age/access/confidence", () => {
    const mem = {
      tier: "ephemeral",
      confidence: 0,
      accessCount: 0,
      createdAt: new Date(Date.now() - 1000 * 3600 * 24 * 100).toISOString(),
      pinnedAt: new Date().toISOString(),
    };
    const score = computeDecayScore(mem, new Date());
    expect(score).toBe(1.0);
  });

  it("uses ephemeral lambda correctly", () => {
    const hoursAgo = 6;
    const now = new Date();
    const lastAccessed = new Date(now.getTime() - hoursAgo * 3_600_000);
    const mem = {
      tier: "ephemeral",
      confidence: 0.5,
      accessCount: 0,
      lastAccessedAt: lastAccessed.toISOString(),
      createdAt: lastAccessed.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_EPHEMERAL * hoursAgo);
    const access = 0;
    const confidence = 0.5;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("uses working lambda correctly", () => {
    const hoursAgo = 48;
    const now = new Date();
    const lastAccessed = new Date(now.getTime() - hoursAgo * 3_600_000);
    const mem = {
      tier: "working",
      confidence: 0.6,
      accessCount: 3,
      lastAccessedAt: lastAccessed.toISOString(),
      createdAt: lastAccessed.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_WORKING * hoursAgo);
    const access = Math.min(1.0, 3 / 5);
    const confidence = 0.6;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("uses durable lambda correctly", () => {
    const hoursAgo = 672;
    const now = new Date();
    const lastAccessed = new Date(now.getTime() - hoursAgo * 3_600_000);
    const mem = {
      tier: "durable",
      confidence: 0.9,
      accessCount: 5,
      lastAccessedAt: lastAccessed.toISOString(),
      createdAt: lastAccessed.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_DURABLE * hoursAgo);
    const access = 1.0;
    const confidence = 0.9;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("uses working lambda for null/undefined tier", () => {
    const hoursAgo = 24;
    const now = new Date();
    const lastAccessed = new Date(now.getTime() - hoursAgo * 3_600_000);
    const mem = {
      tier: undefined,
      confidence: 0.5,
      accessCount: 2,
      lastAccessedAt: lastAccessed.toISOString(),
      createdAt: lastAccessed.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_WORKING * hoursAgo);
    const access = Math.min(1.0, 2 / 5);
    const confidence = 0.5;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("falls back to createdAt when lastAccessedAt is null/undefined", () => {
    const hoursAgo = 12;
    const now = new Date();
    const createdAt = new Date(now.getTime() - hoursAgo * 3_600_000);
    const mem = {
      tier: "working",
      confidence: 0.5,
      accessCount: 1,
      createdAt: createdAt.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_WORKING * hoursAgo);
    const access = Math.min(1.0, 1 / 5);
    const confidence = 0.5;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("clamps confidence above 1.0 to 1.0", () => {
    const now = new Date();
    const mem = {
      tier: "working",
      confidence: 1.5,
      accessCount: 5,
      createdAt: now.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_WORKING * 0);
    const access = 1.0;
    const confidence = 1.0;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("clamps confidence below 0.0 to 0.0", () => {
    const now = new Date();
    const mem = {
      tier: "working",
      confidence: -0.1,
      accessCount: 0,
      createdAt: now.toISOString(),
    };
    const recency = Math.exp(-LAMBDA_WORKING * 0);
    const access = 0.0;
    const confidence = 0.0;
    const expected = (recency + access + confidence) / 3;
    expect(computeDecayScore(mem, now)).toBeCloseTo(expected, 10);
  });

  it("returns exactly 1.0 when recency=1, access=1, confidence=1", () => {
    // recency=1 means hours_since=0, access=1 means accessCount>=5, confidence=1
    const now = new Date();
    const mem = {
      tier: "working",
      confidence: 1.0,
      accessCount: 5,
      createdAt: now.toISOString(),
      lastAccessedAt: now.toISOString(),
    };
    expect(computeDecayScore(mem, now)).toBeCloseTo(1.0, 10);
  });
});

// ─── runDecayPass tests ─────────────────────────────────────────────────────

function makeMockDb(memories: any[]): SurrealClient {
  const updates: any[] = [];
  const db = {
    query: vi.fn(async (q: string, params?: any) => {
      if (q.includes("SELECT") && (q.includes("FROM memories") || q.includes("FROM semiote"))) {
        return [memories];
      }
      updates.push({ q, params });
      return [[]];
    }),
    _updates: updates,
  } as unknown as SurrealClient;
  return db;
}

function makeMemory(overrides: Partial<{
  id: string;
  tier: string;
  confidence: number;
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  pinnedAt: string;
  active: boolean;
}> = {}) {
  const now = Date.now();
  const createdAt = new Date(now - 40 * 24 * 3600_000).toISOString(); // 40 days old
  return {
    id: overrides.id ?? "memories:test1",
    payload: {
      tier: overrides.tier ?? "working",
      confidence: overrides.confidence ?? 0.5,
      accessCount: overrides.accessCount ?? 0,
      lastAccessedAt: overrides.lastAccessedAt ?? undefined,
      createdAt: overrides.createdAt ?? createdAt,
      pinnedAt: overrides.pinnedAt ?? undefined,
      active: overrides.active ?? true,
    },
  };
}

describe("runDecayPass", () => {
  it("scores all memories and returns correct count", async () => {
    const memories = [makeMemory(), makeMemory({ id: "memories:test2" })];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    expect(result.scored).toBe(2);
  });

  it("does not prune durable tier memories", async () => {
    // Create a durable memory that meets all other prune criteria
    const now = Date.now();
    const oldDate = new Date(now - 40 * 24 * 3600_000).toISOString();
    const memories = [makeMemory({ tier: "durable", confidence: 0.1, accessCount: 0, createdAt: oldDate })];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    expect(result.pruned).toBe(0);
    expect(result.skipped_durable).toBeGreaterThanOrEqual(1);
  });

  it("does not prune pinned memories", async () => {
    const now = Date.now();
    const oldDate = new Date(now - 40 * 24 * 3600_000).toISOString();
    const memories = [makeMemory({ tier: "working", confidence: 0.1, accessCount: 0, createdAt: oldDate, pinnedAt: new Date().toISOString() })];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    expect(result.pruned).toBe(0);
    expect(result.skipped_pinned).toBeGreaterThanOrEqual(1);
  });

  it("does not prune memories less than 30 days old", async () => {
    const now = Date.now();
    const youngDate = new Date(now - 20 * 24 * 3600_000).toISOString(); // 20 days old
    const memories = [makeMemory({ tier: "working", confidence: 0.05, accessCount: 0, createdAt: youngDate })];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    expect(result.pruned).toBe(0);
  });

  it("does not prune memories with confidence >= 0.7", async () => {
    const now = Date.now();
    const oldDate = new Date(now - 40 * 24 * 3600_000).toISOString();
    const memories = [makeMemory({ tier: "working", confidence: 0.8, accessCount: 0, createdAt: oldDate })];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    expect(result.pruned).toBe(0);
  });

  it("does not prune memories with vitality >= 0.10", async () => {
    const now = Date.now();
    // Create an ephemeral memory accessed recently, 40 days old
    const oldDate = new Date(now - 40 * 24 * 3600_000).toISOString();
    const recentAccess = new Date(now - 1 * 3600_000).toISOString(); // 1 hour ago
    const memories = [makeMemory({ tier: "working", confidence: 0.5, accessCount: 5, createdAt: oldDate, lastAccessedAt: recentAccess })];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    expect(result.pruned).toBe(0);
  });

  it("enforces 5% rate cap", async () => {
    const now = Date.now();
    const oldDate = new Date(now - 40 * 24 * 3600_000).toISOString();
    const ancientAccess = new Date(now - 200 * 24 * 3600_000).toISOString();
    // Create 100 memories that are all prune-eligible (all meet all 5 conditions)
    const memories = Array.from({ length: 100 }, (_, i) =>
      makeMemory({
        id: `memories:test${i}`,
        tier: "working",
        confidence: 0.05,
        accessCount: 0,
        createdAt: oldDate,
        lastAccessedAt: ancientAccess,
      })
    );
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    // 5% of 100 = 5
    expect(result.pruned).toBeLessThanOrEqual(5);
    expect(result.rate_capped).toBeGreaterThan(0);
  });

  it("prunes eligible memories when all 5 guards pass", async () => {
    const now = Date.now();
    const oldDate = new Date(now - 40 * 24 * 3600_000).toISOString();
    const ancientAccess = new Date(now - 200 * 24 * 3600_000).toISOString();
    // Use 20 memories so 5% rate cap = floor(0.05 * 20) = 1 prune allowed
    // First 19 are healthy (high confidence, accessed recently), 1 is prune-eligible
    const recentDate = new Date(now - 3 * 24 * 3600_000).toISOString(); // 3 days old — not prune eligible (< 30 days)
    const healthyMemories = Array.from({ length: 19 }, (_, i) =>
      makeMemory({ id: `memories:h${i}`, tier: "working", confidence: 0.9, accessCount: 5, createdAt: recentDate }),
    );
    const pruneEligible = makeMemory({ id: "memories:a", tier: "working", confidence: 0.05, accessCount: 0, createdAt: oldDate, lastAccessedAt: ancientAccess });
    const memories = [...healthyMemories, pruneEligible];
    const db = makeMockDb(memories);
    const result = await runDecayPass(db, "user1", "user");
    // With vitality << 0.1, all conditions met, rate cap allows 1 prune
    expect(result.pruned).toBe(1);
  });
});

// ─── runPromotionPass tests ──────────────────────────────────────────────────

describe("runPromotionPass", () => {
  it("promotes ephemeral to working via accessCount path", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 2 * 3600_000).toISOString(); // 2 hours old
    const memories = [{
      id: "memories:eph1",
      payload: {
        tier: "ephemeral",
        confidence: 0.5,
        accessCount: 2,
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_working).toBe(1);
    expect(result.promoted_to_durable).toBe(0);
  });

  it("promotes ephemeral to working via confidence path", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 2 * 3600_000).toISOString();
    const memories = [{
      id: "memories:eph2",
      payload: {
        tier: "ephemeral",
        confidence: 0.95,
        accessCount: 0,
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_working).toBe(1);
    expect(result.promoted_to_durable).toBe(0);
  });

  it("promotes working to durable when all 3 gates pass", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 25 * 3600_000).toISOString(); // 25 hours old
    const memories = [{
      id: "memories:wrk1",
      payload: {
        tier: "working",
        confidence: 0.85,
        accessCount: 3,
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_durable).toBe(1);
    expect(result.promoted_to_working).toBe(0);
  });

  it("does not promote ephemeral records less than 1 hour old", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 30 * 60_000).toISOString(); // 30 min old
    const memories = [{
      id: "memories:eph3",
      payload: {
        tier: "ephemeral",
        confidence: 0.95,
        accessCount: 5,
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_working).toBe(0);
    expect(result.promoted_to_durable).toBe(0);
  });

  it("does not promote working to durable when accessCount < 3", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 25 * 3600_000).toISOString();
    const memories = [{
      id: "memories:wrk2",
      payload: {
        tier: "working",
        confidence: 0.85,
        accessCount: 2, // < 3
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_durable).toBe(0);
  });

  it("does not promote working to durable when confidence < 0.8", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 25 * 3600_000).toISOString();
    const memories = [{
      id: "memories:wrk3",
      payload: {
        tier: "working",
        confidence: 0.7, // < 0.8
        accessCount: 3,
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_durable).toBe(0);
  });

  it("does not promote working to durable when age < 24 hours", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 12 * 3600_000).toISOString(); // 12 hours old
    const memories = [{
      id: "memories:wrk4",
      payload: {
        tier: "working",
        confidence: 0.85,
        accessCount: 3,
        createdAt,
        active: true,
      },
    }];
    const db = makeMockDb(memories);
    const result = await runPromotionPass(db, "user1", "user", { now });
    expect(result.promoted_to_durable).toBe(0);
  });
});
