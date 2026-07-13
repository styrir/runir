import { describe, expect, it } from "vitest";
import {
  createOverlayRegistry,
  type OverlayEntry,
  type OverlayRegistryOptions,
} from "../overlay-store.js";

const DEFAULT_OPTS: OverlayRegistryOptions = {
  perTenantCap: 256,
  ttlMs: 120_000,
  globalAggregateCap: 5_000,
};

function clock(initial: number): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function makeEntry(
  userId: string,
  factKey: string,
  continuitySubjectKey: string,
  text: string,
  nowMs: number,
  ttlMs: number = DEFAULT_OPTS.ttlMs,
): OverlayEntry {
  return {
    memoryId: `mem:${userId}:${factKey}:${continuitySubjectKey}`,
    text,
    lockKey: { factKey, continuitySubjectKey },
    userId,
    score: 1,
    committedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    lastAccessedAtMs: nowMs,
    active: true,
    outcome: "create",
  };
}

describe("overlay store — multi-tenant isolation under Combined-form eviction (Rúnir-yod0.3.12)", () => {
  it("noisy userId cannot evict quiet userId's bucket", () => {
    const c = clock(1_700_000_000_000);
    const registry = createOverlayRegistry({ ...DEFAULT_OPTS, now: c.now });

    // Quiet tenant — 5 entries, plenty of headroom.
    const quiet = registry.forUser("user-quiet");
    for (let i = 0; i < 5; i++) {
      quiet.put(
        { factKey: `q-fact-${i}`, continuitySubjectKey: "subj" },
        makeEntry("user-quiet", `q-fact-${i}`, "subj", `q${i}`, c.now()),
      );
      c.advance(1);
    }
    expect(quiet.size()).toBe(5);

    // Noisy tenant — 300 puts (over the 256 perTenantCap, but well under the
    // 5000 globalAggregateCap given quiet has only 5 entries). Pass 2 should
    // evict from the noisy tenant only; Pass 1 should never fire (5 + 256 < 5000).
    const noisy = registry.forUser("user-noisy");
    for (let i = 0; i < 300; i++) {
      noisy.put(
        { factKey: `n-fact-${i}`, continuitySubjectKey: "subj" },
        makeEntry("user-noisy", `n-fact-${i}`, "subj", `n${i}`, c.now()),
      );
      c.advance(1);
    }

    // Quiet tenant intact — every original entry still readable.
    expect(quiet.size()).toBe(5);
    for (let i = 0; i < 5; i++) {
      const got = quiet.get({ factKey: `q-fact-${i}`, continuitySubjectKey: "subj" });
      expect(got?.text, `q${i} should survive noisy tenant load`).toBe(`q${i}`);
    }

    // Noisy tenant capped at perTenantCap.
    expect(noisy.size()).toBe(256);
  });

  it("Σ ≤ globalAggregateCap holds after worst-case fill (20 tenants × 256 inserts each)", () => {
    const c = clock(1_700_000_000_000);
    const registry = createOverlayRegistry({ ...DEFAULT_OPTS, now: c.now });

    const tenantCount = 20;
    const insertsPerTenant = 256;
    for (let t = 0; t < tenantCount; t++) {
      const store = registry.forUser(`user-${t}`);
      for (let i = 0; i < insertsPerTenant; i++) {
        store.put(
          { factKey: `f-${t}-${i}`, continuitySubjectKey: "subj" },
          makeEntry(`user-${t}`, `f-${t}-${i}`, "subj", `v-${t}-${i}`, c.now()),
        );
        c.advance(1);
      }
    }

    // Combined-form invariant — global cap holds post-insert.
    expect(registry.globalSize()).toBeLessThanOrEqual(DEFAULT_OPTS.globalAggregateCap);
  });

  it("each per-tenant size ≤ perTenantCap after worst-case fill", () => {
    const c = clock(1_700_000_000_000);
    const registry = createOverlayRegistry({ ...DEFAULT_OPTS, now: c.now });

    const tenantCount = 20;
    const insertsPerTenant = 256;
    for (let t = 0; t < tenantCount; t++) {
      const store = registry.forUser(`user-${t}`);
      for (let i = 0; i < insertsPerTenant; i++) {
        store.put(
          { factKey: `f-${t}-${i}`, continuitySubjectKey: "subj" },
          makeEntry(`user-${t}`, `f-${t}-${i}`, "subj", `v-${t}-${i}`, c.now()),
        );
        c.advance(1);
      }
    }

    // Per-tenant invariant — each tenant capped under Pass 2's discipline.
    for (let t = 0; t < tenantCount; t++) {
      const store = registry.forUser(`user-${t}`);
      expect(store.size(), `user-${t} size`).toBeLessThanOrEqual(DEFAULT_OPTS.perTenantCap);
    }
  });

  it("DOC: a mutant flipping to per-tenant-first then global would stabilize at Σ=tenants×perTenantCap", () => {
    // This is a documentation test that captures the discriminating intent of
    // the Combined-form ordering. We do NOT instantiate the broken ordering;
    // we just record the math contract:
    //   - 20 tenants × 256 perTenantCap = 5120
    //   - Pass-2-only would never fire Pass 1 because no single insert pushes
    //     a single tenant above 256 once Pass 2 runs eagerly per-tenant.
    //   - Σ would stabilize at 5120, exceeding globalAggregateCap (5000).
    const tenantCap = 256;
    const tenantCount = 20;
    const globalCap = 5_000;
    const mutantStableSum = tenantCount * tenantCap; // 5120
    expect(mutantStableSum).toBeGreaterThan(globalCap);
    // The Combined-form (Pass 1 globally, Pass 2 locally — both unconditional)
    // is the only ordering that enforces both caps simultaneously. Verified
    // empirically by the worst-case-fill test above.
  });
});
