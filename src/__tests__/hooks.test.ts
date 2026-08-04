import { describe, it, expect, vi, beforeEach } from "vitest";

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
      entityMatches: [
        {
          queryMention: "SurrealDB",
          normalizedMention: "surrealdb",
          entityId: "surrealdb_concept_user",
          canonicalName: "SurrealDB",
          matchedBy: "name",
          linkedMemoryIds: ["memory-surrealdb"],
          scoreChanges: [{ memoryId: "memory-surrealdb", before: 0, boost: 0.9, after: 0.9 }],
        },
      ],
      legRanks: { "memory-surrealdb": { vector: 1, bm25: 2, rrf: 1 } },
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
  runStalenessCoreNoLock: vi.fn().mockResolvedValue({ checked: 0, superseded: 0 }),
}));

vi.mock("../storage/surreal/session-turn-store.js", () => ({
  ensureSessionTurnSchema: vi.fn().mockResolvedValue(undefined),
  recordSessionTurns: vi.fn().mockResolvedValue(undefined),
  listSessionTurnsSince: vi.fn().mockResolvedValue([]),
  deleteExpiredSessionTurns: vi.fn().mockResolvedValue(0),
  resolveTurnRetentionDays: vi.fn().mockReturnValue(30),
}));

vi.mock("../capture/enrichment/memory-enricher.js", () => ({
  runSessionEnrichment: vi.fn().mockResolvedValue(undefined),
  runEnrichment: vi.fn().mockResolvedValue({ processed: 0 }),
  fetchUnenrichedMemories: vi.fn().mockResolvedValue([]),
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
  patchRetrievalTraceCaptureReceipt: vi.fn().mockResolvedValue(undefined),
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
import { runHybridQueryWithEvidenceTable, runHybridQueryWithEvidenceTableAndEntityTrace } from "../recall/query/memory-query.js";
import { EMPTY_PROFILE } from "../recall/policy/ranking-profile.js";
import { arbitrateWrite } from "../storage/writes/write-arbitrator.js";
import { extractMemories, segmentAndSummarize } from "../capture/extraction/capture.js";
import { getLastWatermark, createWatermark, compareAndSwapProjectState, getProjectState, upsertProjectState, getProjectStateForRecall, listContinuityMemoryHits, hydrateLatestStateRepresentativeHits } from "../storage/surreal/surreal-store.js";
import { findEntityByName, getEntityNeighbors, getSupportingMemoryIds } from "../entities/entity-store.js";
import { arbitrateEntity } from "../entities/entity-arbitrator.js";
import { analyzeIntent } from "../recall/intent/intent-analyzer.js";
import { extractEntities } from "../entities/entity-extractor.js";
import { resolveEmbeddingProvider } from "../shared/config.js";
import { runConsolidationForScope } from "../lifecycle/semion/consolidation.js";
import { recordSessionTurns } from "../storage/surreal/session-turn-store.js";
import { runSessionEnrichment } from "../capture/enrichment/memory-enricher.js";
import { runStalenessPass } from "../lifecycle/semion/staleness-pass.js";
import { scoreSessionSalience } from "../capture/continuity/session-salience.js";
import { createRetrievalTrace, getRetrievalTrace, getPrimaryMemoryRowsByIds, initializeSemioteSemiosis, listRetrievalTraces, markSemiotesFoldedIntoProjectState, patchRetrievalTraceAnswer, patchRetrievalTraceRating, patchSemioteProvenance, patchSemioteUsefulness, promoteSemioteToNoema, upsertHexis } from "../storage/surreal/phase2-store.js";
import { clearActiveHexisCacheForTest } from "../hexis/active-hexis-cache.js";
import * as runtimeModule from "../app/runtime.js";
import { createApp } from "../../index.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function getApp() {
  return createApp();
}

function installRunirSessionPersistenceMock() {
  const rows = new Map<string, any>();
  (runtimeModule.runtime.db.query as any).mockImplementation(async (sql: string, vars?: Record<string, any>) => {
    if (sql.includes("FROM runir_session") && sql.includes("WHERE id = type::record('runir_session', $id)")) {
      const row = rows.get(vars?.id);
      return [[row].filter(Boolean)];
    }
    if (sql.includes("UPSERT type::record('runir_session', $id) CONTENT")) {
      rows.set(vars?.id, {
        id: vars?.id,
        user_id: vars?.userId,
        project_key: vars?.projectKey ?? null,
        project_identity_source: vars?.projectIdentitySource ?? null,
        client_kind: vars?.clientKind ?? null,
        native_session_id: vars?.nativeSessionId ?? null,
        native_session_key: vars?.nativeSessionKey ?? null,
        native_session_aliases: vars?.nativeSessionAliases ?? [],
        workspace_path: vars?.workspacePath ?? null,
        workspace_fingerprint: vars?.workspaceFingerprint ?? null,
        host_id: vars?.hostId ?? null,
        device_label: vars?.deviceLabel ?? null,
        status: vars?.status,
        opened_at: vars?.openedAt,
        last_seen_at: vars?.lastSeenAt,
        closed_at: vars?.closedAt ?? null,
        close_reason: vars?.closeReason ?? null,
        resolver_key: vars?.resolverKey,
      });
      return [[]];
    }
    if (sql.includes("UPDATE type::record('runir_session', $id)")) {
      const prev = rows.get(vars?.id) ?? {
        id: vars?.id,
        native_session_aliases: [],
      };
      rows.set(vars?.id, {
        ...prev,
        status: vars?.status ?? prev.status,
        last_seen_at: vars?.lastSeenAt ?? prev.last_seen_at,
        closed_at: vars?.closedAt ?? null,
        close_reason: vars?.closeReason ?? null,
        native_session_aliases: vars?.nativeSessionAliases ?? prev.native_session_aliases ?? [],
        native_session_id: vars?.nativeSessionId ?? prev.native_session_id ?? null,
        native_session_key: vars?.nativeSessionKey ?? prev.native_session_key ?? null,
        workspace_path: vars?.workspacePath ?? prev.workspace_path ?? null,
        workspace_fingerprint: vars?.workspaceFingerprint ?? prev.workspace_fingerprint ?? null,
        host_id: vars?.hostId ?? prev.host_id ?? null,
        device_label: vars?.deviceLabel ?? prev.device_label ?? null,
      });
      return [[]];
    }
    return [[]];
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("hook endpoints – userId resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveHexisCacheForTest();
    // Reset mocks to defaults
    (runHybridQueryWithEvidenceTable as any).mockResolvedValue([]);
    (extractMemories as any).mockResolvedValue([]);
    (segmentAndSummarize as any).mockResolvedValue({ topics: [] });
    (getLastWatermark as any).mockResolvedValue(null);
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m1" });
    (extractEntities as any).mockResolvedValue([]);
    (runConsolidationForScope as any).mockResolvedValue({
      deduped: 0,
      archived: 0,
      backlogReplayed: 0,
      decayPruned: 0,
      promoted: 0,
      status: "completed",
    });
    (getRetrievalTrace as any).mockResolvedValue(null);
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([]);
    (promoteSemioteToNoema as any).mockResolvedValue({ promoted: false, id: null });
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  // Test 5
  it("/hooks/recall passes explicit body.userId to runHybridQueryWithEvidenceTable", async () => {
    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test query for recall", userId: "agent-hermes", hexisDebug: true }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalledWith(expect.objectContaining({
      userId: "agent-hermes",
      evidenceTable: "semiote",
    }));
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalledTimes(1);
    expect((runHybridQueryWithEvidenceTable as any).mock.calls[0][0].userId).toBe("agent-hermes");
    const overlayArg = (runHybridQueryWithEvidenceTable as any).mock.calls[0][0].overlay;
    expect(overlayArg).toEqual(expect.objectContaining({
      registry: expect.objectContaining({
        forUser: expect.any(Function),
      }),
    }));
    const json = await res.json();
    expect(json._debug.rywDiagnostic).toEqual(expect.objectContaining({
      routeOverlayWired: true,
      overlaySnapshotCount: 0,
      rawCandidateCount: 0,
      emptyReason: "no_overlay_entries_or_durable_candidates",
    }));
  });

  it("/memory/search passes explicit semiote evidence table to hybrid retrieval", async () => {
    const app = getApp();
    const res = await app.request("/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test query for memory search", userId: "agent-hermes" }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalledWith(expect.objectContaining({
      userId: "agent-hermes",
      query: "test query for memory search",
      evidenceTable: "semiote",
    }));
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalledTimes(1);
  });

  it("/memory/search returns gated debug trace with separate entity matches", async () => {
    process.env.RUNIR_DEBUG = "1";
    const app = getApp();
    const res = await app.request("/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SurrealDB", userId: "agent-hermes", debug: true, sessionId: "sess-1" }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTableAndEntityTrace).toHaveBeenCalledWith(expect.objectContaining({
      userId: "agent-hermes",
      query: "SurrealDB",
      evidenceTable: "semiote",
      // Rúnir-mmg2: the /memory/search route now resolves the per-tenant ranking
      // profile into tuning. With no RUNIR_RANKING_PROFILES configured this is the
      // clean EMPTY_PROFILE (an unknown tenant gets clean defaults).
      tuning: { entityLookupSessionId: "sess-1", rankingProfile: EMPTY_PROFILE },
    }));
    const json = await res.json();
    expect(json.debug.trace).toMatchObject({ query: "SurrealDB", mode: "hybrid" });
    expect(json.debug.trace).not.toHaveProperty("entityMatches");
    expect(json.debug.entityMatches).toEqual([
      expect.objectContaining({
        canonicalName: "SurrealDB",
        linkedMemoryIds: ["memory-surrealdb"],
      }),
    ]);
    // Layer-2 legRanks sidecar: present in debug, and (like entityMatches) NOT inside debug.trace.
    expect(json.debug.trace).not.toHaveProperty("legRanks");
    expect(json.debug.legRanks).toEqual({ "memory-surrealdb": { vector: 1, bm25: 2, rrf: 1 } });
    delete process.env.RUNIR_DEBUG;
  });

  it("/hooks/maintenance runs semiote maintenance instead of returning 501", async () => {
    process.env.MAINTENANCE_SECRET = "test-secret";
    const app = getApp();
    const res = await app.request("/hooks/maintenance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ userId: "u-maint", scope: "user" }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.table).toBe("semiote");
    expect(runConsolidationForScope).toHaveBeenCalledWith(
      expect.anything(),
      "u-maint",
      "user",
      expect.any(Function),
      expect.any(Map),
      "test-api-key",
      console.warn,
    );
    delete process.env.MAINTENANCE_SECRET;
  });

  it("/hooks/feedback promotes eligible semiote rows into noema", async () => {
    (getRetrievalTrace as any).mockResolvedValue({
      id: "trace-1",
      userId: "u-feedback",
      sessionId: "sess-a",
      prompt: "status",
      intentLabel: "current_status",
      retrievalPath: "hybrid",
      accessTrackedIds: ["semiote:mem-1"],
      items: [{ id: "semiote:mem-1", score: 0.91 }],
      createdAt: "2026-04-13T10:00:00.000Z",
    });
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([{
      id: "semiote:mem-1",
      payload: { l2: "The capture hook writes semiote records directly.", confidence: 0.9 },
      usefulness_alpha: 4,
      usefulness_beta: 1,
      usefulness_score: 0.8,
      retrieved_count: 3,
      used_count: 3,
      successful_use_count: 3,
      cross_session_use_count: 2,
      contradiction_count: 0,
    }]);
    (promoteSemioteToNoema as any).mockResolvedValue({ promoted: true, id: "noema:abc123" });

    const app = getApp();
    const res = await app.request("/hooks/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "u-feedback",
        retrievalTraceId: "trace-1",
        answer: "Yes, the capture hook writes semiote records directly.",
        sessionId: "sess-b",
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.promoted).toBe(1);
    expect(json.promotedIds).toEqual(["noema:abc123"]);
    expect(promoteSemioteToNoema).toHaveBeenCalledTimes(1);
    // the model answer is now persisted onto the trace (recall receipt), not discarded
    expect(patchRetrievalTraceAnswer).toHaveBeenCalledWith(
      expect.anything(),
      "trace-1",
      "u-feedback",
      expect.objectContaining({ answer: "Yes, the capture hook writes semiote records directly." }),
    );
  });

  it("GET /hooks/traces requires an explicit userId (400 when omitted)", async () => {
    const app = getApp();
    const res = await app.request("/hooks/traces");
    expect(res.status).toBe(400);
    expect(listRetrievalTraces).not.toHaveBeenCalled();
  });

  it("GET /hooks/traces lists the user's traces with the limit clamped to 200", async () => {
    (listRetrievalTraces as any).mockResolvedValue([
      { id: "trace-2", prompt: "second", createdAt: "2026-06-01T09:00:00.000Z" },
      { id: "trace-1", prompt: "first", createdAt: "2026-06-01T08:00:00.000Z" },
    ]);
    const app = getApp();
    const res = await app.request("/hooks/traces?userId=u-traces&limit=99999");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.traces).toHaveLength(2);
    expect(listRetrievalTraces).toHaveBeenCalledWith(expect.anything(), "u-traces", 200);
  });

  it("GET /hooks/traces defaults the limit to 20 when absent", async () => {
    (listRetrievalTraces as any).mockResolvedValue([]);
    const app = getApp();
    const res = await app.request("/hooks/traces?userId=u-traces");
    expect(res.status).toBe(200);
    expect(listRetrievalTraces).toHaveBeenCalledWith(expect.anything(), "u-traces", 20);
  });

  it("GET /hooks/traces/:id requires userId, validates the id, and 404s when absent", async () => {
    const app = getApp();
    expect((await app.request("/hooks/traces/trace-1")).status).toBe(400);
    expect((await app.request("/hooks/traces/bad%20id!?userId=u-traces")).status).toBe(400);
    (getRetrievalTrace as any).mockResolvedValueOnce(null);
    expect((await app.request("/hooks/traces/trace-x?userId=u-traces")).status).toBe(404);
  });

  it("GET /hooks/traces/:id returns the full trace (incl. prependContext + answer) for the owner", async () => {
    (getRetrievalTrace as any).mockResolvedValue({
      id: "trace-1",
      userId: "u-traces",
      prompt: "status?",
      prependContext: "## Recall\n- a fact",
      answer: "Yes.",
      items: [{ id: "semiote:m1", score: 0.9 }],
      createdAt: "2026-06-01T08:00:00.000Z",
    });
    const app = getApp();
    const res = await app.request("/hooks/traces/trace-1?userId=u-traces");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.trace).toMatchObject({
      id: "trace-1",
      prependContext: "## Recall\n- a fact",
      answer: "Yes.",
    });
  });

  it("POST /hooks/traces/:id/rate requires an explicit userId (400 when omitted)", async () => {
    const app = getApp();
    const res = await app.request("/hooks/traces/trace-1/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: "helped" }),
    });
    expect(res.status).toBe(400);
    expect(patchRetrievalTraceRating).not.toHaveBeenCalled();
  });

  it("POST /hooks/traces/:id/rate rejects a rating outside the closed vocabulary", async () => {
    const app = getApp();
    const res = await app.request("/hooks/traces/trace-1/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-rate", rating: "amazing" }),
    });
    expect(res.status).toBe(400);
    expect(patchRetrievalTraceRating).not.toHaveBeenCalled();
  });

  it("POST /hooks/traces/:id/rate validates the traceId format", async () => {
    const app = getApp();
    const res = await app.request("/hooks/traces/bad%20id!/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-rate", rating: "helped" }),
    });
    expect(res.status).toBe(400);
    expect(patchRetrievalTraceRating).not.toHaveBeenCalled();
  });

  it("POST /hooks/traces/:id/rate 404s when the trace is absent (or owned by another user)", async () => {
    // getRetrievalTrace is user-scoped (WHERE user_id = $userId), so a trace that exists
    // but belongs to someone else resolves to null here exactly like a missing one — both
    // become a 404 and neither writes a rating. Assert the read gate received the resolved
    // owner uid so a cross-user read regression is caught, not just the null return.
    (getRetrievalTrace as any).mockResolvedValueOnce(null);
    const app = getApp();
    const res = await app.request("/hooks/traces/trace-missing/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-rate", rating: "helped" }),
    });
    expect(res.status).toBe(404);
    expect(getRetrievalTrace).toHaveBeenCalledWith(expect.anything(), "trace-missing", "u-rate");
    expect(patchRetrievalTraceRating).not.toHaveBeenCalled();
  });

  it("POST /hooks/traces/:id/rate records the label WITHOUT touching the usefulness loop", async () => {
    (getRetrievalTrace as any).mockResolvedValue({
      id: "trace-1",
      userId: "u-rate",
      prompt: "status?",
      items: [{ id: "semiote:m1", score: 0.9 }],
      createdAt: "2026-06-01T08:00:00.000Z",
    });
    const app = getApp();
    const res = await app.request("/hooks/traces/trace-1/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-rate", rating: "helped", note: "nailed it" }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, id: "trace-1", rating: "helped", rated: true });
    // the READ gate must be scoped to the resolved owner uid (user-scoped WHERE lives in
    // getRetrievalTrace) — a regression that fed it the wrong uid would leak/rate another
    // user's trace while still compiling, so assert the uid is propagated, not just present.
    expect(getRetrievalTrace).toHaveBeenCalledWith(expect.anything(), "trace-1", "u-rate");
    expect(patchRetrievalTraceRating).toHaveBeenCalledWith(
      expect.anything(),
      "trace-1",
      "u-rate",
      { rating: "helped", note: "nailed it" },
    );
    // SEPARATION from /hooks/feedback: rating must never reinforce per-memory usefulness
    expect(patchSemioteUsefulness).not.toHaveBeenCalled();
    expect(promoteSemioteToNoema).not.toHaveBeenCalled();
    expect(patchRetrievalTraceAnswer).not.toHaveBeenCalled();
  });

  it("POST /hooks/traces/:id/rate coalesces a blank note to undefined", async () => {
    (getRetrievalTrace as any).mockResolvedValue({ id: "trace-1", userId: "u-rate", items: [] });
    const app = getApp();
    const res = await app.request("/hooks/traces/trace-1/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-rate", rating: "unused", note: "   " }),
    });
    expect(res.status).toBe(200);
    expect(patchRetrievalTraceRating).toHaveBeenCalledWith(
      expect.anything(),
      "trace-1",
      "u-rate",
      { rating: "unused", note: undefined },
    );
  });

  it("/hooks/recall persists Hexis metadata when a Hexis hint is supplied", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([
      { id: "semiote:mem-1", text: "The capture hook writes semiote records directly.", score: 0.8, memoryRole: "current_status" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "u-hexis",
        prompt: "What writes semiote records directly?",
        hexis: {
          scope: "project",
          label: "semiote direct-write frame",
          goals: ["capture hook"],
          topicBias: { semiote: 1 },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(createRetrievalTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hexisId: expect.any(String),
        hexisVersion: 1,
        hexisLabel: "semiote direct-write frame",
        retrievalAudit: expect.objectContaining({
          recipe: expect.objectContaining({
            id: "general_recall",
            version: "phase-a-v1",
            relationExpansionEnabled: false,
            latestStateShaping: "off",
          }),
          hexis: expect.objectContaining({
            enabled: true,
          }),
        }),
      }),
    );
  });

  it("/hooks/recall supports an explicit Hexis-off baseline even when a Hexis hint is supplied", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([
      { id: "semiote:mem-1", text: "The capture hook writes semiote records directly.", score: 0.8, memoryRole: "current_status" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "u-hexis-off",
        prompt: "What writes semiote records directly?",
        disableHexis: true,
        hexis: {
          scope: "project",
          label: "semiote direct-write frame",
          goals: ["capture hook"],
          topicBias: { semiote: 1 },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(createRetrievalTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        hexisId: expect.anything(),
      }),
    );
  });

  it("/hooks/recall routes latest_state intent through lineage-aware representative resolution", async () => {
    (analyzeIntent as any).mockReturnValueOnce({ categories: ["entities"], depth: "l1", confidence: 0.9, label: "latest_state" });
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([
      { id: "semiote:stale-1", text: "Old status", score: 0.92, continuitySubjectKey: "subject:alpha", active: false, updatedAt: "2026-04-10T00:00:00Z" },
    ]);
    (hydrateLatestStateRepresentativeHits as any).mockResolvedValueOnce([
      { id: "semiote:active-1", text: "Current active status", score: 0.2, continuitySubjectKey: "subject:alpha", active: true, validAt: "2026-04-12T00:00:00Z" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "u-latest-state",
        prompt: "what is the latest state of alpha?",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prependContext).toBe("injected-rendered");
    expect(createRetrievalTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        laneLabel: "latest_state",
        retrievalPath: "latest_state",
        items: [
          expect.objectContaining({ id: "semiote:active-1" }),
        ],
        retrievalAudit: expect.objectContaining({
          lane: "latest_state",
          recipe: expect.objectContaining({
            id: "status_current",
            latestStateShaping: "latest_state_lane",
            relationExpansionEnabled: false,
          }),
          latestState: expect.objectContaining({
            representativeIds: expect.arrayContaining(["semiote:active-1"]),
          }),
        }),
      }),
    );
  });

  it("/hooks/recall exposes same-pool Hexis debug comparison data", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([
      { id: "semiote:mem-1", text: "Capture hook writes semiote records directly.", score: 0.75, memoryRole: "current_status" },
      { id: "semiote:mem-2", text: "Generic unrelated note.", score: 0.7, memoryRole: "operational_noise" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "u-hexis-debug",
        prompt: "What writes semiote records directly?",
        hexisDebug: true,
        hexis: {
          scope: "project",
          label: "semiote direct-write frame",
          goals: ["capture hook"],
          topicBias: { semiote: 1 },
        },
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json._debug?.hexisComparison).toMatchObject({
      resolutionSource: "explicit",
      applied: true,
      candidatePool: expect.any(Array),
      withoutHexis: { selected: expect.any(Array), count: expect.any(Number) },
      withHexis: { selected: expect.any(Array), count: expect.any(Number) },
      reorderWindow: {
        candidatePoolSize: 2,
        admissibleIds: ["semiote:mem-1", "semiote:mem-2"],
      },
    });
    expect(json._debug.hexisComparison.rankDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "semiote:mem-1",
          baselineRank: expect.anything(),
          finalRank: expect.anything(),
          scoreDelta: expect.any(Number),
        }),
      ]),
    );
  });

  it("/hooks/recall falls back to derived scope when an explicit Hexis id is invalid and carries no other signal", async () => {
    (runHybridQueryWithEvidenceTable as any).mockResolvedValueOnce([
      { id: "semiote:mem-1", text: "The capture hook writes semiote records directly.", score: 0.8, memoryRole: "current_status" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "u-hexis-fallback",
        prompt: "What writes semiote records directly?",
        hexisDebug: true,
        hexis: { id: "missing-hexis-id" },
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json._debug?.hexisComparison).toMatchObject({
      resolutionSource: "agent",
      applied: false,
      resolvedHexisId: null,
    });
    expect("sessionOpener" in json).toBe(false);
  });

  it("/hooks/recall caches id-only Hexis resolution but bypasses for hint-rich follow-ups", async () => {
    const resolveSpy = vi.spyOn(runtimeModule, "resolveActiveHexis");
    (runHybridQueryWithEvidenceTable as any).mockResolvedValue([
      { id: "semiote:mem-1", text: "The capture hook writes semiote records directly.", score: 0.8, memoryRole: "current_status" },
    ]);

    const app = getApp();
    const baseBody = {
      userId: "u-hexis-cache",
      prompt: "What writes semiote records directly?",
      hexis: { id: "frame-1" },
    };

    const first = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const second = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const third = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        hexis: { id: "frame-1", label: "manual frame", goals: ["capture hook"] },
      }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("/hooks/recall does not persist rich Hexis hints and can cache repeated rich-hint lookups", async () => {
    const resolveSpy = vi.spyOn(runtimeModule, "resolveActiveHexis");
    (runHybridQueryWithEvidenceTable as any).mockResolvedValue([
      { id: "semiote:mem-1", text: "The capture hook writes semiote records directly.", score: 0.8, memoryRole: "current_status" },
    ]);

    const app = getApp();
    const richBody = {
      userId: "u-hexis-rich-cache",
      prompt: "What writes semiote records directly?",
      hexis: {
        id: "frame-rich",
        label: "manual frame",
        goals: ["capture hook"],
        topicBias: { semiote: 1 },
      },
    };

    const first = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(richBody),
    });
    const second = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(richBody),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(upsertHexis).not.toHaveBeenCalled();
  });

  // Test 6
  it("/hooks/recall falls back to cfg.userId when no body.userId", async () => {
    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test query for recall" }),
    });

    expect(res.status).toBe(200);
    expect(runHybridQueryWithEvidenceTable).toHaveBeenCalledTimes(1);
    expect((runHybridQueryWithEvidenceTable as any).mock.calls[0][0].userId).toBe("default-user");
  });

  // Test 7
  it("/hooks/capture passes explicit body.userId to writeWithArbitration", async () => {
    (extractMemories as any).mockResolvedValue([
      { l2: "test fact that is long enough to pass the filter", confidence: 0.9, l0: "test fact", l1: "- test fact", category: "cases", tier: "working", tags: [], factKey: "cases:test" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello world this is a test message" }],
        userId: "agent-hermes",
      }),
    });

    expect(res.status).toBe(200);
    // writeWithArbitration calls arbitrateWrite internally with userId
    expect(arbitrateWrite).toHaveBeenCalled();
    expect((arbitrateWrite as any).mock.calls[0][0].userId).toBe("agent-hermes");
    expect((arbitrateWrite as any).mock.calls[0][0].overlay).toEqual(expect.objectContaining({
      registry: expect.objectContaining({
        forUser: expect.any(Function),
      }),
      ttlMs: expect.any(Number),
    }));
  });

  it("/hooks/capture does not block the response on entity linking in normal mode", async () => {
    (extractMemories as any).mockResolvedValue([
      { l2: "test fact that is long enough to pass the filter", confidence: 0.9, l0: "test fact", l1: "- test fact", category: "cases", tier: "working", tags: [], factKey: "cases:test" },
    ]);
    let resolveEntities!: (value: any[]) => void;
    const entityPromise = new Promise<any[]>((resolve) => {
      resolveEntities = resolve;
    });
    (extractEntities as any).mockReturnValueOnce(entityPromise);

    const app = getApp();
    const responsePromise = Promise.resolve(app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello world this is a test message" }],
        userId: "agent-hermes",
      }),
    }));

    const race = await Promise.race([
      responsePromise.then((res) => ({ kind: "resolved" as const, res })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 50)),
    ]);

    if (race.kind === "timeout") {
      resolveEntities([]);
      await responsePromise;
    }
    expect(race.kind).toBe("resolved");
    if (race.kind !== "resolved") return;

    expect(race.res.status).toBe(200);
    const json = await race.res.json();
    expect(json.factsFound).toBe(1);
    expect(json).not.toHaveProperty("_debug");

    resolveEntities([
      { name: "test fact", kind: "concept", confidence: 0.9, context: "test fact that is long enough to pass the filter" },
    ]);
    await vi.waitFor(() => expect(arbitrateEntity).toHaveBeenCalled());
  });

  it("/hooks/capture includes nested phase timings in capture timing debug mode", async () => {
    (extractMemories as any).mockImplementation(async (_messages: any, _prompt: any, _apiKey: any, _timestamp: any, _onReject: any, opts: any) => {
      opts?.onTiming?.("prepare_request", 1);
      opts?.onTiming?.("llm_fetch_headers", 2);
      opts?.onTiming?.("llm_read_json", 3);
      opts?.onTiming?.("parse_model_json", 4);
      return [];
    });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello world this is a test message" }],
        userId: "agent-hermes",
        captureTimingDebug: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.factsFound).toBe(0);
    expect(json._debug?.timings).toEqual(expect.objectContaining({
      totalMs: expect.any(Number),
      phases: expect.any(Array),
    }));
    expect(json._debug.timings.phases.map((phase: any) => phase.name)).toContain("extract_memories");
    expect(json._debug.timings.nested?.extract_memories?.map((phase: any) => phase.name)).toEqual(
      expect.arrayContaining(["prepare_request", "llm_fetch_headers", "llm_read_json", "parse_model_json"]),
    );
    expect(json._debug.timings.nested?.build_capture_context?.map((phase: any) => phase.name)).toEqual(
      expect.arrayContaining(["recent_facts", "nearby_existing", "project_state"]),
    );
    expect(json._debug.timings.longest).toEqual(expect.objectContaining({
      name: expect.any(String),
      durationMs: expect.any(Number),
    }));
  });

  // Test 8
  it("/hooks/session-end propagates explicit body.userId to the watermark + raw-turn calls", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s1",
      }),
    });

    expect(res.status).toBe(200);

    // getLastWatermark(db, sessionKey, uid)
    expect(getLastWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "agent-hermes");

    // recordSessionTurns(db, { userId, sessionId, ... })
    expect(recordSessionTurns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "agent-hermes", sessionId: "s1" }),
      expect.any(Function),
    );

    // createWatermark(db, sessionKey, uid, totalMessageCount)
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "agent-hermes", expect.any(Number));

    // Extraction is turn-based-only (Rúnir-y5on/Rúnir-sq3s): session-end
    // writes no facts and links no entities.
    expect(arbitrateWrite).not.toHaveBeenCalled();
    expect(arbitrateEntity).not.toHaveBeenCalled();
  });

  // Test 9
  it("/hooks/session-end falls back to cfg.userId for the watermark + raw-turn calls", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        sessionId: "s1",
      }),
    });

    expect(res.status).toBe(200);

    expect(getLastWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "default-user");

    expect(recordSessionTurns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "default-user", sessionId: "s1" }),
      expect.any(Function),
    );

    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s1", "default-user", expect.any(Number));

    expect(arbitrateWrite).not.toHaveBeenCalled();
    expect(arbitrateEntity).not.toHaveBeenCalled();
  });
});

describe("/hooks/session-end resilience (must never 500)", () => {
  // The Pi client records ANY non-2xx response as an error trace, so a 500
  // here pollutes the inspector's error count even though session-end is a
  // best-effort, fail-open continuity flush. These two regressions pin the
  // two failure classes that used to surface as 500s (Rúnir capture-timing
  // redesign 2026-06-13): a malformed request body, and an unhandled throw
  // anywhere in the pipeline.
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveHexisCacheForTest();
    (extractMemories as any).mockResolvedValue([]);
    (segmentAndSummarize as any).mockResolvedValue({ topics: [] });
    (getLastWatermark as any).mockResolvedValue(null);
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m1" });
    (extractEntities as any).mockResolvedValue([]);
  });

  it("returns a 200 skip (not a 500) when the request body is not valid JSON", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not valid json",
    });
    // Malformed body degrades to {} via the .catch(() => ({})) guard → the
    // "no messages" skip — never an unhandled c.req.json() throw → 500.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "no messages" });
  });

  it("returns a 200 skip (not a 500) when the body is the JSON literal null", async () => {
    // c.req.json() RESOLVES `null` (does not throw), so .catch() never fires;
    // the object coercion must stop `null.messages` from 500ing before the try.
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "no messages" });
  });

  it("degrades to a 200 skip with reason 'pipeline_error' when an internal call throws", async () => {
    // Force a throw inside the handler's try (getLastWatermark is the first
    // awaited store call after session setup). The outer catch must fail open.
    (getLastWatermark as any).mockRejectedValueOnce(new Error("boom: surreal unreachable"));
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "a question that is long enough to count" },
          { role: "assistant", content: "an answer that is long enough to count" },
        ],
        userId: "agent-resilience",
        sessionId: "s-resilience",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true, reason: "pipeline_error" });
    // The watermark must NOT advance on a failed flush so the tail is
    // reprocessed next time (fail-open, no data loss).
    expect(createWatermark).not.toHaveBeenCalled();
  });
});

describe("/memory/store continuity metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m1" });
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  it("persists derived continuity role, validity, and active task ids for current status writes", async () => {
    const app = getApp();
    const res = await app.request("/memory/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        sessionId: "native-store-1",
        text: "Current status: working on MIM-123 and Rúnir-peyp; next step is finishing recall tests.",
        metadata: {
          blockers: ["waiting on reranker verification"],
          nextSteps: ["finish recall tests"],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(arbitrateWrite).toHaveBeenCalledTimes(1);
    const writeParams = (arbitrateWrite as any).mock.calls[0][0];
    expect(writeParams.userId).toBe("agent-hermes");
    expect(writeParams.metadata.memoryRole).toBe("current_status");
    expect(writeParams.metadata.validAt).toEqual(expect.any(String));
    expect(writeParams.metadata.invalidAt).toBeUndefined();
    expect(writeParams.metadata.activeTaskIds).toEqual(["MIM-123", "Rúnir-peyp"]);
    expect(writeParams.metadata.summary).toContain("Current status:");
    expect(writeParams.metadata.blockers).toEqual(["waiting on reranker verification"]);
    expect(writeParams.metadata.nextSteps).toEqual(["finish recall tests"]);
    expect(patchSemioteProvenance).toHaveBeenCalledWith(expect.anything(), "m1", expect.objectContaining({
      runirSessionId: expect.stringMatching(/^runir_session_[a-f0-9]{24}$/),
      nativeSessionId: "native-store-1",
    }));
  });

  it("preserves caller-supplied continuity metadata when present", async () => {
    const app = getApp();
    const suppliedValidAt = "2026-04-01T12:00:00.000Z";
    const res = await app.request("/memory/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        text: "Plan milestone: next step is landing the final verification pass for MIM-124.",
        metadata: {
          summary: "State lane verification plan",
          activeTaskIds: ["Rúnir-ixk4"],
          validAt: suppliedValidAt,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(arbitrateWrite).toHaveBeenCalledTimes(1);
    const writeParams = (arbitrateWrite as any).mock.calls[0][0];
    expect(writeParams.metadata.memoryRole).toBe("planning_active");
    expect(writeParams.metadata.summary).toBe("State lane verification plan");
    expect(writeParams.metadata.activeTaskIds).toEqual(["Rúnir-ixk4"]);
    expect(writeParams.metadata.validAt).toBe(suppliedValidAt);
  });

  it("persists rich Hexis hints on /memory/store while threading the resolved frame into the write", async () => {
    const app = getApp();
    const res = await app.request("/memory/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        text: "Current status: persisting a rich Hexis hint through memory/store.",
        hexis: {
          scope: "project",
          label: "store frame",
          goals: ["persist store hint"],
          topicBias: { persist: 1 },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertHexis).toHaveBeenCalledTimes(1);
    expect(initializeSemioteSemiosis).toHaveBeenCalledWith(
      expect.anything(),
      "m1",
      expect.objectContaining({
        hexisId: expect.any(String),
        hexisVersion: expect.any(Number),
        hexisFit: expect.any(Number),
      }),
    );
    expect((upsertHexis as any).mock.calls[0][2]).toMatchObject({
      label: "store frame",
      scope: "project",
    });
  });
});

describe("/memory/graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (findEntityByName as any).mockResolvedValue([
      {
        id: { tb: "entities", id: "ent-123" },
        canonicalName: "SurrealDB",
        userId: "agent-hermes",
      },
    ]);
    (getSupportingMemoryIds as any).mockResolvedValue(["m-1", "m-2"]);
    (getEntityNeighbors as any).mockResolvedValue([]);
  });

  it("accepts Surreal record-object entity ids from findEntityByName", async () => {
    const app = getApp();
    const res = await app.request("/memory/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        name: "SurrealDB",
        includeMemories: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(getSupportingMemoryIds).toHaveBeenCalledWith(expect.anything(), "ent-123");
    const json = await res.json();
    expect(json.memoryIds).toEqual(["m-1", "m-2"]);
  });

  // Rúnir-imaf.5 option C (Rúnir-o75n.5): entity->entity links are never
  // populated (linkEntities has zero production callers), so includeNeighbors
  // must return an EXPLICIT unsupported indicator instead of a silent
  // always-empty neighbors:[] — and must not issue the dead query at all.
  it("includeNeighbors returns explicit-unsupported fields and never calls getEntityNeighbors", async () => {
    const app = getApp();
    const res = await app.request("/memory/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        name: "SurrealDB",
        includeNeighbors: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.neighbors).toEqual([]);
    expect(json.neighborsUnsupported).toBe(true);
    expect(json.neighborsReason).toBe("entity-to-entity links are not populated in this release");
    expect(getEntityNeighbors).not.toHaveBeenCalled();
  });

  it("without includeNeighbors the response shape is unchanged (no unsupported fields, no neighbors key)", async () => {
    const app = getApp();
    const res = await app.request("/memory/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "agent-hermes",
        name: "SurrealDB",
        includeMemories: true,
      }),
    });

    expect(res.status).toBe(200);
    // Byte-identical regression (Codex review MINOR): assert the RAW serialized
    // body, not parsed/sorted keys, so key-order or serialization drift fails.
    // `neighbors` is undefined when not requested and JSON serialization drops
    // it, so the body must match the pre-o75n.5 response exactly.
    expect(await res.text()).toBe(JSON.stringify({
      entity: { id: { tb: "entities", id: "ent-123" }, canonicalName: "SurrealDB", userId: "agent-hermes" },
      memoryIds: ["m-1", "m-2"],
    }));
    expect(getEntityNeighbors).not.toHaveBeenCalled();
  });
});

describe("/hooks/capture continuity enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (extractMemories as any).mockResolvedValue([
      { l2: "Current status: working on MIM-99 rewrite", confidence: 0.9, l0: "status", l1: "- status", category: "events", tier: "working", tags: [], factKey: "events:test" },
    ]);
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m-cap" });
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  it("persists memoryRole and validAt on capture writes", async () => {
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Current status: working on MIM-99 rewrite" }],
        userId: "agent-hermes",
        sessionId: "native-capture-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(arbitrateWrite).toHaveBeenCalled();
    const writeParams = (arbitrateWrite as any).mock.calls[0][0];
    expect(writeParams.metadata.memoryRole).toBeDefined();
    expect(writeParams.metadata.validAt).toEqual(expect.any(String));
    expect(patchSemioteProvenance).toHaveBeenCalledWith(expect.anything(), "m-cap", expect.objectContaining({
      runirSessionId: expect.stringMatching(/^runir_session_[a-f0-9]{24}$/),
      nativeSessionId: "native-capture-1",
    }));
  });

  it("preserves richer existing project_state fields during capture warming", async () => {
    (extractMemories as any).mockResolvedValue([
      { l2: "Working on MIM-101 capture warming fix", confidence: 0.95, l0: "status", l1: "- status", category: "events", tier: "working", tags: [], factKey: "events:warm" },
    ]);
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m-cap" });
    (getProjectState as any).mockResolvedValue({
      id: "ps-1",
      userId: "agent-hermes",
      path: "/Users/brooks/Code/runir",
      currentFocus: "Old focus",
      activeTicketIds: ["MIM-100"],
      latestProgress: "Completed prior task",
      blockers: ["waiting on CI"],
      nextSteps: ["finish recall tests"],
      updatedAt: "2026-04-12T09:00:00Z",
      sourceSessionId: "older-session",
      supportingMemoryIds: ["m-old"],
      confidence: 0.8,
    });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Working on MIM-101 capture warming fix", timestamp: "2026-04-12T10:00:00Z" }],
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
      }),
    });
    expect(res.status).toBe(200);
    const psArgs = (upsertProjectState as any).mock.calls.at(-1);
    expect(psArgs[1].activeTicketIds).toEqual(["MIM-100"]);
    expect(psArgs[1].blockers).toEqual(["waiting on CI"]);
    expect(psArgs[1].nextSteps).toEqual(["finish recall tests"]);
    expect(psArgs[1].supportingMemoryIds).toEqual(["m-old"]);
    expect(psArgs[1].latestProgress).toBe("Completed prior task");
  });

  it("does not warm project_state from stale retried capture slices", async () => {
    (extractMemories as any).mockResolvedValue([
      { l2: "Working on stale capture data", confidence: 0.95, l0: "status", l1: "- status", category: "events", tier: "working", tags: [], factKey: "events:stale" },
    ]);
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m-stale" });
    (getProjectState as any).mockResolvedValue({
      id: "ps-2",
      userId: "agent-hermes",
      path: "/Users/brooks/Code/runir",
      currentFocus: "Newer focus",
      activeTicketIds: [],
      latestProgress: "Newer progress",
      blockers: [],
      nextSteps: [],
      updatedAt: "2026-04-12T12:00:00Z",
      sourceSessionId: "newer-session",
      supportingMemoryIds: [],
      confidence: 0.9,
    });

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Working on stale capture data", timestamp: "2026-04-12T10:00:00Z" }],
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
      }),
    });
    expect(res.status).toBe(200);
    expect(upsertProjectState).not.toHaveBeenCalled();
  });

  it("does not warm project_state from multi-turn capture slices", async () => {
    (extractMemories as any).mockResolvedValue([
      { l2: "Working on stale capture data", confidence: 0.95, l0: "status", l1: "- status", category: "events", tier: "working", tags: [], factKey: "events:stale" },
    ]);
    (arbitrateWrite as any).mockResolvedValue({ outcome: "create", memoryId: "m-stale" });
    (getProjectState as any).mockResolvedValue(null);

    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "older turn", timestamp: "2026-04-12T10:00:00Z" },
          { role: "assistant", content: "older answer", timestamp: "2026-04-12T10:00:05Z" },
          { role: "user", content: "newer turn", timestamp: "2026-04-12T12:00:00Z" },
          { role: "assistant", content: "newer answer", timestamp: "2026-04-12T12:00:05Z" },
        ],
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
      }),
    });
    expect(res.status).toBe(200);
    expect(upsertProjectState).not.toHaveBeenCalled();
  });

  it("persists rich Hexis hints on /hooks/capture and threads the frame into capture writes", async () => {
    const app = getApp();
    const res = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Current status: working on capture Hexis persistence." }],
        userId: "agent-hermes",
        hexis: {
          scope: "agent",
          label: "capture frame",
          goals: ["persist capture hint"],
          topicBias: { capture: 1 },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertHexis).toHaveBeenCalledTimes(1);
    expect(initializeSemioteSemiosis).toHaveBeenCalled();
    expect((upsertHexis as any).mock.calls[0][2]).toMatchObject({
      label: "capture frame",
      scope: "agent",
    });
    for (const call of (initializeSemioteSemiosis as any).mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        hexisId: expect.any(String),
        hexisVersion: expect.any(Number),
        hexisFit: expect.any(Number),
      }));
    }
  });
});

describe("/hooks/session-end no-LLM contract (Rúnir-y5on/Rúnir-sq3s)", () => {
  // Session-end is extraction-FREE: watermark + raw-turn recording +
  // runir_session close ONLY. Extraction is turn-based via /hooks/capture;
  // the staleness pass relocated to scheduled maintenance (D1); enrichment
  // was dropped from all automatic paths. These tests pin that contract.
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveHexisCacheForTest();
    (getLastWatermark as any).mockResolvedValue(null);
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  it("records raw turns + advances the watermark and fires NO extraction/LLM seam", async () => {
    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "first user turn" },
          { role: "assistant", content: "first assistant turn" },
        ],
        userId: "agent-hermes",
        sessionId: "s-no-llm",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ skipped: false, rawTurnsRecorded: 2, extraction: "disabled" });
    // The extraction-derived response fields are gone for good.
    expect(json.topicsFound).toBeUndefined();
    expect(json.factsFound).toBeUndefined();
    expect(json.outcomes).toBeUndefined();

    expect(recordSessionTurns).toHaveBeenCalledTimes(1);
    const turnBatch = (recordSessionTurns as any).mock.calls[0][1];
    expect(turnBatch.turns).toEqual([
      { turnIndex: 0, role: "user", content: "first user turn" },
      { turnIndex: 1, role: "assistant", content: "first assistant turn" },
    ]);
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s-no-llm", "agent-hermes", 2);

    // The five removed LLM passes + their write seams must never fire.
    expect(segmentAndSummarize).not.toHaveBeenCalled();
    expect(extractMemories).not.toHaveBeenCalled();
    expect(extractEntities).not.toHaveBeenCalled();
    expect(scoreSessionSalience).not.toHaveBeenCalled();
    expect(runStalenessPass).not.toHaveBeenCalled();
    expect(runSessionEnrichment).not.toHaveBeenCalled();
    expect(arbitrateWrite).not.toHaveBeenCalled();
    expect(arbitrateEntity).not.toHaveBeenCalled();
    // deriveProjectStateSnapshot was DELETED with the removal — its write
    // seams are the observable proof it cannot run.
    expect(compareAndSwapProjectState).not.toHaveBeenCalled();
    expect(markSemiotesFoldedIntoProjectState).not.toHaveBeenCalled();
  });

  it("re-fire with no new messages skips without touching the watermark or raw turns (idempotence)", async () => {
    // Once, not persistent: vi.clearAllMocks() does NOT strip implementations,
    // so a persistent non-null watermark here would bleed into later describes
    // and turn their session-end posts into silent watermark skips.
    (getLastWatermark as any).mockResolvedValueOnce({ message_count: 2 });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "first user turn" },
          { role: "assistant", content: "first assistant turn" },
        ],
        userId: "agent-hermes",
        sessionId: "s-no-llm-refire",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      skipped: true,
      reason: "no new messages since last watermark",
    });
    expect(createWatermark).not.toHaveBeenCalled();
    expect(recordSessionTurns).not.toHaveBeenCalled();
  });

  it("resume records only the new tail at absolute turn indices and advances the watermark", async () => {
    (getLastWatermark as any).mockResolvedValueOnce({ message_count: 3 });

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "m1" },
          { role: "assistant", content: "m2" },
          { role: "user", content: "m3" },
          { role: "assistant", content: "m4" },
          { role: "user", content: "m5" },
        ],
        userId: "agent-hermes",
        sessionId: "s-no-llm-resume",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: false, rawTurnsRecorded: 2, extraction: "disabled" });
    // watermark=3, batchStart=0 → overlap trim 3 → only m4/m5 recorded at
    // ABSOLUTE indices 3 and 4.
    const turnBatch = (recordSessionTurns as any).mock.calls[0][1];
    expect(turnBatch.turns).toEqual([
      { turnIndex: 3, role: "assistant", content: "m4" },
      { turnIndex: 4, role: "user", content: "m5" },
    ]);
    expect(createWatermark).toHaveBeenCalledWith(expect.anything(), "s-no-llm-resume", "agent-hermes", 5);
  });
});

describe("/hooks/recall continuity-before-embedder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolveEmbeddingProvider as any).mockReturnValue({
      embedQuery: vi.fn().mockRejectedValue(new Error("embedder should not be called")),
      embedDocument: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      fingerprint: vi.fn().mockReturnValue("mock-fingerprint"),
    });
  });

  it("returns deterministic continuity results for session_opener intent without calling embedder", async () => {
    (analyzeIntent as any).mockReturnValue({ categories: ["events", "entities"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        currentFocus: "State lane implementation",
        latestProgress: "Completed pass 1 of continuity wiring",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: ["MIM-100"],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: [],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValue([
      { id: "m-noise", text: "scripts/ folder is not in tsconfig.json includes. Use npx tsx for script runs.", score: 0.98, path: "/Users/brooks/Code/runir", tags: [] },
      { id: "m-cont-1", text: "Working on state lane", score: 0.9, memoryRole: "current_status", path: "/Users/brooks/Code/runir", tags: [] },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "let's continue where we left off on the state lane work",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.continuitySource).toBe("deterministic");
    expect(json.sessionOpener).toEqual(expect.objectContaining({
      intent: "continue_previous_work",
      focus: expect.arrayContaining([expect.stringContaining("Working on state lane")]),
      env: [],
    }));
    expect(json.prependContext).toContain("session_opener:");
    expect(runHybridQueryWithEvidenceTable).not.toHaveBeenCalled();
    expect(createRetrievalTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        retrievalPath: "deterministic",
        retrievalAudit: expect.objectContaining({
          recipe: expect.objectContaining({
            id: "status_current",
            latestStateShaping: "deterministic_continuity",
            relationExpansionEnabled: false,
          }),
        }),
      }),
    );
  });

  it("builds session_opener from same-project supporting overlay without pathless cross-project fallback", async () => {
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        projectKey: "project:runir",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Session opener overlay",
        latestProgress: "Project snapshot available",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: ["MIM-100"],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: ["same-1", "other-1"],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pathless-other-project",
          text: "Current status: working on the unrelated docs site.",
          score: 0.99,
          memoryRole: "current_status",
          path: "/Users/brooks/Code/other",
          tags: [],
        },
      ]);
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([
      {
        id: "semiote:same-1",
        payload: {
          l2: "Current status: implementing opener overlay across runir sessions.",
          l0: "Runir opener overlay",
          memoryRole: "current_status",
          path: "/Users/brooks/Code/runir",
          tags: [],
          provenance: { derivation: { projectKey: "project:runir" } },
        },
        updated_at: "2026-04-01T12:05:00.000Z",
      },
      {
        id: "semiote:other-1",
        payload: {
          l2: "Current status: redesigning the unrelated docs site.",
          l0: "Other project",
          memoryRole: "current_status",
          path: "/Users/brooks/Code/other",
          tags: [],
          provenance: { derivation: { projectKey: "project:other" } },
        },
        updated_at: "2026-04-01T12:06:00.000Z",
      },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "let's continue opener work",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(listContinuityMemoryHits).toHaveBeenCalledTimes(1);
    expect(getPrimaryMemoryRowsByIds).toHaveBeenCalledWith(expect.anything(), ["same-1", "other-1"], "semiote");
    expect(JSON.stringify(json.sessionOpener)).toContain("runir sessions");
    expect(JSON.stringify(json.sessionOpener)).not.toContain("unrelated docs site");
    expect(json.sessionOpener.warnings ?? []).not.toContain("path_fallback_used");
  });

  it("reuses same-project opener continuity across different native sessions", async () => {
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        projectKey: "project:runir",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Cross-session opener continuity",
        latestProgress: "Session A persisted opener state",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: ["MIM-100"],
        blockers: [],
        nextSteps: [],
        sourceSessionId: "session-a",
        supportingMemoryIds: ["same-1"],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValueOnce([]);
    (getPrimaryMemoryRowsByIds as any).mockResolvedValue([
      {
        id: "semiote:same-1",
        payload: {
          l2: "Current status: continue the opener overlay from the prior session.",
          l0: "Cross-session continuity",
          memoryRole: "current_status",
          sessionId: "session-a",
          path: "/Users/brooks/Code/runir",
          tags: [],
          provenance: { derivation: { projectKey: "project:runir" } },
        },
        session_id: "session-a",
        updated_at: "2026-04-01T12:05:00.000Z",
      },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "continue opener work",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        sessionId: "session-b",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.stringify(json.sessionOpener)).toContain("prior session");
    expect(json.sessionOpener.focus).toEqual(expect.arrayContaining([expect.stringContaining("prior session")]));
  });

  it("reports project identity source in deterministic opener debug payload", async () => {
    const scopePredicate = await import("../recall/query/scope-predicate.js");
    (scopePredicate.resolveAttrField as any).mockImplementation((value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined,
    );
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Identity-source debug",
        latestProgress: "Path fallback identity in effect",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: [],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: [],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValueOnce([]);

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "continue where we left off",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        hexisDebug: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json._debug?.runirSession?.projectIdentitySource).toBe("git");
    expect(typeof json._debug?.runirSession?.id).toBe("string");
    expect(json._debug?.runirSession?.status).toBe("active");
    expect(json._debug?.runirSession?.closeReason).toBeNull();
  });

  it("reports closed runir session status and closeReason in session-end debug payload", async () => {
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "session fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s1",
        terminationReason: "resume",
        hexisDebug: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json._debug?.runirSession?.status).toBe("closed");
    expect(json._debug?.runirSession?.closeReason).toBe("resume");
    expect(typeof json._debug?.runirSession?.id).toBe("string");
  });

  it("falls back from legacy body.reason when closing runir session debug state", async () => {
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "session fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session" },
    ]);

    const app = getApp();
    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s1-legacy-reason",
        reason: "prompt_input_exit",
        hexisDebug: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json._debug?.runirSession?.status).toBe("closed");
    expect(json._debug?.runirSession?.closeReason).toBe("prompt_input_exit");
    expect(typeof json._debug?.runirSession?.id).toBe("string");
  });

  it("reactivates a closed runir session on the next active route for the same session id", async () => {
    installRunirSessionPersistenceMock();
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any)
      .mockResolvedValueOnce([
        { l2: "session-end fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session-end" },
      ])
      .mockResolvedValueOnce([
        { l2: "capture fact that is long enough to count", confidence: 0.9, l0: "capture fact", l1: "- capture fact", category: "cases", tier: "working", tags: [], factKey: "cases:capture" },
      ]);

    const app = getApp();
    const endRes = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s-reactivate",
        path: "/Users/brooks/Code/runir",
        terminationReason: "resume",
        hexisDebug: true,
      }),
    });
    expect(endRes.status).toBe(200);
    const endJson = await endRes.json();
    expect(endJson._debug?.runirSession?.status).toBe("closed");
    expect(endJson._debug?.runirSession?.closeReason).toBe("resume");

    const captureRes = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "resume work" }],
        userId: "agent-hermes",
        sessionId: "s-reactivate",
        path: "/Users/brooks/Code/runir",
        captureDebug: true,
      }),
    });
    expect(captureRes.status).toBe(200);
    const captureJson = await captureRes.json();
    expect(captureJson._debug?.runirSession?.status).toBe("active");
    expect(captureJson._debug?.runirSession?.closeReason).toBeNull();
    expect(captureJson._debug?.runirSession?.id).toBe(endJson._debug?.runirSession?.id);
  });

  it("reactivates a closed runir session on the next recall route for the same session id", async () => {
    installRunirSessionPersistenceMock();
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Resume the previous workstream",
        latestProgress: "The session-end lane now stores terminationReason and closes runir_session rows.",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: [],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: [],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValue([]);
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "session-end fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session-end" },
    ]);

    const app = getApp();
    const endRes = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s-reactivate-recall",
        path: "/Users/brooks/Code/runir",
        terminationReason: "resume",
        hexisDebug: true,
      }),
    });
    expect(endRes.status).toBe(200);
    const endJson = await endRes.json();
    expect(endJson._debug?.runirSession?.status).toBe("closed");
    expect(endJson._debug?.runirSession?.closeReason).toBe("resume");

    const recallRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "continue where we left off",
        userId: "agent-hermes",
        sessionId: "s-reactivate-recall",
        path: "/Users/brooks/Code/runir",
        hexisDebug: true,
      }),
    });
    expect(recallRes.status).toBe(200);
    const recallJson = await recallRes.json();
    expect(recallJson._debug?.runirSession?.status).toBe("active");
    expect(recallJson._debug?.runirSession?.closeReason).toBeNull();
    expect(recallJson._debug?.runirSession?.id).toBe(endJson._debug?.runirSession?.id);
  });

  it("reactivates a closed runir session on the next opener-style recall for the same session id", async () => {
    installRunirSessionPersistenceMock();
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Resume the previous workstream via opener",
        latestProgress: "The opener path should reactivate runir_session rows after session-end closure.",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: [],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: [],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValue([]);
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "session-end fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session-end" },
    ]);

    const app = getApp();
    const endRes = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s-reactivate-opener",
        path: "/Users/brooks/Code/runir",
        terminationReason: "resume",
        hexisDebug: true,
      }),
    });
    expect(endRes.status).toBe(200);
    const endJson = await endRes.json();
    expect(endJson._debug?.runirSession?.status).toBe("closed");
    expect(endJson._debug?.runirSession?.closeReason).toBe("resume");

    const openerRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "",
        sessionKind: "opener",
        userId: "agent-hermes",
        sessionId: "s-reactivate-opener",
        path: "/Users/brooks/Code/runir",
        hexisDebug: true,
      }),
    });
    expect(openerRes.status).toBe(200);
    const openerJson = await openerRes.json();
    expect(openerJson._debug?.runirSession?.status).toBe("active");
    expect(openerJson._debug?.runirSession?.closeReason).toBeNull();
    expect(openerJson._debug?.runirSession?.id).toBe(endJson._debug?.runirSession?.id);
  });

  it("reactivates a legacy-reason-closed runir session on the next opener-style recall for the same session id", async () => {
    installRunirSessionPersistenceMock();
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Resume the previous workstream via opener",
        latestProgress: "The legacy reason fallback should also permit reactivation on opener.",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: [],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: [],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValue([]);
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "session-end fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session-end-legacy" },
    ]);

    const app = getApp();
    const endRes = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s-reactivate-opener-legacy",
        path: "/Users/brooks/Code/runir",
        reason: "prompt_input_exit",
        hexisDebug: true,
      }),
    });
    expect(endRes.status).toBe(200);
    const endJson = await endRes.json();
    expect(endJson._debug?.runirSession?.status).toBe("closed");
    expect(endJson._debug?.runirSession?.closeReason).toBe("prompt_input_exit");

    const openerRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "",
        sessionKind: "opener",
        userId: "agent-hermes",
        sessionId: "s-reactivate-opener-legacy",
        path: "/Users/brooks/Code/runir",
        hexisDebug: true,
      }),
    });
    expect(openerRes.status).toBe(200);
    const openerJson = await openerRes.json();
    expect(openerJson._debug?.runirSession?.status).toBe("active");
    expect(openerJson._debug?.runirSession?.closeReason).toBeNull();
    expect(openerJson._debug?.runirSession?.id).toBe(endJson._debug?.runirSession?.id);
  });

  it("reactivates a prompt_input_exit-closed runir session on the next opener-style recall for the same session id", async () => {
    installRunirSessionPersistenceMock();
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({
      projectState: {
        id: "ps-1",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
        currentFocus: "Resume the previous workstream via opener",
        latestProgress: "The actual SessionEnd hook forwards prompt_input_exit as terminationReason.",
        updatedAt: "2026-04-01T12:00:00.000Z",
        activeTicketIds: [],
        blockers: [],
        nextSteps: [],
        supportingMemoryIds: [],
        confidence: 0.8,
      },
      usedPathFallback: false,
    });
    (listContinuityMemoryHits as any).mockResolvedValue([]);
    (segmentAndSummarize as any).mockResolvedValue({
      topics: [{ title: "Test Topic", summary: "This is a sufficiently long test summary for the topic" }],
    });
    (extractMemories as any).mockResolvedValue([
      { l2: "session-end fact that is long enough to count", confidence: 0.9, l0: "session fact", l1: "- session fact", category: "cases", tier: "working", tags: [], factKey: "cases:session-end-prompt-input-exit" },
    ]);

    const app = getApp();
    const endRes = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
        userId: "agent-hermes",
        sessionId: "s-reactivate-opener-prompt-input-exit",
        path: "/Users/brooks/Code/runir",
        terminationReason: "prompt_input_exit",
        hexisDebug: true,
      }),
    });
    expect(endRes.status).toBe(200);
    const endJson = await endRes.json();
    expect(endJson._debug?.runirSession?.status).toBe("closed");
    expect(endJson._debug?.runirSession?.closeReason).toBe("prompt_input_exit");

    const openerRes = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "",
        sessionKind: "opener",
        userId: "agent-hermes",
        sessionId: "s-reactivate-opener-prompt-input-exit",
        path: "/Users/brooks/Code/runir",
        hexisDebug: true,
      }),
    });
    expect(openerRes.status).toBe(200);
    const openerJson = await openerRes.json();
    expect(openerJson._debug?.runirSession?.status).toBe("active");
    expect(openerJson._debug?.runirSession?.closeReason).toBeNull();
    expect(openerJson._debug?.runirSession?.id).toBe(endJson._debug?.runirSession?.id);
  });

  it("persists shown ids for deterministic continuity traces instead of all selected ids", async () => {
    (analyzeIntent as any).mockReturnValue({ categories: ["events"], depth: "l1", confidence: 0.8, label: "session_opener" });
    (getProjectStateForRecall as any).mockResolvedValue({ projectState: null, usedPathFallback: false });
    (listContinuityMemoryHits as any).mockResolvedValue([
      { id: "m1", text: "Rendered memory", score: 0.9, memoryRole: "current_status", path: "/Users/brooks/Code/runir", tags: [] },
      { id: "m2", text: "Not shown memory", score: 0.8, memoryRole: "recent_work", path: "/Users/brooks/Code/runir", tags: [] },
    ]);
    const recallSelection = await import("../recall/selection/recall-selection.js");
    (recallSelection.postProcessRecallResults as any).mockReturnValueOnce({
      selected: [
        { id: "m1", text: "Rendered memory", score: 0.9 },
        { id: "m2", text: "Not shown memory", score: 0.8 },
      ],
      renderedText: ["Rendered memory"],
      accessTrackedIds: ["m1"],
      dropped: [],
    });

    const app = getApp();
    const res = await app.request("/hooks/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "continue working on it",
        userId: "agent-hermes",
        path: "/Users/brooks/Code/runir",
      }),
    });

    expect(res.status).toBe(200);
    expect(createRetrievalTrace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accessTrackedIds: ["m1"],
        items: expect.arrayContaining([
          expect.objectContaining({ id: "m1" }),
          expect.objectContaining({ id: "m2" }),
        ]),
      }),
    );
  });
});

describe("session_opener routing", () => {
  it("analyzeIntent classifies 'let\\'s continue' as session_opener", async () => {
    const { analyzeIntent: realAnalyze } = await vi.importActual<typeof import("../recall/intent/intent-analyzer.js")>("../recall/intent/intent-analyzer.js");
    const intent = realAnalyze("let's continue where we left off");
    expect(intent.label).toBe("session_opener");
  });
});

// ---------------------------------------------------------------------------
// POST /hooks/evidence (Rúnir-78sy.9, S-2 ingestion)
// ---------------------------------------------------------------------------
describe("POST /hooks/evidence", () => {
  const ENROLLED_USER = "u-evidence";
  const WORKSPACE_ID = "-";
  const PROJECT_KEY = "project:runir";
  const ENROLLMENT_PROJECT_ID = "leit-proj-123";

  /**
   * Installs a query-string-matching mock over runtime.db.query covering the
   * three surfaces the route touches: project_enrollment (point lookup),
   * continuity_evidence (upsert CREATE/UPDATE/SELECT), and runir_session
   * (binding candidate reads). In-memory Maps stand in for the tables so
   * idempotent re-post / binding-window assertions can be made against
   * response shape without a live DB.
   */
  function installEvidenceRouteMocks(options: { enrolled?: boolean; sessions?: Array<{ id: string; opened_at: string; closed_at?: string | null; project_key?: string }> } = {}) {
    const enrolled = options.enrolled ?? true;
    const evidenceRows = new Map<string, any>();
    const sessions = options.sessions ?? [];

    (runtimeModule.runtime.db.query as any).mockImplementation(async (sql: string, vars?: Record<string, any>) => {
      if (sql.includes("FROM type::record('project_enrollment'")) {
        if (!enrolled) return [[]];
        return [[
          {
            id: `project_enrollment:${PROJECT_KEY}`,
            user_id: ENROLLED_USER,
            workspace_id: WORKSPACE_ID,
            project_key: PROJECT_KEY,
            project_id: ENROLLMENT_PROJECT_ID,
            default_namespace_id: null,
            repo_remote: null,
            repo_root_fingerprint: null,
            source: "manual",
            enrolled_at: "2026-07-01T00:00:00.000Z",
          },
        ]];
      }
      if (sql.includes("FROM runir_session")) {
        return [sessions];
      }
      if (sql.includes("SELECT id FROM type::record('continuity_evidence'")) {
        const row = evidenceRows.get(vars?.recordId);
        return [[row].filter(Boolean)];
      }
      if (sql.includes("CREATE type::record('continuity_evidence'")) {
        if (evidenceRows.has(vars?.recordId)) return [[]]; // simulate unique-index rejection -> null via .catch
        const row = {
          id: vars?.recordId,
          user_id: vars?.userId,
          workspace_id: vars?.workspaceId,
          project_key: vars?.projectKey,
          project_id: vars?.projectId ?? null,
          conflicting_project_id: vars?.conflictingProjectId ?? null,
          source_type: vars?.sourceType,
          source_id: vars?.sourceId,
          occurred_at: vars?.occurredAt ?? null,
          ref: vars?.ref,
          bound_session_id: vars?.boundSessionId ?? null,
          first_seen_at: vars?.firstSeenAt,
          last_seen_at: vars?.lastSeenAt,
        };
        evidenceRows.set(vars?.recordId, row);
        return [[row]];
      }
      if (sql.includes("UPDATE type::record('continuity_evidence'")) {
        const prev = evidenceRows.get(vars?.recordId) ?? { id: vars?.recordId, first_seen_at: vars?.lastSeenAt };
        const row = {
          ...prev,
          user_id: vars?.userId,
          workspace_id: vars?.workspaceId,
          project_key: vars?.projectKey,
          project_id: vars?.projectId ?? null,
          conflicting_project_id: vars?.conflictingProjectId ?? null,
          source_type: vars?.sourceType,
          source_id: vars?.sourceId,
          occurred_at: vars?.occurredAt ?? null,
          ref: vars?.ref,
          bound_session_id: vars?.boundSessionId ?? null,
          last_seen_at: vars?.lastSeenAt,
        };
        evidenceRows.set(vars?.recordId, row);
        return [[row]];
      }
      return [[]];
    });
    return evidenceRows;
  }

  beforeEach(() => {
    delete process.env.RUNIR_EVIDENCE_SECRET;
    delete process.env.RUNIR_API_KEY;
    delete process.env.RUNIR_REQUIRE_API_KEY;
    delete process.env.NODE_ENV;
  });

  it("401s when RUNIR_EVIDENCE_SECRET is unset (fail-closed)", async () => {
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer anything" },
      body: JSON.stringify({ userId: ENROLLED_USER, projectKey: PROJECT_KEY, evidence: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("401s on a wrong bearer token", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "correct-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify({ userId: ENROLLED_USER, projectKey: PROJECT_KEY, evidence: [] }),
    });
    expect(res.status).toBe(401);
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  // [F5] production-ordering proof: under fail-closed middleware mode with NO
  // RUNIR_API_KEY and NO RUNIR_EVIDENCE_SECRET configured, the request must
  // reach the /hooks/evidence HANDLER's own 401 — proving PUBLIC_PATHS exempts
  // this route from the middleware's 503 ("service auth is not configured").
  it("[F5] under RUNIR_REQUIRE_API_KEY=1 with no RUNIR_API_KEY and no RUNIR_EVIDENCE_SECRET, returns the handler's 401 not the middleware's 503", async () => {
    process.env.RUNIR_REQUIRE_API_KEY = "1";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: ENROLLED_USER, projectKey: PROJECT_KEY, evidence: [] }),
    });
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error).toBe("unauthorized");
    delete process.env.RUNIR_REQUIRE_API_KEY;
  });

  it("400s on malformed body (missing projectKey)", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ userId: ENROLLED_USER, evidence: [] }),
    });
    expect(res.status).toBe(400);
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  // [F1 Codex] a valid bearer with NO userId must 400, not silently fall back
  // to the default tenant (resolveUserId's fallback behavior).
  it("[Codex F1] 400s when userId is missing (valid bearer, no default-tenant fallback)", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ projectKey: PROJECT_KEY, evidence: [] }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("userId is required");
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("[Codex F1] 400s when userId is an empty/whitespace string", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ userId: "   ", projectKey: PROJECT_KEY, evidence: [] }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("userId is required");
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("[Codex F1] 400s when userId is not a string", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ userId: 12345, projectKey: PROJECT_KEY, evidence: [] }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("userId is required");
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("400s on malformed body (evidence not an array)", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ userId: ENROLLED_USER, projectKey: PROJECT_KEY, evidence: "not-an-array" }),
    });
    expect(res.status).toBe(400);
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("[F7] 400s when evidence item count exceeds the 100-item cap", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const oversizedBatch = Array.from({ length: 101 }, (_, i) => ({
      sourceType: "git_commit",
      sourceId: `sha-${i}`,
      label: "commit",
    }));
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ userId: ENROLLED_USER, projectKey: PROJECT_KEY, evidence: oversizedBatch }),
    });
    expect(res.status).toBe(400);
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("422s for an unenrolled (workspaceId, projectKey) pair", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks({ enrolled: false });
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ userId: ENROLLED_USER, projectKey: "project:unenrolled", evidence: [] }),
    });
    expect(res.status).toBe(422);
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("200 happy path: accepts a well-formed Leit-sourced evidence batch and canonicalizes the '-' sentinel workspaceId", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        userId: ENROLLED_USER,
        projectKey: PROJECT_KEY,
        evidence: [
          { sourceType: "git_commit", sourceId: "sha1", label: "fix: bug", timestamp: "2026-07-01T00:00:00.000Z" },
          { sourceType: "bead", sourceId: "bead-1", label: "Rúnir-1" },
        ],
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ accepted: 2, updated: 0, rejected: 0 });
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("idempotent re-post of the same 5-tuple returns updated, not accepted", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const payload = JSON.stringify({
      userId: ENROLLED_USER,
      projectKey: PROJECT_KEY,
      evidence: [{ sourceType: "git_commit", sourceId: "sha-dup", label: "first" }],
    });
    const first = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: payload,
    });
    expect((await first.json()).accepted).toBe(1);
    const second = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        userId: ENROLLED_USER,
        projectKey: PROJECT_KEY,
        evidence: [{ sourceType: "git_commit", sourceId: "sha-dup", label: "updated label" }],
      }),
    });
    const secondJson = await second.json();
    expect(secondJson).toEqual({ accepted: 0, updated: 1, rejected: 0 });
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("[F3] rejects a non-Leit sourceType per-item, never aborting the whole batch", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        userId: ENROLLED_USER,
        projectKey: PROJECT_KEY,
        evidence: [
          { sourceType: "git_commit", sourceId: "sha-ok", label: "ok" },
          { sourceType: "semiote", sourceId: "sem-1", label: "not leit-supplied" },
          { sourceType: "runir_session", sourceId: "sess-1", label: "not leit-supplied" },
        ],
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ accepted: 1, updated: 0, rejected: 2 });
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("[F7] rejects an oversize ref (>16 KiB serialized) per-item under 200", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    installEvidenceRouteMocks();
    const app = getApp();
    const hugeExcerpt = "x".repeat(20 * 1024);
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        userId: ENROLLED_USER,
        projectKey: PROJECT_KEY,
        evidence: [
          { sourceType: "git_commit", sourceId: "sha-ok", label: "ok" },
          { sourceType: "doc_artifact", sourceId: "doc-huge", label: "huge", excerpt: hugeExcerpt },
        ],
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ accepted: 1, updated: 0, rejected: 1 });
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });

  it("[F8] a conflicting request projectId is persisted separately, never rejected, and logs no raw content", async () => {
    process.env.RUNIR_EVIDENCE_SECRET = "test-secret";
    const rows = installEvidenceRouteMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = getApp();
    const res = await app.request("/hooks/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        userId: ENROLLED_USER,
        projectKey: PROJECT_KEY,
        projectId: "conflicting-request-project-id",
        evidence: [{ sourceType: "git_commit", sourceId: "sha-conflict", label: "commit", excerpt: "SECRET RAW CONTENT" }],
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ accepted: 1, updated: 0, rejected: 0 });

    const persisted = [...rows.values()].find((r: any) => r.source_id === "sha-conflict");
    expect(persisted?.project_id).toBe(ENROLLMENT_PROJECT_ID); // enrollment's value is the durable target
    expect(persisted?.conflicting_project_id).toBe("conflicting-request-project-id");

    // The structured warn log carries counts/ids only — never raw ref/excerpt content.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("evidence projectId mismatch"));
    expect(warnSpy).toHaveBeenCalledWith(expect.not.stringContaining("SECRET RAW CONTENT"));
    warnSpy.mockRestore();
    delete process.env.RUNIR_EVIDENCE_SECRET;
  });
});
