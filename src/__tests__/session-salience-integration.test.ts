import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mock all side-effect modules BEFORE importing the app
// ---------------------------------------------------------------------------

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("../shared/config.js", () => ({
  parseConfig: vi.fn().mockReturnValue({
    userId: "test-user",
    autoRecall: true,
    autoCapture: true,
    topK: 5,
    customPrompt: undefined,
    surrealdb: {
      url: "http://localhost:8000",
      username: "root",
      password: "",
      namespace: "main",
      database: "main",
    },
    embedder: {
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      baseURL: "http://localhost:11434",
      dimensions: 768,
      timeoutMs: 4000,
    },
    reranker: { provider: "local" },
    extractMaxChars: 400000,
  }),
  validateRerankerConfig: vi.fn().mockReturnValue({ provider: "local" }),
  resolveEmbeddingProvider: vi.fn().mockReturnValue({
    embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
    embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
    fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
  }),
  resolveCaptureApiKey: vi.fn().mockReturnValue("test-api-key"),
}));

const mockCreateWatermark = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../storage/surreal/surreal-store.js", () => {
  class MockSurrealClient {
    query = vi.fn().mockResolvedValue([[]]);
    close = vi.fn();
  }
  return {
    SurrealClient: MockSurrealClient,
    createWatermark: mockCreateWatermark,
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
    getEmbeddingFingerprint: vi.fn().mockResolvedValue("mock-fingerprint"),
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
  arbitrateWrite: vi.fn().mockResolvedValue({ outcome: "create", memoryId: "m1" }),
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
  STOP_WORDS: new Set(["the", "and", "for", "with"]),
}));

vi.mock("../recall/selection/recall-selection.js", () => ({
  formatRecallInjection: vi.fn().mockReturnValue("injected"),
  formatRecallInjectionFromRendered: vi.fn().mockReturnValue("injected-rendered"),
  toToolSearchResults: vi.fn().mockReturnValue({ results: [] }),
  toAuditSearchResults: vi.fn().mockReturnValue({ results: [] }),
  postProcessRecallResults: vi.fn().mockImplementation((hits: any[]) => hits),
  formatAtDepth: vi.fn().mockImplementation((entry: any, depth: string) => entry.text),
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

// NoiseBank mock with controllable `initialized` flag
const { mockNoiseBankLearn, mockNoiseBankIsNoise, mockNoiseBankInitializedRef } = vi.hoisted(() => ({
  mockNoiseBankLearn: vi.fn(),
  mockNoiseBankIsNoise: vi.fn().mockReturnValue(false),
  mockNoiseBankInitializedRef: { value: false },
}));
vi.mock("../capture/extraction/noise-prototype-bank.js", () => {
  class MockNoisePrototypeBank {
    get initialized() { return mockNoiseBankInitializedRef.value; }
    size = 0;
    init = vi.fn().mockResolvedValue(undefined);
    isNoise = mockNoiseBankIsNoise;
    learn = mockNoiseBankLearn;
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

// ---------------------------------------------------------------------------
// Import mocked modules for assertions
// ---------------------------------------------------------------------------
import { extractMemories, segmentAndSummarize } from "../capture/extraction/capture.js";
import { createApp } from "../../index.js";
import { DEFAULT_CAPTURE_PROMPT } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("session-salience integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNoiseBankInitializedRef.value = false;
    (extractMemories as Mock).mockResolvedValue([]);
    (segmentAndSummarize as Mock).mockResolvedValue({ topics: [] });
  });

  function getApp() {
    return createApp();
  }

  // --- Part A: session-end is extraction-free (Rúnir-y5on/Rúnir-sq3s) ---

  it("session-end calls NEITHER segmentAndSummarize NOR extractMemories (turn-based-only)", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "debugging the type::record issue" },
          { role: "assistant", content: "The root cause is SDK coercion" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(extractMemories).not.toHaveBeenCalled();
    expect(segmentAndSummarize).not.toHaveBeenCalled();
  });

  it("watermark is created on session-end without any extraction", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "just a simple test message" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.extraction).toBe("disabled");
    expect(mockCreateWatermark).toHaveBeenCalled();
  });

  // --- Part B.3: noiseBank feedback loop guard ---

  it("noiseBank.learn NOT called when session has commit hash (hardOverride=true, extraction returns [])", async () => {
    mockNoiseBankInitializedRef.value = true;
    (extractMemories as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Committed as dc54da4 and deployed to production" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockNoiseBankLearn).not.toHaveBeenCalled();
  });

  it("noiseBank.learn NOT called when salience.score >= 0.25 (extraction returns [])", async () => {
    mockNoiseBankInitializedRef.value = true;
    (extractMemories as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "We switched to Qdrant instead of LanceDB for the vector store persistence layer" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockNoiseBankLearn).not.toHaveBeenCalled();
  });

  it("noiseBank.learn IS called for greeting session (score<0.25, extraction returns [])", async () => {
    mockNoiseBankInitializedRef.value = true;
    (extractMemories as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Hi there!" },
          { role: "assistant", content: "Hello! How can I help you today?" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockNoiseBankLearn).toHaveBeenCalled();
  });

  // --- Prompt verification ---

  it("DEFAULT_CAPTURE_PROMPT includes the new type::record few-shot example", () => {
    expect(DEFAULT_CAPTURE_PROMPT).toContain("type::record");
  });
});
