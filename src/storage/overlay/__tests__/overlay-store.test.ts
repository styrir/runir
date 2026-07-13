import { describe, expect, it } from "vitest";
import type { OverlayLockKey } from "../../writes/overlay-supersession.js";
import {
  createOverlayRegistry,
  type OverlayEntry,
  type OverlayRegistryOptions,
} from "../overlay-store.js";

const FIXED_NOW_MS = 1_700_000_000_000;
const DEFAULT_OPTS: OverlayRegistryOptions = {
  perTenantCap: 256,
  ttlMs: 120_000,
  globalAggregateCap: 5_000,
  // Inject a stable clock so the entries' hardcoded `expiresAtMs` (now + ttl)
  // remain in the future relative to the registry's lazy-expiry check.
  now: () => FIXED_NOW_MS,
};

function makeEntry(
  userId: string,
  factKey: string,
  continuitySubjectKey: string,
  text: string,
  outcome: OverlayEntry["outcome"] = "create",
): OverlayEntry {
  const now = FIXED_NOW_MS;
  return {
    memoryId: `mem:${userId}:${factKey}:${continuitySubjectKey}`,
    text,
    lockKey: { factKey, continuitySubjectKey },
    userId,
    score: 1,
    committedAtMs: now,
    expiresAtMs: now + DEFAULT_OPTS.ttlMs,
    lastAccessedAtMs: now,
    active: true,
    outcome,
  };
}

describe("overlay store skeleton — per-userId registry over (factKey, continuitySubjectKey) lock key", () => {
  it("createOverlayRegistry().forUser(userId) returns stable per-tenant store", () => {
    const registry = createOverlayRegistry(DEFAULT_OPTS);
    const a1 = registry.forUser("user-a");
    const a2 = registry.forUser("user-a");
    const b = registry.forUser("user-b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("OverlayLockKey shape unchanged from src/storage/writes/overlay-supersession.ts:11-13", () => {
    const lockKey: OverlayLockKey = { factKey: "preference:editor", continuitySubjectKey: "user:alice" };
    expect(Object.keys(lockKey).sort()).toEqual(["continuitySubjectKey", "factKey"]);
    const registry = createOverlayRegistry(DEFAULT_OPTS);
    const store = registry.forUser("user-alice");
    store.put(lockKey, makeEntry("user-alice", lockKey.factKey, lockKey.continuitySubjectKey, "v1"));
    const fetched = store.get(lockKey);
    expect(fetched?.lockKey).toEqual(lockKey);
  });

  it("put/get/delete round-trip on the lock key", () => {
    const registry = createOverlayRegistry(DEFAULT_OPTS);
    const store = registry.forUser("user-x");
    const lk: OverlayLockKey = { factKey: "fact:f1", continuitySubjectKey: "subj:s1" };

    expect(store.get(lk)).toBeNull();
    store.put(lk, makeEntry("user-x", lk.factKey, lk.continuitySubjectKey, "v1"));
    expect(store.get(lk)?.text).toBe("v1");
    expect(store.size()).toBe(1);

    store.put(lk, makeEntry("user-x", lk.factKey, lk.continuitySubjectKey, "v2", "merge-update"));
    expect(store.get(lk)?.text).toBe("v2");
    expect(store.size()).toBe(1);

    expect(store.delete(lk)).toBe(true);
    expect(store.get(lk)).toBeNull();
    expect(store.size()).toBe(0);
    expect(store.delete(lk)).toBe(false);
  });

  it("snapshot() returns a frozen copy of all entries across factKeys", () => {
    const registry = createOverlayRegistry(DEFAULT_OPTS);
    const store = registry.forUser("user-y");
    store.put({ factKey: "fact:a", continuitySubjectKey: "subj:1" }, makeEntry("user-y", "fact:a", "subj:1", "a1"));
    store.put({ factKey: "fact:a", continuitySubjectKey: "subj:2" }, makeEntry("user-y", "fact:a", "subj:2", "a2"));
    store.put({ factKey: "fact:b", continuitySubjectKey: "subj:1" }, makeEntry("user-y", "fact:b", "subj:1", "b1"));

    const snap = store.snapshot();
    expect(snap.length).toBe(3);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap.map((e) => e.text).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("globalSize() and tenantCount() reflect cross-tenant accumulation", () => {
    const registry = createOverlayRegistry(DEFAULT_OPTS);
    expect(registry.globalSize()).toBe(0);
    expect(registry.tenantCount()).toBe(0);

    const a = registry.forUser("user-a");
    const b = registry.forUser("user-b");
    a.put({ factKey: "f1", continuitySubjectKey: "s1" }, makeEntry("user-a", "f1", "s1", "x"));
    a.put({ factKey: "f2", continuitySubjectKey: "s1" }, makeEntry("user-a", "f2", "s1", "x"));
    b.put({ factKey: "f1", continuitySubjectKey: "s1" }, makeEntry("user-b", "f1", "s1", "x"));

    expect(registry.globalSize()).toBe(3);
    expect(registry.tenantCount()).toBe(2);
  });

  it("isolation — put on tenant A does not appear on tenant B's snapshot or get", () => {
    const registry = createOverlayRegistry(DEFAULT_OPTS);
    const a = registry.forUser("user-a");
    const b = registry.forUser("user-b");
    const lk: OverlayLockKey = { factKey: "shared", continuitySubjectKey: "subj" };

    a.put(lk, makeEntry("user-a", lk.factKey, lk.continuitySubjectKey, "a-only"));
    expect(b.get(lk)).toBeNull();
    expect(b.snapshot().length).toBe(0);
    expect(a.snapshot().length).toBe(1);
  });
});
