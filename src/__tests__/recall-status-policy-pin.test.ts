import { describe, it, expect, vi, afterEach } from "vitest";
import { computeCurrentStatusScore, rerankCurrentStatusHits } from "../recall/continuity/recall-status-policy.js";
import type { SearchHit } from "../domain/memory/types.js";

// Rúnir-dn3e service half: an un-pinned Date.now() inside recencyScore was the
// service-side wall-clock leak that made same-data replay recordings drift.
// These tests prove the pinned-clock thread-through.

function hit(id: string, updatedAt: string, score = 0.5): SearchHit {
  return {
    id,
    text: `status update ${id} in progress`,
    score,
    updatedAt,
    createdAt: updatedAt,
  } as SearchHit;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("dn3e: pinned clock in current-status scoring", () => {
  it("produces identical scores under a pinned nowMs regardless of wall clock", () => {
    const pool = [hit("a", "2026-06-01T00:00:00.000Z"), hit("b", "2026-06-10T00:00:00.000Z")];
    const PIN = Date.parse("2026-06-11T00:00:00.000Z");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
    const early = pool.map((h) => computeCurrentStatusScore(h, pool, undefined, PIN));

    // Advance the wall clock a week — pinned scores must not move
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));
    const late = pool.map((h) => computeCurrentStatusScore(h, pool, undefined, PIN));
    expect(late).toEqual(early);

    // Control: the unpinned default DOES move with the wall clock (recency decays)
    const unpinned = pool.map((h) => computeCurrentStatusScore(h, pool, undefined));
    expect(unpinned).not.toEqual(early);
  });

  it("rerankCurrentStatusHits threads nowMs through to every hit's score", () => {
    const pool = [hit("old", "2026-05-01T00:00:00.000Z", 0.9), hit("new", "2026-06-10T00:00:00.000Z", 0.9)];
    const PIN = Date.parse("2026-06-11T00:00:00.000Z");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z")); // wall clock far in the future
    const ranked = rerankCurrentStatusHits(pool, undefined, PIN);
    // Under the pin, "new" is 1 day old (recency ≈ 0.906) and "old" is 41 days
    // old (recency ≈ 0.017) — deterministic ordering independent of wall clock
    expect(ranked[0].id).toBe("new");
    const expectedRecencyGap = 0.18 * (Math.pow(0.5, 1 / 7) - Math.pow(0.5, 41 / 7));
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(expectedRecencyGap, 10);
  });
});
