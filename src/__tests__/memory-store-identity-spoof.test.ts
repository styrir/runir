import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Rúnir-pn1l Q4 U0 (2026-07-07) — SPOOF REGRESSION.
//
// Route-level test for the `/memory/store` identity-metadata strip + the
// noemaClaimKey proof-arm drop, exercised TOGETHER through the real HTTP app
// and the real arbitrateWrite (only surreal-store.js / config-adjacent
// leaves are mocked — write-arbitrator.js is deliberately NOT mocked so the
// real proveReferentIdentity / anchor-conflict veto runs).
//
// Scenario: a caller injects `metadata.noemaClaimKey` (and separately
// `metadata.atomicFact`) that matches a stored candidate's, while the two
// facts carry a genuine referent-anchor CONFLICT (same file_line KIND,
// different line — the exact class this brief's setsEqual fix targets;
// Codex code-review P2, 2026-07-07: the earlier "conflicting project tags"
// premise was moot, since `factMetadata()` unconditionally overwrites
// `metadata.tags` with `fact.tags` before it ever reaches arbitration —
// `memory/index.ts:219-221` — so tags sent by the caller are discarded
// regardless of this fix). Before this fix, a matching noemaClaimKey/
// atomicFact alone could PROVE referent identity and authorize a supersede/
// merge across genuinely different facts — an unauthenticated
// client-injected "proof of identity". After this fix:
//   1. The route strips noemaClaimKey/atomicFact from client-supplied metadata
//      before it ever reaches write arbitration (defense-in-depth).
//   2. noemaClaimKey is no longer a ReferentKeys proof arm at all, so even if
//      it reached arbitration unstripped it could not prove identity.
//   3. The genuine anchor conflict deterministically forces the merge-band
//      anchor-conflict veto (outcome: "create"), which ALSO guarantees
//      upsertMemory — not updateMemoryText — is the fn that persists, since
//      updateMemoryText's continuityMetadata param cannot structurally carry
//      noemaClaimKey/atomicFact at all (asserting against it would prove
//      nothing regardless of the fix).
// Net: NO supersede/merge, and the metadata argument ACTUALLY PERSISTED by
// upsertMemory never carries the injected identity-proof keys.

const { mockFindSimilarMemories, mockLogSupersedeShadow, mockSupersedeMemory, mockUpdateMemoryText, mockUpsertMemory } =
  vi.hoisted(() => ({
    mockFindSimilarMemories: vi.fn().mockResolvedValue([]),
    mockLogSupersedeShadow: vi.fn().mockResolvedValue(undefined),
    mockSupersedeMemory: vi.fn().mockResolvedValue(undefined),
    mockUpdateMemoryText: vi.fn().mockResolvedValue(undefined),
    mockUpsertMemory: vi.fn().mockResolvedValue("new-id"),
  }));

// ---------------------------------------------------------------------------
// Mock all side-effect modules index.ts/server.ts import at module level.
// Deliberately mirrors payload-write-source.test.ts's scaffold, EXCEPT
// write-arbitrator.js is NOT mocked (the real arbitrateWrite must run so the
// real proveReferentIdentity / anchor-conflict veto is exercised).
// ---------------------------------------------------------------------------

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("../shared/config.js", () => ({
  parseConfig: vi.fn().mockReturnValue({
    userId: "default-user",
    autoRecall: true,
    autoCapture: true,
    topK: 5,
    customPrompt: undefined,
    surrealdb: { url: "http://localhost:8000", username: "root", password: "", namespace: "main", database: "main" },
    embedder: { provider: "ollama", model: "nomic-embed-text:v1.5", baseURL: "http://localhost:11434", dimensions: 8, timeoutMs: 4000 },
    reranker: { provider: "local" },
  }),
  validateRerankerConfig: vi.fn().mockReturnValue({ provider: "local" }),
  resolveEmbeddingProvider: vi.fn().mockReturnValue({
    embedQuery: vi.fn().mockResolvedValue(makeVec(0)),
    embedDocument: vi.fn().mockResolvedValue(makeVec(0)),
    fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
  }),
  resolveCaptureApiKey: vi.fn().mockReturnValue("test-api-key"),
}));

vi.mock("../storage/surreal/surreal-store.js", () => {
  class MockSurrealClient { query = vi.fn().mockResolvedValue([[]]); close = vi.fn(); }
  return {
    SurrealClient: MockSurrealClient,
    ACTIVE_MEMORY_FILTER: "AND (active = NONE OR active = true)",
    createWatermark: vi.fn().mockResolvedValue(undefined),
    deleteMemoryById: vi.fn(),
    ensureBm25Index: vi.fn().mockResolvedValue(undefined),
    ensureSessionWatermarksTable: vi.fn().mockResolvedValue(undefined),
    ensureEmbeddingMetadataTable: vi.fn().mockResolvedValue(undefined),
    ensureMemoryEnrichmentSchema: vi.fn().mockResolvedValue(undefined),
    ensureSupersedeShadowTable: vi.fn().mockResolvedValue(undefined),
    extractId: vi.fn((id: string) => id),
    getLastWatermark: vi.fn().mockResolvedValue(null),
    getMemoryById: vi.fn(),
    getMemoryHealth: vi.fn(),
    getMemoryLineage: vi.fn(),
    getEmbeddingFingerprint: vi.fn().mockResolvedValue(null),
    setEmbeddingFingerprint: vi.fn().mockResolvedValue(undefined),
    listMemories: vi.fn(),
    listRecentMemories: vi.fn(),
    restoreMemoryById: vi.fn(),
    ensureRejectionLogTable: vi.fn().mockResolvedValue(undefined),
    ensureAttributionFields: vi.fn().mockResolvedValue(undefined),
    backfillHasPath: vi.fn().mockResolvedValue(0),
    logRejection: vi.fn().mockResolvedValue(undefined),
    ensureProjectStateTable: vi.fn().mockResolvedValue(undefined),
    compareAndSwapProjectState: vi.fn().mockImplementation(async (_db: any, state: any) => ({
      id: "ps-1",
      ...state,
      version: (state.expectedVersion ?? 0) + 1,
    })),
    upsertProjectState: vi.fn().mockResolvedValue({ id: "ps-1", userId: "test", activeTicketIds: [], blockers: [], nextSteps: [], supportingMemoryIds: [], confidence: 0.8, updatedAt: new Date().toISOString() }),
    getProjectState: vi.fn().mockResolvedValue(null),
    getProjectStateForCaptureContext: vi.fn().mockResolvedValue(null),
    listRecentFactsForCaptureContext: vi.fn().mockResolvedValue([]),
    listNearbyExistingForCaptureContext: vi.fn().mockResolvedValue([]),
    listContinuityMemoryHits: vi.fn().mockResolvedValue([]),
    hydrateLatestStateRepresentativeHits: vi.fn().mockResolvedValue([]),
    projectStateRecordId: vi.fn().mockReturnValue("project_state_test123"),
    invalidateContinuityStateRecords: vi.fn().mockResolvedValue(0),
    // The write-arbitration surface actually exercised by this test:
    findSimilarMemories: mockFindSimilarMemories,
    logSupersedeShadow: mockLogSupersedeShadow,
    supersedeMemory: mockSupersedeMemory,
    updateMemoryText: mockUpdateMemoryText,
    upsertMemory: mockUpsertMemory,
  };
});

vi.mock("../recall/query/memory-query.js", () => ({
  runHybridQuery: vi.fn().mockResolvedValue([]),
  runHybridQueryWithEvidenceTable: vi.fn().mockResolvedValue([]),
  runHybridQueryWithEvidenceTableAndEntityTrace: vi.fn().mockResolvedValue({ hits: [], entityMatches: [], legRanks: {} }),
  vectorSearch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../storage/surreal/runir-session-store.js", () => ({
  ensureRunirSessionTable: vi.fn().mockResolvedValue(undefined),
  resolveRunirSession: vi.fn().mockResolvedValue({
    id: "runir_session_test123",
    userId: "default-user",
    projectIdentitySource: "absent",
    nativeSessionAliases: [],
    status: "active",
    openedAt: "2026-07-07T08:00:00.000Z",
    lastSeenAt: "2026-07-07T08:00:00.000Z",
    resolverKey: "resolver",
  }),
}));

vi.mock("../capture/extraction/capture.js", () => ({
  extractMemories: vi.fn().mockResolvedValue([]),
  normalizeCaptureMessages: vi.fn().mockImplementation((msgs: any[]) => msgs),
  resolveCapturePrompt: vi.fn().mockReturnValue("test-prompt"),
  segmentAndSummarize: vi.fn().mockResolvedValue({ topics: [] }),
  normalizeExtractedFact: vi.fn().mockImplementation((raw: any) => ({
    l2: raw.l2,
    l0: raw.l2.slice(0, 100),
    l1: "- " + raw.l2.slice(0, 100),
    confidence: raw.confidence ?? 0.7,
    category: "cases",
    tier: "working",
    tags: [],
    factKey: "cases:test-abc123",
  })),
  isNoisyFact: vi.fn().mockReturnValue(false),
  extractTopicTags: vi.fn().mockReturnValue([]),
  batchDedupFacts: vi.fn().mockImplementation(async (facts: any[]) => facts),
  STOP_WORDS: new Set(["the", "and", "for", "with", "this", "that"]),
}));

vi.mock("../capture/extraction/noise-prototype-bank.js", () => {
  class MockNoisePrototypeBank {
    initialized = false;
    size = 0;
    init = vi.fn().mockResolvedValue(undefined);
    isNoise = vi.fn().mockReturnValue(false);
    learn = vi.fn();
  }
  return { NoisePrototypeBank: MockNoisePrototypeBank };
});

vi.mock("../recall/intent/intent-analyzer.js", () => ({
  analyzeIntent: vi.fn().mockReturnValue({ categories: [], depth: "full", confidence: 0.3, label: "fact" }),
  applyCategoryBoost: vi.fn().mockImplementation((results: any[]) => results),
}));

vi.mock("../lifecycle/compaction/memory-compactor.js", () => ({
  runCompaction: vi.fn().mockResolvedValue(null),
  DEFAULT_COMPACTION_CONFIG: { enabled: false },
}));

vi.mock("../recall/selection/recall-selection.js", () => ({
  formatRecallInjection: vi.fn().mockReturnValue("injected"),
  formatRecallInjectionFromRendered: vi.fn().mockReturnValue("injected-rendered"),
  toToolSearchResults: vi.fn().mockReturnValue({ results: [] }),
  toAuditSearchResults: vi.fn().mockReturnValue({ results: [] }),
  postProcessRecallResults: vi.fn().mockImplementation((hits: any[]) => hits),
}));

vi.mock("../recall/query/scope-predicate.js", () => ({
  resolveScopeFilter: vi.fn().mockReturnValue(undefined),
  resolveWriteScope: vi.fn().mockReturnValue({ scope: "user", sessionId: undefined }),
  resolveAttrField: vi.fn().mockReturnValue(undefined),
  resolveAttributionFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  mergeFilters: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  applyRecallSoftFilters: vi.fn().mockImplementation((hits) => hits),
}));

vi.mock("../lifecycle/semion/lock.js", () => ({
  ensureConsolidationLockTable: vi.fn().mockResolvedValue(undefined),
  ensureStalenessBacklogTable: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lifecycle/semion/consolidation.js", () => ({
  ensureConsolidationLogTable: vi.fn().mockResolvedValue(undefined),
  ensureConsolidationStateTable: vi.fn().mockResolvedValue(undefined),
  startConsolidationScheduler: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../lifecycle/semion/staleness-pass.js", () => ({
  runStalenessPass: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../entities/entity-store.js", () => ({
  ensureEntityTables: vi.fn().mockResolvedValue(undefined),
  findEntityByName: vi.fn().mockResolvedValue([]),
  getEntityNeighbors: vi.fn().mockResolvedValue([]),
  getSupportingMemoryIds: vi.fn().mockResolvedValue([]),
  linkEntityToMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../entities/entity-arbitrator.js", () => ({
  normalizeEntityName: vi.fn((n: string) => n.toLowerCase()),
  arbitrateEntity: vi.fn().mockResolvedValue({ entityId: "e1", outcome: "create" }),
}));

vi.mock("../entities/entity-extractor.js", () => ({
  extractEntities: vi.fn().mockResolvedValue([]),
}));

vi.mock("../capture/continuity/salience-schema.js", () => ({
  ensureSalienceSchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../capture/continuity/salience-prototypes.js", () => ({
  upsertSeedPrototypes: vi.fn().mockResolvedValue(undefined),
  deriveCentroids: vi.fn().mockResolvedValue(undefined),
  fetchSalienceCentroids: vi.fn().mockResolvedValue(new Map()),
  SEED_PROTOTYPES: [],
}));

vi.mock("../capture/continuity/session-salience.js", () => ({
  scoreSessionSalience: vi.fn().mockResolvedValue({
    score: 0.8,
    hardOverride: false,
    signals: { lexicalDensity: 0.5, causalMarkerCount: 0, technicalArtifactScore: 0.5 },
    reason: "mock",
    vectorSignals: undefined,
  }),
  setSalienceVectorReady: vi.fn(),
  salienceVectorReady: false,
}));

vi.mock("../shared/debug-logger.js", () => ({
  makeDebugLogger: vi.fn().mockReturnValue({
    segmentation: vi.fn(), factExtraction: vi.fn(), arbitrationOutcome: vi.fn(),
    entityExtraction: vi.fn(), entityOutcome: vi.fn(), recallResults: vi.fn(),
    watermark: vi.fn(), normalize: vi.fn(), salience: vi.fn(),
  }),
}));

vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

import { createApp } from "../../index.js";
// `recentWrites` is a REAL module-level in-memory dedup cache (not mocked here —
// write-arbitrator.js/runtime.ts are deliberately left real so the actual
// proveReferentIdentity/anchor-conflict veto runs). It must be cleared between
// tests in this file, otherwise test 2's write can be caught by test 1's
// exact-normalized-duplicate skip band (recentWrites persists across `it()`
// blocks within the same test file/module graph).
import { recentWrites } from "../app/runtime.js";

function getApp() { return createApp(); }

const NOW = new Date().toISOString();

describe("memory-store-identity-spoof (Rúnir-pn1l Q4 U0, 2026-07-07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSimilarMemories.mockResolvedValue([]);
    mockLogSupersedeShadow.mockResolvedValue(undefined);
    mockSupersedeMemory.mockResolvedValue(undefined);
    mockUpdateMemoryText.mockResolvedValue(undefined);
    mockUpsertMemory.mockResolvedValue("new-id");
    recentWrites.clear();
    delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
    delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
    delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
    delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
    delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
    delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
    delete process.env.RUNIR_SUPERSEDE_SHADOW;
  });

  it("injected noemaClaimKey matching a conflicting candidate does NOT supersede; persisted upsertMemory metadata carries no injected key", async () => {
    // Rúnir-pn1l Q4 U0 P2 fix (Codex code-review, 2026-07-07): the prior version of
    // this test used "conflicting project tags" as the differentiator, but that premise
    // is moot — factMetadata() unconditionally overwrites metadata.tags with fact.tags
    // (memory/index.ts:219-221; the mocked normalizeExtractedFact always returns tags:
    // []), so any tags the caller sends are discarded before arbitration ever sees them.
    // This version instead uses a real referent-anchor conflict (same file_line anchor
    // KIND, DIFFERENT line — the exact class of conflict this brief's fix targets) as
    // the genuine differentiator between the two facts, which ALSO deterministically
    // forces the merge-band anchor-conflict veto to fire (outcome: "create", not
    // "merge-update"), guaranteeing upsertMemory (not updateMemoryText) is the fn that
    // actually persists — updateMemoryText's continuityMetadata param shape
    // (memoryRole/validAt/continuitySubjectKey only, surreal-store.ts:836-840) cannot
    // structurally carry noemaClaimKey/atomicFact at all, so asserting against it would
    // prove nothing regardless of the fix.
    //
    // Same statement key ("deploy target") on both sides so F1 (deterministic_text)
    // NOMINATES the candidate — the veto, not a missing nomination, must be what stops
    // the supersede. The caller also injects a noemaClaimKey that matches the
    // candidate's exactly — an attempted spoof of the key:noemaClaimKey proof arm that
    // (pre-fix) could alone PROVE referent identity and authorize a supersede/merge.
    mockFindSimilarMemories.mockResolvedValue([
      {
        id: "candidate-1",
        l2: "deploy target: src/config.ts:10 needs an update",
        similarity: 0.90,
        createdAt: NOW,
        updatedAt: NOW,
        noemaClaimKey: "claim:spoofed-shared-key",
      },
    ]);

    const app = getApp();
    const res = await app.request("/memory/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Same file_line KIND (src/config.ts) but a DIFFERENT line (99 vs 10) — a real
        // anchor conflict, not a tag artifact that factMetadata would discard anyway.
        text: "deploy target: src/config.ts:99 needs an update",
        metadata: {
          noemaClaimKey: "claim:spoofed-shared-key",
        },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.outcome).toBe("create");
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
    expect(mockUpdateMemoryText).not.toHaveBeenCalled();

    // Assert the ACTUAL persisted metadata argument, not an incidental object in the
    // call args. upsertMemory's signature is (db, id, text, userId, embedding, metadata,
    // scope, sessionId, lifecycle, tableName) — metadata is positional argument index 5
    // (write-arbitrator.ts create-path call site, `await upsertMemory(input.db, id,
    // input.text, input.userId, input.embedding, { ...input.metadata, ... }, ...)`).
    expect(mockUpsertMemory).toHaveBeenCalledTimes(1);
    const persistedMetadata = mockUpsertMemory.mock.calls[0][5] as Record<string, unknown>;
    expect(persistedMetadata).toBeDefined();
    expect(persistedMetadata.noemaClaimKey).toBeUndefined();
  });

  it("injected atomicFact matching a conflicting candidate does NOT supersede; persisted upsertMemory metadata carries no injected atomicFact", async () => {
    // Same P2 fix as above, mirrored for the atomicFact spoof arm. Distinct l2 text vs
    // the noemaClaimKey test above (different file path in the anchor, different
    // statement-key value) — the module-level recentWrites cache in runtime.ts is real
    // and shared across tests in this file, so an identical incoming text here would be
    // caught by the earlier exact-duplicate skip band instead of exercising this test's
    // own scenario.
    mockFindSimilarMemories.mockResolvedValue([
      {
        id: "candidate-2",
        l2: "release target: src/deploy.ts:10 needs an update",
        similarity: 0.90,
        createdAt: NOW,
        updatedAt: NOW,
        atomicFact: { subject: "shared-subject", predicate: "shared-predicate", value: "candidate-value" },
      },
    ]);

    const app = getApp();
    const res = await app.request("/memory/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "release target: src/deploy.ts:99 needs an update",
        metadata: {
          // Injected atomicFact with the SAME subject|predicate as the candidate's
          // (an attempted spoof of the key:atomicFactIdentity proof arm).
          atomicFact: { subject: "shared-subject", predicate: "shared-predicate", value: "incoming-value" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.outcome).toBe("create");
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
    expect(mockUpdateMemoryText).not.toHaveBeenCalled();

    expect(mockUpsertMemory).toHaveBeenCalledTimes(1);
    const persistedMetadata = mockUpsertMemory.mock.calls[0][5] as Record<string, unknown>;
    expect(persistedMetadata).toBeDefined();
    expect(persistedMetadata.atomicFact).toBeUndefined();
  });
});
