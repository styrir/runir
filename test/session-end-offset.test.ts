import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock all side-effect modules that index.ts imports at module level
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
// Import mocked modules to access mock fns in assertions
// ---------------------------------------------------------------------------
import { normalizeCaptureMessages, segmentAndSummarize } from "../src/capture/extraction/capture.js";
import { getLastWatermark, createWatermark } from "../src/storage/surreal/surreal-store.js";
import { arbitrateWrite } from "../src/storage/writes/write-arbitrator.js";
import { resolveEmbeddingProvider } from "../src/shared/config.js";
import { runtime } from "../src/app/runtime.js";
import { createApp } from "../index.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
const makeMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i + 1}`,
  }));

function getApp() {
  return createApp();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("session-end messageOffset integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (getLastWatermark as any).mockResolvedValue(null);
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  // Test 1
  it("harness smoke test — createApp() instantiates without side effects", () => {
    const app = getApp();
    expect(app).toBeTruthy();
  });

  // Test 2
  it("no messageOffset — legacy behavior — no watermark → processes all messages", async () => {
    (getLastWatermark as any).mockResolvedValue(null);

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(5),
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).not.toBe(true);
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "test", 5);
  });

  // Test 3
  it("no messageOffset — legacy behavior — watermark=3, 5 messages → processes messages[3..4]", async () => {
    (getLastWatermark as any).mockResolvedValue({ message_count: 3 });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(5),
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).not.toBe(true);
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "test", 5);
    // batchStart=0, overlapCount=max(0,3-0)=3, so messages.slice(3) = 2 messages
    expect(normalizeCaptureMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: "message 4" })]),
      expect.any(Number),
    );
    const normalizedArg = (normalizeCaptureMessages as any).mock.calls[0][0];
    expect(normalizedArg).toHaveLength(2);
  });

  // Test 4
  it("messageOffset present — normal incremental — watermark=10, 5 new msgs, offset=15", async () => {
    (getLastWatermark as any).mockResolvedValue({ message_count: 10 });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(5),
        messageOffset: 15,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).not.toBe(true);
    // batchStart=15-5=10, overlapCount=max(0,10-10)=0 → all 5 processed
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "test", 15);
    const normalizedArg = (normalizeCaptureMessages as any).mock.calls[0][0];
    expect(normalizedArg).toHaveLength(5);
  });

  // Test 5
  it("messageOffset present — duplicate batch — watermark=15, offset=15 → skipped", async () => {
    (getLastWatermark as any).mockResolvedValue({ message_count: 15 });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(5),
        messageOffset: 15,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toMatch(/no new messages/i);
    expect(createWatermark).not.toHaveBeenCalled();
  });

  // Test 5b (Rúnir-78sy.13, F2)
  it("watermark-skip path STILL closes the runir_session row before returning (the fix — was previously an early-return with no close write)", async () => {
    (getLastWatermark as any).mockResolvedValue({ message_count: 15 });
    const dbQueryMock = runtime.db.query as any;

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(5),
        messageOffset: 15,
        terminationReason: "user_exit",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toMatch(/no new messages/i);
    // The route resolves the runir_session row TWICE per request regardless
    // of outcome: once up front (resolveBodyRunirSession, status:"active",
    // establishing/heartbeating the row) and — with F2 — once more via the
    // close closure even on the watermark-skip path. Both go through
    // resolveRunirSession's SELECT-then-UPDATE/UPSERT, so the mocked
    // SurrealClient.query sees a SELECT for the row followed by an UPDATE (or
    // UPSERT on first-ever contact) whose SET clause carries status:'closed'.
    // Assert the CLOSE write's status param specifically — proves the
    // watermark-skip path issues a close, not just that SOME query ran.
    const closeCalls = dbQueryMock.mock.calls.filter(
      ([sql, vars]: [string, Record<string, unknown> | undefined]) =>
        typeof sql === "string"
        && (sql.includes("UPDATE type::record('runir_session'") || sql.includes("UPSERT type::record('runir_session'"))
        && vars?.status === "closed",
    );
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  // Test 6
  it("messageOffset present — replay after state loss — watermark=10, 14 msgs, offset=14 → 4 processed", async () => {
    (getLastWatermark as any).mockResolvedValue({ message_count: 10 });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(14),
        messageOffset: 14,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).not.toBe(true);
    // batchStart=14-14=0, overlapCount=max(0,10-0)=10 → messages.slice(10) = 4 messages
    const normalizedArg = (normalizeCaptureMessages as any).mock.calls[0][0];
    expect(normalizedArg).toHaveLength(4);
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "test", 14);
  });

  // Test 7
  it("malformed session-end userId returns 400 without normalization or writes", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: { injection: "attempt" },
        messages: makeMessages(2),
      }),
    });

    expect(res.status).toBe(400);
    expect(normalizeCaptureMessages).not.toHaveBeenCalled();
    expect(createWatermark).not.toHaveBeenCalled();
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });

  // Test 8
  it("session-end skips when normalization yields no eligible messages", async () => {
    (normalizeCaptureMessages as any).mockReturnValueOnce([]);

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        userId: "test",
        messages: makeMessages(2),
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      skipped: true,
      reason: "no normalizable messages",
    });
    expect(segmentAndSummarize).not.toHaveBeenCalled();
    expect(createWatermark).not.toHaveBeenCalled();
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });
});
