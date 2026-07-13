/**
 * Overlay store — per-userId registry of in-memory RYW (read-your-writes)
 * memories pending durable-index visibility.
 *
 * Keyed on the shipped `OverlayLockKey` from `src/storage/writes/overlay-
 * supersession.ts:11-13` (factKey, continuitySubjectKey). Tenancy is the
 * OUTER dimension via the registry; the inner lock-key shape is unchanged
 * (Principle 1 — see `.omc/plans/2026-04-29-runir-yod0.3-overlay-execution.md`
 * §3 and ADR 0009 §Lock key).
 *
 * Eviction follows the **Combined form** (yod0.3.12 — see plan §3 / ADR 0009
 * §Multi-tenant partitioning rule). On every successful `put`, both passes
 * run unconditionally:
 *   Pass 1 — registry-wide LRU evicts oldest cross-tenant entry until
 *            `globalSize() ≤ globalAggregateCap`.
 *   Pass 2 — inserting tenant's per-tenant LRU evicts its oldest entry
 *            until `size(tenant) ≤ perTenantCap`.
 * Both passes are removal-only; pass order is irrelevant for invariant
 * satisfaction. The standardized order (Pass 1 then Pass 2) matches the
 * "global pressure first, local trim second" intuition.
 *
 * Lazy expiry runs on `get` and `snapshot` — entries past `expiresAtMs`
 * are dropped before the call returns. Lazy expiry is orthogonal to LRU
 * and not part of the cap-enforcement precedence.
 *
 * Canonical anchor: `~/Documents/Obsidian Vault/1. Projects/Styrir/Runir/
 * Rúnir architectural improvement plan.md` §Priority 1 "fix read-your-writes".
 */

import type { OverlayLockKey } from "../writes/overlay-supersession.js";

export interface OverlayEntry {
  readonly memoryId: string;
  readonly text: string;
  readonly lockKey: OverlayLockKey;
  readonly userId: string;
  readonly score: number;
  readonly committedAtMs: number;
  readonly expiresAtMs: number;
  readonly lastAccessedAtMs: number;
  readonly active: boolean;
  readonly outcome: "create" | "merge-update" | "supersede";
}

export interface OverlayStore {
  put(lockKey: OverlayLockKey, entry: OverlayEntry): void;
  get(lockKey: OverlayLockKey): OverlayEntry | null;
  delete(lockKey: OverlayLockKey): boolean;
  snapshot(): readonly OverlayEntry[];
  size(): number;
}

export interface OverlayRegistry {
  forUser(userId: string): OverlayStore;
  globalSize(): number;
  tenantCount(): number;
  evictExpired(now?: number): number;
}

export interface OverlayRegistryOptions {
  readonly perTenantCap: number;
  readonly ttlMs: number;
  readonly globalAggregateCap: number;
  readonly now?: () => number;
}

function serializeLockKey(lockKey: OverlayLockKey): string {
  // \x00 is invalid in user-supplied factKey / continuitySubjectKey strings
  // by upstream sanitization (see capture/extraction). Using it as a
  // separator here yields a collision-proof flat key.
  return `${lockKey.factKey}\x00${lockKey.continuitySubjectKey}`;
}

class PerTenantStore implements OverlayStore {
  /** Flat storage; Map's insertion order tracks LRU (head = least-recently-
   *  used, tail = most-recently-used). `put` and `get` re-insert at the tail
   *  to keep this invariant; `lruHead()` reads the head. */
  private readonly entries: Map<string, OverlayEntry> = new Map();

  constructor(
    private readonly opts: OverlayRegistryOptions,
    private readonly onAfterPut: () => void,
  ) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private lazyExpire(): void {
    const t = this.nowMs();
    let expired: string[] | null = null;
    for (const [k, e] of this.entries) {
      if (t >= e.expiresAtMs) {
        if (expired === null) expired = [];
        expired.push(k);
      }
    }
    if (expired !== null) {
      for (const k of expired) this.entries.delete(k);
    }
  }

  put(lockKey: OverlayLockKey, entry: OverlayEntry): void {
    const k = serializeLockKey(lockKey);
    if (this.entries.has(k)) this.entries.delete(k);
    this.entries.set(k, entry);
    this.onAfterPut();
  }

  get(lockKey: OverlayLockKey): OverlayEntry | null {
    const k = serializeLockKey(lockKey);
    const existing = this.entries.get(k);
    if (!existing) return null;
    if (this.nowMs() >= existing.expiresAtMs) {
      this.entries.delete(k);
      return null;
    }
    // Touch — move to LRU tail and refresh lastAccessedAtMs.
    this.entries.delete(k);
    const touched: OverlayEntry = { ...existing, lastAccessedAtMs: this.nowMs() };
    this.entries.set(k, touched);
    return touched;
  }

  delete(lockKey: OverlayLockKey): boolean {
    return this.entries.delete(serializeLockKey(lockKey));
  }

  snapshot(): readonly OverlayEntry[] {
    this.lazyExpire();
    const out: OverlayEntry[] = [];
    for (const e of this.entries.values()) out.push(e);
    return Object.freeze(out);
  }

  size(): number {
    this.lazyExpire();
    return this.entries.size;
  }

  /** O(1) — head of the per-tenant LRU. Returns the oldest non-expired
   *  entry for this tenant, or null if empty. */
  lruHead(): OverlayEntry | null {
    this.lazyExpire();
    const it = this.entries.values().next();
    return it.done ? null : it.value;
  }

  /** Evict the per-tenant LRU head; returns true if anything was removed. */
  evictLruHead(): boolean {
    this.lazyExpire();
    const it = this.entries.keys().next();
    if (it.done) return false;
    return this.entries.delete(it.value);
  }

  /** Drop expired entries; returns the count removed. */
  evictExpired(): number {
    const t = this.nowMs();
    let count = 0;
    let expired: string[] | null = null;
    for (const [k, e] of this.entries) {
      if (t >= e.expiresAtMs) {
        if (expired === null) expired = [];
        expired.push(k);
      }
    }
    if (expired !== null) {
      for (const k of expired) {
        if (this.entries.delete(k)) count++;
      }
    }
    return count;
  }
}

class OverlayRegistryImpl implements OverlayRegistry {
  private readonly tenants: Map<string, PerTenantStore> = new Map();

  constructor(private readonly _opts: OverlayRegistryOptions) {}

  forUser(userId: string): OverlayStore {
    let store = this.tenants.get(userId);
    if (!store) {
      store = new PerTenantStore(this._opts, () => this.afterPut(userId));
      this.tenants.set(userId, store);
    }
    return store;
  }

  globalSize(): number {
    let total = 0;
    for (const store of this.tenants.values()) total += store.size();
    return total;
  }

  tenantCount(): number {
    let count = 0;
    for (const store of this.tenants.values()) {
      if (store.size() > 0) count++;
    }
    return count;
  }

  evictExpired(): number {
    let total = 0;
    for (const store of this.tenants.values()) total += store.evictExpired();
    return total;
  }

  /** Combined-form eviction post-`put`. Both passes run unconditionally and
   *  are order-independent for invariant satisfaction (see ADR 0009
   *  §Multi-tenant partitioning rule). Standardized order is Pass 1 then
   *  Pass 2 — global pressure first, local trim second. */
  private afterPut(insertingUserId: string): void {
    // Pass 1 — registry-wide LRU until Σ ≤ globalAggregateCap.
    while (this.globalSize() > this._opts.globalAggregateCap) {
      const head = this.registryLruHead();
      if (head === null) break;
      head.store.evictLruHead();
    }
    // Pass 2 — inserting tenant's per-tenant LRU until size(tenant) ≤ perTenantCap.
    const store = this.tenants.get(insertingUserId);
    if (!store) return;
    while (store.size() > this._opts.perTenantCap) {
      if (!store.evictLruHead()) break;
    }
  }

  /** Find the registry-wide LRU head — the oldest non-expired entry across
   *  every tenant store (compared by `lastAccessedAtMs`). Cost is O(T) where
   *  T = active tenant count (bounded by traffic shape, typically ≤ 20). */
  private registryLruHead(): { store: PerTenantStore; entry: OverlayEntry } | null {
    let owner: PerTenantStore | null = null;
    let oldest: OverlayEntry | null = null;
    for (const store of this.tenants.values()) {
      const head = store.lruHead();
      if (head === null) continue;
      if (oldest === null || head.lastAccessedAtMs < oldest.lastAccessedAtMs) {
        owner = store;
        oldest = head;
      }
    }
    return owner !== null && oldest !== null ? { store: owner, entry: oldest } : null;
  }
}

export function createOverlayRegistry(opts: OverlayRegistryOptions): OverlayRegistry {
  return new OverlayRegistryImpl(opts);
}
