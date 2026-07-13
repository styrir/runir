import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// /hooks/recall, /hooks/feedback, /hooks/capture malformed-body resilience
// (Rúnir-o75n.2). Same contract already pinned for /hooks/session-end in
// hooks.test.ts: clients record ANY non-2xx as an error trace, so a malformed
// or truncated request body must degrade into the handler's EXISTING
// missing-field path — never an unhandled c.req.json() throw that Hono
// surfaces as a 500. Two failure classes per endpoint:
//   1. syntactically invalid JSON ('{{{') → .catch(() => ({})) guard;
//   2. the JSON literal `null`, which c.req.json() RESOLVES rather than
//      throws (so .catch() never fires) → the non-object coercion guard.
//
// The mock harness below mirrors src/__tests__/hooks.test.ts — the
// established app-bootstrapping pattern: mock every side-effect module that
// index.ts pulls in at module level BEFORE importing createApp.
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
    extractId: vi.fn((rawId: unknown) => {
      if (typeof rawId === "object" && rawId !== null && "id" in rawId) {
        return String((rawId as any).id);
      }
      return String(rawId).replace(/^[^:]+:/, "");
    }),
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
    getProjectStateForRecall: vi.fn().mockResolvedValue({ projectState: null, usedPathFallback: false }),
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
  const runHybridQueryWithEvidenceTable = vi.fn().mockResolvedValue([]);
  return {
    runHybridQueryWithEvidenceTable,
    runHybridQueryWithEvidenceTableAndEntityTrace: vi.fn(async (input: any) => ({
      hits: await runHybridQueryWithEvidenceTable(input),
      entityMatches: [],
      legRanks: {},
    })),
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
  runConsolidationForScope: vi.fn().mockResolvedValue({
    deduped: 0,
    archived: 0,
    backlogReplayed: 0,
    decayPruned: 0,
    promoted: 0,
    status: "completed",
  }),
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
  isStatusClassIntent: (label: string) => label === "current_status" || label === "session_opener",
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
  queryLearnedStatusNoiseIds: vi.fn().mockResolvedValue([]),
  getRetrievalFootprintFromTrace: vi.fn().mockResolvedValue(null),
  getRetrievalTrace: vi.fn().mockResolvedValue(null),
  listRetrievalTraces: vi.fn().mockResolvedValue([]),
  patchRetrievalTraceAnswer: vi.fn().mockResolvedValue(undefined),
  patchRetrievalTraceRating: vi.fn().mockResolvedValue(undefined),
  TRACE_RATINGS: ["helped", "hurt", "unused", "missing", "stale"],
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
// Import mocked modules to access mock fns in assertions
// ---------------------------------------------------------------------------
import { runHybridQueryWithEvidenceTable } from "../recall/query/memory-query.js";
import { extractMemories } from "../capture/extraction/capture.js";
import { getRetrievalTrace } from "../storage/surreal/phase2-store.js";
import { clearActiveHexisCacheForTest } from "../hexis/active-hexis-cache.js";
import { createApp } from "../../index.js";

function getApp() {
  return createApp();
}

// Each endpoint is exercised with the two malformed-body classes. The asserted
// degrade responses are the handlers' EXISTING missing-field paths for an
// empty body {} — no new error shapes:
//   /hooks/recall   → 200 { skipped: true, reason: "adaptive" }   (empty prompt)
//   /hooks/feedback → 400 { error: "retrievalTraceId and answer are required" }
//   /hooks/capture  → 200 { skipped: true, reason: "no messages" }
const MALFORMED_BODIES: Array<{ label: string; raw: string }> = [
  { label: "syntactically invalid JSON ('{{{')", raw: "{{{" },
  { label: "the JSON literal null", raw: "null" },
];

describe("/hooks/recall, /hooks/feedback, /hooks/capture malformed-body resilience (must never 500)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveHexisCacheForTest();
    (runHybridQueryWithEvidenceTable as any).mockResolvedValue([]);
    (extractMemories as any).mockResolvedValue([]);
    (getRetrievalTrace as any).mockResolvedValue(null);
  });

  for (const { label, raw } of MALFORMED_BODIES) {
    it(`/hooks/recall degrades to the adaptive skip on ${label}`, async () => {
      const app = getApp();
      const res = await app.request("/hooks/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: true, reason: "adaptive" });
      // The degrade path must short-circuit before retrieval runs.
      expect(runHybridQueryWithEvidenceTable).not.toHaveBeenCalled();
    });

    it(`/hooks/feedback degrades to the existing missing-field 400 on ${label}`, async () => {
      const app = getApp();
      const res = await app.request("/hooks/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "retrievalTraceId and answer are required" });
      // The degrade path must short-circuit before any trace lookup.
      expect(getRetrievalTrace).not.toHaveBeenCalled();
    });

    it(`/hooks/capture degrades to the "no messages" skip on ${label}`, async () => {
      const app = getApp();
      const res = await app.request("/hooks/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: true, reason: "no messages" });
      // The degrade path must short-circuit before extraction runs.
      expect(extractMemories).not.toHaveBeenCalled();
    });
  }
});
