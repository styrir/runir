import { describe, it, expect, vi } from "vitest";
import {
  EMPTY_PROFILE,
  DEFAULT_LEARNED_NOISE_THRESHOLD,
  getLearnedNoiseProfile,
  resetLearnedNoiseCacheForTests,
  type RankingProfile,
} from "../recall/policy/ranking-profile.js";
import { applyStaleSignalDemotion } from "../recall/selection/recall-selection.js";
import type { IntentSignal, QueryIntent } from "../recall/intent/intent-analyzer.js";
import type { SearchHit } from "../domain/memory/types.js";

function makeIntent(label: QueryIntent): IntentSignal {
  return { categories: [], depth: "full", confidence: 0.8, label };
}

function makeHit(id: string, score: number, text = ""): SearchHit {
  return { id, text, score, createdAt: "2026-01-01" };
}

function profileWith(over: Partial<RankingProfile>): RankingProfile {
  return { ...EMPTY_PROFILE, ...over };
}

// ── MEMBERSHIP RULE (threshold + pin exclusion), via the cached view ──────────

describe("learned-noise-profile: getLearnedNoiseProfile membership", () => {
  it("uses the default threshold and returns the fetcher's matching ids", async () => {
    const key = {};
    const fetch = vi.fn(async (_uid: string, threshold: number) => {
      expect(threshold).toBe(DEFAULT_LEARNED_NOISE_THRESHOLD);
      return ["a", "b"];
    });
    const result = await getLearnedNoiseProfile(key, "owner", EMPTY_PROFILE, fetch, 1000);
    expect([...result.learnedNoiseIds].sort()).toEqual(["a", "b"]);
    expect(result.threshold).toBe(DEFAULT_LEARNED_NOISE_THRESHOLD);
    resetLearnedNoiseCacheForTests(key);
  });

  it("honors a per-tenant threshold override from the profile", async () => {
    const key = {};
    const fetch = vi.fn(async (_uid: string, threshold: number) => {
      expect(threshold).toBe(3);
      return ["x"];
    });
    await getLearnedNoiseProfile(key, "owner", profileWith({ learnedNoiseThreshold: 3 }), fetch, 1000);
    expect(fetch).toHaveBeenCalledWith("owner", 3);
    resetLearnedNoiseCacheForTests(key);
  });

  it("EXCLUDES never-demote pins from the learned set", async () => {
    const key = {};
    const fetch = vi.fn(async () => ["keep", "pinned", "alsoKeep"]);
    const profile = profileWith({ neverDemotePins: new Set(["pinned"]) });
    const result = await getLearnedNoiseProfile(key, "owner", profile, fetch, 1000);
    expect([...result.learnedNoiseIds].sort()).toEqual(["alsoKeep", "keep"]);
    expect(result.learnedNoiseIds.has("pinned")).toBe(false);
    resetLearnedNoiseCacheForTests(key);
  });

  it("a fresh tenant (fetcher returns []) yields an EMPTY learned set", async () => {
    const key = {};
    const result = await getLearnedNoiseProfile(key, "fresh", EMPTY_PROFILE, async () => [], 1000);
    expect(result.learnedNoiseIds.size).toBe(0);
    resetLearnedNoiseCacheForTests(key);
  });

  it("degrades to an empty set (warn-logged) when the fetcher throws", async () => {
    const key = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getLearnedNoiseProfile(key, "owner", EMPTY_PROFILE, async () => {
      throw new Error("db down");
    }, 1000);
    expect(result.learnedNoiseIds.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    resetLearnedNoiseCacheForTests(key);
  });
});

// ── TTL CACHE (ogkn.1 WeakMap-per-client pattern) ─────────────────────────────

describe("learned-noise-profile: TTL cache", () => {
  it("serves from cache within the TTL window, re-queries after expiry", async () => {
    const key = {};
    const fetch = vi.fn(async () => ["a"]);
    await getLearnedNoiseProfile(key, "owner", EMPTY_PROFILE, fetch, 1000);
    await getLearnedNoiseProfile(key, "owner", EMPTY_PROFILE, fetch, 1000 + 30_000); // within 60s
    expect(fetch).toHaveBeenCalledTimes(1);
    await getLearnedNoiseProfile(key, "owner", EMPTY_PROFILE, fetch, 1000 + 61_000); // past TTL
    expect(fetch).toHaveBeenCalledTimes(2);
    resetLearnedNoiseCacheForTests(key);
  });

  it("re-queries when the threshold changes even within the TTL window", async () => {
    const key = {};
    const fetch = vi.fn(async () => ["a"]);
    await getLearnedNoiseProfile(key, "owner", profileWith({ learnedNoiseThreshold: 5 }), fetch, 1000);
    await getLearnedNoiseProfile(key, "owner", profileWith({ learnedNoiseThreshold: 9 }), fetch, 1005);
    expect(fetch).toHaveBeenCalledTimes(2);
    resetLearnedNoiseCacheForTests(key);
  });

  it("partitions cache by client key (admin override-clients never poison each other)", async () => {
    const a = {};
    const b = {};
    const fetchA = vi.fn(async () => ["fromA"]);
    const fetchB = vi.fn(async () => ["fromB"]);
    const ra = await getLearnedNoiseProfile(a, "owner", EMPTY_PROFILE, fetchA, 1000);
    const rb = await getLearnedNoiseProfile(b, "owner", EMPTY_PROFILE, fetchB, 1000);
    expect([...ra.learnedNoiseIds]).toEqual(["fromA"]);
    expect([...rb.learnedNoiseIds]).toEqual(["fromB"]);
    resetLearnedNoiseCacheForTests(a);
    resetLearnedNoiseCacheForTests(b);
  });
});

// ── DEMOTION-SITE UNION (learned ∪ static) + provable no-op (R4) ──────────────

describe("learned-noise-profile: applyStaleSignalDemotion union", () => {
  const STALE_FACTOR = 0.4;

  it("PROVABLE NO-OP: empty learned set is byte-identical to the regex-only path", () => {
    const hits = [makeHit("a", 0.9), makeHit("b", 0.7)];
    const withoutArg = applyStaleSignalDemotion(hits, makeIntent("current_status"), EMPTY_PROFILE.staleSignals);
    const withEmpty = applyStaleSignalDemotion(hits, makeIntent("current_status"), EMPTY_PROFILE.staleSignals, new Set());
    expect(withEmpty.demoted.map((h) => `${h.id}:${h.score}`)).toEqual(
      withoutArg.demoted.map((h) => `${h.id}:${h.score}`),
    );
    expect(withEmpty.staleDemotedIds.size).toBe(0);
  });

  it("demotes a learned-set member 0.40x on a status-class intent", () => {
    const hits = [makeHit("learned", 0.9), makeHit("fresh", 0.5)];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(
      hits,
      makeIntent("current_status"),
      EMPTY_PROFILE.staleSignals,
      new Set(["learned"]),
    );
    expect(staleDemotedIds.has("learned")).toBe(true);
    const learned = demoted.find((h) => h.id === "learned")!;
    expect(learned.score).toBeCloseTo(0.9 * STALE_FACTOR);
    // 0.9*0.4 = 0.36 < 0.5 → fresh now ranks first.
    expect(demoted[0].id).toBe("fresh");
  });

  it("does NOT apply the learned set on a NON-status intent (intent-conditioned)", () => {
    const hits = [makeHit("learned", 0.9), makeHit("fresh", 0.5)];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(
      hits,
      makeIntent("fact"),
      EMPTY_PROFILE.staleSignals,
      new Set(["learned"]),
    );
    expect(staleDemotedIds.size).toBe(0);
    expect(demoted.find((h) => h.id === "learned")!.score).toBeCloseTo(0.9);
  });

  it("UNION: a hit demoted by EITHER the regex OR the learned set is demoted (and not double-counted)", () => {
    const staleSignals = { current_status: [/builder brief/i] };
    const hits = [
      makeHit("regexOnly", 0.9, "The Builder Brief says X"),
      makeHit("learnedOnly", 0.8, "totally clean text"),
      makeHit("both", 0.7, "The Builder Brief again"),
      makeHit("neither", 0.6, "clean and useful"),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(
      hits,
      makeIntent("current_status"),
      staleSignals,
      new Set(["learnedOnly", "both"]),
    );
    expect(staleDemotedIds.has("regexOnly")).toBe(true);
    expect(staleDemotedIds.has("learnedOnly")).toBe(true);
    expect(staleDemotedIds.has("both")).toBe(true);
    expect(staleDemotedIds.has("neither")).toBe(false);
    // "both" demoted exactly once (0.7*0.4), not 0.7*0.4*0.4.
    expect(demoted.find((h) => h.id === "both")!.score).toBeCloseTo(0.7 * STALE_FACTOR);
  });

  it("PIN EXCLUSION end-to-end: a pinned id removed from the learned set is NOT demoted", async () => {
    // getLearnedNoiseProfile strips pins; the demotion site then sees no pinned id.
    const key = {};
    const profile = profileWith({ neverDemotePins: new Set(["pinned"]) });
    const { learnedNoiseIds } = await getLearnedNoiseProfile(
      key,
      "owner",
      profile,
      async () => ["pinned", "other"],
      1000,
    );
    const hits = [makeHit("pinned", 0.9), makeHit("other", 0.8)];
    const { staleDemotedIds } = applyStaleSignalDemotion(
      hits,
      makeIntent("session_opener"),
      EMPTY_PROFILE.staleSignals,
      learnedNoiseIds,
    );
    expect(staleDemotedIds.has("pinned")).toBe(false);
    expect(staleDemotedIds.has("other")).toBe(true);
    resetLearnedNoiseCacheForTests(key);
  });
});
