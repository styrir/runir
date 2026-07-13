import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Set RUNIR_DEBUG=1 BEFORE module loads so the singleton debugLogger is enabled
// ---------------------------------------------------------------------------
vi.hoisted(() => {
  process.env.RUNIR_DEBUG = "1";
});

// ---------------------------------------------------------------------------
// Mock all side-effect modules (same pattern as session-end-offset.test.ts)
// ---------------------------------------------------------------------------
vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("../src/shared/config.js", () => ({
  parseConfig: vi.fn().mockReturnValue({
    userId: "default-user",
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
  }),
  validateRerankerConfig: vi.fn().mockReturnValue({ provider: "local" }),
  resolveEmbeddingProvider: vi.fn().mockReturnValue({
    embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
    embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
    fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
  }),
  resolveCaptureApiKey: vi.fn().mockReturnValue("test-api-key"),
}));

vi.mock("../src/storage/surreal/surreal-store.js", () => {
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
    upsertProjectState: vi.fn().mockResolvedValue({ id: "ps-1", userId: "test", activeTicketIds: [], blockers: [], nextSteps: [], supportingMemoryIds: [], confidence: 0.8, updatedAt: new Date().toISOString() }),
    getProjectState: vi.fn().mockResolvedValue(null),
    listContinuityMemoryHits: vi.fn().mockResolvedValue([]),
    projectStateRecordId: vi.fn().mockReturnValue("project_state_test123"),
    invalidateContinuityStateRecords: vi.fn().mockResolvedValue(0),
    ACTIVE_MEMORY_FILTER: "AND (active = NONE OR active = true)",
  };
});

vi.mock("../src/recall/query/memory-query.js", () => {
  return {
    runHybridQueryWithEvidenceTable: vi.fn().mockResolvedValue([]),
    vectorSearch: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../src/capture/continuity/salience-schema.js", () => ({
  ensureSalienceSchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/capture/continuity/salience-prototypes.js", () => ({
  upsertSeedPrototypes: vi.fn().mockResolvedValue(undefined),
  deriveCentroids: vi.fn().mockResolvedValue(undefined),
  fetchSalienceCentroids: vi.fn().mockResolvedValue(new Map()),
  SEED_PROTOTYPES: [],
}));

vi.mock("../src/capture/continuity/session-salience.js", () => ({
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

vi.mock("../src/storage/writes/write-arbitrator.js", () => ({
  arbitrateWrite: vi.fn().mockResolvedValue({ outcome: "create", memoryId: "m1" }),
}));

vi.mock("../src/capture/continuity/salience-schema.js", () => ({
  ensureSalienceSchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/capture/continuity/salience-prototypes.js", () => ({
  upsertSeedPrototypes: vi.fn().mockResolvedValue(undefined),
  deriveCentroids: vi.fn().mockResolvedValue(undefined),
  fetchSalienceCentroids: vi.fn().mockResolvedValue(new Map()),
  SEED_PROTOTYPES: [],
}));

vi.mock("../src/capture/continuity/session-salience.js", () => ({
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

vi.mock("../src/capture/extraction/capture.js", () => ({
  extractMemories: vi.fn().mockResolvedValue([]),
  normalizeCaptureMessages: vi.fn().mockImplementation((msgs: any[]) => msgs),
  resolveCapturePrompt: vi.fn().mockReturnValue("test-prompt"),
  segmentAndSummarize: vi.fn().mockResolvedValue({ topics: [] }),
  normalizeExtractedFact: vi.fn().mockImplementation((raw: any) => ({
    l2: raw.l2 ?? raw.text, l0: (raw.l2 ?? raw.text).slice(0, 100), l1: "- " + (raw.l2 ?? raw.text).slice(0, 100),
    confidence: raw.confidence ?? 0.7, category: "cases", tier: "working", tags: [], factKey: "cases:test-abc123",
  })),
  isNoisyFact: vi.fn().mockReturnValue(false),
  extractTopicTags: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/recall/selection/recall-selection.js", () => ({
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

vi.mock("../src/recall/query/scope-predicate.js", () => ({
  resolveScopeFilter: vi.fn().mockReturnValue(undefined),
  resolveWriteScope: vi.fn().mockReturnValue({ scope: "user", sessionId: undefined }),
  resolveAttrField: vi.fn().mockReturnValue(undefined),
  resolveAttributionFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  resolvePathRecallFilter: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  applyPathScorePenalty: vi.fn().mockImplementation((hits: any[]) => hits),
  mergeFilters: vi.fn().mockReturnValue({ whereClause: "", vars: {} }),
  applyRecallSoftFilters: vi.fn().mockImplementation((hits) => hits),
}));

vi.mock("../src/lifecycle/semion/lock.js", () => ({
  ensureConsolidationLockTable: vi.fn().mockResolvedValue(undefined),
  ensureStalenessBacklogTable: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lifecycle/semion/consolidation.js", () => ({
  ensureConsolidationLogTable: vi.fn().mockResolvedValue(undefined),
  ensureConsolidationStateTable: vi.fn().mockResolvedValue(undefined),
  startConsolidationScheduler: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../src/lifecycle/semion/staleness-pass.js", () => ({
  runStalenessPass: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/entities/entity-store.js", () => ({
  ensureEntityTables: vi.fn().mockResolvedValue(undefined),
  findEntityByName: vi.fn().mockResolvedValue([]),
  getEntityNeighbors: vi.fn().mockResolvedValue([]),
  getSupportingMemoryIds: vi.fn().mockResolvedValue([]),
  linkEntityToMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/entities/entity-arbitrator.js", () => ({
  normalizeEntityName: vi.fn((n: string) => n.toLowerCase()),
  arbitrateEntity: vi.fn().mockResolvedValue({ entityId: "e1", outcome: "create" }),
}));

vi.mock("../src/entities/entity-extractor.js", () => ({
  extractEntities: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Import mocked modules
// ---------------------------------------------------------------------------
import { segmentAndSummarize, extractMemories } from "../src/capture/extraction/capture.js";
import { getLastWatermark, createWatermark } from "../src/storage/surreal/surreal-store.js";
import { resolveEmbeddingProvider } from "../src/shared/config.js";
import { arbitrateWrite } from "../src/storage/writes/write-arbitrator.js";
import { arbitrateEntity } from "../src/entities/entity-arbitrator.js";
import { linkEntityToMemory } from "../src/entities/entity-store.js";
import { runStalenessPass } from "../src/lifecycle/semion/staleness-pass.js";
import { extractEntities } from "../src/entities/entity-extractor.js";
import { runHybridQueryWithEvidenceTable } from "../src/recall/query/memory-query.js";
import { createApp } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i + 1}`,
  }));

function getApp() {
  return createApp();
}

// ===========================================================================
// TASK 7: Route-level debug instrumentation (RUNIR_DEBUG=1)
// ===========================================================================

describe("route-level debug instrumentation (enabled)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    (getLastWatermark as any).mockResolvedValue(null);
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "Test summary for this topic segment" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "fact one", l0: "fact one title", l1: "- fact one", confidence: 0.9, category: "cases", tier: "working", tags: [], factKey: "cases:fact-one-abc123" },
    ]);
    (extractEntities as any).mockResolvedValue([
      { name: "TestEntity", kind: "concept", context: "test", confidence: 0.8 },
    ]);
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- /hooks/session-end ---

  it("POST /hooks/session-end with RUNIR_DEBUG=1 emits debug lines", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s-debug-1",
        userId: "test",
        messages: makeMessages(3),
      }),
    });
    expect(res.status).toBe(200);

    const logCalls = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logCalls.some((l) => /\[debug\] session-end: watermark/.test(l))).toBe(true);
    // No segmentation debug line anymore: session-end is extraction-free
    // (Rúnir-y5on/Rúnir-sq3s) — segmentation happens only on /hooks/capture.
    expect(logCalls.some((l) => /\[debug\] session-end: segmentation/.test(l))).toBe(false);
  });

  // --- /hooks/recall ---

  it("POST /hooks/recall with RUNIR_DEBUG=1 emits recall debug line", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValue([
      { score: 0.87, text: "result 1" },
    ]);
    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test query for memory recall", sessionId: "test-001" }),
    });
    expect(res.status).toBe(200);

    const logCalls = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logCalls.some((l) => /\[debug\] recall: results/.test(l))).toBe(true);
  });
});

// ===========================================================================
// TASK 8: /debug/ping dry-run isolation (RUNIR_DEBUG=1)
// ===========================================================================

describe("/debug/ping dry-run isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "GraphQL Basics", summary: "Discussion about GraphQL" }],
    });
    (extractMemories as any).mockResolvedValue([
      { text: "User is interested in GraphQL", confidence: 0.88 },
    ]);
    (extractEntities as any).mockResolvedValue([
      { name: "GraphQL", kind: "concept", context: "test", confidence: 0.9 },
    ]);
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST /debug/ping with RUNIR_DEBUG=1 returns 200 with expected shape", async () => {
    const app = getApp();
    const res = await app.request("/debug/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: makeMessages(3),
        sessionId: "test-ping",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).toHaveProperty("topics");
    expect(json).toHaveProperty("facts");
    expect(json).toHaveProperty("entities");
    expect(json).toHaveProperty("debugLines");

    expect(Array.isArray(json.topics)).toBe(true);
    expect(json.topics).toContain("GraphQL Basics");

    expect(Array.isArray(json.facts)).toBe(true);
    expect(json.facts[0]).toHaveProperty("text");
    expect(json.facts[0]).toHaveProperty("confidence");

    expect(Array.isArray(json.entities)).toBe(true);
    expect(json.entities).toContain("GraphQL");

    expect(Array.isArray(json.debugLines)).toBe(true);
  });

  it("dry-run isolation — write/arbitration functions must NOT have been called", async () => {
    const app = getApp();
    await app.request("/debug/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: makeMessages(3),
        sessionId: "test-ping-isolation",
      }),
    });

    expect(vi.mocked(arbitrateWrite).mock.calls).toHaveLength(0);
    expect(vi.mocked(arbitrateEntity).mock.calls).toHaveLength(0);
    expect(vi.mocked(createWatermark).mock.calls).toHaveLength(0);
    expect(vi.mocked(getLastWatermark).mock.calls).toHaveLength(0);
    expect(vi.mocked(linkEntityToMemory).mock.calls).toHaveLength(0);
    expect(vi.mocked(runStalenessPass).mock.calls).toHaveLength(0);
  });

  it("debugLines in response contains at least one string matching /[debug]/", async () => {
    const app = getApp();
    const res = await app.request("/debug/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: makeMessages(3),
        sessionId: "test-ping-lines",
      }),
    });
    const json = await res.json();
    expect(json.debugLines.length).toBeGreaterThan(0);
    expect(json.debugLines.some((l: string) => /\[debug\]/.test(l))).toBe(true);
  });
});
