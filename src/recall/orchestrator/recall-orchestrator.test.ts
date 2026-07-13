/**
 * Smoke test for orchestrateRecall (Rúnir-qjn4.2).
 *
 * Proves the extracted orchestrator is callable with an injected `deps` object
 * and no HTTP server: one skipped/adaptive path (zero deps touched) and one
 * happy hybrid path (deps + mocked dependency modules). The byte-identical
 * response contract is proven exhaustively by the existing recall-contract
 * suites that drive the route end-to-end; this file only guards the seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchHit } from "../../domain/memory/types.js";
import type { RecallOrchestratorDeps } from "./recall-orchestrator.js";

const mocks = vi.hoisted(() => ({
  shouldSkipRetrieval: vi.fn(),
  analyzeIntent: vi.fn(),
  resolveRetrievalController: vi.fn(),
  resolveNoemaRetrievalPolicy: vi.fn(),
  resolveRankingProfile: vi.fn(),
  resolveActiveHexisCached: vi.fn(),
  resolveCanonicalContextIdentity: vi.fn(),
  resolveRunirSession: vi.fn(),
  runHybridQuery: vi.fn(),
  postProcessRecallResults: vi.fn(),
  applyHexisByPolicy: vi.fn(),
  buildSessionOpenerPayload: vi.fn(),
  formatRecallInjectionFromRendered: vi.fn(),
  createRetrievalTrace: vi.fn(),
  relevanceGateDrops: vi.fn(),
  finalizeTrace: vi.fn(),
}));

vi.mock("../intent/adaptive-retrieval.js", () => ({
  shouldSkipRetrieval: mocks.shouldSkipRetrieval,
}));
vi.mock("../intent/intent-analyzer.js", () => ({
  analyzeIntent: mocks.analyzeIntent,
  applyCategoryBoost: vi.fn((hits: SearchHit[]) => hits),
  isStatusClassIntent: (label: string) =>
    label === "current_status" || label === "session_opener"
    || label === "pre_compaction" || label === "post_compaction_validation",
}));
vi.mock("../policy/retrieval-controller.js", () => ({
  resolveRetrievalController: mocks.resolveRetrievalController,
  applyHexisByPolicy: mocks.applyHexisByPolicy,
}));
vi.mock("../policy/noema-retrieval-policy.js", () => ({
  resolveNoemaRetrievalPolicy: mocks.resolveNoemaRetrievalPolicy,
}));
vi.mock("../policy/ranking-profile.js", () => ({
  resolveRankingProfile: mocks.resolveRankingProfile,
  // mmg2.2: only reached on status-class intents; this test uses "recall" so it
  // is never called, but the export must exist for the module import to resolve.
  getLearnedNoiseProfile: vi.fn(() => Promise.resolve({ learnedNoiseIds: new Set<string>(), threshold: 5 })),
}));
vi.mock("../policy/recipe-registry.js", () => ({
  buildRecipeTraceMetadata: vi.fn(() => ({ id: "test", version: 1 })),
}));
vi.mock("../policy/calibration-telemetry.js", () => ({
  buildRetrievalCalibrationTelemetry: vi.fn(() => ({})),
}));
vi.mock("../latest-state/run-latest-state-lane.js", () => ({
  runLatestStateLane: vi.fn(),
}));
vi.mock("../continuity/session-opener.js", () => ({
  buildSessionOpenerPayload: mocks.buildSessionOpenerPayload,
  formatSessionOpenerInjection: vi.fn(() => "<opener/>"),
}));
vi.mock("../query/memory-query.js", () => ({
  runHybridQueryWithEvidenceTable: vi.fn((input: any) => mocks.runHybridQuery(input)),
}));
vi.mock("../query/scope-predicate.js", () => ({
  applyPathScorePenalty: vi.fn((hits: SearchHit[]) => hits),
  applyRecallSoftFilters: vi.fn((hits: SearchHit[]) => hits),
  mergeFilters: vi.fn((...filters: unknown[]) => filters[0] ?? {}),
  resolveAttributionFilter: vi.fn(() => undefined),
  resolveAttrField: vi.fn((v: unknown) => (typeof v === "string" ? v : undefined)),
  resolvePathRecallFilter: vi.fn(() => undefined),
  resolveScopeFilter: vi.fn(() => undefined),
}));
vi.mock("../selection/recall-selection.js", () => ({
  postProcessRecallResults: mocks.postProcessRecallResults,
  formatRecallInjectionFromRendered: mocks.formatRecallInjectionFromRendered,
}));
vi.mock("../selection/relevance-gate.js", () => ({
  relevanceGateDrops: mocks.relevanceGateDrops,
  RECALL_RELEVANCE_FLOOR: 0.55,
}));
vi.mock("../selection/retrieval-trace.js", () => ({
  TraceCollector: class {
    stages: unknown[] = [];
    startStage = vi.fn();
    endStage = vi.fn();
    finalize = (...args: unknown[]) => mocks.finalizeTrace(...args);
    summarize = vi.fn(() => "");
  },
}));
vi.mock("../../storage/surreal/surreal-store.js", () => ({
  extractId: vi.fn((id: string) => id),
  getProjectStateForRecall: vi.fn(() => Promise.resolve({ projectState: null, usedPathFallback: false })),
  listContinuityMemoryHits: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../storage/surreal/phase2-store.js", () => ({
  createRetrievalTrace: mocks.createRetrievalTrace,
  toRetrievalFootprintIdentitySnapshot: vi.fn(() => ({})),
  getPrimaryMemoryRowsByIds: vi.fn(() => Promise.resolve([])),
  queryLearnedStatusNoiseIds: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../storage/surreal/runir-session-store.js", () => ({
  resolveRunirSession: mocks.resolveRunirSession,
}));
vi.mock("../../identity/canonical-context.js", () => ({
  resolveCanonicalContextIdentity: mocks.resolveCanonicalContextIdentity,
  formatCanonicalContextForDebug: vi.fn(() => "ctx:test"),
}));
vi.mock("../../hexis/active-hexis-cache.js", () => ({
  resolveActiveHexisCached: mocks.resolveActiveHexisCached,
  hasAdditionalHexisHintSignal: vi.fn(() => false),
}));

import { orchestrateRecall } from "./recall-orchestrator.js";

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
  { id: "hit-1", text: "First", score: 0.9, memoryRole: "project_state" },
  { id: "hit-2", text: "Second", score: 0.6 },
];

function makeDeps(overrides: Partial<RecallOrchestratorDeps> = {}): RecallOrchestratorDeps {
  return {
    db: { query: vi.fn(() => Promise.resolve([])) } as any,
    provider: { embedQuery: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])) } as any,
    overlayRegistry: { forUser: vi.fn(() => ({ snapshot: vi.fn(() => []) })) } as any,
    cfg: { topK: 5, reranker: undefined } as any,
    debugLogger: { recallResults: vi.fn(), retrievalTrace: vi.fn() } as any,
    retrievalStats: { recordQuery: vi.fn() } as any,
    resolveActiveHexis: vi.fn(() => Promise.resolve(null)) as any,
    ...overrides,
  };
}

describe("orchestrateRecall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: relevance gate OFF, so existing tests behave as before. Gate-firing test overrides.
    mocks.relevanceGateDrops.mockReturnValue(false);
    // Default: trace finalize → null, so non-debug tests stay hybrid_plain. Debug test overrides.
    mocks.finalizeTrace.mockReturnValue(null);
  });

  it("skipped path: returns {skipped, reason:'adaptive'} without touching deps", async () => {
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    const deps = makeDeps();

    const result = await orchestrateRecall(deps, { body: {}, prompt: "", uid: "owner" });

    expect(result.kind).toBe("skipped");
    expect(result.body).toEqual({ skipped: true, reason: "adaptive" });
    expect(result.statusCode).toBeUndefined();
    // No singleton was consulted on the skip path.
    expect((deps.provider as any).embedQuery).not.toHaveBeenCalled();
    expect((deps.db as any).query).not.toHaveBeenCalled();
  });

  it("happy hybrid path: returns hybrid_plain with selected[] from injected deps", async () => {
    mocks.shouldSkipRetrieval.mockReturnValue(false);
    mocks.analyzeIntent.mockReturnValue({ label: "recall", categories: [] });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: {
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        retrievalPath: "hybrid",
        hexis: { enabled: false },
        lane: "recall",
        selectorProfile: "default",
        admissibilityContract: undefined,
        rrfWeights: {},
        recencyWindowHours: 0,
      },
      recipe: { id: "default", version: 1 },
    });
    mocks.resolveNoemaRetrievalPolicy.mockReturnValue({ id: "noema", mode: "off", reason: "test" });
    mocks.resolveRankingProfile.mockReturnValue(undefined);
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({ id: "sess-test", projectIdentitySource: "session", status: "open", closeReason: null });
    mocks.runHybridQuery.mockResolvedValue(CANNED_HITS);
    mocks.applyHexisByPolicy.mockReturnValue({
      hits: CANNED_HITS,
      gate: { enabled: false, reason: "disabled", admissibleIds: [], reorderWindow: 5, ambiguityGap: 0 },
    });
    mocks.postProcessRecallResults.mockReturnValue({
      selected: CANNED_HITS,
      renderedText: ["line 1"],
      accessTrackedIds: CANNED_HITS.map((h) => h.id),
      admissibility: {},
    });
    mocks.formatRecallInjectionFromRendered.mockReturnValue("<ctx>memory</ctx>");
    mocks.buildSessionOpenerPayload.mockReturnValue(null);
    mocks.createRetrievalTrace.mockResolvedValue("trace-abc");

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, {
      body: { sessionId: "sess-test" },
      prompt: "what was I working on?",
      uid: "owner",
    });

    expect(result.kind).toBe("hybrid_plain");
    expect(result.statusCode).toBeUndefined();
    expect(result.body.prependContext).toBe("<ctx>memory</ctx>");
    expect(result.body.count).toBe(1);
    expect(result.body.retrievalTraceId).toBe("trace-abc");
    const selected = result.body.selected as Array<Record<string, unknown>>;
    expect(selected).toHaveLength(2);
    expect(selected[0]).toMatchObject({ id: "hit-1", content: "First", rank: 1, role: "project_state" });
    expect(selected[1]).toMatchObject({ id: "hit-2", content: "Second", rank: 2 });
    // Injected singletons were exercised (no module-scope runtime capture).
    expect((deps.provider as any).embedQuery).toHaveBeenCalledOnce();
  });

  it("relevance gate fires (Rúnir-2i8k): returns EMPTY + zeroed audit + relevance_gated reason", async () => {
    // Same hybrid TURN setup as the happy path, but the relevance gate fires (top hit below floor).
    mocks.shouldSkipRetrieval.mockReturnValue(false);
    mocks.analyzeIntent.mockReturnValue({ label: "recall", categories: [] });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: {
        useDeterministicContinuity: false,
        useLatestStateResolution: false,
        retrievalPath: "hybrid",
        hexis: { enabled: false },
        lane: "recall",
        selectorProfile: "default",
        admissibilityContract: undefined,
        rrfWeights: {},
        recencyWindowHours: 0,
      },
      recipe: { id: "default", version: 1 },
    });
    mocks.resolveNoemaRetrievalPolicy.mockReturnValue({ id: "noema", mode: "off", reason: "test" });
    mocks.resolveRankingProfile.mockReturnValue(undefined);
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({ id: "sess-test", projectIdentitySource: "session", status: "open", closeReason: null });
    mocks.runHybridQuery.mockResolvedValue(CANNED_HITS);
    mocks.applyHexisByPolicy.mockReturnValue({
      hits: CANNED_HITS,
      gate: { enabled: false, reason: "disabled", admissibleIds: [], reorderWindow: 5, ambiguityGap: 0 },
    });
    mocks.postProcessRecallResults.mockReturnValue({
      selected: CANNED_HITS,
      renderedText: ["line 1"],
      accessTrackedIds: CANNED_HITS.map((h) => h.id),
      admissibility: {},
    });
    mocks.formatRecallInjectionFromRendered.mockReturnValue("<ctx>memory</ctx>");
    mocks.buildSessionOpenerPayload.mockReturnValue(null);
    mocks.createRetrievalTrace.mockResolvedValue("trace-abc");
    // THE GATE FIRES (top hit's rerank cosine below the floor):
    mocks.relevanceGateDrops.mockReturnValue(true);
    // Truthy finalTrace + hexisDebug → reach the hybrid_debug envelope so we can assert telemetry.
    mocks.finalizeTrace.mockReturnValue({});

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, {
      body: { sessionId: "sess-test", hexisDebug: true },
      prompt: "what is the unrelated thing nobody stored?",
      uid: "owner",
    });

    // Load-bearing contract: gate fires → EMPTY agent-facing response (nothing irrelevant injected).
    expect(result.kind).toBe("hybrid_debug");
    expect(result.body.prependContext).toBeNull();
    expect(result.body.count).toBe(0);
    expect(result.body.selected as unknown[]).toHaveLength(0);
    // Telemetry: gate recorded, audit zeroed, honest empty reason.
    const dbg = result.body._debug as Record<string, any>;
    expect(dbg.relevanceGate).toMatchObject({ floor: 0.55, droppedIds: ["hit-1", "hit-2"] });
    expect(dbg.rywDiagnostic.emptyReason).toBe("relevance_gated");
    expect(dbg.retrievalAudit.attribution.finalSelectedIds).toHaveLength(0);
    // Dropped hits are NOT access-tracked (nothing was shown to the agent).
    const updateCalls = (deps.db as any).query.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("accessCount"));
    expect(updateCalls).toHaveLength(0);
  });

  it("OM-1 no-refill guard (Rúnir-tfxt.1): budget-emptied deterministic recall returns empty, never refills from hybrid", async () => {
    mocks.shouldSkipRetrieval.mockReturnValue(false);
    mocks.analyzeIntent.mockReturnValue({ label: "current_status", categories: [], depth: "full", confidence: 0.9 });
    mocks.resolveRetrievalController.mockReturnValue({
      policy: {
        useDeterministicContinuity: true,
        useLatestStateResolution: false,
        retrievalPath: "deterministic",
        hexis: { enabled: false },
        lane: "status",
        selectorProfile: "status_continuity",
        admissibilityContract: undefined,
        rrfWeights: {},
        recencyWindowHours: 0,
      },
      recipe: { id: "status", version: 1 },
    });
    mocks.resolveNoemaRetrievalPolicy.mockReturnValue({ id: "noema", mode: "off", reason: "test" });
    mocks.resolveRankingProfile.mockReturnValue(undefined);
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({ id: "sess-test", projectIdentitySource: "session", status: "open", closeReason: null });
    // The deterministic lane found continuity content…
    const { listContinuityMemoryHits } = await import("../../storage/surreal/surreal-store.js");
    vi.mocked(listContinuityMemoryHits).mockResolvedValueOnce([
      { id: "cont-1", text: "Continuity status line", score: 1 },
    ] as any);
    // …but the budget fit dropped everything (tiny budget).
    mocks.postProcessRecallResults.mockReturnValue({
      selected: [],
      renderedText: [],
      accessTrackedIds: [],
      dropped: [],
      budgetFit: { budgetTokens: 5, approximateTokens: 0, depth: "l0", degraded: true, droppedIds: ["cont-1"] },
    });
    mocks.buildSessionOpenerPayload.mockReturnValue(null);

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, {
      body: { sessionId: "sess-test", budgetTokens: 5 },
      prompt: "what is the current status?",
      uid: "owner",
    });

    // Honest empty under-budget response from the deterministic lane…
    expect(result.kind).toBe("deterministic_plain");
    expect(result.statusCode).toBeUndefined();
    expect(result.body.prependContext).toBeNull();
    expect(result.body.count).toBe(0);
    expect(result.body.budgetFit).toMatchObject({ budgetTokens: 5, droppedIds: ["cont-1"] });
    // …and NO refill: the hybrid lane was never consulted.
    expect((deps.provider as any).embedQuery).not.toHaveBeenCalled();
    expect(mocks.runHybridQuery).not.toHaveBeenCalled();
  });

  // ── OM-2 (Rúnir-tfxt.2): compaction-render projection ──────────────────────

  const COMPACTION_POLICY = {
    policy: {
      useDeterministicContinuity: true,
      useLatestStateResolution: false,
      retrievalPath: "deterministic",
      hexis: { enabled: false },
      lane: "compaction_projection",
      selectorProfile: "status_continuity",
      admissibilityContract: undefined,
      rrfWeights: {},
      recencyWindowHours: 0,
    },
    recipe: { id: "compaction_projection", version: 1 },
  };

  const COMPACTION_PAYLOAD = {
    intent: "continue_previous_work",
    confidence: "medium",
    scope: { project: "proj", area: "src/x.ts", path: "/tmp/proj" },
    status: "active",
    focus: ["Finish the exporter"],
    state: ["Exporter re-point landed"],
    env: [],
    next: ["Wire the CLI runner"],
    directives: [],
    evidenceTitles: ["Exporter status"],
    warnings: [],
  };

  function setupCompaction(sessionKind: string) {
    mocks.analyzeIntent.mockImplementation((_prompt: string, opts?: { hint?: string }) => ({
      label: opts?.hint ?? "fact",
      categories: [],
      depth: "l1",
      confidence: 0.95,
    }));
    mocks.resolveRetrievalController.mockReturnValue(COMPACTION_POLICY);
    mocks.resolveNoemaRetrievalPolicy.mockReturnValue({ id: "noema", mode: "off", reason: "test" });
    mocks.resolveRankingProfile.mockReturnValue(undefined);
    mocks.resolveActiveHexisCached.mockResolvedValue(null);
    mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
    mocks.resolveRunirSession.mockResolvedValue({ id: "sess-test", projectIdentitySource: "session", status: "open", closeReason: null });
    return { body: { sessionId: "sess-test", sessionKind }, prompt: "", uid: "owner" };
  }

  it("OM-2: empty-prompt pre_compaction ping bypasses the adaptive skip and returns an honest empty (no hybrid)", async () => {
    // shouldSkipRetrieval would skip an empty prompt — the compaction hint must
    // bypass it entirely (same class as the OM-1 opener-bypass finding).
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    const request = setupCompaction("pre_compaction");

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, request);

    expect(mocks.shouldSkipRetrieval).not.toHaveBeenCalled();
    expect(mocks.analyzeIntent).toHaveBeenCalledWith("", { hint: "pre_compaction" });
    // Deterministic lane found nothing (default surreal mocks) → honest empty,
    // NEVER the hybrid lane.
    expect(result.kind).toBe("deterministic_compaction");
    expect(result.body.prependContext).toBeNull();
    expect(result.body.count).toBe(0);
    expect(result.body.selected as unknown[]).toHaveLength(0);
    expect("budgetFit" in result.body).toBe(false);
    expect((deps.provider as any).embedQuery).not.toHaveBeenCalled();
    expect(mocks.runHybridQuery).not.toHaveBeenCalled();
  });

  it("OM-2: compaction projection with content returns deterministic_compaction with the payload + fitted trace", async () => {
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    const request = setupCompaction("pre_compaction");
    const contHit = { id: "cont-1", text: "Continuity status line", score: 1 };
    const { listContinuityMemoryHits } = await import("../../storage/surreal/surreal-store.js");
    vi.mocked(listContinuityMemoryHits).mockResolvedValueOnce([contHit] as any);
    mocks.postProcessRecallResults.mockReturnValue({
      selected: [contHit],
      renderedText: ["Continuity status line"],
      accessTrackedIds: ["cont-1"],
      dropped: [],
    });
    mocks.buildSessionOpenerPayload.mockReturnValue(COMPACTION_PAYLOAD);
    mocks.createRetrievalTrace.mockResolvedValue("trace-compaction");

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, request);

    expect(result.kind).toBe("deterministic_compaction");
    expect(result.body.sessionOpener).toBe(COMPACTION_PAYLOAD);
    expect(result.body.count).toBe(1);
    expect(result.body.retrievalTraceId).toBe("trace-compaction");
    // The REAL compaction renderer ran (module is unmocked): honest root key.
    expect(String(result.body.prependContext)).toContain("compaction_projection:");
    expect(String(result.body.prependContext)).toContain("phase: pre");
    // No budget → no fit audit; trace items = the fitted (= full) selection.
    expect("budgetFit" in result.body).toBe(false);
    const traceArgs = mocks.createRetrievalTrace.mock.calls[0][1];
    expect(traceArgs.items.map((i: { id: string }) => i.id)).toEqual(["cont-1"]);
    expect(mocks.runHybridQuery).not.toHaveBeenCalled();
  });

  it("OM-2: budget-emptied compaction projection returns honest empty with audit — dropped hits never traced, no hybrid refill", async () => {
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    const request = setupCompaction("post_compaction_validation");
    (request.body as Record<string, unknown>).budgetTokens = 5;
    const contHit = { id: "cont-1", text: "Continuity status line", score: 1 };
    const { listContinuityMemoryHits } = await import("../../storage/surreal/surreal-store.js");
    vi.mocked(listContinuityMemoryHits).mockResolvedValueOnce([contHit] as any);
    mocks.postProcessRecallResults.mockReturnValue({
      selected: [contHit],
      renderedText: ["Continuity status line"],
      accessTrackedIds: ["cont-1"],
      dropped: [],
    });
    // The (mocked) payload builder returns the same payload however few hits
    // remain, so no prefix can fit a 5-token ceiling → honest empty.
    mocks.buildSessionOpenerPayload.mockReturnValue(COMPACTION_PAYLOAD);

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, request);

    expect(result.kind).toBe("deterministic_compaction");
    expect(result.body.prependContext).toBeNull();
    expect(result.body.count).toBe(0);
    expect(result.body.selected as unknown[]).toHaveLength(0);
    expect("sessionOpener" in result.body).toBe(false);
    expect(result.body.budgetFit).toMatchObject({
      budgetTokens: 5,
      approximateTokens: 0,
      degraded: true,
      droppedIds: ["cont-1"],
    });
    // Nothing was shown → nothing traced, nothing refilled.
    expect(mocks.createRetrievalTrace).not.toHaveBeenCalled();
    expect((deps.provider as any).embedQuery).not.toHaveBeenCalled();
    expect(mocks.runHybridQuery).not.toHaveBeenCalled();
  });

  it("OM-2 (Codex round-2 finding 1): debug trace.hits/finalSelectedIds reflect the FITTED set, never budget-dropped ids", async () => {
    mocks.shouldSkipRetrieval.mockReturnValue(true);
    const request = setupCompaction("pre_compaction");
    (request.body as Record<string, unknown>).hexisDebug = true;

    const psRecord = {
      id: "ps-1",
      userId: "owner",
      latestProgress: "exporter re-point landed",
      updatedAt: "2026-07-01T00:00:00Z",
      path: "/tmp/proj",
      supportingMemoryIds: [],
      blockers: [],
      nextSteps: [],
      activeTicketIds: [],
      confidence: 0.9,
      version: 1,
    };
    const psHit = { id: "ps-1", text: "exporter re-point landed", score: 1, memoryRole: "project_state" };
    const contHit = { id: "cont-1", text: `Long continuity detail. ${"x".repeat(600)}`, score: 0.8 };
    const { getProjectStateForRecall, listContinuityMemoryHits } = await import("../../storage/surreal/surreal-store.js");
    vi.mocked(getProjectStateForRecall).mockResolvedValueOnce({ projectState: psRecord, usedPathFallback: false } as any);
    vi.mocked(listContinuityMemoryHits).mockResolvedValueOnce([contHit] as any);
    mocks.postProcessRecallResults.mockReturnValue({
      selected: [psHit, contHit],
      renderedText: ["exporter re-point landed", "Long continuity detail."],
      accessTrackedIds: ["ps-1", "cont-1"],
      dropped: [],
    });
    // Payload render grows with the hits fed in, so the fit can PARTIALLY
    // drop: the budget below admits the hit-less render but not cont-1's.
    mocks.buildSessionOpenerPayload.mockImplementation(
      (args: { hits: Array<{ text: string }> }) => ({
        ...COMPACTION_PAYLOAD,
        state: args.hits.map((h) => h.text),
      }),
    );
    mocks.createRetrievalTrace.mockResolvedValue("trace-compaction-debug");
    const { formatCompactionProjectionInjection } = await import("../continuity/compaction-projection.js");
    const { approximateTokens } = await import("../policy/preference-packet.js");
    const budgetTokens = approximateTokens(
      formatCompactionProjectionInjection({ ...COMPACTION_PAYLOAD, state: [] } as any, "pre"),
    );
    (request.body as Record<string, unknown>).budgetTokens = budgetTokens;

    const deps = makeDeps();
    const result = await orchestrateRecall(deps, request);

    expect(result.kind).toBe("deterministic_compaction");
    expect(result.body.budgetFit).toMatchObject({ degraded: true, droppedIds: ["cont-1"] });
    const selected = result.body.selected as Array<{ id: string }>;
    expect(selected.map((s) => s.id)).toEqual(["ps-1"]);
    // The debug envelope must expose the SAME fitted view — a budget-dropped
    // id in trace.hits or finalSelectedIds would claim cont-1 was shown.
    const dbg = result.body._debug as Record<string, any>;
    expect(dbg.trace.hits.map((h: { id: string }) => h.id)).toEqual(["ps-1"]);
    expect(dbg.retrievalAudit.finalSelectedIds).toEqual(["ps-1"]);
    const traceArgs = mocks.createRetrievalTrace.mock.calls[0][1];
    expect(traceArgs.items.map((i: { id: string }) => i.id)).toEqual(["ps-1"]);
    expect(traceArgs.accessTrackedIds).toEqual(["ps-1"]);
  });
});
