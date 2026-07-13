/**
 * MIM-54: AccessTracker unit tests.
 * Tests half-life decay scoring, debounce, concurrent flush safety, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AccessTracker, DEBOUNCE_MS, DEFAULT_HALF_LIFE_HOURS, type AccessRecord } from "../recall/selection/access-tracker.js";

// ---------------------------------------------------------------------------
// Half-life decay computation
// ---------------------------------------------------------------------------
describe("AccessTracker.computeAccessScore — half-life decay", () => {
  const NOW_MS = Date.parse("2026-01-15T12:00:00.000Z");
  const halfLifeHours = 10;

  function hoursAgoIso(hours: number): string {
    return new Date(NOW_MS - hours * 3_600_000).toISOString();
  }

  it("accessed once at exactly 1 half-life ago: score ≈ 0.5", () => {
    const record: AccessRecord = {
      accessCount: 1,
      lastAccessedAt: hoursAgoIso(halfLifeHours),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it("accessed once at 2x half-life ago: score ≈ 0.25", () => {
    const record: AccessRecord = {
      accessCount: 1,
      lastAccessedAt: hoursAgoIso(2 * halfLifeHours),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(0.25, 2);
  });

  it("accessed 4 times at 1 half-life ago: score ≈ 2.0", () => {
    const record: AccessRecord = {
      accessCount: 4,
      lastAccessedAt: hoursAgoIso(halfLifeHours),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(2.0, 2);
  });

  it("accessed N times at N*halfLife hours ago: score ≈ N * 0.5^N (N=1)", () => {
    const N = 1;
    const record: AccessRecord = {
      accessCount: N,
      lastAccessedAt: hoursAgoIso(N * halfLifeHours),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(N * Math.pow(0.5, N), 3);
  });

  it("accessed N times at N*halfLife hours ago: score ≈ N * 0.5^N (N=2)", () => {
    const N = 2;
    const record: AccessRecord = {
      accessCount: N,
      lastAccessedAt: hoursAgoIso(N * halfLifeHours),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(N * Math.pow(0.5, N), 3);
  });

  it("accessed N times at N*halfLife hours ago: score ≈ N * 0.5^N (N=3)", () => {
    const N = 3;
    const record: AccessRecord = {
      accessCount: N,
      lastAccessedAt: hoursAgoIso(N * halfLifeHours),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(N * Math.pow(0.5, N), 3);
  });

  it("accessed just now (0 hours elapsed): score = accessCount", () => {
    const nowMs = Date.now();
    const record: AccessRecord = {
      accessCount: 3,
      lastAccessedAt: new Date(nowMs).toISOString(),
      halfLifeHours,
    };
    const score = AccessTracker.computeAccessScore(record, nowMs);
    expect(score).toBeCloseTo(3.0, 3);
  });

  it("uses DEFAULT_HALF_LIFE_HOURS when halfLifeHours omitted", () => {
    const record: AccessRecord = {
      accessCount: 1,
      lastAccessedAt: hoursAgoIso(DEFAULT_HALF_LIFE_HOURS),
      // halfLifeHours omitted — should use DEFAULT_HALF_LIFE_HOURS
    };
    const score = AccessTracker.computeAccessScore(record, NOW_MS);
    expect(score).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — must not throw, return safe defaults
// ---------------------------------------------------------------------------
describe("AccessTracker.computeAccessScore — malformed inputs (must not throw)", () => {
  const NOW_MS = Date.parse("2026-01-15T12:00:00.000Z");
  const validDate = new Date(NOW_MS - 3_600_000).toISOString();

  it("NaN accessCount → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: NaN, lastAccessedAt: validDate }, NOW_MS)).toBe(0);
  });

  it("Infinity accessCount → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: Infinity, lastAccessedAt: validDate }, NOW_MS)).toBe(0);
  });

  it("negative accessCount → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: -5, lastAccessedAt: validDate }, NOW_MS)).toBe(0);
  });

  it("Infinity halfLifeHours → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: 1, lastAccessedAt: validDate, halfLifeHours: Infinity }, NOW_MS)).toBe(0);
  });

  it("NaN halfLifeHours → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: 1, lastAccessedAt: validDate, halfLifeHours: NaN }, NOW_MS)).toBe(0);
  });

  it("zero halfLifeHours → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: 1, lastAccessedAt: validDate, halfLifeHours: 0 }, NOW_MS)).toBe(0);
  });

  it("lastAccessedAt = undefined → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: 1, lastAccessedAt: undefined }, NOW_MS)).toBe(0);
  });

  it("lastAccessedAt = 'not-a-date' → returns 0", () => {
    expect(AccessTracker.computeAccessScore({ accessCount: 1, lastAccessedAt: "not-a-date" }, NOW_MS)).toBe(0);
  });

  it("lastAccessedAt in the future (negative elapsed) → returns 0", () => {
    const futureDate = new Date(NOW_MS + 3_600_000).toISOString();
    expect(AccessTracker.computeAccessScore({ accessCount: 1, lastAccessedAt: futureDate }, NOW_MS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// track() — debounce behavior
// ---------------------------------------------------------------------------
describe("AccessTracker.track — debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("two rapid .track() calls (no delay): pending count = 1, not 2", async () => {
    const tracker = new AccessTracker();
    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = { query: queryMock };

    tracker.track("mem-1");
    tracker.track("mem-1");  // immediate second call — within debounce window

    await tracker.flush(db);

    // Should have been called once, with count=1
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0];
    expect(call[1]).toMatchObject({ count: 1 });
  });

  it("two .track() calls after DEBOUNCE_MS+100ms: count = 2", async () => {
    const tracker = new AccessTracker();
    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = { query: queryMock };

    tracker.track("mem-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    tracker.track("mem-1");  // after debounce window — new access

    await tracker.flush(db);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0];
    expect(call[1]).toMatchObject({ count: 2 });
  });

  it("different memory IDs: each tracked separately", async () => {
    const tracker = new AccessTracker();
    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = { query: queryMock };

    tracker.track("mem-A");
    tracker.track("mem-B");

    await tracker.flush(db);

    expect(queryMock).toHaveBeenCalledTimes(2);
    const ids = queryMock.mock.calls.map((c: any) => c[1].id);
    expect(ids).toContain("mem-A");
    expect(ids).toContain("mem-B");
  });
});

// ---------------------------------------------------------------------------
// flush() — concurrent safety
// ---------------------------------------------------------------------------
describe("AccessTracker.flush — concurrent safety", () => {
  it("two simultaneous flush calls: db.query called exactly once for the pending record", async () => {
    const tracker = new AccessTracker();
    let resolveQuery: ((value: unknown[][]) => void) | undefined;
    const queryMock = vi.fn().mockImplementation(
      () => new Promise<unknown[][]>((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const db = { query: queryMock };

    tracker.track("mem-1");

    // Fire two flushes simultaneously
    const [p1, p2] = [tracker.flush(db), tracker.flush(db)];
    expect(queryMock).toHaveBeenCalledTimes(1);
    resolveQuery?.([[]]);
    await Promise.all([p1, p2]);

    // Only one flush should have actually executed
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("after flush, pending is cleared: second flush does nothing", async () => {
    const tracker = new AccessTracker();
    const queryMock = vi.fn().mockResolvedValue([[]]);
    const db = { query: queryMock };

    tracker.track("mem-1");
    await tracker.flush(db);

    // Now flush again with nothing pending
    await tracker.flush(db);
    expect(queryMock).toHaveBeenCalledTimes(1); // still 1, not 2
  });
});

// ---------------------------------------------------------------------------
// flush() — empty pending
// ---------------------------------------------------------------------------
describe("AccessTracker.flush — no-op when empty", () => {
  it("flush with nothing pending: db.query not called", async () => {
    const tracker = new AccessTracker();
    const queryMock = vi.fn();
    const db = { query: queryMock };
    await tracker.flush(db);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
