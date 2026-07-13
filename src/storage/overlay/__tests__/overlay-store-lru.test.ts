import { describe, expect, it } from "vitest";
import type { OverlayLockKey } from "../../writes/overlay-supersession.js";
import {
  createOverlayRegistry,
  type OverlayEntry,
  type OverlayRegistry,
  type OverlayRegistryOptions,
} from "../overlay-store.js";

const BASE_OPTS: Omit<OverlayRegistryOptions, "now"> = {
  perTenantCap: 256,
  ttlMs: 120_000,
  globalAggregateCap: 5_000,
};

function makeEntry(
  userId: string,
  factKey: string,
  continuitySubjectKey: string,
  text: string,
  nowMs: number,
  ttlMs: number = BASE_OPTS.ttlMs,
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

function clock(initial: number): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function withClock(initial = 1_700_000_000_000): {
  registry: OverlayRegistry;
  clock: ReturnType<typeof clock>;
} {
  const c = clock(initial);
  return { registry: createOverlayRegistry({ ...BASE_OPTS, now: c.now }), clock: c };
}

describe("overlay store — LRU + TTL lazy expiry (Rúnir-yod0.3.12)", () => {
  it("get on a non-expired entry refreshes lastAccessedAtMs and moves it to LRU tail", () => {
    const { registry, clock } = withClock();
    const store = registry.forUser("user-a");
    const lk1: OverlayLockKey = { factKey: "f1", continuitySubjectKey: "s1" };
    const lk2: OverlayLockKey = { factKey: "f2", continuitySubjectKey: "s1" };

    store.put(lk1, makeEntry("user-a", "f1", "s1", "v1", clock.now()));
    clock.advance(10);
    store.put(lk2, makeEntry("user-a", "f2", "s1", "v2", clock.now()));

    // lk1 is currently the LRU head.
    clock.advance(10);
    const got = store.get(lk1);
    expect(got?.text).toBe("v1");
    expect(got?.lastAccessedAtMs).toBe(clock.now());

    // Inserting a new entry that triggers a per-tenant eviction (cap=2 here would
    // be ideal, but the global cap = 5000 and per-tenant cap = 256, so we test
    // ordering via snapshot iteration — last value should be the most recently
    // touched.
    const ordered = store.snapshot().map((e) => e.text);
    // Insertion order after touch: lk2 then lk1 (lk1 was re-inserted on get).
    expect(ordered).toEqual(["v2", "v1"]);
  });

  it("get on an expired entry returns null and drops it from the store", () => {
    const { registry, clock } = withClock();
    const store = registry.forUser("user-a");
    const lk: OverlayLockKey = { factKey: "f", continuitySubjectKey: "s" };
    store.put(lk, makeEntry("user-a", "f", "s", "v", clock.now(), 1_000));

    expect(store.size()).toBe(1);
    clock.advance(1_001);
    expect(store.get(lk)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("snapshot purges expired entries and returns only live ones", () => {
    const { registry, clock } = withClock();
    const store = registry.forUser("user-a");
    store.put({ factKey: "f1", continuitySubjectKey: "s" }, makeEntry("user-a", "f1", "s", "v1", clock.now(), 500));
    store.put({ factKey: "f2", continuitySubjectKey: "s" }, makeEntry("user-a", "f2", "s", "v2", clock.now(), 5_000));

    clock.advance(1_000);
    const snap = store.snapshot();
    expect(snap.map((e) => e.text)).toEqual(["v2"]);
    expect(store.size()).toBe(1);
  });

  it("registry.evictExpired() drops expired entries across all tenants", () => {
    const { registry, clock } = withClock();
    const a = registry.forUser("user-a");
    const b = registry.forUser("user-b");
    a.put({ factKey: "fa", continuitySubjectKey: "s" }, makeEntry("user-a", "fa", "s", "x", clock.now(), 500));
    b.put({ factKey: "fb", continuitySubjectKey: "s" }, makeEntry("user-b", "fb", "s", "x", clock.now(), 500));
    b.put({ factKey: "fc", continuitySubjectKey: "s" }, makeEntry("user-b", "fc", "s", "x", clock.now(), 50_000));

    clock.advance(1_000);
    const dropped = registry.evictExpired();
    expect(dropped).toBe(2);
    expect(registry.globalSize()).toBe(1);
  });

  it("Combined-form eviction triggers Pass 1 when Σ exceeds globalAggregateCap", () => {
    const c = clock(1_700_000_000_000);
    const registry = createOverlayRegistry({
      perTenantCap: 100, // intentionally larger than the per-test loop so Pass 2 doesn't fire here
      ttlMs: 10 * 60 * 1_000,
      globalAggregateCap: 5,
      now: c.now,
    });

    // 6 distinct tenants each insert one entry; 6 > globalAggregateCap (5),
    // so Pass 1 evicts the oldest cross-tenant entry on the 6th put.
    for (let i = 1; i <= 6; i++) {
      const userId = `user-${i}`;
      const store = registry.forUser(userId);
      store.put(
        { factKey: `f-${i}`, continuitySubjectKey: "s" },
        makeEntry(userId, `f-${i}`, "s", `v-${i}`, c.now()),
      );
      c.advance(1);
    }

    expect(registry.globalSize()).toBeLessThanOrEqual(5);
    // The oldest cross-tenant entry (user-1's) should have been evicted.
    expect(registry.forUser("user-1").get({ factKey: "f-1", continuitySubjectKey: "s" })).toBeNull();
    // Newer entries remain.
    expect(registry.forUser("user-6").get({ factKey: "f-6", continuitySubjectKey: "s" })?.text).toBe("v-6");
  });

  it("Combined-form eviction triggers Pass 2 when a single tenant exceeds perTenantCap", () => {
    const c = clock(1_700_000_000_000);
    const registry = createOverlayRegistry({
      perTenantCap: 3,
      ttlMs: 10 * 60 * 1_000,
      globalAggregateCap: 1_000,
      now: c.now,
    });

    const store = registry.forUser("user-x");
    for (let i = 1; i <= 5; i++) {
      store.put(
        { factKey: `f-${i}`, continuitySubjectKey: "s" },
        makeEntry("user-x", `f-${i}`, "s", `v-${i}`, c.now()),
      );
      c.advance(1);
    }

    // After 5 puts with perTenantCap=3, the 2 oldest must have been evicted.
    expect(store.size()).toBe(3);
    expect(store.get({ factKey: "f-1", continuitySubjectKey: "s" })).toBeNull();
    expect(store.get({ factKey: "f-2", continuitySubjectKey: "s" })).toBeNull();
    expect(store.get({ factKey: "f-3", continuitySubjectKey: "s" })?.text).toBe("v-3");
    expect(store.get({ factKey: "f-5", continuitySubjectKey: "s" })?.text).toBe("v-5");
  });
});
