import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockArbitrateWrite, mockLinkEntityToMemory, mockArbitrateEntity } = vi.hoisted(() => ({
  mockArbitrateWrite: vi.fn().mockResolvedValue({ outcome: "create", memoryId: "m1" }),
  mockLinkEntityToMemory: vi.fn().mockResolvedValue("edge-1"),
  mockArbitrateEntity: vi.fn().mockResolvedValue({ entityId: "e1", outcome: "create" }),
}));

// ---------------------------------------------------------------------------
// Mock all side-effect modules
// ---------------------------------------------------------------------------

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

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
    // Capture-context exports (the probe now rides /hooks/capture since the
    // session-end extraction removal — Rúnir-y5on/Rúnir-sq3s):
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

vi.mock("../capture/extraction/capture.js", () => ({
  extractMemories: vi.fn().mockResolvedValue([]),
  normalizeCaptureMessages: vi.fn().mockImplementation((msgs: any[]) => msgs),
  resolveCapturePrompt: vi.fn().mockReturnValue("test-prompt"),
  segmentAndSummarize: vi.fn().mockResolvedValue({ topics: [] }),
  normalizeExtractedFact: vi.fn().mockImplementation((raw: any) => ({
    l2: raw.l2, l0: raw.l2.slice(0, 100), l1: "- " + raw.l2.slice(0, 100),
    confidence: raw.confidence ?? 0.7, category: "cases", tier: "working", tags: [], factKey: "cases:test-abc123",
  })),
  isNoisyFact: vi.fn().mockReturnValue(false),
  batchDedupFacts: vi.fn().mockImplementation(async (facts: any[]) => facts),
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
  linkEntityToMemory: mockLinkEntityToMemory,
}));

vi.mock("../entities/entity-arbitrator.js", () => ({
  normalizeEntityName: vi.fn((n: string) => n.toLowerCase()),
  arbitrateEntity: mockArbitrateEntity,
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

import { extractMemories } from "../capture/extraction/capture.js";
import { extractEntities } from "../entities/entity-extractor.js";
import { createApp } from "../../index.js";

describe("relate-probe integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArbitrateWrite.mockResolvedValue({ outcome: "create", memoryId: "m1" });
  });

  it("synthetic session creates entities and edges", async () => {
    const fakeFacts = [
      {
        l2: "Migrated from PostgreSQL to SurrealDB for graph traversal",
        l0: "DB Migration: PostgreSQL to SurrealDB for graph",
        l1: "## Migration\nFrom PostgreSQL to SurrealDB.",
        confidence: 0.95,
        category: "cases",
        tier: "durable",
        tags: ["surrealdb", "postgresql"],
        factKey: "cases:db-migration-abc123",
      },
    ];
    const fakeEntities = [
      {
        name: "SurrealDB",
        kind: "concept" as const,
        context: "Migrated to SurrealDB for graph traversal",
        confidence: 0.95,
        description: "A multi-model database",
        aliases: [],
      },
    ];

    (extractMemories as any).mockResolvedValueOnce(fakeFacts);
    (extractEntities as any).mockResolvedValueOnce(fakeEntities);

    // Entity linking rides /hooks/capture (turn-based-only extraction since
    // Rúnir-y5on/Rúnir-sq3s — session-end no longer extracts or links).
    // captureDebug:true makes the entity-linking pass awaited (not
    // fire-and-forget) so the assertions below are deterministic.
    const app = createApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "probe-test-session",
        captureDebug: true,
        messages: [
          { role: "user", content: "We migrated from PostgreSQL to SurrealDB for graph traversal." },
          { role: "assistant", content: "SurrealDB supports RELATE for creating typed edges." },
        ],
      }),
    });

    const data = await res.json();
    if (res.status !== 200) {
      console.error("capture returned", res.status, JSON.stringify(data));
    }
    expect(res.status).toBe(200);
    expect(data.skipped).not.toBe(true);

    // Entity arbitration was called
    expect(mockArbitrateEntity).toHaveBeenCalled();

    // Entity-to-memory link was created
    expect(mockLinkEntityToMemory).toHaveBeenCalled();
  });

  it("entity-to-memory edges exist after capture", async () => {
    const fakeFacts = [
      {
        l2: "SurrealDB supports RELATE for typed edges between records",
        l0: "SurrealDB: RELATE for typed graph edges",
        l1: "## Feature\nRELATE creates typed edges.",
        confidence: 0.92,
        category: "entities",
        tier: "working",
        tags: ["surrealdb", "relate"],
        factKey: "entities:surrealdb-relate-def456",
      },
    ];
    const fakeEntities = [
      {
        name: "SurrealDB",
        kind: "concept" as const,
        context: "SurrealDB supports RELATE",
        confidence: 0.95,
        description: "Multi-model DB",
        aliases: [],
      },
      {
        name: "RELATE",
        kind: "concept" as const,
        context: "RELATE for typed edges",
        confidence: 0.85,
        description: "SurrealDB graph edge creation statement",
        aliases: [],
      },
    ];

    (extractMemories as any).mockResolvedValueOnce(fakeFacts);
    (extractEntities as any).mockResolvedValueOnce(fakeEntities);

    const app = createApp();
    await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "probe-edge-test",
        captureDebug: true,
        messages: [
          { role: "user", content: "SurrealDB supports RELATE for typed edges between records" },
          { role: "assistant", content: "Yes, RELATE is the graph edge creation statement" },
        ],
      }),
    });

    // Both entities should have been arbitrated
    expect(mockArbitrateEntity).toHaveBeenCalledTimes(2);

    // At least one linkEntityToMemory call — entities whose names overlap with fact text get linked
    expect(mockLinkEntityToMemory.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
