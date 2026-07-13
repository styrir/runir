import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockArbitrateWrite, mockResolveRunirSession } = vi.hoisted(() => ({
  mockArbitrateWrite: vi.fn().mockResolvedValue({ outcome: "create", memoryId: "m1" }),
  mockResolveRunirSession: vi.fn().mockResolvedValue({
    id: "runir_session_test123",
    userId: "default-user",
    projectIdentitySource: "absent",
    nativeSessionAliases: [],
    status: "active",
    openedAt: "2026-04-20T08:00:00.000Z",
    lastSeenAt: "2026-04-20T08:00:00.000Z",
    resolverKey: "resolver",
  }),
}));

// ---------------------------------------------------------------------------
// Mock all side-effect modules that index.ts imports at module level
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
    embedder: { provider: "ollama", model: "nomic-embed-text:v1.5", baseURL: "http://localhost:11434", dimensions: 768, timeoutMs: 4000 },
    reranker: { provider: "local" },
  }),
  validateRerankerConfig: vi.fn().mockReturnValue({ provider: "local" }),
  resolveEmbeddingProvider: vi.fn().mockReturnValue({
    embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
    embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
    fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
  }),
  resolveCaptureApiKey: vi.fn().mockReturnValue("test-api-key"),
}));

vi.mock("../storage/surreal/surreal-store.js", () => {
  class MockSurrealClient { query = vi.fn().mockResolvedValue([[]]); close = vi.fn(); }
  return {
    SurrealClient: MockSurrealClient,
    createWatermark: vi.fn().mockResolvedValue(undefined),
    deleteMemoryById: vi.fn(),
    ensureBm25Index: vi.fn().mockResolvedValue(undefined),
    ensureSessionWatermarksTable: vi.fn().mockResolvedValue(undefined),
    ensureEmbeddingMetadataTable: vi.fn().mockResolvedValue(undefined),
    ensureMemoryEnrichmentSchema: vi.fn().mockResolvedValue(undefined),
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
    ACTIVE_MEMORY_FILTER: "AND (active = NONE OR active = true)",
  };
});

vi.mock("../recall/query/memory-query.js", () => {
  const runHybridQuery = vi.fn().mockResolvedValue([]);
  return {
    runHybridQuery,
    runHybridQueryWithEvidenceTable: vi.fn((input: any) =>
      runHybridQuery(input.db, input.userId, input.query, input.embedding, input.limit, input.statsCache, input.scopeFilter, input.warn, input.rerankerConfig, input.embeddingProvider, input.trace, input.activeFilter, input.evidenceTable, input.tuning, input.overlay),
    ),
    vectorSearch: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../storage/writes/write-arbitrator.js", () => ({
  arbitrateWrite: mockArbitrateWrite,
}));

vi.mock("../storage/surreal/runir-session-store.js", () => ({
  ensureRunirSessionTable: vi.fn().mockResolvedValue(undefined),
  resolveRunirSession: mockResolveRunirSession,
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

import { extractMemories, segmentAndSummarize } from "../capture/extraction/capture.js";
import { createApp } from "../../index.js";

function getApp() { return createApp(); }

describe("payload-write-source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArbitrateWrite.mockResolvedValue({ outcome: "create", memoryId: "m1" });
    mockResolveRunirSession.mockResolvedValue({
      id: "runir_session_test123",
      userId: "default-user",
      projectIdentitySource: "absent",
      nativeSessionAliases: [],
      status: "active",
      openedAt: "2026-04-20T08:00:00.000Z",
      lastSeenAt: "2026-04-20T08:00:00.000Z",
      resolverKey: "resolver",
    });
  });

  it("capture path produces writeSource='capture' in metadata", async () => {
    const enrichedFact = {
      l2: "Test fact for capture path",
      l0: "Test fact for capture pat",
      l1: "- Test",
      confidence: 0.9,
      category: "cases",
      tier: "working",
      tags: [],
      factKey: "cases:test-abc123",
    };
    (extractMemories as any).mockResolvedValueOnce([enrichedFact]);

    const app = getApp();
    await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    });

    expect(mockArbitrateWrite).toHaveBeenCalled();
    const callArgs = mockArbitrateWrite.mock.calls[0][0];
    expect(callArgs.metadata.writeSource).toBe("capture");
  });

  it("agent-write path produces writeSource='agent-write' in metadata", async () => {
    const app = getApp();
    await app.request("/memory/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Direct agent write" }),
    });

    expect(mockArbitrateWrite).toHaveBeenCalled();
    const callArgs = mockArbitrateWrite.mock.calls[0][0];
    expect(callArgs.metadata.writeSource).toBe("agent-write");
  });

  it("session-end path performs NO semiote writes (extraction is turn-based-only)", async () => {
    // Rúnir-y5on/Rúnir-sq3s: writeSource="session-end" writes no longer exist —
    // session-end is watermark + raw-turn recording + runir_session close only.
    // terminationReason still lands on the runir_session close (asserted in the
    // debug test below), not on write metadata.
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session",
        messages: [{ role: "user", content: "test message" }],
        terminationReason: "resume",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: false, extraction: "disabled" });
    expect(mockArbitrateWrite).not.toHaveBeenCalled();
  });

  it("capture debug reports an active runir session with no close reason", async () => {
    // Self-sufficient extraction mock: this test previously leaned on the
    // (now deleted) session-end tests' persistent extractMemories mocks —
    // without a fact, capture takes the zero-facts early return, whose _debug
    // has no runirSession block.
    (extractMemories as any).mockResolvedValueOnce([
      { l2: "Capture debug fact that is long enough to count", confidence: 0.9, l0: "capture debug fact", l1: "- capture debug fact", category: "cases", tier: "working", tags: [], factKey: "cases:capture-debug" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test" }],
        captureDebug: true,
        sessionId: "s-active",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json._debug.runirSession).toEqual(expect.objectContaining({
      id: "runir_session_test123",
      status: "active",
      closeReason: null,
    }));
  });

  it("session-end debug reports the closed runir session reason", async () => {
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    mockResolveRunirSession
      .mockResolvedValueOnce({
        id: "runir_session_test123",
        userId: "default-user",
        projectIdentitySource: "absent",
        nativeSessionAliases: [],
        status: "active",
        openedAt: "2026-04-20T08:00:00.000Z",
        lastSeenAt: "2026-04-20T08:00:00.000Z",
        resolverKey: "resolver",
      })
      .mockResolvedValueOnce({
        id: "runir_session_test123",
        userId: "default-user",
        projectIdentitySource: "absent",
        nativeSessionAliases: [],
        status: "closed",
        closeReason: "resume",
        closedAt: "2026-04-20T08:05:00.000Z",
        openedAt: "2026-04-20T08:00:00.000Z",
        lastSeenAt: "2026-04-20T08:05:00.000Z",
        resolverKey: "resolver",
      });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test" }],
        hexisDebug: true,
        sessionId: "s-closed",
        terminationReason: "resume",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json._debug.runirSession).toEqual(expect.objectContaining({
      id: "runir_session_test123",
      status: "closed",
      closeReason: "resume",
    }));
  });
});
