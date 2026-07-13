import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbQuery } = vi.hoisted(() => ({
  mockDbQuery: vi.fn().mockResolvedValue([[]]),
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
  class MockSurrealClient { query = mockDbQuery; close = vi.fn(); }
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
    listContinuityMemoryHits: vi.fn().mockResolvedValue([]),
    hydrateLatestStateRepresentativeHits: vi.fn().mockResolvedValue([]),
    projectStateRecordId: vi.fn().mockReturnValue("project_state_test123"),
    invalidateContinuityStateRecords: vi.fn().mockResolvedValue(0),
    ACTIVE_MEMORY_FILTER: "AND (active = NONE OR active = true)",
  };
});

vi.mock("../recall/query/memory-query.js", () => {
  return {
    runHybridQueryWithEvidenceTable: vi.fn().mockResolvedValue([]),
    vectorSearch: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../storage/writes/write-arbitrator.js", () => ({
  arbitrateWrite: vi.fn().mockResolvedValue({ outcome: "create", memoryId: "m1" }),
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
  extractTopicTags: vi.fn().mockReturnValue([]),
}));

vi.mock("../recall/selection/recall-selection.js", () => ({
  formatRecallInjection: vi.fn().mockReturnValue("injected"),
  formatRecallInjectionFromRendered: vi.fn().mockReturnValue("injected-rendered"),
  toToolSearchResults: vi.fn().mockReturnValue({ results: [] }),
  toAuditSearchResults: vi.fn().mockReturnValue({ results: [] }),
  postProcessRecallResults: vi.fn().mockImplementation((hits: any[], opts: any) => ({
    selected: hits.slice(0, opts.topK),
    renderedText: hits.slice(0, opts.topK).map((h: any) => h.text),
    accessTrackedIds: hits.slice(0, opts.topK).map((h: any) => h.id).filter(Boolean),
    dropped: hits.slice(opts.topK),
  })),
}));

vi.mock("../recall/query/scope-predicate.js", () => ({
  resolveScopeFilter: vi.fn().mockReturnValue(undefined),
  resolveWriteScope: vi.fn().mockReturnValue({ scope: "user", sessionId: undefined }),
  resolveAttrField: vi.fn().mockReturnValue(undefined),
  resolveAttributionFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  resolvePathRecallFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  applyPathScorePenalty: vi.fn().mockImplementation((hits: any[]) => hits),
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
  findEntitiesByNames: vi.fn().mockResolvedValue([]),
  findEntitiesByAliases: vi.fn().mockResolvedValue([]),
  getEntityNeighbors: vi.fn().mockResolvedValue([]),
  getSupportingMemoryIds: vi.fn().mockResolvedValue([]),
  linkEntityToMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../entities/entity-arbitrator.js", () => ({
  normalizeEntityName: vi.fn((n: string) => n.toLowerCase()),
  arbitrateEntity: vi.fn().mockResolvedValue({ entityId: "e1", outcome: "create" }),
}));

vi.mock("../entities/entity-extractor.js", () => ({ extractEntities: vi.fn().mockResolvedValue([]) }));

vi.mock("../shared/debug-logger.js", () => ({
  makeDebugLogger: vi.fn().mockReturnValue({
    segmentation: vi.fn(), factExtraction: vi.fn(), arbitrationOutcome: vi.fn(),
    entityExtraction: vi.fn(), entityOutcome: vi.fn(), recallResults: vi.fn(),
    watermark: vi.fn(), normalize: vi.fn(), retrievalTrace: vi.fn(), salience: vi.fn(),
  }),
}));

import { runHybridQueryWithEvidenceTable } from "../recall/query/memory-query.js";
import { createApp } from "../../index.js";

function getApp() { return createApp(); }

describe("recall-access-tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue([[]]);
  });

  it("after recall, accessCount UPDATE query is fired", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([
      { id: "memories:abc", text: "test memory", score: 0.9 },
    ]);

    const app = getApp();
    await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "search query test" }),
    });

    // Allow fire-and-forget promise to resolve
    await new Promise((r) => setTimeout(r, 10));

    // Check that the UPDATE query was issued
    const updateCalls = mockDbQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("accessCount"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const query = updateCalls[0][0] as string;
    expect(query).toContain("accessCount");
    expect(query).toContain("lastAccessedAt");
  });

  it("after recall with no results, no access tracking update is fired", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([]);

    const app = getApp();
    await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "search query test" }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const updateCalls = mockDbQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("accessCount"),
    );
    expect(updateCalls.length).toBe(0);
  });
});
