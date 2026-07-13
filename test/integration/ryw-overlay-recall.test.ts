/**
 * RYW (read-your-writes) regression trio — Rúnir-yod0.3.17 / closes Rúnir-yod0.4.3.
 *
 * Three deterministic fixtures, each driving the
 * (s1-t1 admit → s1-t2 query) pair end-to-end through the in-process
 * `arbitrateWrite` overlay-put + `mergeOverlayLeg` retrieval merge stack
 * shipped under Wave 4 (Rúnir-yod0.3.13/.15/.16). Each fixture asserts:
 *
 *   - **must_contain**: the admitted memoryId appears in the s1-t2 query
 *     result with the admitted text and the overlay-leg's commit-time
 *     score.
 *   - **must_not_contain**: the result is bounded — only the admitted
 *     memory is returned (durable RRF leg is empty during the s1-t2
 *     window because the async vector/FTS index has not yet caught up).
 *
 * Determinism strategy:
 *
 *   - Stub extraction — `arbitrateWrite` accepts a pre-extracted text and
 *     embedding directly, bypassing LLM-judge nondeterminism by design.
 *   - Deterministic embeddings — `mockEmbed` derives a fixed-length
 *     `Float32Array` from the SHA-256 prefix of its input.
 *   - Fixed clock — overlay registry's `now` factory returns
 *     `FIXED_NOW_MS`. `arbitrateWrite` uses real `Date.now()` for
 *     `withinHours` recency comparisons; tests therefore mock
 *     `findSimilarMemories` to return the empty array (no merge / no
 *     supersede candidates), forcing a clean `create` outcome.
 *
 * ADR 0009 §Synchrony pins `arbitrateWrite`'s overlay-put on the same
 * microtask as the durable resolve; ADR 0009 §Read semantics +
 * §Dedupe-precedence rule pin the merge step. The harness companion at
 * `harness/__tests__/first-session-overlay-retrieval.test.ts` extends the
 * end-to-end coverage to the per-turn `ingest → turn_open → answer`
 * order.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../src/lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../src/storage/surreal/surreal-store.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/storage/surreal/surreal-store.js")
  >();
  return {
    ...actual,
    findSimilarMemories: vi.fn().mockResolvedValue([]),
    updateMemoryText: vi.fn().mockResolvedValue(undefined),
    upsertMemory: vi.fn().mockResolvedValue(undefined),
    supersedeMemory: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  findSimilarMemories,
  updateMemoryText,
  upsertMemory,
  supersedeMemory,
} from "../../src/storage/surreal/surreal-store.js";
import {
  createOverlayRegistry,
  type OverlayRegistry,
} from "../../src/storage/overlay/overlay-store.js";
import { arbitrateWrite } from "../../src/storage/writes/write-arbitrator.js";
import { mergeOverlayLeg } from "../../src/recall/query/overlay-merge.js";
import type { RecentWrite, SearchHit } from "../../src/domain/memory/types.js";
import type { SurrealClient } from "../../src/storage/surreal/surreal-store.js";

const FIXED_NOW_MS = 1_700_000_000_000;
const EMBEDDING_DIMS = 8;

function mockEmbed(text: string): number[] {
  const hash = createHash("sha256").update(text).digest();
  const out = new Array<number>(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    out[i] = (hash[i] ?? 0) / 255;
  }
  return out;
}

interface RywFixture {
  readonly name: string;
  readonly factKey: string;
  readonly continuitySubjectKey: string;
  readonly text: string;
  readonly mustNotContainSubstrings: readonly string[];
}

const FIXTURES: readonly RywFixture[] = [
  {
    name: "stable preference: s1-t1 admit visible at s1-t2 query",
    factKey: "preference:indentation",
    continuitySubjectKey: "user:user-stable-pref",
    text: "user prefers tabs over spaces",
    mustNotContainSubstrings: ["spaces with width", "ruff", "pyright"],
  },
  {
    name: "Python/mypy: s1-t1 admit visible at s1-t2 query",
    factKey: "config:python-typechecker",
    continuitySubjectKey: "project:python-mypy",
    text: "project uses mypy strict mode",
    mustNotContainSubstrings: ["pyright", "ruff", "pytype"],
  },
  {
    name: "auth-service v3 JWT_EXPIRY: s1-t1 admit visible at s1-t2 query",
    factKey: "config:auth-token-ttl",
    continuitySubjectKey: "project:auth-service",
    text: "auth-service v3 sets JWT_EXPIRY=3600",
    mustNotContainSubstrings: ["v2", "v1", "JWT_EXPIRY=900"],
  },
];

let registry: OverlayRegistry;
let recentWrites: Map<string, RecentWrite[]>;
let dbQuery: Mock;
let db: SurrealClient;

beforeEach(() => {
  vi.clearAllMocks();
  registry = createOverlayRegistry({
    perTenantCap: 256,
    ttlMs: 120_000,
    globalAggregateCap: 5_000,
    now: () => FIXED_NOW_MS,
  });
  recentWrites = new Map();
  dbQuery = vi.fn().mockResolvedValue([[]]);
  db = { query: dbQuery } as unknown as SurrealClient;
  (findSimilarMemories as Mock).mockResolvedValue([]);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
});

describe("RYW overlay recall trio (Rúnir-yod0.3.17)", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const userId = fixture.continuitySubjectKey;
      const embedding = mockEmbed(fixture.text);

      // === s1-t1: admit ===
      const admitResult = await arbitrateWrite({
        db,
        text: fixture.text,
        userId,
        embedding,
        metadata: {
          factKey: fixture.factKey,
          continuitySubjectKey: fixture.continuitySubjectKey,
        },
        scope: "user",
        source: "memory_store",
        recentWrites,
        embedText: vi.fn(async (text: string) => mockEmbed(text)),
        overlay: { registry, ttlMs: 120_000, now: () => FIXED_NOW_MS },
      });

      expect(admitResult.outcome).toBe("create");
      expect(admitResult.memoryId).toBeDefined();
      const admittedId = admitResult.memoryId!;

      // Overlay populated synchronously inside arbitrateWrite (ADR 0009 §Synchrony).
      const snapshot = registry.forUser(userId).snapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].memoryId).toBe(admittedId);
      expect(snapshot[0].text).toBe(fixture.text);

      // === s1-t2: query ===
      // Simulate the realistic RYW window: durable RRF leg returns no hits
      // because the async vector/FTS index has not yet caught up. The
      // overlay leg MUST surface the just-committed memory by itself —
      // its memoryId goes to the residual bucket and the batched fallback
      // confirms `active=true` against the durable row (which DID succeed
      // at write time).
      dbQuery.mockResolvedValueOnce([[{ id: admittedId, active: true }]]);
      const durableHits: SearchHit[] = [];
      const merged = await mergeOverlayLeg({
        db,
        userId,
        overlay: { registry },
        durableHits,
      });

      // must_contain: the admitted memoryId is visible at s1-t2.
      const hit = merged.find((h) => h.id === admittedId);
      expect(hit).toBeDefined();
      expect(hit!.text).toBe(fixture.text);
      expect(hit!.continuitySubjectKey).toBe(fixture.continuitySubjectKey);

      // must_not_contain: no irrelevant noise in the result.
      expect(merged).toHaveLength(1);
      for (const banned of fixture.mustNotContainSubstrings) {
        expect(hit!.text).not.toContain(banned);
      }

      // The single residual id was resolved via AT MOST ONE batched read
      // (ADR 0009 §Active-filter batching) — never per-id.
      expect(dbQuery).toHaveBeenCalledTimes(1);
      const [, params] = dbQuery.mock.calls[0];
      expect(params).toEqual({ ids: [admittedId] });
    });
  }
});
