import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HexisState } from "../hexis/runtime-hexis.js";
import {
  ACTIVE_HEXIS_CACHE_TESTING,
  buildActiveHexisCacheKey,
  clearActiveHexisCacheForTest,
  hasAdditionalHexisHintSignal,
  resolveActiveHexisCached,
} from "../hexis/active-hexis-cache.js";

function makeHexis(label: string): HexisState {
  return {
    id: `hexis-${label}`,
    scope: "project",
    scopeKey: `owner::project::${label}`,
    label,
    goals: [],
    roles: [],
    hypotheses: [],
    topicBias: {},
    memoryRoleWeights: {},
    relevanceWeights: {
      semantic: 1,
      recency: 1,
      usefulness: 1,
      authority: 1,
      stability: 1,
      hexisMatch: 1,
      contradictionRisk: 1,
    },
    version: 1,
    updatedAt: "2026-04-15T00:00:00.000Z",
  };
}

describe("active-hexis-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearActiveHexisCacheForTest();
  });

  afterEach(() => {
    clearActiveHexisCacheForTest();
    vi.useRealTimers();
  });

  it("hits the cache for repeated id-only lookups within TTL", async () => {
    const resolver = vi.fn().mockResolvedValue(makeHexis("id-only"));
    const input = { userId: "owner", path: "/repo", hexisHint: { id: "frame-1" } };

    const first = await resolveActiveHexisCached(input, resolver);
    const second = await resolveActiveHexisCached(input, resolver);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-resolves after the TTL expires", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce(makeHexis("first"))
      .mockResolvedValueOnce(makeHexis("second"));
    const input = { userId: "owner", path: "/repo", hexisHint: { id: "frame-1" } };

    await resolveActiveHexisCached(input, resolver);
    await vi.advanceTimersByTimeAsync(ACTIVE_HEXIS_CACHE_TESTING.CACHE_TTL_MS + 1);
    const refreshed = await resolveActiveHexisCached(input, resolver);

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(refreshed?.label).toBe("second");
  });

  it("single-flights concurrent cold-key lookups", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = vi.fn(async () => {
      await gate;
      return makeHexis("cold");
    });
    const input = { userId: "owner", path: "/repo", hexisHint: { id: "frame-1" } };

    const first = resolveActiveHexisCached(input, resolver);
    const second = resolveActiveHexisCached(input, resolver);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      makeHexis("cold"),
      makeHexis("cold"),
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("negative-caches null results within the TTL", async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    const input = { userId: "owner", path: "/repo", hexisHint: { id: "missing" } };

    const first = await resolveActiveHexisCached(input, resolver);
    const second = await resolveActiveHexisCached(input, resolver);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("bypasses cache reads when the hint carries additional signal", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce(makeHexis("cached"))
      .mockResolvedValueOnce(makeHexis("hint-rich"));

    await resolveActiveHexisCached(
      { userId: "owner", path: "/repo", hexisHint: { id: "frame-1" } },
      resolver,
    );

    const second = await resolveActiveHexisCached(
      {
        userId: "owner",
        path: "/repo",
        hexisHint: { id: "frame-1", label: "rich", goals: ["capture"] },
      },
      resolver,
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(second?.label).toBe("hint-rich");
  });

  it("single-flights concurrent hint-rich bypasses on the same fingerprinted key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = vi.fn(async () => {
      await gate;
      return makeHexis("hint-rich");
    });
    const input = {
      userId: "owner",
      path: "/repo",
      hexisHint: { id: "frame-1", label: "rich", goals: ["capture"] },
    };

    const first = resolveActiveHexisCached(input, resolver);
    const second = resolveActiveHexisCached(input, resolver);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      makeHexis("hint-rich"),
      makeHexis("hint-rich"),
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("can reuse cached rich-hint resolutions when explicitly allowed", async () => {
    const resolver = vi.fn().mockResolvedValue(makeHexis("hint-rich"));
    const input = {
      userId: "owner",
      path: "/repo",
      hexisHint: { id: "frame-1", label: "rich", goals: ["capture"] },
      allowHintRichCacheRead: true,
    };

    const first = await resolveActiveHexisCached(input, resolver);
    const second = await resolveActiveHexisCached(input, resolver);

    expect(first).toEqual(second);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("evicts the least-recently-used entry when max size is exceeded", async () => {
    const resolver = vi.fn(async (label: string) => makeHexis(label));
    for (let index = 0; index < ACTIVE_HEXIS_CACHE_TESTING.CACHE_MAX_ENTRIES; index += 1) {
      const frame = `frame-${index}`;
      await resolveActiveHexisCached(
        { userId: "owner", path: "/repo", hexisHint: { id: frame } },
        () => resolver(frame),
      );
    }

    await resolveActiveHexisCached(
      { userId: "owner", path: "/repo", hexisHint: { id: "frame-0" } },
      () => resolver("frame-0-refresh"),
    );

    await resolveActiveHexisCached(
      { userId: "owner", path: "/repo", hexisHint: { id: "frame-overflow" } },
      () => resolver("frame-overflow"),
    );

    await resolveActiveHexisCached(
      { userId: "owner", path: "/repo", hexisHint: { id: "frame-1" } },
      () => resolver("frame-1-reloaded"),
    );

    expect(resolver).toHaveBeenCalledWith("frame-1-reloaded");
  });

  it("produces stable cache keys for semantically identical hint payloads", () => {
    const left = buildActiveHexisCacheKey({
      userId: "owner",
      path: "/repo",
      hexisHint: {
        id: "frame-1",
        goals: ["capture"],
        topicBias: { semiote: 1 },
      },
    });
    const right = buildActiveHexisCacheKey({
      userId: "owner",
      path: "/repo",
      hexisHint: {
        topicBias: { semiote: 1 },
        goals: ["capture"],
        id: "frame-1",
      },
    });

    expect(left).toBe(right);
    expect(hasAdditionalHexisHintSignal({ id: "frame-1" })).toBe(false);
    expect(hasAdditionalHexisHintSignal({ id: "frame-1", goals: ["capture"] })).toBe(true);
  });
});
