/**
 * Drift contract for `memory_committed` vs `memory_indexed` — Rúnir-yod0.3.15.
 *
 * `memory_committed` fires synchronously on the durable-resolve path inside
 * `arbitrateWrite` (see `src/storage/writes/__tests__/overlay-put-synchrony.test.ts`).
 * `memory_indexed` is decoupled and fires asynchronously when the vector
 * /FTS index visibility lands. The two counters are observable via Sink-B
 * structured stderr (`src/obs/counters.ts`) and the contract that platform
 * on-call alerts on is:
 *
 *     committedIndexedDrift({ committedCount, indexedCount }).contractHolds === true
 *
 * which translates to `committedCount >= indexedCount` at every observed
 * moment — `memory_indexed` should never appear without a preceding
 * `memory_committed`. This file pins that invariant under a synthetic
 * 50-write workload with progressively delayed indexed callbacks (lag
 * sweeps through 0, 1, 2, 5 events) and additionally asserts the 5%/60s
 * breach threshold fires at exactly the boundary documented in ADR 0009
 * §Phantom-prevention rules row 2.
 */

import { describe, expect, it } from "vitest";
import { committedIndexedDrift } from "../counters.js";

interface SyntheticEvent {
  readonly type: "memory_committed" | "memory_indexed";
  readonly memoryId: string;
  readonly tMs: number;
}

/** Build a synthetic 50-write workload with `indexedLag` events of lag
 *  between each commit and its corresponding indexed event. The events are
 *  interleaved into a single ordered stream so the contract can be checked
 *  at every prefix. */
function buildWorkload(commitCount: number, indexedLag: number): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  for (let i = 0; i < commitCount; i++) {
    events.push({ type: "memory_committed", memoryId: `m-${i}`, tMs: i * 10 });
    const indexedFor = i - indexedLag;
    if (indexedFor >= 0) {
      events.push({
        type: "memory_indexed",
        memoryId: `m-${indexedFor}`,
        tMs: i * 10 + 1,
      });
    }
  }
  // Drain the trailing lag so the final `indexedCount` matches `committedCount`.
  for (let i = commitCount - indexedLag; i < commitCount; i++) {
    if (i < 0) continue;
    events.push({
      type: "memory_indexed",
      memoryId: `m-${i}`,
      tMs: commitCount * 10 + (i - (commitCount - indexedLag)),
    });
  }
  return events;
}

describe("committedIndexedDrift — drift contract under workload (Rúnir-yod0.3.15)", () => {
  it("committed >= indexed always", () => {
    // The full Cartesian sweep: 50 writes × {0, 1, 2, 5} indexed-lag values.
    // At EVERY prefix of the event stream, the contract `committed >= indexed`
    // must hold. This is the canonical invariant feeding the platform on-call
    // drift alert (`committedIndexedDrift.contractHolds === true`).
    const commitCount = 50;
    for (const indexedLag of [0, 1, 2, 5]) {
      const events = buildWorkload(commitCount, indexedLag);
      let committed = 0;
      let indexed = 0;
      for (const event of events) {
        if (event.type === "memory_committed") committed++;
        else indexed++;
        const drift = committedIndexedDrift({
          committedCount: committed,
          indexedCount: indexed,
        });
        expect(drift.contractHolds).toBe(true);
        // The drift ratio is bounded by `indexedLag / commitCount` at peak;
        // for lag=5 over 50 writes that's 10%. The contract assertion does
        // not require breach=false — only that the contract still holds.
      }
      // After the workload drains, committed === indexed and ratio == 0.
      expect(committed).toBe(commitCount);
      expect(indexed).toBe(commitCount);
      const final = committedIndexedDrift({
        committedCount: committed,
        indexedCount: indexed,
      });
      expect(final.ratio).toBe(0);
      expect(final.breach).toBe(false);
      expect(final.contractHolds).toBe(true);
    }
  });

  it("breach fires when (committed - indexed) / committed exceeds 5% over a 60s window", () => {
    // ADR 0009 §Phantom-prevention rules row 2 sets the alert threshold at
    // 5% sustained drift over 60s. The 60s aggregation is upstream of the
    // counter math; this test pins the boundary at the per-sample level.
    // 100 commits / 90 indexed → 10% drift → breach.
    const breached = committedIndexedDrift({
      committedCount: 100,
      indexedCount: 90,
    });
    expect(breached.contractHolds).toBe(true);
    expect(breached.ratio).toBeCloseTo(0.1, 5);
    expect(breached.breach).toBe(true);

    // 100 commits / 96 indexed → 4% drift → no breach.
    const ok = committedIndexedDrift({
      committedCount: 100,
      indexedCount: 96,
    });
    expect(ok.ratio).toBeCloseTo(0.04, 5);
    expect(ok.breach).toBe(false);

    // Tighter custom threshold (2%) flips the same 4% drift into a breach.
    const tightened = committedIndexedDrift({
      committedCount: 100,
      indexedCount: 96,
      thresholdRatio: 0.02,
    });
    expect(tightened.breach).toBe(true);
  });

  it("contractHolds=false when an indexed event arrives without a matching commit", () => {
    // The accounting-inversion failure mode (e.g., a leaked indexed emit
    // from a different tenant) trips `contractHolds=false`, which the
    // platform on-call runbook (docs/runbooks/overlay-on-call.md §3) pages
    // on immediately — separate from the percentage-drift breach.
    const inverted = committedIndexedDrift({
      committedCount: 5,
      indexedCount: 6,
    });
    expect(inverted.contractHolds).toBe(false);
    expect(inverted.breach).toBe(false);
    expect(inverted.ratio).toBeLessThan(0);
  });
});
