import { afterEach, describe, expect, it } from "vitest";
import {
  committedIndexedDrift,
  recordCounter,
  recordMemoryCommitted,
  recordMemoryIndexed,
  recordOverlayEvictionGlobal,
  recordOverlayEvictionPerTenant,
  resetCounterEmitter,
  setCounterEmitter,
} from "../counters.js";

const FIXED_NOW_MS = 1_700_000_000_000;

function captureEmitter(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const restore = setCounterEmitter({
    emit: (line) => {
      lines.push(line);
    },
  });
  return { lines, restore };
}

describe("observability counters — Sink-B structured stderr (Rúnir-yod0.3.18)", () => {
  afterEach(() => {
    resetCounterEmitter();
  });

  it("recordCounter emits a single structured line with metric, count, and ts", () => {
    const { lines, restore } = captureEmitter();
    try {
      recordCounter("foo", 7, { now: () => FIXED_NOW_MS });
    } finally {
      restore();
    }
    expect(lines).toEqual([`metric=foo count=7 ts=${FIXED_NOW_MS}`]);
  });

  it("recordCounter renders tenant label first, then any other labels in insertion order", () => {
    const { lines, restore } = captureEmitter();
    try {
      recordCounter("bar", 3, {
        now: () => FIXED_NOW_MS,
        labels: { region: "us-east", tenant: "user-a", source: "test" },
      });
    } finally {
      restore();
    }
    expect(lines).toHaveLength(1);
    const line = lines[0];
    // tenant must precede other labels (per emit ordering rule).
    const tenantIdx = line.indexOf("tenant=user-a");
    const regionIdx = line.indexOf("region=us-east");
    const sourceIdx = line.indexOf("source=test");
    expect(tenantIdx).toBeGreaterThan(0);
    expect(tenantIdx).toBeLessThan(regionIdx);
    expect(tenantIdx).toBeLessThan(sourceIdx);
    expect(line.endsWith(`ts=${FIXED_NOW_MS}`)).toBe(true);
  });

  it("recordOverlayEvictionPerTenant emits `metric=overlay_evictions_per_tenant count=N userId=…`", () => {
    const { lines, restore } = captureEmitter();
    try {
      recordOverlayEvictionPerTenant("user-noisy", 5, () => FIXED_NOW_MS);
    } finally {
      restore();
    }
    expect(lines).toEqual([
      `metric=overlay_evictions_per_tenant count=5 tenant=user-noisy ts=${FIXED_NOW_MS}`,
    ]);
  });

  it("recordOverlayEvictionGlobal emits the global eviction counter without a tenant label", () => {
    const { lines, restore } = captureEmitter();
    try {
      recordOverlayEvictionGlobal(2, () => FIXED_NOW_MS);
    } finally {
      restore();
    }
    expect(lines).toEqual([`metric=overlay_evictions_global count=2 ts=${FIXED_NOW_MS}`]);
  });

  it("recordMemoryCommitted and recordMemoryIndexed emit per-tenant lines", () => {
    const { lines, restore } = captureEmitter();
    try {
      recordMemoryCommitted("user-a", 1, () => FIXED_NOW_MS);
      recordMemoryIndexed("user-a", 1, () => FIXED_NOW_MS + 50);
    } finally {
      restore();
    }
    expect(lines).toEqual([
      `metric=memory_committed count=1 tenant=user-a ts=${FIXED_NOW_MS}`,
      `metric=memory_indexed count=1 tenant=user-a ts=${FIXED_NOW_MS + 50}`,
    ]);
  });

  it("committedIndexedDrift — ratio is 0 and breach is false when no commits have landed", () => {
    const r = committedIndexedDrift({ committedCount: 0, indexedCount: 0 });
    expect(r.ratio).toBe(0);
    expect(r.breach).toBe(false);
    expect(r.contractHolds).toBe(true);
  });

  it("committedIndexedDrift — committed-indexed drift alert fires when ratio > 5% over 60s window", () => {
    // 100 committed, 90 indexed → drift = 10 / 100 = 10% > 5% → breach.
    const breached = committedIndexedDrift({ committedCount: 100, indexedCount: 90 });
    expect(breached.ratio).toBeCloseTo(0.1, 5);
    expect(breached.breach).toBe(true);
    expect(breached.contractHolds).toBe(true);

    // 100 committed, 96 indexed → drift = 4 / 100 = 4% ≤ 5% → no breach.
    const ok = committedIndexedDrift({ committedCount: 100, indexedCount: 96 });
    expect(ok.ratio).toBeCloseTo(0.04, 5);
    expect(ok.breach).toBe(false);
    expect(ok.contractHolds).toBe(true);

    // Custom threshold — same drift, tighter threshold should breach.
    const tightened = committedIndexedDrift({
      committedCount: 100,
      indexedCount: 96,
      thresholdRatio: 0.02,
    });
    expect(tightened.breach).toBe(true);
  });

  it("committedIndexedDrift — contract violation (indexed > committed) flags contractHolds=false", () => {
    const r = committedIndexedDrift({ committedCount: 10, indexedCount: 12 });
    expect(r.contractHolds).toBe(false);
    // ratio is negative in the violation case; breach defaults to false because
    // the "drift" is in the wrong direction (we receive an indexed event
    // without a corresponding committed). Caller should escalate on
    // contractHolds === false directly.
    expect(r.ratio).toBeLessThan(0);
    expect(r.breach).toBe(false);
  });
});
