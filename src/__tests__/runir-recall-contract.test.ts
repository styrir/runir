/**
 * Contract test: /hooks/recall selected[] payload shape.
 *
 * Mocking strategy: vi.mock the two heavy dependencies that require live infra:
 *   - ../../app/runtime.js  — exports cfg/db/provider/etc., all replaced with stubs
 *   - ../../recall/query/memory-query.js — runHybridQuery returns canned SearchHit[]
 *
 * All SurrealDB-touching store modules are mocked to no-ops so the handler runs
 * in-process without a database or embedder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { parseRecallResponse } from "../recall/recall-contract.js";
import type { SearchHit } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  runHybridQuery: vi.fn(),
  embedQuery: vi.fn(),
  shouldSkipRetrieval: vi.fn(),
  resolveUserId: vi.fn(),
  resolveRetrievalController: vi.fn(),
  analyzeIntent: vi.fn(),
  postProcessRecallResults: vi.fn(),
  applyHexisByPolicy: vi.fn(),
  buildSelectedViewFromPool: vi.fn(),
  buildAdmissiblePool: vi.fn(),
  getProjectStateForRecall: vi.fn(),
  listContinuityMemoryHits: vi.fn(),
  createRetrievalTrace: vi.fn(),
  resolveRunirSession: vi.fn(),
  resolveCanonicalContextIdentity: vi.fn(),
  resolveActiveHexisCached: vi.fn(),
  buildSessionOpenerPayload: vi.fn(),
  formatSessionOpenerInjection: vi.fn(),
  formatRecallInjectionFromRendered: vi.fn(),
}));

vi.mock("../app/runtime.js", () => ({
  cfg: { userId: "owner", topK: 5, autoRecall: true, autoCapture: true, reranker: undefined, embedder: { model: "test", baseURL: "http://localhost" }, surrealdb: {} },
  db: { query: vi.fn(() => Promise.resolve([])) },
  runtime: {
    db: { query: vi.fn(() => Promise.resolve([])) },
    overlayRegistry: {
      forUser: vi.fn(() => ({
        snapshot: vi.fn(() => []),
      })),
    },
  },
  provider: { embedQuery: mocks.embedQuery },
  debugLogger: { recallResults: vi.fn(), retrievalTrace: vi.fn() },
  bm25StatsCache: { get: vi.fn(() => undefined) },
  noiseBank: { isNoisy: vi.fn(() => false) },
  retrievalStats: { recordQuery: vi.fn() },
  resolveUserId: mocks.resolveUserId,
  deriveContinuityMetadata: vi.fn(),
  deriveProjectStateSnapshot: vi.fn(),
  factMetadata: vi.fn(),
  resolveActiveHexis: vi.fn(() => Promise.resolve(null)),
  writeWithArbitration: vi.fn(),
}));

vi.mock("../recall/query/memory-query.js", () => ({
  runHybridQuery: mocks.runHybridQuery,
  runHybridQueryWithEvidenceTable: vi.fn((input: any) =>
    mocks.runHybridQuery(
      input.db,
      input.userId,
      input.query,
      input.embedding,
      input.limit,
      input.statsCache,
      input.scopeFilter,
      input.warn,
      input.rerankerConfig,
      input.embeddingProvider,
      input.trace,
      input.activeFilter,
      input.evidenceTable,
      input.tuning,
      input.overlay,
    ),
  ),
}));

vi.mock("../recall/intent/adaptive-retrieval.js", () => ({
  shouldSkipRetrieval: mocks.shouldSkipRetrieval,
}));

vi.mock("../recall/intent/intent-analyzer.js", () => ({
  analyzeIntent: mocks.analyzeIntent,
  applyCategoryBoost: vi.fn((hits: SearchHit[]) => hits),
  // Real predicate (mmg2.2): drives whether the orchestrator resolves the learned
  // noise set; mirrors STATUS_CLASS_INTENTS so the opener branch exercises it.
  isStatusClassIntent: (label: string) =>
    label === "current_status" || label === "session_opener"
    || label === "pre_compaction" || label === "post_compaction_validation",
}));

vi.mock("../recall/policy/retrieval-controller.js", () => ({
  resolveRetrievalController: mocks.resolveRetrievalController,
  applyHexisByPolicy: mocks.applyHexisByPolicy,
}));

vi.mock("../recall/selection/recall-selection.js", () => ({
  postProcessRecallResults: mocks.postProcessRecallResults,
  formatRecallInjectionFromRendered: mocks.formatRecallInjectionFromRendered,
}));

vi.mock("../recall/continuity/session-opener.js", () => ({
  buildSessionOpenerPayload: mocks.buildSessionOpenerPayload,
  formatSessionOpenerInjection: mocks.formatSessionOpenerInjection,
}));

vi.mock("../recall/continuity/recall-status-policy.js", () => ({
  classifyRecallMemoryKind: vi.fn(() => "recall"),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  createWatermark: vi.fn(),
  extractId: vi.fn((id: string) => id),
  getLastWatermark: vi.fn(() => Promise.resolve(null)),
  getProjectState: vi.fn(() => Promise.resolve(null)),
  getProjectStateForRecall: mocks.getProjectStateForRecall,
  listContinuityMemoryHits: mocks.listContinuityMemoryHits,
  logRejection: vi.fn(),
  upsertProjectState: vi.fn(() => Promise.resolve()),
  compareAndSwapProjectState: vi.fn(() => Promise.resolve()),
  SurrealClient: class {},
  getEmbeddingFingerprint: vi.fn(),
  setEmbeddingFingerprint: vi.fn(),
}));

vi.mock("../storage/surreal/phase2-store.js", () => ({
  createRetrievalTrace: mocks.createRetrievalTrace,
  getRetrievalTrace: vi.fn(),
  patchRetrievalTraceCaptureReceipt: vi.fn(),
  markSemiotesFoldedIntoProjectState: vi.fn(),
  patchSemioteUsefulness: vi.fn(),
  promoteSemioteToNoema: vi.fn(),
  upsertSemioteRelation: vi.fn(),
  getPrimaryMemoryRowsByIds: vi.fn(() => Promise.resolve([])),
  // mmg2.2: fresh-tenant learned-noise lookup → empty set → no-op union.
  queryLearnedStatusNoiseIds: vi.fn(() => Promise.resolve([])),
  buildSessionOpenerOverlayHits: vi.fn(() => []),
  getHexisById: vi.fn(() => Promise.resolve(null)),
  getHexisByScopeKey: vi.fn(() => Promise.resolve(null)),
  initializeSemioteSemiosis: vi.fn(() => Promise.resolve()),
  patchSemioteProvenance: vi.fn(() => Promise.resolve()),
  upsertHexis: vi.fn(() => Promise.resolve()),
  buildSemioteProvenanceEnvelope: vi.fn(),
  toRetrievalFootprintIdentitySnapshot: vi.fn(() => ({})),
}));

vi.mock("../storage/surreal/runir-session-store.js", () => ({
  resolveRunirSession: mocks.resolveRunirSession,
}));

vi.mock("../identity/canonical-context.js", () => ({
  resolveCanonicalContextIdentity: mocks.resolveCanonicalContextIdentity,
  formatCanonicalContextForDebug: vi.fn(() => "ctx:test"),
  buildProjectStateRef: vi.fn(() => ({ recordId: "ps:proj-1", projectKey: "proj-1" })),
  buildHexisContextRef: vi.fn(() => ({ scope: "session", scopeKey: "proj-1" })),
  buildArbitrationPartitionRef: vi.fn(() => ({ partitionKey: "owner::session::sess-test", scope: "session" })),
}));

vi.mock("../hexis/active-hexis-cache.js", () => ({
  resolveActiveHexisCached: mocks.resolveActiveHexisCached,
  hasAdditionalHexisHintSignal: vi.fn(() => false),
}));

vi.mock("../recall/policy/recipe-registry.js", () => ({
  buildRecipeTraceMetadata: vi.fn(() => ({ id: "test", version: 1 })),
}));

vi.mock("../recall/query/scope-predicate.js", () => ({
  applyPathScorePenalty: vi.fn((hits: SearchHit[]) => hits),
  applyRecallSoftFilters: vi.fn((hits: SearchHit[]) => hits),
  mergeFilters: vi.fn((...filters: unknown[]) => filters[0] ?? {}),
  resolveAttributionFilter: vi.fn(() => undefined),
  resolveAttrField: vi.fn((v: unknown) => (typeof v === "string" ? v : undefined)),
  resolvePathRecallFilter: vi.fn(() => undefined),
  resolveScopeFilter: vi.fn(() => undefined),
}));

vi.mock("../recall/selection/retrieval-trace.js", () => ({
  TraceCollector: class {
    stages: unknown[] = [];
    startStage = vi.fn();
    endStage = vi.fn();
    finalize = vi.fn(() => null);
    summarize = vi.fn(() => "");
  },
}));

vi.mock("../recall/latest-state/run-latest-state-lane.js", () => ({
  runLatestStateLane: vi.fn(),
}));

vi.mock("../lifecycle/semion/consolidation.js", () => ({
  runConsolidationForScope: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lifecycle/semion/staleness-pass.js", () => ({
  runStalenessPass: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lifecycle/semion/usefulness-feedback.js", () => ({
  applyUsefulnessFeedback: vi.fn(() => Promise.resolve()),
  initializeUsefulnessState: vi.fn(() => Promise.resolve()),
}));

vi.mock("../entities/entity-store.js", () => ({
  linkEntityToMemory: vi.fn(() => Promise.resolve()),
}));

vi.mock("../app/semiote-write-context.js", () => ({
  resolveSemioteOriginContext: vi.fn(() => ({})),
}));

vi.mock("../shared/config.js", () => ({
  resolveCaptureApiKey: vi.fn(() => undefined),
}));

vi.mock("../app/readiness.js", () => ({
  probeDatabaseReady: vi.fn(),
  getBootstrapReadinessReport: vi.fn(() => ({ ready: true, checkedAt: "", checks: [] })),
}));

vi.mock("../capture/extraction/capture.js", () => ({
  batchDedupFacts: vi.fn(),
  extractMemories: vi.fn(),
  extractTopicTags: vi.fn(),
  isNoisyFact: vi.fn(),
  normalizeCaptureMessages: vi.fn(),
  normalizeExtractedFact: vi.fn(),
  resolveCapturePrompt: vi.fn(),
  segmentAndSummarize: vi.fn(),
}));

vi.mock("../capture/enrichment/memory-enricher.js", () => ({
  runSessionEnrichment: vi.fn(() => Promise.resolve()),
}));

vi.mock("../capture/continuity/session-compressor.js", () => ({
  compressMessages: vi.fn(),
}));

vi.mock("../capture/continuity/session-diff-extractor.js", () => ({
  parseGitCommits: vi.fn(),
  buildGitDiffContext: vi.fn(),
  SPARSE_SESSION_THRESHOLD: 10,
}));

vi.mock("../capture/continuity/session-salience.js", () => ({
  scoreSessionSalience: vi.fn(() => 0.5),
}));

vi.mock("../capture/continuity/project-state-warming.js", () => ({
  buildWarmedProjectState: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../capture/capture-context-assembler.js", () => ({
  buildCaptureContextPacket: vi.fn(),
}));

vi.mock("../app/auth.js", () => ({
  createApiAuthMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock("../hexis/runtime-hexis.js", () => ({
  scoreHexisFit: vi.fn(() => 0),
  hasHexisSignal: vi.fn(() => false),
  normalizeHexis: vi.fn((h: unknown) => h),
  buildHexisScopeKey: vi.fn(() => "scope"),
}));

// ---------------------------------------------------------------------------
// Import the app factory after all mocks are in place
// ---------------------------------------------------------------------------
import { registerHookRoutes } from "../app/routes/hooks/index.js";

// ---------------------------------------------------------------------------
// Canned data
// ---------------------------------------------------------------------------
const CANONICAL_IDENTITY = {
  userId: "owner",
  contextScopeKind: "session" as const,
  projectKey: "proj-1",
  raw: { sessionId: "sess-test", path: undefined, projectId: undefined, agentId: undefined, gitRemoteUrl: undefined, gitRepoRoot: undefined },
  derivation: {
    contextScopeKind: { value: "session", source: "sessionId" as const },
    agentId: { value: undefined, source: "absent" as const },
    resolvedTaskId: { value: undefined, source: "absent" as const },
    projectKey: { value: "proj-1", marker: "sessionId" as const },
  },
};

const CANNED_HITS: SearchHit[] = [
  { id: "hit-1", text: "First memory content", score: 0.9, memoryRole: "project_state", rankingExplanation: ["hexis boosted"] },
  { id: "hit-2", text: "Second memory content", score: 0.75 },
  { id: "hit-3", text: "Third memory content", score: 0.6, memoryRole: "recent_work" },
];

function makeApp() {
  const app = new Hono();
  // Bypass auth middleware
  app.use("*", async (_c, next) => next());
  registerHookRoutes(app);
  return app;
}

function makeRecallRequest(overrides: Record<string, unknown> = {}) {
  return {
    userId: "owner",
    prompt: "what was I working on?",
    sessionId: "sess-test",
    ...overrides,
  };
}

async function postRecall(app: Hono, body: Record<string, unknown>) {
  return app.request("/hooks/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

function setupStandardMocks(renderedText: string[] = ["Memory line 1", "Memory line 2"]) {
  mocks.resolveUserId.mockReturnValue("owner");
  mocks.shouldSkipRetrieval.mockReturnValue(false);
  mocks.analyzeIntent.mockReturnValue({ label: "recall", categories: [] });
  mocks.resolveRetrievalController.mockReturnValue({
    policy: {
      useDeterministicContinuity: false,
      retrievalPath: "hybrid",
      hexis: { enabled: false },
      lane: "recall",
      selectorProfile: "default",
      admissibilityContract: undefined,
    },
    recipe: { id: "default", version: 1 },
  });
  mocks.resolveActiveHexisCached.mockResolvedValue(null);
  mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
  mocks.resolveRunirSession.mockResolvedValue({
    id: "sess-test",
    projectIdentitySource: "session",
    status: "open",
    closeReason: null,
  });
  mocks.runHybridQuery.mockResolvedValue(CANNED_HITS);
  mocks.applyHexisByPolicy.mockReturnValue({
    hits: CANNED_HITS,
    gate: { enabled: false, reason: "disabled", admissibleIds: [], reorderWindow: 5, ambiguityGap: 0 },
  });
  mocks.buildAdmissiblePool.mockReturnValue(CANNED_HITS);

  const accessTrackedIds = CANNED_HITS.map((h) => h.id);
  mocks.postProcessRecallResults.mockReturnValue({
    selected: CANNED_HITS,
    renderedText,
    accessTrackedIds,
    admissibility: {},
  });
  mocks.buildSelectedViewFromPool.mockReturnValue({
    selected: CANNED_HITS,
    renderedText,
    accessTrackedIds,
    admissibility: {},
    filtered: CANNED_HITS,
  });
  mocks.formatRecallInjectionFromRendered.mockReturnValue("<ctx>memory</ctx>");
  mocks.buildSessionOpenerPayload.mockReturnValue(null);
  mocks.createRetrievalTrace.mockResolvedValue("trace-abc");
}

function verifySelectedShape(selected: unknown[]) {
  expect(Array.isArray(selected)).toBe(true);
  selected.forEach((entry, i) => {
    const e = entry as Record<string, unknown>;
    expect(typeof e.id).toBe("string");
    expect(typeof e.content).toBe("string");
    expect(typeof e.score).toBe("number");
    expect(typeof e.rank).toBe("number");
    expect(e.rank).toBe(i + 1);
    if ("role" in e) expect(typeof e.role).toBe("string");
    if ("supportSummary" in e) expect(Array.isArray(e.supportSummary)).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("recall selected[] contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skip path: no selected[] and skipped=true", async () => {
    mocks.resolveUserId.mockReturnValue("owner");
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    mocks.analyzeIntent.mockReturnValue({ label: "recall", categories: [] });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: { useDeterministicContinuity: false, retrievalPath: "hybrid", hexis: { enabled: false }, lane: "recall" },
      recipe: { id: "default", version: 1 },
    });

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ prompt: "" }));
    const body = await res.json() as Record<string, unknown>;

    expect(body.skipped).toBe(true);
    expect(body.selected).toBeUndefined();
  });

  it("main branch (plain): selected[] present with correct shape", async () => {
    setupStandardMocks();

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest());
    const body = await res.json() as Record<string, unknown>;

    expect(Array.isArray(body.selected)).toBe(true);
    verifySelectedShape(body.selected as unknown[]);

    const entries = body.selected as Array<Record<string, unknown>>;
    expect(entries[0].id).toBe("hit-1");
    expect(entries[0].content).toBe("First memory content");
    expect(entries[0].rank).toBe(1);
    expect(entries[0].role).toBe("project_state");
    expect(Array.isArray(entries[0].supportSummary)).toBe(true);

    expect(entries[1].id).toBe("hit-2");
    expect(entries[1].rank).toBe(2);
    expect(entries[1].role).toBeUndefined();
    expect(entries[1].supportSummary).toBeUndefined();

    expect(entries[2].rank).toBe(3);
  });

  it("main branch (debug): selected[] present with correct shape", async () => {
    setupStandardMocks();
    // isDebug path requires both RUNIR_DEBUG=1 and finalTrace to be truthy,
    // but TraceCollector.finalize is mocked to return null — so debug branch
    // won't activate. This test verifies the plain branch fallback still fires.
    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ hexisDebug: true }));
    const body = await res.json() as Record<string, unknown>;

    expect(Array.isArray(body.selected)).toBe(true);
    verifySelectedShape(body.selected as unknown[]);
  });

  it("deterministic continuity / non-sessionOpener branch: selected[] present", async () => {
    mocks.resolveUserId.mockReturnValue("owner");
    mocks.shouldSkipRetrieval.mockReturnValue(false);
    mocks.analyzeIntent.mockReturnValue({ label: "recall", categories: [] });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: {
        useDeterministicContinuity: true,
        retrievalPath: "hybrid",
        hexis: { enabled: false },
        lane: "continuity",
        selectorProfile: "default",
        admissibilityContract: undefined,
      },
      recipe: { id: "continuity", version: 1 },
    });
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({
      id: "sess-test",
      projectIdentitySource: "session",
      status: "open",
      closeReason: null,
    });
    mocks.getProjectStateForRecall.mockResolvedValue({
      projectState: { id: "ps-1", latestProgress: "in progress", updatedAt: "2026-01-01", path: "/test", supportingMemoryIds: [] },
      usedPathFallback: false,
    });
    mocks.listContinuityMemoryHits.mockResolvedValue([]);

    const accessTrackedIds = CANNED_HITS.map((h) => h.id);
    mocks.postProcessRecallResults.mockReturnValue({
      selected: CANNED_HITS,
      renderedText: ["Continuity line"],
      accessTrackedIds,
      admissibility: {},
    });
    mocks.formatRecallInjectionFromRendered.mockReturnValue("<ctx>continuity</ctx>");
    mocks.buildSessionOpenerPayload.mockReturnValue(null);
    mocks.createRetrievalTrace.mockResolvedValue("trace-continuity");

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ sessionKind: "turn" }));
    const body = await res.json() as Record<string, unknown>;

    expect(Array.isArray(body.selected)).toBe(true);
    verifySelectedShape(body.selected as unknown[]);
    expect(body.continuitySource).toBe("deterministic");
  });

  // OM-1 (Rúnir-tfxt.1) ROUTE-LEVEL no-budget identity. The seam-level snapshot
  // in recall-budget-fit.test.ts proved insufficient when the tfxt.1 landing
  // broke response ASSEMBLY (a new orchestrator import from the vi.mock'ed
  // recall-selection module resolved to undefined → TypeError → the 500 catch
  // body without selected[]). This locks the full route response: absent vs
  // malformed budgetTokens must be BYTE-identical, always 200, and must never
  // grow a budgetFit key.
  it("budgetTokens absent vs malformed: route response byte-identical, never 500 (Rúnir-tfxt.1)", async () => {
    setupStandardMocks();
    const app = makeApp();

    const baselineRes = await postRecall(app, makeRecallRequest());
    expect(baselineRes.status).toBe(200);
    const baselineText = await baselineRes.text();
    expect(baselineText).toContain('"selected"');
    expect(baselineText).not.toContain('"budgetFit"');

    // JSON-transportable malformed variants (NaN/Infinity cannot ride JSON;
    // fractional <1 floors to 0 = invalid inside the selection guard).
    const malformed: unknown[] = ["512", -50, 0, 0.4, null, true, {}, [128]];
    for (const budgetTokens of malformed) {
      const res = await postRecall(app, makeRecallRequest({ budgetTokens }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(baselineText);
    }
  });

  it("sessionKind=opener is retired — short-circuits to a content-less skip (no selected[], no sessionOpener)", async () => {
    mocks.resolveUserId.mockReturnValue("owner");
    mocks.shouldSkipRetrieval.mockReturnValue(false);
    mocks.analyzeIntent.mockReturnValue({ label: "session_opener", categories: [] });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: {
        useDeterministicContinuity: true,
        retrievalPath: "hybrid",
        hexis: { enabled: false },
        lane: "continuity",
        selectorProfile: "default",
        admissibilityContract: undefined,
      },
      recipe: { id: "continuity", version: 1 },
    });
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({
      id: "sess-test",
      projectIdentitySource: "session",
      status: "open",
      closeReason: null,
    });
    mocks.getProjectStateForRecall.mockResolvedValue({
      projectState: { id: "ps-1", latestProgress: "focus text", updatedAt: "2026-01-01", path: "/test", supportingMemoryIds: [] },
      usedPathFallback: false,
    });
    mocks.listContinuityMemoryHits.mockResolvedValue([]);

    const accessTrackedIds = CANNED_HITS.map((h) => h.id);
    mocks.postProcessRecallResults.mockReturnValue({
      selected: CANNED_HITS,
      renderedText: ["Session opener line"],
      accessTrackedIds,
      admissibility: {},
    });

    const sessionOpenerPayload = {
      intent: "continue_previous_work",
      confidence: "high",
      scope: { project: "runir" },
      status: "active",
      focus: ["test"],
      state: [],
      env: [],
      next: [],
      directives: [],
      evidenceTitles: [],
      warnings: [],
      evidence: { handoff: [], active: [], recentWork: [], supplemental: [] },
    };
    mocks.buildSessionOpenerPayload.mockReturnValue(sessionOpenerPayload);
    mocks.formatSessionOpenerInjection.mockReturnValue("<session-opener>payload</session-opener>");
    mocks.createRetrievalTrace.mockResolvedValue("trace-opener");

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ sessionKind: "opener" }));
    const body = await res.json() as Record<string, unknown>;

    // Opener retired (2026-06-13 — architecture-canon §1): sessionKind="opener"
    // short-circuits to a content-less skip — no selected[], no sessionOpener, no
    // deterministic-continuity branch. Continuity comes from per-turn recall.
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("opener_retired");
    expect(body.selected).toBeUndefined();
    expect(body.sessionOpener).toBeUndefined();
    expect(body.continuitySource).toBeUndefined();
  });

  // ── OM-2 (Rúnir-tfxt.2): compaction-render projection, route level ─────────

  // Identity gate: only the exact sessionKind values "opener",
  // "pre_compaction", and "post_compaction_validation" are recognized — every
  // other string must behave byte-identically to an absent sessionKind.
  it("unknown sessionKind values are ignored: route response byte-identical to absent (Rúnir-tfxt.2)", async () => {
    setupStandardMocks();
    const app = makeApp();

    const baselineRes = await postRecall(app, makeRecallRequest());
    expect(baselineRes.status).toBe(200);
    const baselineText = await baselineRes.text();
    expect(baselineText).toContain('"selected"');

    for (const sessionKind of ["turn", "compaction", "PRE_COMPACTION", "pre-compaction", "", 42, null]) {
      const res = await postRecall(app, makeRecallRequest({ sessionKind }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(baselineText);
    }
  });

  function setupCompactionRouteMocks() {
    mocks.resolveUserId.mockReturnValue("owner");
    // An empty compaction ping would be adaptively skipped — the hint must bypass.
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    mocks.analyzeIntent.mockImplementation((_prompt: string, opts?: { hint?: string }) => ({
      label: opts?.hint ?? "recall",
      categories: [],
      depth: "l1",
      confidence: 0.95,
    }));
    mocks.resolveRetrievalController.mockReturnValue({
      policy: {
        useDeterministicContinuity: true,
        retrievalPath: "deterministic",
        hexis: { enabled: false },
        lane: "compaction_projection",
        selectorProfile: "status_continuity",
        admissibilityContract: undefined,
      },
      recipe: { id: "compaction_projection", version: 1 },
    });
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({
      id: "sess-test",
      projectIdentitySource: "session",
      status: "open",
      closeReason: null,
    });
  }

  it("sessionKind=pre_compaction with empty prompt serves the projection (payload + honest root key, schema-valid)", async () => {
    setupCompactionRouteMocks();
    mocks.getProjectStateForRecall.mockResolvedValue({
      projectState: { id: "ps-1", latestProgress: "exporter re-point landed", updatedAt: "2026-01-01", path: "/test", supportingMemoryIds: [], blockers: [], nextSteps: [] },
      usedPathFallback: false,
    });
    mocks.listContinuityMemoryHits.mockResolvedValue([]);
    const psHit = { id: "ps-1", text: "exporter re-point landed", score: 1, memoryRole: "project_state" };
    mocks.postProcessRecallResults.mockReturnValue({
      selected: [psHit],
      renderedText: ["exporter re-point landed"],
      accessTrackedIds: [],
      admissibility: {},
    });
    const compactionPayload = {
      intent: "continue_previous_work",
      confidence: "high",
      scope: { project: "runir" },
      status: "active",
      focus: ["exporter re-point"],
      state: ["landed"],
      env: [],
      next: ["wire the CLI runner"],
      directives: [],
      evidenceTitles: [],
      warnings: [],
      evidence: { handoff: [], active: [], recentWork: [], supplemental: [] },
    };
    mocks.buildSessionOpenerPayload.mockReturnValue(compactionPayload);
    mocks.createRetrievalTrace.mockResolvedValue("trace-compaction");

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ prompt: "", sessionKind: "pre_compaction" }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // The projection rides the existing contract fields — parse must succeed.
    parseRecallResponse(body);
    expect(body.continuitySource).toBe("deterministic");
    expect(body.sessionOpener).toBeDefined();
    // The REAL compaction renderer ran (module unmocked): honest root key, NOT
    // the opener injection.
    expect(String(body.prependContext)).toContain("compaction_projection:");
    expect(String(body.prependContext)).toContain("phase: pre");
    verifySelectedShape(body.selected as unknown[]);
    expect(body.count).toBe(1);
  });

  it("post_compaction_validation with content renders the recite-back trim (phase line, no env/evidence_titles)", async () => {
    setupCompactionRouteMocks();
    mocks.getProjectStateForRecall.mockResolvedValue({
      projectState: { id: "ps-1", latestProgress: "exporter re-point landed", updatedAt: "2026-01-01", path: "/test", supportingMemoryIds: [], blockers: [], nextSteps: [] },
      usedPathFallback: false,
    });
    mocks.listContinuityMemoryHits.mockResolvedValue([]);
    const psHit = { id: "ps-1", text: "exporter re-point landed", score: 1, memoryRole: "project_state" };
    mocks.postProcessRecallResults.mockReturnValue({
      selected: [psHit],
      renderedText: ["exporter re-point landed"],
      accessTrackedIds: [],
      admissibility: {},
    });
    // env + evidenceTitles are non-empty ON the payload — the post profile
    // must trim them out of the render anyway (recite-back shape).
    mocks.buildSessionOpenerPayload.mockReturnValue({
      intent: "continue_previous_work",
      confidence: "high",
      scope: { project: "runir" },
      status: "active",
      focus: ["exporter re-point"],
      state: ["landed"],
      env: ["port 7700 base url"],
      next: ["wire the CLI runner"],
      directives: [],
      evidenceTitles: ["Exporter status"],
      warnings: [],
      evidence: { handoff: [], active: [], recentWork: [], supplemental: [] },
    });
    mocks.createRetrievalTrace.mockResolvedValue("trace-post-validation");

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ prompt: "", sessionKind: "post_compaction_validation" }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    parseRecallResponse(body);
    const injection = String(body.prependContext);
    expect(injection).toContain("compaction_projection:");
    expect(injection).toContain("phase: post_validation");
    expect(injection).not.toContain("  env:");
    expect(injection).not.toContain("  evidence_titles:");
    for (const section of ["  focus:", "  state:", "  next:", "  directives:"]) {
      expect(injection).toContain(section);
    }
  });

  it("compaction with no continuity content returns honest empty — never the hybrid lane (Codex finding 2)", async () => {
    setupCompactionRouteMocks();
    mocks.getProjectStateForRecall.mockResolvedValue({ projectState: null, usedPathFallback: false });
    mocks.listContinuityMemoryHits.mockResolvedValue([]);
    mocks.buildSessionOpenerPayload.mockReturnValue(null);

    const app = makeApp();
    const res = await postRecall(app, makeRecallRequest({ prompt: "", sessionKind: "post_compaction_validation" }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    parseRecallResponse(body);
    expect(body.prependContext).toBeNull();
    expect(body.count).toBe(0);
    expect(body.continuitySource).toBe("deterministic");
    expect(body.selected as unknown[]).toHaveLength(0);
    expect(body.sessionOpener).toBeUndefined();
    // No hybrid refill: nothing was embedded, nothing was queried.
    expect(mocks.embedQuery).not.toHaveBeenCalled();
    expect(mocks.runHybridQuery).not.toHaveBeenCalled();
  });

  it("shape parity: all success branches emit same selected[] entry shape", async () => {
    // Main branch shape
    setupStandardMocks();
    const app = makeApp();
    const mainRes = await postRecall(app, makeRecallRequest());
    const mainBody = await mainRes.json() as Record<string, unknown>;
    const mainEntries = mainBody.selected as Array<Record<string, unknown>>;
    const mainKeys = Object.keys(mainEntries[0]).sort();

    // Continuity non-opener branch shape
    vi.clearAllMocks();
    mocks.resolveUserId.mockReturnValue("owner");
    mocks.shouldSkipRetrieval.mockReturnValue(false);
    mocks.analyzeIntent.mockReturnValue({ label: "recall", categories: [] });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: { useDeterministicContinuity: true, retrievalPath: "hybrid", hexis: { enabled: false }, lane: "continuity", selectorProfile: "default", admissibilityContract: undefined },
      recipe: { id: "continuity", version: 1 },
    });
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({ id: "sess-test", projectIdentitySource: "session", status: "open", closeReason: null });
    mocks.getProjectStateForRecall.mockResolvedValue({
      projectState: { id: "ps-1", latestProgress: "progress", updatedAt: "2026-01-01", path: "/test", supportingMemoryIds: [] },
      usedPathFallback: false,
    });
    mocks.listContinuityMemoryHits.mockResolvedValue([]);
    mocks.postProcessRecallResults.mockReturnValue({
      selected: CANNED_HITS,
      renderedText: ["line"],
      accessTrackedIds: CANNED_HITS.map((h) => h.id),
      admissibility: {},
    });
    mocks.formatRecallInjectionFromRendered.mockReturnValue("<ctx>cont</ctx>");
    mocks.buildSessionOpenerPayload.mockReturnValue(null);
    mocks.createRetrievalTrace.mockResolvedValue("trace-cont");

    const contApp = makeApp();
    const contRes = await postRecall(contApp, makeRecallRequest({ sessionKind: "turn" }));
    const contBody = await contRes.json() as Record<string, unknown>;
    const contEntries = contBody.selected as Array<Record<string, unknown>>;
    const contKeys = Object.keys(contEntries[0]).sort();

    // Both entry shapes should have the same keys
    expect(mainKeys).toEqual(contKeys);
  });
});
