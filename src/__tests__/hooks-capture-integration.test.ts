import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

const sourceAppend = vi.hoisted(() => vi.fn(async (turns: unknown[]) => turns.map(() => true)));
vi.mock("../capture/source-turn-spool.js", () => ({
  SourceTurnSpool: class {
    appendBatch = sourceAppend;
    drain = vi.fn().mockResolvedValue(undefined);
    snapshot = vi.fn().mockReturnValue({ appended: 0, pending: 0, pendingBytes: 0, appendFailures: 0 });
  },
}));

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
  STOP_WORDS: new Set(["the", "and", "for", "with", "this", "that"]),
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

vi.mock("../storage/surreal/phase2-store.js", () => ({
  buildSemioteProvenanceEnvelope: vi.fn().mockImplementation((input: any) => input),
  ensurePhase2Schema: vi.fn().mockResolvedValue(undefined),
  createRetrievalTrace: vi.fn().mockResolvedValue("trace-1"),
  getHexisById: vi.fn().mockResolvedValue(null),
  getHexisByScopeKey: vi.fn().mockResolvedValue(null),
  getPrimaryMemoryRowsByIds: vi.fn().mockResolvedValue([]),
  getRetrievalFootprintFromTrace: vi.fn().mockResolvedValue(null),
  getRetrievalTrace: vi.fn().mockResolvedValue(null),
  listRetrievalTraces: vi.fn().mockResolvedValue([]),
  patchRetrievalTraceCaptureReceipt: vi.fn().mockResolvedValue(undefined),
  patchSemioteProvenance: vi.fn().mockResolvedValue(undefined),
  markSemiotesFoldedIntoProjectState: vi.fn().mockResolvedValue(undefined),
  patchSemioteUsefulness: vi.fn().mockResolvedValue(undefined),
  promoteSemioteToNoema: vi.fn().mockResolvedValue({ promoted: false, id: null }),
  initializeSemioteSemiosis: vi.fn().mockResolvedValue(undefined),
  retrievalFootprintIdentityMatches: vi.fn().mockReturnValue(true),
  toRetrievalFootprintIdentitySnapshot: vi.fn().mockImplementation((identity: any) => ({
    userId: identity.userId,
    contextScopeKind: identity.contextScopeKind,
    sessionId: identity.raw?.sessionId,
    projectKey: identity.projectKey,
    agentId: identity.agentId,
    resolvedTaskId: identity.resolvedTaskId,
    path: identity.raw?.path,
    derivation: identity.derivation,
  })),
  upsertSemioteRelation: vi.fn().mockResolvedValue("m1->derived_from->m0"),
  upsertHexis: vi.fn().mockResolvedValue("hexis-1"),
}));

// ---------------------------------------------------------------------------
// Import mocked modules for assertions
// ---------------------------------------------------------------------------
import { extractMemories } from "../capture/extraction/capture.js";
import { logRejection } from "../storage/surreal/surreal-store.js";
import { arbitrateWrite } from "../storage/writes/write-arbitrator.js";
import { resolveCaptureApiKey } from "../shared/config.js";
import { getPrimaryMemoryRowsByIds, getRetrievalFootprintFromTrace, getRetrievalTrace, listRetrievalTraces, patchRetrievalTraceCaptureReceipt, patchSemioteProvenance, retrievalFootprintIdentityMatches, upsertSemioteRelation } from "../storage/surreal/phase2-store.js";
import { normalizeCaptureMessages } from "../capture/extraction/capture.js";
import { createApp } from "../../index.js";
import { runtime } from "../app/runtime.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /hooks/capture integration (MIM-58)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    (extractMemories as Mock).mockResolvedValue([]);
    (arbitrateWrite as Mock).mockResolvedValue({ outcome: "create", memoryId: "m1" });
    (resolveCaptureApiKey as Mock).mockReturnValue("test-api-key");
    (getRetrievalFootprintFromTrace as any).mockResolvedValue(null);
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([]);
    (retrievalFootprintIdentityMatches as any).mockReturnValue(true);
    (patchSemioteProvenance as any).mockResolvedValue(undefined);
    (upsertSemioteRelation as any).mockResolvedValue("m1->derived_from->m0");
  });

  function getApp() {
    return createApp();
  }

  it("POST /hooks/capture with valid transcript calls extractMemories and arbitrateWrite", async () => {
    (extractMemories as Mock).mockResolvedValue([
      { l2: "test fact number one that is long enough", confidence: 0.9, l0: "test", l1: "- test", category: "cases", tier: "working", tags: [], factKey: "cases:test" },
      { l2: "test fact number two that is also long enough", confidence: 0.85, l0: "test2", l1: "- test2", category: "cases", tier: "working", tags: [], factKey: "cases:test2" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "hello world this is a test message" },
          { role: "assistant", content: "I understand your test message" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(extractMemories).toHaveBeenCalled();
    expect(arbitrateWrite).toHaveBeenCalledTimes(2);
    expect(json.factsFound).toBe(2);
    expect(json.outcomes.create).toBe(2);
  });

  it("POST /hooks/capture drops malformed extraction before fact writes with watermark-safe body", async () => {
    (extractMemories as Mock).mockResolvedValueOnce([{ l2: null, confidence: 0.9 }]);
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "synthetic source" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ skipped: false, reason: "redaction_assertion_failed", factsFound: 0, units: [] });
    expect(body).not.toHaveProperty("error");
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture drops an assertion-failing source before extraction", async () => {
    const res = await getApp().request("/hooks/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Authorization: Basic QUFBQUFBQUFBQUFBQUFBQQ==" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ skipped: false, reason: "redaction_assertion_failed", factsFound: 0, units: [] });
    expect(body).not.toHaveProperty("error");
    expect(extractMemories).not.toHaveBeenCalled();
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture keeps synthetic secret canaries out of writer arguments and JSON", async () => {
    const canary = "Bearer AAAAAAAAAAAAAAAAAAAAAAAA";
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (extractMemories as Mock).mockResolvedValueOnce([{
      l2: `The safe fact includes ${canary}`, l0: `Fact ${canary}`, l1: `- Fact ${canary}`,
      confidence: 0.9, category: "cases", tier: "working", tags: [],
      raw_source_text: `Source ${canary}`,
      rawSpan: { text: `Span ${canary}`, kind: "exact_answer" },
    }]);
    const res = await getApp().request("/hooks/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captureDebug: true, messages: [{ role: "user", content: `Source ${canary}` }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body).includes(canary)).toBe(false);
    expect(body.units[0]).not.toHaveProperty("raw_source_text");
    expect(JSON.stringify((arbitrateWrite as Mock).mock.calls).includes(canary)).toBe(false);
    expect(JSON.stringify((arbitrateWrite as Mock).mock.calls)).not.toContain("raw_source_text");
    expect(JSON.stringify(warnings.mock.calls).includes(canary)).toBe(false);
    warnings.mockRestore();
  });

  it("POST /hooks/capture keeps rejection candidates and catch errors out of public text", async () => {
    const canary = "Bearer AAAAAAAAAAAAAAAAAAAAAAAA";
    (extractMemories as Mock).mockImplementationOnce(async (_messages: unknown, _prompt: unknown, _key: unknown,
      _timestamp: unknown, onReject: (fact: { l2: string; confidence: number }, reason: string) => void) => {
      onReject({ l2: `Rejected ${canary}`, confidence: 0.1 }, "low-confidence");
      return [];
    });
    const app = getApp();
    const rejection = await app.request("/hooks/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "synthetic source" }] }),
    });
    expect(rejection.status).toBe(200);
    expect(JSON.stringify((logRejection as Mock).mock.calls).includes(canary)).toBe(false);
    (extractMemories as Mock).mockRejectedValueOnce(new Error(canary));
    const failure = await app.request("/hooks/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "synthetic source" }] }),
    });
    expect(failure.status).toBe(500);
    expect(await failure.json()).toMatchObject({ error: "capture failed" });
  });

  // G004: body.sessionTimestamp must thread through to extractMemories' 4th arg
  // so replay drivers (LoCoMo, etc.) can anchor relative-date extraction to
  // the source conversation's actual wall-clock. Falls back to "now" when
  // absent or invalid. MUST NOT replace operational created_at.
  it("POST /hooks/capture threads body.sessionTimestamp into extractMemories", async () => {
    (extractMemories as Mock).mockResolvedValueOnce([]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "g004-locomo-conv-26",
        sessionId: "locomo-session-1",
        sessionTimestamp: "2023-05-07T00:00:00.000Z",
        messages: [
          { role: "user", content: "Caroline went yesterday and it was great" },
          { role: "assistant", content: "Glad to hear that" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(extractMemories).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "2023-05-07T00:00:00.000Z",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("POST /hooks/capture falls back to new Date() when sessionTimestamp is missing", async () => {
    (extractMemories as Mock).mockResolvedValueOnce([]);

    const app = getApp();
    const before = Date.now();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "no timestamp supplied this turn" }],
      }),
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(extractMemories).toHaveBeenCalled();
    const calls = (extractMemories as Mock).mock.calls;
    const tsArg = calls[calls.length - 1][3];
    const parsed = Date.parse(tsArg);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1);
    expect(parsed).toBeLessThanOrEqual(after + 1);
  });

  it("POST /hooks/capture rejects garbage sessionTimestamp and falls back to new Date()", async () => {
    (extractMemories as Mock).mockResolvedValueOnce([]);

    const app = getApp();
    const before = Date.now();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionTimestamp: "not a date string at all",
        messages: [{ role: "user", content: "garbage timestamp should not poison the extractor" }],
      }),
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    const calls = (extractMemories as Mock).mock.calls;
    const tsArg = calls[calls.length - 1][3];
    expect(tsArg).not.toBe("not a date string at all");
    const parsed = Date.parse(tsArg);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1);
    expect(parsed).toBeLessThanOrEqual(after + 1);
  });

  it("POST /hooks/capture with no messages returns {skipped:true} without calling extract", async () => {
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("no messages");
    // extractMemories should not be called for empty messages
    expect(extractMemories).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture with zero extracted facts still returns an explicit outcomes summary", async () => {
    (extractMemories as Mock).mockResolvedValue([]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        messages: [{ role: "user", content: "no durable facts should come from this turn" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      skipped: false,
      factsFound: 0,
      outcomes: {
        create: 0,
        skip: 0,
        "merge-update": 0,
        supersede: 0,
      },
      units: [],
      rejections: {
        suppressed: 0,
        rejected_short: 0,
        rejected_noise: 0,
      },
    });
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });

  it("stores redacted source before a no-key early exit when the flag is on", async () => {
    vi.stubEnv("RUNIR_SOURCE_STORE", "on");
    vi.stubEnv("RUNIR_SOURCE_HMAC_KEY", "synthetic-key");
    (resolveCaptureApiKey as Mock).mockReturnValue(undefined);
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "test-user", sessionId: "synthetic-session", client: "codex",
        scope: "global", teamId: "untrusted-team", projectKey: "untrusted-project",
        messages: [{ role: "user", content: "synthetic.person@example.com", turnIndex: 8, sessionEpoch: "epoch:2" }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("no capture API key");
    expect(sourceAppend).toHaveBeenCalledTimes(1);
    const stored = sourceAppend.mock.calls[0]?.[0] as Array<{
      content: string; turnIndex: number; identityQuality: string;
      scope: string; teamId?: string; projectKey?: string;
    }>;
    expect(stored[0]?.content).not.toContain("synthetic.person@example.com");
    expect(stored[0]).toMatchObject({ turnIndex: 8, identityQuality: "ordinal" });
    expect(stored[0]?.scope).toBe("user");
    expect(stored[0]?.teamId).toBeUndefined();
    expect(stored[0]?.projectKey).not.toBe("untrusted-project");
    const status = await app.request("/hooks/source-spool");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ pending: 0, appendFailures: 0 });
  });

  it("counts a failed spool append and returns normal capture with an unavailable fact link", async () => {
    vi.stubEnv("RUNIR_SOURCE_STORE", "on");
    vi.stubEnv("RUNIR_SOURCE_HMAC_KEY", "synthetic-key");
    sourceAppend.mockResolvedValueOnce([false]);
    (extractMemories as Mock).mockResolvedValueOnce([
      { l2: "A synthetic compiler fact with sufficient length", confidence: 0.9, source_turn_index: 0 },
    ]);
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "test-user", sessionId: "synthetic-session", client: "codex",
        messages: [{ role: "user", content: "synthetic compiler fact", turnIndex: 0, sessionEpoch: "epoch:0" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.skipped).toBe(false);
    expect((runtime.db.query as Mock).mock.calls.some(([sql, params]) =>
      String(sql).includes("source_turn_link_state") && params?.state === "unavailable")).toBe(true);
  });

  it("refuses source writes on an HMAC fingerprint mismatch but still accepts capture", async () => {
    vi.stubEnv("RUNIR_SOURCE_STORE", "on");
    vi.stubEnv("RUNIR_SOURCE_HMAC_KEY", "different-synthetic-key");
    (runtime.db.query as Mock).mockImplementation(async (sql: string) =>
      String(sql).includes("SELECT VALUE key_fingerprint FROM session_turn")
        ? [["0000000000000000"]] : [[]]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (extractMemories as Mock).mockResolvedValueOnce([
      { l2: "A synthetic compiler fact with sufficient length", confidence: 0.9, source_turn_index: 0 },
    ]);
    try {
      const res = await getApp().request("/hooks/capture", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "test-user", sessionId: "synthetic-key-mismatch", client: "grok",
          messages: [{ role: "user", content: "synthetic compiler fact" }] }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).error).toBeUndefined();
      expect(sourceAppend).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/key fingerprint mismatch configured=[0-9a-f]{16} recorded=0000000000000000/));
      expect((runtime.db.query as Mock).mock.calls.some(([sql, params]) =>
        String(sql).includes("source_turn_link_state") && params?.state === "unavailable")).toBe(true);
    } finally {
      errorLog.mockRestore();
      (runtime.db.query as Mock).mockResolvedValue([[]]);
    }
  });

  it("POST /hooks/capture persists an exact headless capture receipt on the retrieval trace", async () => {
    const prompt = "Which deployment target did we choose?";
    const answer = "production";
    (getRetrievalTrace as Mock).mockResolvedValue({
      id: "trace-headless",
      userId: "agent-hermes",
      sessionId: "00000000-0000-4000-8000-000000000123",
      prompt,
      intentLabel: "fact",
      laneLabel: "fact",
      retrievalPath: "hybrid",
      accessTrackedIds: ["semiote:m1", "semiote:m2"],
      items: [
        { id: "semiote:m1", score: 0.9 },
        { id: "semiote:m2", score: 0.8 },
      ],
      createdAt: "2026-08-04T00:00:00.000Z",
    });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        client: "grok",
        sessionId: "00000000-0000-4000-8000-000000000123",
        path: "/repo",
        retrievalTraceId: "trace-headless",
        memoryIds: ["semiote:m1", "semiote:m2"],
        captureReceipt: true,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: answer },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(patchRetrievalTraceCaptureReceipt).toHaveBeenCalledWith(
      expect.anything(),
      "trace-headless",
      "agent-hermes",
      {
        sessionId: "00000000-0000-4000-8000-000000000123",
        memoryIds: ["semiote:m1", "semiote:m2"],
        prompt,
        answer,
        client: undefined,
        path: undefined,
      },
    );
  });

  it("POST /hooks/capture ignores malformed memoryIds for legacy non-receipt clients", async () => {
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        memoryIds: "legacy-non-array-value",
        messages: [
          { role: "user", content: "legacy prompt" },
          { role: "assistant", content: "legacy answer" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(extractMemories).toHaveBeenCalled();
  });

  it("POST /hooks/capture rejects a headless receipt whose memory identities do not exactly match the trace", async () => {
    vi.stubEnv("RUNIR_SOURCE_STORE", "on");
    vi.stubEnv("RUNIR_SOURCE_HMAC_KEY", "synthetic-key");
    (getRetrievalTrace as Mock).mockResolvedValueOnce({
      id: "trace-headless",
      userId: "agent-hermes",
      sessionId: "sess-1",
      prompt: "original prompt",
      intentLabel: "fact",
      laneLabel: "fact",
      retrievalPath: "hybrid",
      accessTrackedIds: ["semiote:m1"],
      items: [{ id: "semiote:m1", score: 0.9 }],
      createdAt: "2026-08-04T00:00:00.000Z",
    });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        sessionId: "sess-1",
        retrievalTraceId: "trace-headless",
        memoryIds: ["m2"],
        captureReceipt: true,
        messages: [
          { role: "user", content: "original prompt" },
          { role: "assistant", content: "final answer" },
        ],
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "capture receipt memoryIds mismatch" });
    expect(listRetrievalTraces).not.toHaveBeenCalled();
    expect(extractMemories).not.toHaveBeenCalled();
    expect(patchRetrievalTraceCaptureReceipt).not.toHaveBeenCalled();
    expect(sourceAppend).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture rejects prefix-normalized memoryIds instead of rewriting the receipt", async () => {
    (getRetrievalTrace as Mock).mockResolvedValueOnce({
      id: "trace-headless",
      userId: "agent-hermes",
      sessionId: "sess-1",
      prompt: "original prompt",
      intentLabel: "fact",
      laneLabel: "fact",
      retrievalPath: "hybrid",
      accessTrackedIds: ["semiote:m1"],
      items: [{ id: "semiote:m1", score: 0.9 }],
      createdAt: "2026-08-04T00:00:00.000Z",
    });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        sessionId: "sess-1",
        retrievalTraceId: "trace-headless",
        memoryIds: ["m1"],
        captureReceipt: true,
        messages: [
          { role: "user", content: "original prompt" },
          { role: "assistant", content: "final answer" },
        ],
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "capture receipt memoryIds mismatch" });
    expect(patchRetrievalTraceCaptureReceipt).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture skips when normalization yields no eligible messages", async () => {
    (normalizeCaptureMessages as Mock).mockReturnValueOnce([]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        messages: [{ role: "tool", content: "tool-only noise" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      skipped: true,
      reason: "no normalizable messages",
    });
    expect(extractMemories).not.toHaveBeenCalled();
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture without API key returns graceful response", async () => {
    (resolveCaptureApiKey as Mock).mockReturnValue(null);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test message" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Without API key, extraction is skipped
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("no capture API key");
  });

  it("POST /hooks/capture does not write facts that are too short", async () => {
    (extractMemories as Mock).mockResolvedValue([
      { l2: "one fact here is sufficiently long", confidence: 0.9, l0: "test", l1: "- test", category: "cases", tier: "working", tags: [], factKey: "cases:test" },
      { l2: "too short", confidence: 0.9, l0: "short", l1: "- short", category: "cases", tier: "working", tags: [], factKey: "cases:short" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test content that is long enough" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.factsFound).toBe(2);
    expect(json.outcomes.create).toBe(1);
    expect(json.outcomes.skip).toBe(0);
    expect(arbitrateWrite).toHaveBeenCalledTimes(1);
    expect((arbitrateWrite as Mock).mock.calls[0]?.[0]?.text).toBe("one fact here is sufficiently long");
  });

  it("POST /hooks/capture: when arbitrateWrite returns skip, increments skipped count in outcomes", async () => {
    (extractMemories as Mock).mockResolvedValue([
      { l2: "fact one is long enough to pass", confidence: 0.9, l0: "test1", l1: "- test1", category: "cases", tier: "working", tags: [], factKey: "cases:test1" },
      { l2: "fact two is also long enough", confidence: 0.9, l0: "test2", l1: "- test2", category: "cases", tier: "working", tags: [], factKey: "cases:test2" },
      { l2: "fact three is definitely long enough", confidence: 0.9, l0: "test3", l1: "- test3", category: "cases", tier: "working", tags: [], factKey: "cases:test3" },
    ]);

    // First call creates, second skips, third creates
    (arbitrateWrite as Mock)
      .mockResolvedValueOnce({ outcome: "create", memoryId: "m1" })
      .mockResolvedValueOnce({ outcome: "skip", reason: "duplicate" })
      .mockResolvedValueOnce({ outcome: "create", memoryId: "m2" });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "test content here" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.factsFound).toBe(3);
    expect(json.outcomes.create).toBe(2);
    expect(json.outcomes.skip).toBe(1);
  });

  it("POST /hooks/capture: malformed userId returns 400 and does not extract", async () => {
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: { injection: "attempt" },
        messages: [{ role: "user", content: "test message" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(extractMemories).not.toHaveBeenCalled();
    expect(arbitrateWrite).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture suppresses exact shown-memory re-mentions when retrievalTraceId is provided", async () => {
    (extractMemories as Mock).mockResolvedValue([
      { l2: "The capture hook writes semiote records directly.", confidence: 0.95, l0: "capture hook", l1: "- capture hook", category: "cases", tier: "working", tags: [], factKey: "cases:test-abc123" },
    ]);
    (getRetrievalFootprintFromTrace as any).mockResolvedValue({
      traceId: "trace-1",
      identity: {
        userId: "agent-hermes",
        contextScopeKind: "agent",
        derivation: {
          contextScopeKind: { value: "agent", source: "default" },
          agentId: { source: "absent" },
          resolvedTaskId: { source: "absent" },
          projectKey: { source: "absent" },
        },
      },
      shownMemoryIds: ["semiote:mem-1"],
      selectedMemoryIds: ["semiote:mem-1"],
      createdAt: "2026-04-16T07:00:00.000Z",
      retrievalPath: "hybrid",
      intentLabel: "fact",
    });
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([
      { id: "semiote:mem-1", payload: { l2: "The capture hook writes semiote records directly.", factKey: "cases:test-abc123" } },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        retrievalTraceId: "trace-1",
        captureDebug: true,
        messages: [{ role: "user", content: "The capture hook writes semiote records directly." }],
      }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(arbitrateWrite).not.toHaveBeenCalled();
    expect(json._debug.suppressedShownRementionCount).toBe(1);
    expect(upsertSemioteRelation).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture fails closed on footprint identity mismatch and does not suppress writes", async () => {
    (extractMemories as Mock).mockResolvedValue([
      { l2: "The capture hook writes semiote records directly.", confidence: 0.95, l0: "capture hook", l1: "- capture hook", category: "cases", tier: "working", tags: [], factKey: "cases:test-abc123" },
    ]);
    (getRetrievalFootprintFromTrace as any).mockResolvedValue({
      traceId: "trace-1",
      identity: {
        userId: "other-user",
        contextScopeKind: "agent",
        derivation: {
          contextScopeKind: { value: "agent", source: "default" },
          agentId: { source: "absent" },
          resolvedTaskId: { source: "absent" },
          projectKey: { source: "absent" },
        },
      },
      shownMemoryIds: ["semiote:mem-1"],
      selectedMemoryIds: ["semiote:mem-1"],
      createdAt: "2026-04-16T07:00:00.000Z",
      retrievalPath: "hybrid",
      intentLabel: "fact",
    });
    (retrievalFootprintIdentityMatches as any).mockReturnValue(false);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        retrievalTraceId: "trace-1",
        captureDebug: true,
        messages: [{ role: "user", content: "The capture hook writes semiote records directly." }],
      }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(arbitrateWrite).toHaveBeenCalledTimes(1);
    expect(json._debug.captureContext.identityMatchedFootprint).toBe(false);
    expect(json._debug.suppressedShownRementionCount).toBe(0);
    expect(upsertSemioteRelation).not.toHaveBeenCalled();
  });

  it("POST /hooks/capture still sends materially changed corrections to arbitration when retrievalTraceId is provided", async () => {
    (extractMemories as Mock).mockResolvedValue([
      {
        l2: "The capture hook writes semiote records directly after the April fix.",
        confidence: 0.95,
        l0: "capture hook",
        l1: "- capture hook",
        category: "cases",
        tier: "working",
        tags: [],
        factKey: "cases:test-abc123",
      },
    ]);
    (getRetrievalFootprintFromTrace as any).mockResolvedValue({
      traceId: "trace-1",
      identity: {
        userId: "agent-hermes",
        contextScopeKind: "agent",
        derivation: {
          contextScopeKind: { value: "agent", source: "default" },
          agentId: { source: "absent" },
          resolvedTaskId: { source: "absent" },
          projectKey: { source: "absent" },
        },
      },
      shownMemoryIds: ["semiote:mem-1"],
      selectedMemoryIds: ["semiote:mem-1"],
      createdAt: "2026-04-16T07:00:00.000Z",
      retrievalPath: "hybrid",
      intentLabel: "fact",
    });
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([
      { id: "semiote:mem-1", payload: { l2: "The capture hook writes semiote records directly.", factKey: "cases:test-abc123" } },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        retrievalTraceId: "trace-1",
        captureDebug: true,
        messages: [{ role: "user", content: "The capture hook writes semiote records directly after the April fix." }],
      }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(arbitrateWrite).toHaveBeenCalledTimes(1);
    expect(json._debug.suppressedShownRementionCount).toBe(0);
    expect(patchSemioteProvenance).toHaveBeenCalledTimes(1);
    expect(upsertSemioteRelation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "derived_from",
        retrievalTraceId: "trace-1",
        sourceWrite: "capture",
      }),
    );
    expect(json._debug.createdDerivedFromCount).toBe(1);
  });

  it("POST /hooks/capture does not create derived_from relations for supersede outcomes", async () => {
    (extractMemories as Mock).mockResolvedValue([
      {
        l2: "The capture hook now writes provenance envelopes after the April fix.",
        confidence: 0.95,
        l0: "capture hook",
        l1: "- capture hook",
        category: "cases",
        tier: "working",
        tags: [],
        factKey: "cases:test-abc123",
      },
    ]);
    (arbitrateWrite as Mock).mockResolvedValue({ outcome: "supersede", memoryId: "m2" });
    (getRetrievalFootprintFromTrace as any).mockResolvedValue({
      traceId: "trace-1",
      identity: {
        userId: "agent-hermes",
        contextScopeKind: "agent",
        derivation: {
          contextScopeKind: { value: "agent", source: "default" },
          agentId: { source: "absent" },
          resolvedTaskId: { source: "absent" },
          projectKey: { source: "absent" },
        },
      },
      shownMemoryIds: ["semiote:mem-1"],
      selectedMemoryIds: ["semiote:mem-1"],
      createdAt: "2026-04-16T07:00:00.000Z",
      retrievalPath: "hybrid",
      intentLabel: "fact",
    });
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([
      { id: "semiote:mem-1", payload: { l2: "The capture hook writes semiote records directly.", factKey: "cases:test-abc123" } },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        retrievalTraceId: "trace-1",
        captureDebug: true,
        messages: [{ role: "user", content: "The capture hook now writes provenance envelopes after the April fix." }],
      }),
    });

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(patchSemioteProvenance).toHaveBeenCalledTimes(1);
    expect(upsertSemioteRelation).not.toHaveBeenCalled();
    expect(json._debug.createdDerivedFromCount).toBe(0);
  });
});

// Product-eval Step 3.0: a PER-REQUEST `body.captureFixtureFacts` array
// overrides the process-global RUNIR_TEST_CAPTURE_FACTS_JSON env blob (so the
// product-eval lane can inject distinct facts per session), gated by
// RUNIR_TEST_MODE=1; production (RUNIR_TEST_MODE unset) ignores the body field.
describe("POST /hooks/capture per-request captureFixtureFacts body override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (arbitrateWrite as Mock).mockResolvedValue({ outcome: "create", memoryId: "m1" });
    (resolveCaptureApiKey as Mock).mockReturnValue("test-api-key");
  });

  const SAVED_TEST_MODE = process.env.RUNIR_TEST_MODE;
  const SAVED_ENV_BLOB = process.env.RUNIR_TEST_CAPTURE_FACTS_JSON;

  afterEach(() => {
    if (SAVED_TEST_MODE === undefined) delete process.env.RUNIR_TEST_MODE;
    else process.env.RUNIR_TEST_MODE = SAVED_TEST_MODE;
    if (SAVED_ENV_BLOB === undefined) delete process.env.RUNIR_TEST_CAPTURE_FACTS_JSON;
    else process.env.RUNIR_TEST_CAPTURE_FACTS_JSON = SAVED_ENV_BLOB;
  });

  it("in fixture mode, body.captureFixtureFacts overrides the env blob and bypasses extractMemories", async () => {
    process.env.RUNIR_TEST_MODE = "1";
    process.env.RUNIR_TEST_CAPTURE_FACTS_JSON = JSON.stringify([
      { l2: "ENV blob fact that should be overridden", confidence: 0.5 },
    ]);
    (extractMemories as Mock).mockResolvedValue([]);

    const app = createApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "eval-pe-x",
        sessionId: "s1",
        captureFixtureFacts: [
          { l2: "BODY fact one that is long enough to keep", confidence: 0.95 },
          { l2: "BODY fact two that is long enough to keep", confidence: 0.9 },
        ],
        messages: [{ role: "user", content: "session one message" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // The body facts (2) drove the write path, NOT the env blob (1) and NOT extraction.
    expect(extractMemories).not.toHaveBeenCalled();
    expect(json.factsFound).toBe(2);
    expect(arbitrateWrite).toHaveBeenCalledTimes(2);
  });

  it("ignores body.captureFixtureFacts in production (RUNIR_TEST_MODE unset) and runs extraction", async () => {
    delete process.env.RUNIR_TEST_MODE;
    delete process.env.RUNIR_TEST_CAPTURE_FACTS_JSON;
    (extractMemories as Mock).mockResolvedValue([
      { l2: "real extracted fact long enough", confidence: 0.9, l0: "x", l1: "- x", category: "cases", tier: "working", tags: [], factKey: "cases:x" },
    ]);

    const app = createApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "prod-user",
        sessionId: "s1",
        captureFixtureFacts: [
          { l2: "BODY fact that MUST be ignored in production", confidence: 0.99 },
        ],
        messages: [{ role: "user", content: "production message that should be extracted" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Production path ignores the body field entirely and goes through extraction.
    expect(extractMemories).toHaveBeenCalled();
    expect(json.factsFound).toBe(1);
  });

  // Rúnir-x41m.1 D9: extract-mode child env pins RUNIR_TEST_MODE="0" (not mere omit)
  // and neutralizes RUNIR_TEST_CAPTURE_FACTS_JSON. Even with a stale non-empty
  // fixture blob in the env, fixture mode must stay OFF and extractMemories runs.
  // extractMemories spy is allowed ONLY in this zero-cost service-contract test.
  it('RUNIR_TEST_MODE="0" + stale non-empty fixture blob still routes to extractMemories', async () => {
    process.env.RUNIR_TEST_MODE = "0";
    process.env.RUNIR_TEST_CAPTURE_FACTS_JSON = JSON.stringify([
      { l2: "STALE env blob fact that must NOT bypass extraction", confidence: 0.99 },
    ]);
    (extractMemories as Mock).mockResolvedValue([
      {
        l2: "real extracted fact long enough for keep",
        confidence: 0.9,
        l0: "x",
        l1: "- x",
        category: "cases",
        tier: "working",
        tags: [],
        factKey: "cases:x",
      },
    ]);

    const app = createApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "eval-extract",
        sessionId: "s1",
        // Body field present but fixture mode is OFF — must be ignored.
        captureFixtureFacts: [
          { l2: "BODY fact that must be ignored when RUNIR_TEST_MODE is 0", confidence: 0.99 },
        ],
        messages: [{ role: "user", content: "extract mode message that should hit extractMemories" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(extractMemories).toHaveBeenCalled();
    expect(json.factsFound).toBe(1);
    // Stale blob / body inject must not drive multi-fact write from fixture path.
    expect(arbitrateWrite).toHaveBeenCalledTimes(1);
  });
});
