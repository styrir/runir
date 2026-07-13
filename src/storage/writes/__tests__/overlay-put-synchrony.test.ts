/**
 * Synchrony test pair for `arbitrateWrite` overlay-put — Rúnir-yod0.3.15.
 *
 * Test 1 ("overlay-put runs synchronously inside the durable-resolve
 * continuation") asserts that `overlayStore.put` is invoked on the same JS
 * microtask as the durable DB-write resolution. The detection mechanism is
 * a wrapped `Promise.resolve` that counts user-explicit invocations during
 * a synchrony window opened inside the `upsertMemory` mock body and closed
 * inside the `overlay.put` proxy. V8's engine internals (await
 * fulfillment-reaction scheduling) do NOT go through the user-overridden
 * `Promise.resolve` static, so the correct case observes ZERO calls inside
 * the window. The `.then`-counting alternative was rejected because V8's
 * slow-path (which fires whenever `Promise.prototype.then` is overridden)
 * routes engine-internal `await` continuations through user `.then`,
 * making the count noisy and Node-version dependent.
 *
 * Test 2 ("MUTANT: wrapping overlay-put in Promise.resolve().then breaks
 * synchrony") substitutes `arbitrateWrite` via `vi.doMock` with a mutant
 * implementation that mirrors the correct create-branch await chain but
 * defers overlay-put one microtask via `await Promise.resolve().then(...)`.
 * The mutant fires an EXPLICIT user `Promise.resolve()` call inside the
 * window — the synchrony harness MUST detect this
 * (`promiseResolveCallsAtPut >= 1`).
 *
 * The mutant lives entirely inside `vi.doMock`; production
 * `arbitrateWrite` MUST be free of test seams (greppable:
 * `grep -nE '__mutantOverlay|__testHook'
 *   src/storage/writes/write-arbitrator.ts | wc -l` outputs `0`).
 *
 * The file MUST run tests sequentially — the global `Promise.resolve`
 * override is order-sensitive and parallel test execution would corrupt
 * the counter. Vitest's `concurrent` modifiers (on `describe`, `test`,
 * and `it`) are therefore forbidden in this file; the bead AC pins this
 * via a greppable absence check.
 *
 * ADR 0009 §Synchrony pins the contract; plan §4 documents the call-order.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));

import { upsertMemory } from "../../surreal/surreal-store.js";
import {
  createOverlayRegistry,
  type OverlayRegistry,
  type OverlayStore,
} from "../../overlay/overlay-store.js";
import type { OverlayLockKey } from "../overlay-supersession.js";
import type { OverlayHandle } from "../write-arbitrator.js";
import { arbitrateWrite } from "../write-arbitrator.js";
import type { RecentWrite } from "../../../domain/memory/types.js";

const FIXED_NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Window-tracked discriminator (Promise.resolve global override).
//
// V8's engine internals (await fulfillment-reaction scheduling) do NOT go
// through user-overridden `Promise.resolve`; only explicit user-source calls
// do. Counting `Promise.resolve` invocations inside the synchrony window
// therefore yields a clean binary discriminator: 0 in correct code,
// >= 1 in any code that defers via `Promise.resolve(...).then(...)` or
// `await Promise.resolve()` between durable-resolve and overlay-put.
//
// ORIG_RESOLVE is captured ONCE at module load and never reassigned, so the
// wrapped version can safely call it without recursion.
// ---------------------------------------------------------------------------

const ORIG_RESOLVE: <T>(value?: T) => Promise<T> = Promise.resolve.bind(
  Promise,
) as <T>(value?: T) => Promise<T>;

let inWindow = false;
let promiseResolveCallsInWindow = 0;
let promiseResolveCallsAtPut = -1;
let callOrder: string[] = [];

const wrappedResolve = function <T>(value?: T): Promise<T> {
  if (inWindow) {
    promiseResolveCallsInWindow += 1;
  }
  return ORIG_RESOLVE(value);
};

beforeEach(() => {
  inWindow = false;
  promiseResolveCallsInWindow = 0;
  promiseResolveCallsAtPut = -1;
  callOrder = [];
  (Promise as { resolve: unknown }).resolve = wrappedResolve;
});

// Single afterEach: restore via try/finally, then post-restore sentinel.
// Vitest runs afterEach hooks in LIFO order — splitting into two would put
// the sentinel before the restore. Inlining keeps the order deterministic.
afterEach(() => {
  try {
    inWindow = false;
  } finally {
    (Promise as { resolve: unknown }).resolve = ORIG_RESOLVE;
  }
  // Post-restore sentinel: confirms the global override was unwound.
  expect(Promise.resolve).toBe(ORIG_RESOLVE);
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDb(): Parameters<typeof arbitrateWrite>[0]["db"] {
  return { query: vi.fn().mockResolvedValue([[]]) } as unknown as Parameters<
    typeof arbitrateWrite
  >[0]["db"];
}

function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

interface SpyOverlay {
  handle: OverlayHandle;
  registry: OverlayRegistry;
}

/** Create an overlay handle whose per-tenant store pushes
 *  `overlay-put-invoked` to `callOrder` AND snapshots both window counters
 *  on every `put`. The window-close happens AT the moment of put, so any
 *  post-put microtasks the test runner may schedule do not pollute the
 *  count. */
function makeSpyOverlay(): SpyOverlay {
  const registry = createOverlayRegistry({
    perTenantCap: 256,
    ttlMs: 120_000,
    globalAggregateCap: 5_000,
    now: () => FIXED_NOW_MS,
  });
  const realForUser = registry.forUser.bind(registry);
  registry.forUser = (userId: string): OverlayStore => {
    const store = realForUser(userId);
    return new Proxy(store, {
      get(target: OverlayStore, prop: keyof OverlayStore) {
        if (prop === "put") {
          return (lockKey: OverlayLockKey, entry: Parameters<OverlayStore["put"]>[1]) => {
            callOrder.push("overlay-put-invoked");
            promiseResolveCallsAtPut = promiseResolveCallsInWindow;
            inWindow = false;
            target.put(lockKey, entry);
          };
        }
        return Reflect.get(target, prop);
      },
    });
  };
  return {
    handle: { registry, ttlMs: 120_000, now: () => FIXED_NOW_MS },
    registry,
  };
}

const EXPECTED_CALL_ORDER = [
  "durable-resolve-enter",
  "overlay-put-invoked",
  "durable-resolve-exit",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("arbitrateWrite — overlay-put synchrony pin (Rúnir-yod0.3.15)", () => {
  it("overlay-put runs synchronously inside the durable-resolve continuation", async () => {
    // Mock the durable upsert: the moment its async body runs is the moment
    // the synchrony window opens. The body sets `inWindow = true` and pushes
    // `durable-resolve-enter`; control then yields to V8 which schedules the
    // continuation back into `arbitrateWrite`. With the override active, V8
    // uses the slow-path `.then` to register that continuation, so the
    // correct case observes exactly ONE `.then` call inside the window —
    // and ZERO explicit `Promise.resolve` calls.
    (upsertMemory as Mock).mockImplementation(async () => {
      inWindow = true;
      callOrder.push("durable-resolve-enter");
      return "synchrony-id";
    });

    const { handle } = makeSpyOverlay();
    const recentWrites = new Map<string, RecentWrite[]>();

    const result = await arbitrateWrite({
      db: makeDb(),
      text: "user prefers tabs over spaces",
      userId: "user-syn",
      embedding: makeVec(0),
      metadata: {
        factKey: "preference:indentation",
        continuitySubjectKey: "user:user-syn",
      },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(makeVec(0)),
      overlay: handle,
    });

    callOrder.push("durable-resolve-exit");

    expect(result.outcome).toBe("create");
    expect(callOrder).toEqual(EXPECTED_CALL_ORDER);
    // The window opens inside the upsert mock body and closes at
    // put-invocation. The synchrony invariant on this path is that NO code
    // calls `Promise.resolve(...)` between durable-resolve and overlay-put —
    // the engine's fulfillment-reaction scheduling for `await` does NOT go
    // through the user-overridden `Promise.resolve` static. ANY future
    // refactor that inserts `await Promise.resolve().then(...)`,
    // `Promise.resolve(x).then(...)`, or any other explicit
    // `Promise.resolve` call between the two events bumps the counter.
    expect(promiseResolveCallsAtPut).toBe(0);
  });

  it("MUTANT: wrapping overlay-put in Promise.resolve().then breaks synchrony", async () => {
    // Mutant via `vi.doMock` of the `arbitrateWrite` import path. The mutant
    // mirrors the correct create-branch await chain (await findSim, await
    // upsert) so the comparison is apples-to-apples; on top of that it
    // defers overlay-put one microtask via the canonical mutation:
    // `await Promise.resolve().then(() => overlayStore.put(...))`. The
    // synchrony harness MUST detect the explicit `Promise.resolve()` call
    // inside the window — `promiseResolveCallsAtPut >= 1`.
    vi.resetModules();
    vi.doMock("../write-arbitrator.js", () => ({
      arbitrateWrite: async (
        input: Parameters<typeof arbitrateWrite>[0],
      ): Promise<{ outcome: "create"; memoryId: string; reason: string }> => {
        // Simulate `await findSimilarMemories(...)` — outside the window.
        await ORIG_RESOLVE([] as unknown[]);
        // Simulate `await upsertMemory(...)` — opens the window inside the
        // simulated mock body, exactly like the real upsert mock does.
        const upsertResult = await (async () => {
          inWindow = true;
          callOrder.push("durable-resolve-enter");
          return "mutant-memid";
        })();
        // MUTATION — the line that the synchrony assertion catches.
        await Promise.resolve().then(() => {
          if (!input.overlay) return;
          const factKey = (input.metadata?.factKey as string) ?? "";
          const continuitySubjectKey =
            (input.metadata?.continuitySubjectKey as string) ?? "";
          if (!factKey || !continuitySubjectKey) return;
          input.overlay.registry.forUser(input.userId).put(
            { factKey, continuitySubjectKey },
            {
              memoryId: upsertResult,
              text: input.text,
              lockKey: { factKey, continuitySubjectKey },
              userId: input.userId,
              score: 1,
              committedAtMs: FIXED_NOW_MS,
              expiresAtMs: FIXED_NOW_MS + 120_000,
              lastAccessedAtMs: FIXED_NOW_MS,
              active: true,
              outcome: "create",
            },
          );
        });
        return {
          outcome: "create",
          memoryId: upsertResult,
          reason: "mutant",
        };
      },
    }));

    const mutantModule = (await import("../write-arbitrator.js")) as {
      arbitrateWrite: typeof arbitrateWrite;
    };
    const mutantArbitrateWrite = mutantModule.arbitrateWrite;

    const { handle } = makeSpyOverlay();
    const recentWrites = new Map<string, RecentWrite[]>();

    await mutantArbitrateWrite({
      db: makeDb(),
      text: "user prefers tabs over spaces",
      userId: "user-mut",
      embedding: makeVec(0),
      metadata: {
        factKey: "preference:indentation",
        continuitySubjectKey: "user:user-mut",
      },
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(makeVec(0)),
      overlay: handle,
    });

    callOrder.push("durable-resolve-exit");

    // Cleanup: unmock so the next test in the same run gets the real module.
    vi.doUnmock("../write-arbitrator.js");
    vi.resetModules();

    // The mutant's explicit `Promise.resolve()` call is the discriminator.
    // V8's engine internals do NOT go through user-overridden
    // `Promise.resolve`; only explicit user-source calls do. Correct code
    // observes 0 in this counter; the mutant's
    // `await Promise.resolve().then(...)` causes >= 1.
    const mutantDetected = promiseResolveCallsAtPut > 0;
    expect(mutantDetected).toBe(true);
    expect(promiseResolveCallsAtPut).toBeGreaterThanOrEqual(1);
  });
});
