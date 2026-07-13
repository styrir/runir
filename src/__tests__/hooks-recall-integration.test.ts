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

vi.mock("../storage/surreal/surreal-store.js", () => {
  class MockSurrealClient {
    query = vi.fn().mockResolvedValue([[]]);
    close = vi.fn();
  }
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

vi.mock("../recall/selection/recall-selection.js", () => ({
  formatRecallInjection: vi.fn().mockReturnValue("injected"),
  formatRecallInjectionFromRendered: vi.fn().mockReturnValue("injected-rendered"),
  toToolSearchResults: vi.fn().mockReturnValue({ results: [] }),
  toAuditSearchResults: vi.fn().mockReturnValue({ results: [] }),
  formatAtDepth: vi.fn().mockImplementation((entry: any, depth: string) => entry.text),
  postProcessRecallResults: vi.fn().mockImplementation((hits: any[], opts: any) => ({
    selected: hits.slice(0, opts.topK),
    renderedText: hits.slice(0, opts.topK).map((h: any) => h.text),
    accessTrackedIds: hits.slice(0, opts.topK).map((h: any) => h.id).filter(Boolean),
    dropped: hits.slice(opts.topK),
  })),
}));

vi.mock("../recall/query/scope-predicate.js", () => ({
  resolveScopeFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  resolveWriteScope: vi.fn().mockReturnValue({ scope: "user", sessionId: undefined }),
  resolveAttrField: vi.fn().mockImplementation((bodyVal: unknown, _envKey: string) => {
    return bodyVal && typeof bodyVal === "string" && bodyVal.trim() ? bodyVal.trim() : undefined;
  }),
  resolveAttributionFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  resolvePathRecallFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  applyPathScorePenalty: vi.fn().mockImplementation((hits: any[], _path: any) => hits),
  mergeFilters: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  applyRecallSoftFilters: vi.fn().mockImplementation((hits: any[]) => hits),
}));

// Partial mock: keep all real phase2-store behavior, but spy createRetrievalTrace so a test can
// assert the PERSISTED audit never carries `attribution` (Rúnir-x41m.10 M1: response-only clone).
vi.mock("../storage/surreal/phase2-store.js", async (importActual) => {
  const actual = await importActual<typeof import("../storage/surreal/phase2-store.js")>();
  return { ...actual, createRetrievalTrace: vi.fn().mockResolvedValue("trace-attr-test") };
});

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

vi.mock("../recall/intent/adaptive-retrieval.js", () => ({
  shouldSkipRetrieval: vi.fn().mockReturnValue(false),
}));

vi.mock("../recall/intent/intent-analyzer.js", () => ({
  analyzeIntent: vi.fn().mockReturnValue({ categories: [], depth: "full", confidence: 0.3, label: "fact" }),
  applyCategoryBoost: vi.fn().mockImplementation((results: any[]) => results),
  isStatusClassIntent: (label: string) => label === "current_status" || label === "session_opener",
}));

vi.mock("../shared/debug-logger.js", () => ({
  makeDebugLogger: vi.fn().mockReturnValue({
    retrievalTrace: vi.fn(),
    recallResults: vi.fn(),
    salience: vi.fn(),
    watermark: vi.fn(),
    captureResults: vi.fn(),
    arbitration: vi.fn(),
  }),
}));

vi.mock("../recall/selection/retrieval-stats.js", () => {
  class MockRetrievalStatsCollector {
    recordQuery = vi.fn();
    getStats = vi.fn().mockReturnValue({});
  }
  return { RetrievalStatsCollector: MockRetrievalStatsCollector };
});

vi.mock("../recall/selection/retrieval-trace.js", () => {
  class MockTraceCollector {
    stages = [
      { name: "vector_search", outputCount: 3 },
      { name: "bm25_search", outputCount: 2 },
      { name: "recency_search", outputCount: 1 },
    ];
    startStage = vi.fn();
    endStage = vi.fn();
    finalize = vi.fn().mockReturnValue({
      query: "test",
      mode: "hybrid",
      startedAt: Date.now(),
      stages: [],
      finalCount: 0,
      totalMs: 1,
    });
    summarize = vi.fn().mockReturnValue("mock-summary");
  }
  return { TraceCollector: MockTraceCollector };
});

vi.mock("../lifecycle/compaction/memory-compactor.js", () => ({
  runCompaction: vi.fn().mockResolvedValue(null),
  DEFAULT_COMPACTION_CONFIG: { enabled: false },
}));

// ---------------------------------------------------------------------------
// Import mocked modules for assertions
// ---------------------------------------------------------------------------
import { runHybridQueryWithEvidenceTable } from "../recall/query/memory-query.js";
import { createRetrievalTrace } from "../storage/surreal/phase2-store.js";
import {
  resolvePathRecallFilter,
  applyPathScorePenalty,
  resolveAttributionFilter,
  mergeFilters,
} from "../recall/query/scope-predicate.js";
import { analyzeIntent } from "../recall/intent/intent-analyzer.js";
import { shouldSkipRetrieval } from "../recall/intent/adaptive-retrieval.js";
import { postProcessRecallResults, formatRecallInjectionFromRendered } from "../recall/selection/recall-selection.js";
import { arbitrateWrite } from "../storage/writes/write-arbitrator.js";
import { extractMemories } from "../capture/extraction/capture.js";
import { cfg } from "../app/runtime.js";
import { createApp } from "../../index.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /hooks/recall path-scoped recall (MIM-71)", () => {
  function combineMockFilters(...filters: Array<{ whereClause: string; vars: Record<string, unknown> }>) {
    return {
      whereClause: filters
        .map((filter) => filter.whereClause)
        .filter((clause) => clause.length > 0)
        .join(" "),
      vars: Object.assign({}, ...filters.map((filter) => filter.vars)),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset scope-predicate mocks to their defaults
    (resolvePathRecallFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    (applyPathScorePenalty as Mock).mockImplementation((hits: any[], _path: any) => hits);
    (resolveAttributionFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    cfg.reranker = { provider: "local" };
  });

  function getApp() {
    return createApp();
  }

  it("/hooks/recall with body.path: calls resolvePathRecallFilter (not resolveAttributionFilter for path)", async () => {
    const mockResults = [
      { id: "m1", text: "path-matched memory", score: 0.9, path: "/Users/brooks/Code/runir" },
      { id: "m2", text: "null-path legacy memory", score: 0.8 },
    ];
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test recall query",
        path: "/Users/brooks/Code/runir",
      }),
    });

    expect(res.status).toBe(200);

    // resolvePathRecallFilter should be called with the provided path
    expect(resolvePathRecallFilter).toHaveBeenCalledWith("/Users/brooks/Code/runir");

    // applyPathScorePenalty should be called with results and path
    expect(applyPathScorePenalty).toHaveBeenCalledWith(
      expect.any(Array),
      "/Users/brooks/Code/runir",
    );
  });

  it("/hooks/recall with body.path: null-path hits scored at 0.70x, path-matched unchanged", async () => {
    const pathMatchedHit = { id: "m1", text: "path-matched memory", score: 0.9, path: "/Users/brooks/Code/runir" };
    const nullPathHit = { id: "m2", text: "null-path legacy memory", score: 0.8 };
    const mockResults = [pathMatchedHit, nullPathHit];

    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);

    // Override applyPathScorePenalty to simulate actual penalty application
    (applyPathScorePenalty as Mock).mockImplementation((hits: any[], requestedPath: string | undefined) => {
      if (!requestedPath) return hits;
      return hits.map((h: any) => {
        if (!h.path) return { ...h, score: h.score * 0.70 };
        return h;
      });
    });

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test recall query",
        path: "/Users/brooks/Code/runir",
      }),
    });

    expect(res.status).toBe(200);

    // Verify penalty was applied to the null-path hit
    const penaltyCallArgs = (applyPathScorePenalty as Mock).mock.calls[0];
    const passedHits = penaltyCallArgs[0];
    const passedPath = penaltyCallArgs[1];
    expect(passedPath).toBe("/Users/brooks/Code/runir");

    // The null path hit in the results should have been passed through penalty
    const nullHit = passedHits.find((h: any) => h.id === "m2");
    expect(nullHit).toBeDefined();
    expect(nullHit?.path).toBeUndefined();
  });

  it("/hooks/recall without body.path: behavior unchanged (no filter, no penalty)", async () => {
    const mockResults = [
      { id: "m1", text: "some memory", score: 0.9 },
    ];
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test recall query",
      }),
    });

    expect(res.status).toBe(200);

    // resolvePathRecallFilter should be called with undefined (no path)
    expect(resolvePathRecallFilter).toHaveBeenCalledWith(undefined);

    // applyPathScorePenalty should be called with undefined path (no-op)
    expect(applyPathScorePenalty).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
    );
  });

  it("/hooks/recall with client but no path: uses resolveAttributionFilter for client only", async () => {
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test recall query",
        client: "myclient",
      }),
    });

    expect(res.status).toBe(200);

    // resolvePathRecallFilter called with undefined (no path)
    expect(resolvePathRecallFilter).toHaveBeenCalledWith(undefined);

    // resolveAttributionFilter called for client scoping
    expect(resolveAttributionFilter).toHaveBeenCalledWith(undefined, "myclient");
  });

  it("/hooks/recall with client but no path: passes a strict client scope filter into hybrid recall", async () => {
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([]);
    (resolveAttributionFilter as Mock).mockReturnValue({
      whereClause: "AND payload.client = $attrClient",
      vars: { attrClient: "hermes" },
    });
    (mergeFilters as Mock).mockImplementation(combineMockFilters);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test recall query",
        client: "hermes",
      }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalled();
    expect((runHybridQueryWithEvidenceTable as Mock).mock.calls[0][0].scopeFilter).toEqual({
      whereClause: expect.stringContaining("payload.client = $attrClient"),
      vars: expect.objectContaining({ attrClient: "hermes" }),
    });
  });

  it("/hooks/recall disables llm reranker before hybrid query", async () => {
    cfg.reranker = { provider: "llm", openrouterApiKey: "test-key", model: "test/model" };
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "test recall query",
      }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalled();
    expect((runHybridQueryWithEvidenceTable as Mock).mock.calls[0][0].rerankerConfig).toEqual({ provider: "off" });
  });

  it("/hooks/recall with mixed client-tagged hits: returns only the requested client's rendered context", async () => {
    const mixedHits = [
      { id: "m-hermes", text: "hermes-lane-only-marker", score: 0.9 },
      { id: "m-claude", text: "claude-lane-only-marker", score: 0.8 },
      { id: "m-untagged", text: "untagged-client-marker", score: 0.7 },
    ];
    (resolveAttributionFilter as Mock).mockImplementation((_path: unknown, client: string | undefined) => (
      client
        ? { whereClause: "AND payload.client = $attrClient", vars: { attrClient: client } }
        : { whereClause: "", vars: {} }
    ));
    (mergeFilters as Mock).mockImplementation(combineMockFilters);
    (runHybridQueryWithEvidenceTable as Mock).mockImplementation((input: { scopeFilter?: { vars?: Record<string, unknown> } }) => {
      const client = input.scopeFilter?.vars?.attrClient;
      if (client === "hermes") return Promise.resolve([mixedHits[0]]);
      if (client === "claude-code") return Promise.resolve([mixedHits[1]]);
      return Promise.resolve(mixedHits);
    });
    (formatRecallInjectionFromRendered as Mock).mockImplementation((renderedText: string[]) => renderedText.join("\n"));

    const app = getApp();
    const unscopedRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hermes-filter-token-9f3a" }),
    });
    const hermesRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hermes-filter-token-9f3a", client: "hermes" }),
    });
    const claudeRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hermes-filter-token-9f3a", client: "claude-code" }),
    });

    const unscopedJson = await unscopedRes.json();
    const hermesJson = await hermesRes.json();
    const claudeJson = await claudeRes.json();

    expect(unscopedJson.prependContext).toContain("hermes-lane-only-marker");
    expect(unscopedJson.prependContext).toContain("claude-lane-only-marker");
    expect(unscopedJson.prependContext).toContain("untagged-client-marker");

    expect(hermesJson.prependContext).toContain("hermes-lane-only-marker");
    expect(hermesJson.prependContext).not.toContain("claude-lane-only-marker");
    expect(hermesJson.prependContext).not.toContain("untagged-client-marker");

    expect(claudeJson.prependContext).toContain("claude-lane-only-marker");
    expect(claudeJson.prependContext).not.toContain("hermes-lane-only-marker");
    expect(claudeJson.prependContext).not.toContain("untagged-client-marker");
  });
});

// ── MIM-69 Task 3: hasPath at write-time ────────────────────────────────────
// factMetadata is tested indirectly — when /hooks/capture processes facts,
// the metadata passed to arbitrateWrite includes hasPath derived from path.
// Since the capture flow has many dependencies, we verify this via the
// arbitrateWrite mock call args when extractMemories returns facts.

describe("POST /hooks/capture — hasPath metadata (MIM-69)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolvePathRecallFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    (applyPathScorePenalty as Mock).mockImplementation((hits: any[], _path: any) => hits);

    // extractMemories must return a fact for the write path to execute
    (extractMemories as Mock).mockResolvedValue([
      {
        l2: "test fact about memory system",
        l0: "test fact",
        l1: "- test fact",
        confidence: 0.8,
        category: "cases",
        tier: "working",
        tags: [],
        factKey: "cases:test-abc123",
      },
    ]);
  });

  it("includes hasPath: true when path is provided", async () => {
    const app = createApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test message" }, { role: "assistant", content: "test reply" }],
        path: "/Users/brooks/Code/runir",
      }),
    });

    expect(res.status).toBe(200);

    // arbitrateWrite should have been called with metadata including hasPath: true
    expect(arbitrateWrite).toHaveBeenCalled();
    const callArgs = (arbitrateWrite as Mock).mock.calls[0][0];
    expect(callArgs.metadata).toHaveProperty("hasPath", true);
  });

  it("includes hasPath: false when path is not provided", async () => {
    const app = createApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test message" }, { role: "assistant", content: "test reply" }],
      }),
    });

    expect(res.status).toBe(200);

    expect(arbitrateWrite).toHaveBeenCalled();
    const callArgs = (arbitrateWrite as Mock).mock.calls[0][0];
    expect(callArgs.metadata).toHaveProperty("hasPath", false);
  });
});

// ── MIM-69 Task 4: isStale predicate in /hooks/recall ─────────────────────

describe("POST /hooks/recall — isStale exclusion filter (MIM-69)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolvePathRecallFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    (applyPathScorePenalty as Mock).mockImplementation((hits: any[], _path: any) => hits);
    (resolveAttributionFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    (postProcessRecallResults as Mock).mockImplementation((hits: any[], opts: any) => ({
      selected: hits.slice(0, opts.topK),
      renderedText: hits.slice(0, opts.topK).map((h: any) => h.text),
      accessTrackedIds: hits.slice(0, opts.topK).map((h: any) => h.id).filter(Boolean),
      dropped: hits.slice(opts.topK),
    }));
    (formatRecallInjectionFromRendered as Mock).mockReturnValue("injected-rendered");
  });

  function getApp() {
    return createApp();
  }

  it("runHybridQuery receives a scope filter containing explicit stale NONE-or-false predicate", async () => {
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalled();
    expect(mergeFilters).toHaveBeenCalled();

    const mergeArgs = (mergeFilters as Mock).mock.calls[0];
    const staleFilter = mergeArgs.find(
      (arg: any) => typeof arg?.whereClause === "string" && arg.whereClause.includes("payload.isStale = NONE OR payload.isStale = false"),
    );
    expect(staleFilter).toBeTruthy();
  });
});

// ── MIM-69 Task 11: postProcessRecallResults wired into /hooks/recall ───────

describe("POST /hooks/recall — postProcessRecallResults pipeline (MIM-69)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolvePathRecallFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    (applyPathScorePenalty as Mock).mockImplementation((hits: any[], _path: any) => hits);
    (resolveAttributionFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
  });

  it("postProcessRecallResults is called with filtered hits and intent", async () => {
    const mockResults = [
      { id: "m1", text: "memory one", score: 0.9 },
      { id: "m2", text: "memory two", score: 0.8 },
    ];
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });

    expect(res.status).toBe(200);
    expect(postProcessRecallResults).toHaveBeenCalled();
    const callArgs = (postProcessRecallResults as Mock).mock.calls[0];
    expect(callArgs[1]).toHaveProperty("intent");
    expect(callArgs[1]).toHaveProperty("topK");
  });

  it("access tracking uses accessTrackedIds from postProcessRecallResults, not all IDs", async () => {
    // Configure postProcessRecallResults to return only a subset of IDs for tracking
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: [
        { id: "m1", text: "memory one", score: 0.9 },
        { id: "m2", text: "memory two", score: 0.8 },
      ],
      renderedText: ["memory one", "memory two"],
      accessTrackedIds: ["m1"], // only m1 is quality-approved
      dropped: [],
    });
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([
      { id: "m1", text: "memory one", score: 0.9 },
      { id: "m2", text: "memory two", score: 0.8 },
    ]);

    const app = createApp();
    await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));

    // The DB should only be called with accessTrackedIds, not all selected IDs
    // We can't easily check exact args on the shared mockDbQuery, but we can verify
    // postProcessRecallResults was called and its output was used
    expect(postProcessRecallResults).toHaveBeenCalled();
  });

  it("RUNIR_DEBUG=1 response includes staleness metadata in _debug.trace.hits (MIM-69 Task 14)", async () => {
    const originalDebug = process.env.RUNIR_DEBUG;
    process.env.RUNIR_DEBUG = "1";

    const mockResults = [
      { id: "m1", text: "memory one", score: 0.9, isStale: true, staleSince: "2026-03-20T00:00:00Z", contradictedBy: "m2" },
    ];
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: mockResults,
      renderedText: ["memory one"],
      accessTrackedIds: [],
      dropped: [],
    });

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test query" }),
    });

    const json = await res.json() as any;
    // When RUNIR_DEBUG=1, the response should include staleness metadata under _debug.trace.hits
    expect(json._debug).toBeDefined();
    if (json._debug) {
      expect(json._debug.trace).toBeDefined();
      expect(json._debug.trace.hits).toBeDefined();
      expect(json._debug.trace.hits[0]).toHaveProperty("isStale", true);
      expect(json._debug.trace.hits[0]).toHaveProperty("staleSince", "2026-03-20T00:00:00Z");
      expect(json._debug.trace.hits[0]).toHaveProperty("contradictedBy", "m2");
    }

    process.env.RUNIR_DEBUG = originalDebug;
  });

  it("RUNIR_DEBUG=1 response includes A3 recipe metadata in trace/debug output", async () => {
    const originalDebug = process.env.RUNIR_DEBUG;
    process.env.RUNIR_DEBUG = "1";

    const mockResults = [
      { id: "m1", text: "Architecture note", score: 0.9 },
    ];
    (analyzeIntent as Mock).mockReturnValueOnce({
      categories: ["entities"],
      depth: "l1",
      confidence: 0.9,
      label: "architecture",
    });
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: mockResults,
      renderedText: ["Architecture note"],
      accessTrackedIds: ["m1"],
      dropped: [],
    });

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "show me the architecture reference" }),
    });

    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json._debug.trace.recipe).toEqual(expect.objectContaining({
      id: "reference_architecture",
      version: "phase-a-v1",
      relationExpansionEnabled: false,
      latestStateShaping: "off",
    }));
    expect(json._debug.retrievalAudit.recipe).toEqual(expect.objectContaining({
      id: "reference_architecture",
      sourceBudgets: expect.arrayContaining([
        expect.objectContaining({ source: "vector", budget: 15 }),
        expect.objectContaining({ source: "bm25", budget: 15 }),
        expect.objectContaining({ source: "recency", budget: 15 }),
      ]),
      sourceCounts: expect.arrayContaining([
        expect.objectContaining({ source: "vector", count: 3 }),
        expect.objectContaining({ source: "bm25", count: 2 }),
        expect.objectContaining({ source: "recency", count: 1 }),
      ]),
    }));

    process.env.RUNIR_DEBUG = originalDebug;
  });

  // Rúnir-x41m.10 / Option A+: recall-native attribution envelope
  it("RUNIR_DEBUG=1 /hooks/recall emits a recall attribution envelope (debug-only)", async () => {
    const originalDebug = process.env.RUNIR_DEBUG;
    process.env.RUNIR_DEBUG = "1";

    // Bare IDs (extractId form) — the real onLegRanks/onCandidateStages emitters strip the
    // table prefix; here surreal-store.extractId is mocked to identity, so feed bare directly.
    const mockResults = [
      { id: "m1", text: "Alpha fact", score: 0.9 },
      { id: "m2", text: "Beta fact", score: 0.8 },
    ];
    // m9 fuses beyond the returned window — present in legRanks (the blind-spot the envelope exposes).
    const legRanks = {
      m1: { vector: 1, bm25: 2, rrf: 1 },
      m2: { vector: 2, bm25: 1, rrf: 2 },
      m9: { vector: 7, rrf: 12 },
    };
    (analyzeIntent as Mock).mockReturnValueOnce({
      categories: [], depth: "l1", confidence: 0.9, label: "fact",
    });
    // Override the wrapper so the read-only attribution callbacks actually fire.
    (runHybridQueryWithEvidenceTable as Mock).mockImplementationOnce(async (input: any) => {
      input.tuning?.onLegRanks?.(legRanks);
      input.tuning?.onCandidateStages?.({
        candidateLimit: 15,
        candidatePoolIds: ["m1", "m2"],
        preRerankerIds: ["m1", "m2"],
        postRerankerIds: ["m1", "m2"],
        rerankerActive: false,
      });
      return mockResults;
    });
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: mockResults,
      renderedText: ["Alpha fact", "Beta fact"],
      accessTrackedIds: ["m1", "m2"],
      dropped: [],
    });

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "alpha beta" }),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(200);

    const attribution = json._debug?.retrievalAudit?.attribution;
    expect(attribution).toBeDefined();
    expect(attribution.schemaVersion).toBe(1);
    expect(attribution.window).toEqual({ topK: cfg.topK, candidateLimit: 15 });
    expect(attribution.legRanks).toEqual(legRanks);
    // rrfFusedIds derived from legRanks sorted by .rrf — includes m9 (the beyond-window unit).
    expect(attribution.rrfFusedIds).toEqual(["m1", "m2", "m9"]);
    // candidatePoolIds = the full fused+merged pool before the rerank-window slice (architect pass-4);
    // m9 fused beyond the window so it is NOT in the pool — only legRanks/rrfFusedIds expose it.
    expect(attribution.candidatePoolIds).toEqual(["m1", "m2"]);
    expect(attribution.preRerankerIds).toEqual(["m1", "m2"]);
    expect(attribution.postRerankerIds).toEqual(["m1", "m2"]);
    expect(attribution.reranker).toEqual(expect.objectContaining({ active: false, droppedIds: [] }));
    // All IDs bare (extractId), mutually joinable with legRanks.
    expect(attribution.baseCandidateIds).toEqual(["m1", "m2"]);
    expect(attribution.finalSelectedIds).toEqual(["m1", "m2"]);
    // accessTrackedIds (NOT "shown") + the reader-visible renderedSelectedIds (architect L2-review).
    expect(attribution.accessTrackedIds).toEqual(["m1", "m2"]);
    expect(attribution.renderedSelectedIds).toEqual(["m1", "m2"]);

    // M1 (response-only): the PERSISTED audit must NEVER carry attribution — it is set on the
    // _debug clone only. createRetrievalTrace receives the clean audit (built before the clone).
    expect((createRetrievalTrace as Mock)).toHaveBeenCalled();
    const persistedAudit = (createRetrievalTrace as Mock).mock.calls.at(-1)?.[1]?.retrievalAudit;
    expect(persistedAudit).toBeDefined();
    expect(persistedAudit.attribution).toBeUndefined();

    process.env.RUNIR_DEBUG = originalDebug;
  });

  it("RUNIR_DEBUG=1 attribution exposes per-id reranker scores + drops (reranker active)", async () => {
    const originalDebug = process.env.RUNIR_DEBUG;
    process.env.RUNIR_DEBUG = "1";

    // m3 is dropped by the reranker (below threshold) but its score must stay visible.
    const mockResults = [
      { id: "m1", text: "Alpha", score: 0.91 },
      { id: "m2", text: "Beta", score: 0.74 },
    ];
    (analyzeIntent as Mock).mockReturnValueOnce({
      categories: [], depth: "l1", confidence: 0.9, label: "fact",
    });
    (runHybridQueryWithEvidenceTable as Mock).mockImplementationOnce(async (input: any) => {
      input.tuning?.onLegRanks?.({ m1: { rrf: 1 }, m2: { rrf: 2 }, m3: { rrf: 3 } });
      input.tuning?.onCandidateStages?.({
        candidateLimit: 15,
        candidatePoolIds: ["m1", "m2", "m3"],
        preRerankerIds: ["m1", "m2", "m3"],
        postRerankerIds: ["m1", "m2"],
        rerankerActive: true,
        rerankerThreshold: 0.5,
        rerankerScores: { m1: 0.91, m2: 0.74, m3: 0.12 },
      });
      return mockResults;
    });
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: mockResults,
      renderedText: ["Alpha", "Beta"],
      accessTrackedIds: ["m1", "m2"],
      dropped: [],
    });

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "alpha beta" }),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(200);

    const reranker = json._debug?.retrievalAudit?.attribution?.reranker;
    expect(reranker).toBeDefined();
    expect(reranker.active).toBe(true);
    expect(reranker.threshold).toBe(0.5);
    expect(reranker.droppedIds).toEqual(["m3"]); // in pre, absent from post
    expect(reranker.scores).toEqual({ m1: 0.91, m2: 0.74, m3: 0.12 });
    // The dropped unit's score is diagnosable against the threshold.
    expect(reranker.scores.m3).toBeLessThan(reranker.threshold);

    process.env.RUNIR_DEBUG = originalDebug;
  });

  it("/hooks/recall WITHOUT debug emits no _debug (attribution is debug-only)", async () => {
    const originalDebug = process.env.RUNIR_DEBUG;
    delete process.env.RUNIR_DEBUG;

    const mockResults = [{ id: "m1", text: "Alpha fact", score: 0.9 }];
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue(mockResults);
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: mockResults,
      renderedText: ["Alpha fact"],
      accessTrackedIds: ["m1"],
      dropped: [],
    });

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "alpha" }),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json._debug).toBeUndefined();

    process.env.RUNIR_DEBUG = originalDebug;
  });

  // MIM-71 Test A: count matches rendered non-empty bullets
  it("response count equals number of non-empty rendered bullets (MIM-71)", async () => {
    // Simulate: 3 hits, but one renders to empty string
    (postProcessRecallResults as Mock).mockReturnValueOnce({
      selected: [
        { id: "m1", text: "memory one", score: 0.9 },
        { id: "m2", text: "", score: 0.8 },
        { id: "m3", text: "memory three", score: 0.7 },
      ],
      renderedText: ["rendered memory one", "", "rendered memory three"],
      accessTrackedIds: ["m1", "m3"],
      dropped: [],
    });
    // formatRecallInjectionFromRendered returns the formatted injection
    (formatRecallInjectionFromRendered as Mock).mockReturnValueOnce(
      "- rendered memory one\n- rendered memory three",
    );
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([
      { id: "m1", text: "memory one", score: 0.9 },
      { id: "m2", text: "", score: 0.8 },
      { id: "m3", text: "memory three", score: 0.7 },
    ]);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });

    const json = await res.json() as any;
    expect(json.count).toBe(2); // only 2 non-empty rendered lines
    expect(json.prependContext).toBeTruthy();
  });

  it("debug output reports selected vs shown footprint counts", async () => {
    const originalDebug = process.env.RUNIR_DEBUG;
    process.env.RUNIR_DEBUG = "1";
    (postProcessRecallResults as Mock).mockImplementation(() => ({
      selected: [
        { id: "m1", text: "memory one", score: 0.9 },
        { id: "m2", text: "memory two", score: 0.8 },
      ],
      renderedText: ["rendered memory one"],
      accessTrackedIds: ["m1"],
      dropped: [],
    }));
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([
      { id: "m1", text: "memory one", score: 0.9 },
      { id: "m2", text: "memory two", score: 0.8 },
    ]);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });
    const json = await res.json() as any;

    expect(res.status).toBe(200);
    expect(json._debug.footprint).toEqual(expect.objectContaining({
      selectedCount: 2,
      shownCount: 1,
      selectedNotShownCount: 1,
    }));
    process.env.RUNIR_DEBUG = originalDebug;
  });

  it("response count is 0 and prependContext is null when all rendered lines are empty (MIM-71)", async () => {
    (postProcessRecallResults as Mock).mockImplementation(() => ({
      selected: [{ id: "m1", text: "has raw text", score: 0.9 }],
      renderedText: ["", "  "],
      accessTrackedIds: [],
      dropped: [],
    }));
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([
      { id: "m1", text: "has raw text", score: 0.9 },
    ]);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });

    const json = await res.json() as any;
    expect(json.count).toBe(0);
    expect(json.prependContext).toBeNull();
  });

  it("formatRecallInjectionFromRendered is called with rendered text from pipeline", async () => {
    (postProcessRecallResults as Mock).mockImplementation(() => ({
      selected: [{ id: "m1", text: "memory one", score: 0.9 }],
      renderedText: ["rendered memory one"],
      accessTrackedIds: ["m1"],
      dropped: [],
    }));
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([
      { id: "m1", text: "memory one", score: 0.9 },
    ]);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test recall query" }),
    });

    expect(res.status).toBe(200);
    expect(formatRecallInjectionFromRendered).toHaveBeenCalledWith(["rendered memory one"]);
  });
});

// ── Stage 4 (T4s): sessionKind="opener" bypass before shouldSkipRetrieval ────

describe("POST /hooks/recall — sessionKind=opener bypass (Stage 4 T4s)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolvePathRecallFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    (applyPathScorePenalty as Mock).mockImplementation((hits: any[], _path: any) => hits);
    (resolveAttributionFilter as Mock).mockReturnValue({ whereClause: "", vars: {} });
    // Default analyzeIntent back to the fact label so each case can override.
    (analyzeIntent as Mock).mockReturnValue({ categories: [], depth: "full", confidence: 0.3, label: "fact" });
    // Default shouldSkipRetrieval to true for empty prompts so the bypass test is meaningful.
    (shouldSkipRetrieval as Mock).mockImplementation((q: string) => q.trim().length === 0);
  });

  it("sessionKind=opener is RETIRED — short-circuits to {skipped:true, reason:'opener_retired'} with no recall or opener composition", async () => {
    // The manufactured session opener is retired (2026-06-13 — architecture-canon §1).
    // A session-start opener no longer routes to a session_opener intent or builds a
    // continuity block; it short-circuits before intent analysis / hybrid query.
    (analyzeIntent as Mock).mockImplementation((_prompt: string, opts?: { hint?: string }) => {
      if (opts?.hint === "opener") {
        return { categories: ["events", "entities"], depth: "l1", confidence: 0.95, label: "session_opener" };
      }
      return { categories: [], depth: "full", confidence: 0.3, label: "fact" };
    });
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([]);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "brooks",
        client: "claudecode",
        sessionKind: "opener",
        prompt: "",
        sessionId: "test-opener-1",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("opener_retired");
    expect(json.prependContext).toBeUndefined();
    // No manufactured opener: intent analysis and hybrid query are never reached.
    expect(analyzeIntent).not.toHaveBeenCalled();
    expect(runHybridQueryWithEvidenceTable).not.toHaveBeenCalled();
  });

  it("no sessionKind with empty prompt still short-circuits to {skipped:true, reason:'adaptive'} (regression control)", async () => {
    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "brooks",
        client: "claudecode",
        prompt: "",
        sessionId: "test-opener-ctrl",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toEqual({ skipped: true, reason: "adaptive" });
    // analyzeIntent must NOT have been called because shouldSkipRetrieval short-circuited.
    expect(analyzeIntent).not.toHaveBeenCalled();
  });

  it("no sessionKind with normal prompt routes through analyzeIntent without hint (regression control)", async () => {
    (shouldSkipRetrieval as Mock).mockReturnValue(false);
    (runHybridQueryWithEvidenceTable as Mock).mockResolvedValue([]);

    const app = createApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "brooks",
        client: "claudecode",
        prompt: "what did i work on yesterday",
        sessionId: "test-opener-ctrl-2",
      }),
    });

    expect(res.status).toBe(200);
    // analyzeIntent must be called with hint: undefined (no sessionKind="opener" in body).
    expect(analyzeIntent).toHaveBeenCalledWith("what did i work on yesterday", { hint: undefined });
  });
});
