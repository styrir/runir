import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { SearchHit } from "../domain/memory/types.js";
import type { CanonicalContextIdentity } from "../identity/canonical-context.js";
import {
  PROCESSING_LINEAGE_ORIGIN,
  PROCESSING_LINEAGE_STATE,
  PROCESSING_LINEAGE_VERSION,
  PROCESSING_POLICY_VERSION,
} from "../domain/memory/processing-lineage.js";
import {
  attachSearchHitLineage,
  attachSelectedSearchHitLineage,
  getSearchHitLineage,
} from "../domain/memory/search-hit-lineage.js";
import {
  formatRecallInjection,
  formatRecallInjectionFromRendered,
  toAuditSearchResults,
  toToolSearchResults,
} from "../recall/selection/recall-selection.js";
import { TraceCollector } from "../recall/selection/retrieval-trace.js";
import { buildCaptureContextPacket } from "../capture/capture-context-assembler.js";
import { registerMemoryRoutes } from "../app/routes/memory/index.js";
import { registerHookRoutes } from "../app/routes/hooks/index.js";

const mocks = vi.hoisted(() => {
  const embedQuery = vi.fn();
  const embedDocument = vi.fn();
  const fingerprint = vi.fn();
  const db = { query: vi.fn().mockResolvedValue([[]]) };
  const cfg = {
    userId: "owner",
    autoRecall: true,
    autoCapture: true,
    topK: 5,
    customPrompt: undefined,
    extractModel: undefined,
    extractTimeoutMs: 1_000,
    extractMaxChars: 4_000,
    reranker: { provider: "off" as const },
  };
  return {
  cfg,
  db,
  provider: { embedQuery, embedDocument, fingerprint },
  runHybridQueryWithEvidenceTable: vi.fn(),
  runHybridQueryWithEvidenceTableAndEntityTrace: vi.fn(),
  embedQuery,
  embedDocument,
  fingerprint,
  resolveUserId: vi.fn(),
  resolveScopeFilter: vi.fn(),
  resolveAttrField: vi.fn(),
  resolveRankingProfile: vi.fn(),
  resolveCanonicalContextIdentity: vi.fn(),
  resolveBodyCanonicalContext: vi.fn(),
  resolveActiveHexis: vi.fn(),
  resolveActiveHexisCached: vi.fn(),
  resolveCaptureApiKey: vi.fn(),
  resolveLlmBaseUrl: vi.fn(),
  resolveLlmTimeoutMs: vi.fn(),
  getMemoryLineage: vi.fn(),
  getProjectStateForCaptureContext: vi.fn(),
  listNearbyExistingForCaptureContext: vi.fn(),
  listRecentFactsForCaptureContext: vi.fn(),
  getRetrievalFootprintFromTrace: vi.fn(),
  retrievalFootprintIdentityMatches: vi.fn(),
  toRetrievalFootprintIdentitySnapshot: vi.fn(),
  listRetrievalTraces: vi.fn(),
  getRetrievalTrace: vi.fn(),
  patchRetrievalTraceCaptureReceipt: vi.fn(),
  patchRetrievalTraceRating: vi.fn(),
  getPrimaryMemoryRowsByIds: vi.fn(),
  patchSemioteUsefulness: vi.fn(),
  promoteSemioteToNoema: vi.fn(),
  batchDedupFacts: vi.fn(),
  extractMemories: vi.fn(),
  isNoisyFact: vi.fn(),
  normalizeCaptureMessages: vi.fn(),
  normalizeExtractedFact: vi.fn(),
  resolveCapturePrompt: vi.fn(),
  compressMessages: vi.fn(),
  compressMessagesWithIndices: vi.fn(),
  scoreSessionSalience: vi.fn(),
  buildWarmedProjectState: vi.fn(),
  resolveRunirSession: vi.fn(),
  linkEntityToMemory: vi.fn(),
  getProjectEnrollment: vi.fn(),
  upsertProjectEnrollment: vi.fn(),
  ingestEvidenceBatch: vi.fn(),
  runConsolidationForScope: vi.fn(),
  resolveSemioteOriginContext: vi.fn(),
  recordPipelineDrop: vi.fn(),
  applyUsefulnessFeedback: vi.fn(),
  accrueUsefulnessFromCapture: vi.fn(),
  writeWithArbitration: vi.fn(),
  deriveContinuityMetadata: vi.fn(),
  factMetadata: vi.fn(),
  createWatermark: vi.fn(),
  getLastWatermark: vi.fn(),
  extractId: vi.fn(),
  logRejection: vi.fn(),
  getProjectState: vi.fn(),
  upsertProjectState: vi.fn(),
  redactFact: vi.fn(),
  scoreHexisFit: vi.fn(),
  prepareSourceTurn: vi.fn(),
  sourceKeyFingerprint: vi.fn(),
  assertSourceKeyFingerprint: vi.fn(),
  upsertSourceTurn: vi.fn(),
  markFactSourceLink: vi.fn(),
  reconcileSourceTurnLinks: vi.fn(),
  };
});

vi.mock("../app/runtime.js", () => ({
  cfg: mocks.cfg,
  runtime: {
    db: mocks.db,
    overlayRegistry: { forUser: vi.fn().mockReturnValue({ snapshot: vi.fn().mockReturnValue([]) }) },
  },
  provider: mocks.provider,
  bm25StatsCache: new Map(),
  debugLogger: {
    salience: vi.fn(),
    entityExtraction: vi.fn(),
    entityOutcome: vi.fn(),
    recallResults: vi.fn(),
    retrievalTrace: vi.fn(),
  },
  noiseBank: { initialized: false, isNoise: vi.fn(), learn: vi.fn() },
  retrievalStats: { recordQuery: vi.fn() },
  resolveUserId: mocks.resolveUserId,
  resolveActiveHexis: mocks.resolveActiveHexis,
  deriveContinuityMetadata: mocks.deriveContinuityMetadata,
  factMetadata: mocks.factMetadata,
  writeWithArbitration: mocks.writeWithArbitration,
}));

vi.mock("../recall/query/memory-query.js", () => ({
  runHybridQueryWithEvidenceTable: mocks.runHybridQueryWithEvidenceTable,
  runHybridQueryWithEvidenceTableAndEntityTrace: mocks.runHybridQueryWithEvidenceTableAndEntityTrace,
  vectorSearch: vi.fn(),
}));

vi.mock("../recall/query/scope-predicate.js", () => ({
  resolveScopeFilter: mocks.resolveScopeFilter,
  resolveAttrField: mocks.resolveAttrField,
  resolveWriteScope: vi.fn(),
  resolveAttributionFilter: vi.fn(),
  resolvePathRecallFilter: vi.fn(),
  applyPathScorePenalty: vi.fn((hits: SearchHit[]) => hits),
  applyRecallSoftFilters: vi.fn((hits: SearchHit[]) => hits),
  mergeFilters: vi.fn(),
}));

vi.mock("../recall/policy/ranking-profile.js", () => ({
  resolveRankingProfile: mocks.resolveRankingProfile,
  EMPTY_PROFILE: {},
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  getMemoryLineage: mocks.getMemoryLineage,
  getProjectStateForCaptureContext: mocks.getProjectStateForCaptureContext,
  listNearbyExistingForCaptureContext: mocks.listNearbyExistingForCaptureContext,
  listRecentFactsForCaptureContext: mocks.listRecentFactsForCaptureContext,
  getMemoryById: vi.fn(),
  getMemoryHealth: vi.fn(),
  listMemories: vi.fn(),
  listRecentMemories: vi.fn(),
  restoreMemoryById: vi.fn(),
  deleteMemoryById: vi.fn(),
  getEmbeddingFingerprint: vi.fn().mockResolvedValue(null),
  ACTIVE_MEMORY_FILTER: "AND (active = NONE OR active = true)",
  extractId: mocks.extractId,
  logRejection: mocks.logRejection,
  getLastWatermark: mocks.getLastWatermark,
  createWatermark: mocks.createWatermark,
  getProjectState: mocks.getProjectState,
  upsertProjectState: mocks.upsertProjectState,
  ensureProjectStateTable: vi.fn(),
}));

vi.mock("../storage/surreal/phase2-store.js", () => ({
  getRetrievalFootprintFromTrace: mocks.getRetrievalFootprintFromTrace,
  retrievalFootprintIdentityMatches: mocks.retrievalFootprintIdentityMatches,
  toRetrievalFootprintIdentitySnapshot: mocks.toRetrievalFootprintIdentitySnapshot,
  listRetrievalTraces: mocks.listRetrievalTraces,
  getRetrievalTrace: mocks.getRetrievalTrace,
  patchRetrievalTraceCaptureReceipt: mocks.patchRetrievalTraceCaptureReceipt,
  patchRetrievalTraceRating: mocks.patchRetrievalTraceRating,
  getPrimaryMemoryRowsByIds: mocks.getPrimaryMemoryRowsByIds,
  patchSemioteUsefulness: mocks.patchSemioteUsefulness,
  promoteSemioteToNoema: mocks.promoteSemioteToNoema,
  TRACE_RATINGS: ["helped", "hurt", "unused", "missing", "stale"],
  upsertSemioteRelation: vi.fn(),
  patchRetrievalTraceAnswer: vi.fn(),
}));

vi.mock("../capture/extraction/capture.js", () => ({
  batchDedupFacts: mocks.batchDedupFacts,
  extractMemories: mocks.extractMemories,
  isNoisyFact: mocks.isNoisyFact,
  normalizeCaptureMessages: mocks.normalizeCaptureMessages,
  normalizeExtractedFact: mocks.normalizeExtractedFact,
  resolveCapturePrompt: mocks.resolveCapturePrompt,
  normalizeExtractedFactForTesting: vi.fn(),
}));

vi.mock("../capture/continuity/session-compressor.js", () => ({
  compressMessages: mocks.compressMessages,
  compressMessagesWithIndices: mocks.compressMessagesWithIndices,
}));

vi.mock("../capture/continuity/session-salience.js", () => ({
  scoreSessionSalience: mocks.scoreSessionSalience,
}));

vi.mock("../capture/continuity/project-state-warming.js", () => ({
  buildWarmedProjectState: mocks.buildWarmedProjectState,
}));

vi.mock("../capture/source-turn-identity.js", () => ({
  prepareSourceTurn: mocks.prepareSourceTurn,
  sourceKeyFingerprint: mocks.sourceKeyFingerprint,
}));

vi.mock("../capture/source-turn-spool.js", () => ({
  SourceTurnSpool: class {
    async commitCapture(): Promise<void> {}
    async drain(): Promise<void> {}
    snapshot() { return { appended: 0, replayed: 0, appendFailures: 0, persistFailures: 0, conflicts: 0, pending: 0, pendingBytes: 0 }; }
  },
}));

vi.mock("../storage/surreal/session-turn-store.js", () => ({
  assertSourceKeyFingerprint: mocks.assertSourceKeyFingerprint,
  SourceKeyMismatchError: class SourceKeyMismatchError extends Error {},
  upsertSourceTurn: mocks.upsertSourceTurn,
  recordSessionTurns: vi.fn(),
}));

vi.mock("../storage/surreal/source-turn-link-store.js", () => ({
  markFactSourceLink: mocks.markFactSourceLink,
  reconcileSourceTurnLinks: mocks.reconcileSourceTurnLinks,
  unlinkFactSource: vi.fn(),
}));

vi.mock("../shared/config.js", () => ({
  resolveCaptureApiKey: mocks.resolveCaptureApiKey,
  resolveLlmBaseUrl: mocks.resolveLlmBaseUrl,
  resolveLlmTimeoutMs: mocks.resolveLlmTimeoutMs,
}));

vi.mock("../hexis/runtime-hexis.js", () => ({
  scoreHexisFit: mocks.scoreHexisFit,
}));

vi.mock("../hexis/active-hexis-cache.js", () => ({
  resolveActiveHexisCached: mocks.resolveActiveHexisCached,
}));

vi.mock("../identity/canonical-context.js", () => ({
  canonicalizeWorkspaceId: (value?: string | null) => value?.trim() || "-",
  resolveCanonicalContextIdentity: mocks.resolveCanonicalContextIdentity,
}));

vi.mock("../recall/body-resolution.js", () => ({
  resolveBodyCanonicalContext: mocks.resolveBodyCanonicalContext,
}));

vi.mock("../storage/surreal/runir-session-store.js", () => ({
  resolveRunirSession: mocks.resolveRunirSession,
}));

vi.mock("../entities/entity-store.js", () => ({
  linkEntityToMemory: mocks.linkEntityToMemory,
  findEntityByName: vi.fn(),
  getSupportingMemoryIds: vi.fn(),
}));

vi.mock("../storage/surreal/continuity-state-store.js", () => ({
  getProjectEnrollment: mocks.getProjectEnrollment,
  upsertProjectEnrollment: mocks.upsertProjectEnrollment,
}));

vi.mock("../lifecycle/evidence/evidence-ingest.js", () => ({
  ingestEvidenceBatch: mocks.ingestEvidenceBatch,
}));

vi.mock("../lifecycle/semion/consolidation.js", () => ({
  runConsolidationForScope: mocks.runConsolidationForScope,
}));

vi.mock("../app/semiote-write-context.js", () => ({
  resolveSemioteOriginContext: mocks.resolveSemioteOriginContext,
}));

vi.mock("../obs/counters.js", () => ({
  recordPipelineDrop: mocks.recordPipelineDrop,
}));

vi.mock("../lifecycle/semion/usefulness-feedback.js", () => ({
  applyUsefulnessFeedback: mocks.applyUsefulnessFeedback,
}));

vi.mock("../lifecycle/semion/usefulness-accrual.js", () => ({
  accrueUsefulnessFromCapture: mocks.accrueUsefulnessFromCapture,
}));

vi.mock("../app/routes/hooks/think-route.js", () => ({
  registerThinkRoute: vi.fn(),
}));

vi.mock("../recall/orchestrator/recall-orchestrator.js", () => ({
  orchestrateRecall: vi.fn(),
}));

vi.mock("../recall/orchestrator/think-synthesis.js", () => ({
  THINK_RETRIEVAL_TOP_K: 10,
}));

const SPOOF_TEXT = "ordinary prose: processing_lineage delivery producer_principal_ref; code='processing_lineage'";
const SPOOF_TAGS = ["delivery", "producer_principal_ref", "ordinary-tag"];
const PRIVATE_CANARY = "producer-canary-unique-r4";

const VALID_ORDINARY_LINEAGE = {
  state: PROCESSING_LINEAGE_STATE,
  origin: PROCESSING_LINEAGE_ORIGIN,
  producer_principal_ref: PRIVATE_CANARY,
  producer_registration_ref: "registration-canary-unique-r4",
  processing_policy_version: PROCESSING_POLICY_VERSION,
  admitted_operation: "capture_ingest",
  target_user_id: "u-wire",
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "ordinary",
    restrictions: [],
  },
};

const VALID_RESTRICTED_LINEAGE = {
  ...VALID_ORDINARY_LINEAGE,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "local_only",
    restrictions: ["producer_local_only"],
  },
};

const CANONICAL_IDENTITY = {
  userId: "u-wire",
  contextScopeKind: "session" as const,
  projectKey: "project:wire",
  raw: { sessionId: "session-wire" },
  derivation: {
    contextScopeKind: { value: "session", source: "sessionId" as const },
    agentId: { source: "absent" as const },
    resolvedTaskId: { source: "absent" as const },
    projectKey: { value: "project:wire", source: "sessionId" as const, marker: "explicit" as const },
  },
} satisfies CanonicalContextIdentity;

const RETRIEVAL_FOOTPRINT = {
  traceId: "trace-wire",
  identity: {
    userId: "u-wire",
    contextScopeKind: "session" as const,
    sessionId: "session-wire",
    projectKey: "project:wire",
    derivation: CANONICAL_IDENTITY.derivation,
  },
  shownMemoryIds: ["hit-wire"],
  selectedMemoryIds: ["hit-wire", "hit-nearby"],
  createdAt: "2026-10-02T00:00:00.000Z",
  retrievalPath: "hybrid",
  intentLabel: "recall",
  sessionId: "session-wire",
} as const;

function makeHit(id = "hit-wire"): SearchHit {
  return {
    id,
    text: SPOOF_TEXT,
    score: 0.91,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    tags: SPOOF_TAGS,
    path: "/tmp/ordinary-path",
    client: "processing_lineage-client",
    isStale: false,
    staleSince: "2026-10-01T09:00:00.000Z",
    contradictedBy: "replacement-wire",
    active: true,
    inactiveReason: "ordinary delivery data",
    supersededById: "replacement-wire",
    lineageRootId: "root-business-wire",
    confidence: 0.87,
    tier: "working",
    category: "cases",
    payload: {
      processing_lineage: "payload spoof data",
      delivery: "payload delivery data",
    },
    processing_lineage: "top-level spoof must be removed by attach",
  } as SearchHit & { payload: Record<string, string>; processing_lineage: string };
}

function attachVerified(hit: SearchHit, selected?: unknown): SearchHit {
  return attachSelectedSearchHitLineage(hit, arguments.length < 2 ? VALID_ORDINARY_LINEAGE : selected);
}

function seedCaptureContext(): void {
  const recent = attachVerified(makeHit());
  const nearby = attachVerified(makeHit("hit-nearby"), VALID_RESTRICTED_LINEAGE);
  mocks.listRecentFactsForCaptureContext.mockResolvedValue([recent]);
  mocks.listNearbyExistingForCaptureContext.mockResolvedValue([nearby]);
  mocks.getProjectStateForCaptureContext.mockResolvedValue({
    id: "project-state-wire",
    currentFocus: SPOOF_TEXT,
    latestProgress: "ordinary progress",
    blockers: ["delivery blocker data"],
    nextSteps: ["producer_principal_ref as next step data"],
    updatedAt: new Date().toISOString(),
    confidence: 0.8,
  });
  mocks.getRetrievalFootprintFromTrace.mockResolvedValue(RETRIEVAL_FOOTPRINT);
}

function resetMocks(): void {
  vi.clearAllMocks();
  mocks.resolveUserId.mockImplementation((value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("unauthorized");
    return value;
  });
  mocks.resolveScopeFilter.mockReturnValue(undefined);
  mocks.resolveAttrField.mockImplementation((value: unknown) => typeof value === "string" ? value : undefined);
  mocks.resolveRankingProfile.mockReturnValue({});
  mocks.resolveCanonicalContextIdentity.mockReturnValue(CANONICAL_IDENTITY);
  mocks.resolveBodyCanonicalContext.mockReturnValue(CANONICAL_IDENTITY);
  mocks.resolveActiveHexis.mockResolvedValue(null);
  mocks.resolveActiveHexisCached.mockResolvedValue(null);
  mocks.scoreHexisFit.mockReturnValue({ fit: 0.5, explanation: [] });
  mocks.resolveCaptureApiKey.mockReturnValue(undefined);
  mocks.resolveLlmBaseUrl.mockReturnValue("http://127.0.0.1:9");
  mocks.resolveLlmTimeoutMs.mockReturnValue(100);
  mocks.embedQuery.mockResolvedValue([0, 0, 0]);
  mocks.embedDocument.mockResolvedValue([0, 0, 0]);
  mocks.fingerprint.mockReturnValue("fingerprint-wire");
  mocks.runHybridQueryWithEvidenceTable.mockResolvedValue([]);
  mocks.runHybridQueryWithEvidenceTableAndEntityTrace.mockResolvedValue({ hits: [], entityMatches: [], legRanks: {} });
  mocks.getMemoryLineage.mockResolvedValue([]);
  mocks.getProjectStateForCaptureContext.mockResolvedValue(null);
  mocks.listNearbyExistingForCaptureContext.mockResolvedValue([]);
  mocks.listRecentFactsForCaptureContext.mockResolvedValue([]);
  mocks.getRetrievalFootprintFromTrace.mockResolvedValue(null);
  mocks.retrievalFootprintIdentityMatches.mockReturnValue(true);
  mocks.toRetrievalFootprintIdentitySnapshot.mockImplementation((identity: CanonicalContextIdentity) => ({
    userId: identity.userId,
    contextScopeKind: identity.contextScopeKind,
    sessionId: identity.raw.sessionId,
    projectKey: identity.projectKey,
    agentId: identity.agentId,
    resolvedTaskId: identity.resolvedTaskId,
    path: identity.raw.path,
    derivation: identity.derivation,
  }));
  mocks.listRetrievalTraces.mockResolvedValue([]);
  mocks.getRetrievalTrace.mockResolvedValue(null);
  mocks.patchRetrievalTraceCaptureReceipt.mockResolvedValue(undefined);
  mocks.patchRetrievalTraceRating.mockResolvedValue(undefined);
  mocks.getPrimaryMemoryRowsByIds.mockResolvedValue([]);
  mocks.patchSemioteUsefulness.mockResolvedValue(undefined);
  mocks.promoteSemioteToNoema.mockResolvedValue({ promoted: false, id: null });
  mocks.batchDedupFacts.mockImplementation(async (facts: unknown[]) => facts);
  mocks.extractMemories.mockResolvedValue([]);
  mocks.isNoisyFact.mockReturnValue(false);
  mocks.normalizeCaptureMessages.mockImplementation((messages: unknown[]) => messages);
  mocks.normalizeExtractedFact.mockImplementation((raw: { l2: string; confidence?: number }) => ({
    l2: raw.l2,
    l0: raw.l2,
    l1: raw.l2,
    confidence: raw.confidence ?? 0.9,
    category: "cases",
    tier: "working",
    tags: SPOOF_TAGS,
    factKey: "cases:wire-fixture",
  }));
  mocks.resolveCapturePrompt.mockReturnValue("wire fixture prompt");
  mocks.compressMessages.mockImplementation((messages: unknown[]) => messages);
  mocks.compressMessagesWithIndices.mockReturnValue(undefined);
  mocks.scoreSessionSalience.mockResolvedValue({
    score: 1,
    hardOverride: true,
    signals: { lexicalDensity: 1, causalMarkerCount: 0, technicalArtifactScore: 1 },
    reason: "wire fixture",
    vectorSignals: undefined,
  });
  mocks.buildWarmedProjectState.mockReturnValue(null);
  mocks.resolveRunirSession.mockResolvedValue({
    id: "runir-session-wire",
    projectIdentitySource: "session",
    status: "open",
    closeReason: null,
  });
  mocks.linkEntityToMemory.mockResolvedValue(undefined);
  mocks.getProjectEnrollment.mockResolvedValue(null);
  mocks.upsertProjectEnrollment.mockResolvedValue({});
  mocks.ingestEvidenceBatch.mockResolvedValue({});
  mocks.runConsolidationForScope.mockResolvedValue({});
  mocks.resolveSemioteOriginContext.mockReturnValue({
    path: undefined,
    client: undefined,
    sessionId: "session-wire",
    provenance: {},
  });
  mocks.recordPipelineDrop.mockReturnValue(undefined);
  mocks.applyUsefulnessFeedback.mockReturnValue({});
  mocks.accrueUsefulnessFromCapture.mockResolvedValue(undefined);
  mocks.writeWithArbitration.mockResolvedValue({ outcome: "create", memoryId: "capture-wire" });
  mocks.deriveContinuityMetadata.mockReturnValue({});
  mocks.factMetadata.mockReturnValue({});
  mocks.createWatermark.mockResolvedValue(undefined);
  mocks.getLastWatermark.mockResolvedValue(null);
  mocks.extractId.mockImplementation((value: unknown) => String(value));
  mocks.logRejection.mockResolvedValue(undefined);
  mocks.getProjectState.mockResolvedValue(null);
  mocks.upsertProjectState.mockResolvedValue(undefined);
  mocks.prepareSourceTurn.mockReturnValue({});
  mocks.sourceKeyFingerprint.mockReturnValue("source-fingerprint-wire");
  mocks.assertSourceKeyFingerprint.mockResolvedValue(undefined);
  mocks.upsertSourceTurn.mockResolvedValue(undefined);
  mocks.markFactSourceLink.mockResolvedValue(undefined);
  mocks.reconcileSourceTurnLinks.mockResolvedValue(undefined);
}

function makeMemoryApp(): Hono {
  const app = new Hono();
  registerMemoryRoutes(app);
  return app;
}

function makeHooksApp(): Hono {
  const app = new Hono();
  registerHookRoutes(app);
  return app;
}

function publicKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.keys(value);
}

describe("processing-lineage carrier wire omission", () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    delete process.env.RUNIR_DEBUG;
    delete process.env.RUNIR_TEST_MODE;
  });

  it("keeps the internal carrier across the complete synthetic state matrix without inferring from data", () => {
    const verified = attachVerified(makeHit());
    const restricted = attachVerified(makeHit("hit-restricted"), VALID_RESTRICTED_LINEAGE);
    const legacy = attachVerified(makeHit("hit-legacy"), undefined);
    const invalid = attachVerified(makeHit("hit-invalid"), null);
    const unavailable = attachSearchHitLineage(makeHit("hit-unavailable"));
    const manual = makeHit("hit-manual");
    const copied = { ...verified };
    const inherited = Object.create(verified) as SearchHit;
    const jsonShaped = JSON.parse(JSON.stringify(verified)) as SearchHit;

    const cases: Array<{ name: string; value: unknown; state: string }> = [
      { name: "verified ordinary", value: verified, state: "minni_verified" },
      { name: "verified restricted", value: restricted, state: "minni_verified" },
      { name: "legacy selected absence", value: legacy, state: "legacy_unknown" },
      { name: "invalid selected value", value: invalid, state: "invalid" },
      { name: "unavailable mapper", value: unavailable, state: "unavailable" },
      { name: "manual object", value: manual, state: "unavailable" },
      { name: "ordinary spread copy", value: copied, state: "minni_verified" },
      { name: "inherited symbol", value: inherited, state: "unavailable" },
      { name: "json-shaped copy", value: jsonShaped, state: "unavailable" },
    ];

    for (const testCase of cases) {
      expect(getSearchHitLineage(testCase.value), testCase.name).toMatchObject({ state: testCase.state });
    }

    expect(getSearchHitLineage(restricted)).toMatchObject({ state: "minni_verified" });
    expect(JSON.stringify(verified)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(verified)).not.toContain("runir.searchHitLineage");
    expect(publicKeys(verified)).not.toContain("processing_lineage");
    expect((verified as SearchHit & { payload: Record<string, string> }).payload).toEqual({
      processing_lineage: "payload spoof data",
      delivery: "payload delivery data",
    });
    expect(verified.text).toBe(SPOOF_TEXT);
    expect(verified.client).toBe("processing_lineage-client");
    expect(verified.tags).toEqual(SPOOF_TAGS);

    const jsonCopy = JSON.parse(JSON.stringify(verified)) as Record<string, unknown>;
    expect(jsonCopy).not.toHaveProperty("processing_lineage");
    expect(jsonCopy.text).toBe(SPOOF_TEXT);
    expect(jsonCopy.client).toBe("processing_lineage-client");
    expect(jsonCopy.tags).toEqual(SPOOF_TAGS);
  });

  it("projects tool, audit, text, and trace shapes without private evidence", () => {
    const verified = attachVerified(makeHit());
    const restricted = attachVerified(makeHit("hit-restricted"), VALID_RESTRICTED_LINEAGE);

    const legacy = attachVerified(makeHit("hit-legacy"), undefined);
    const invalid = attachVerified(makeHit("hit-invalid"), null);
    const unavailable = attachSearchHitLineage(makeHit("hit-unavailable"));
    const manual = makeHit("hit-manual");
    const copied = { ...verified };
    const inherited = Object.create(verified) as SearchHit;
    const jsonShaped = JSON.parse(JSON.stringify(verified)) as SearchHit;
    const projectionCases: Array<{ name: string; hit: SearchHit }> = [
      { name: "verified ordinary", hit: verified },
      { name: "verified restricted", hit: restricted },
      { name: "legacy selected absence", hit: legacy },
      { name: "invalid selected value", hit: invalid },
      { name: "unavailable mapper", hit: unavailable },
      { name: "manual object", hit: manual },
      { name: "ordinary spread copy", hit: copied },
      { name: "inherited symbol", hit: inherited },
      { name: "json-shaped copy", hit: jsonShaped },
    ];
    const toolKeys = ["id", "memory", "score", "created_at", "updated_at", "tags"];
    const auditKeys = [
      "id", "memory", "score", "created_at", "updated_at", "tags", "path", "isStale",
      "staleSince", "contradictedBy", "active", "inactiveReason", "supersededById", "lineageRootId",
      "confidence", "tier", "category",
    ];

    for (const { name, hit } of projectionCases) {
      const tool = toToolSearchResults([hit], 1);
      expect(tool.results[0], `${name} tool projection`).toEqual({
        id: hit.id,
        memory: SPOOF_TEXT,
        score: 0.91,
        created_at: "2026-10-01T10:00:00.000Z",
        updated_at: "2026-10-02T10:00:00.000Z",
        tags: SPOOF_TAGS,
      });
      expect(Reflect.ownKeys(tool.results[0] ?? {}), `${name} tool keys`).toEqual(toolKeys);
      expect(Object.getOwnPropertySymbols(tool.results[0] ?? {}), `${name} tool symbols`).toHaveLength(0);

      const audit = toAuditSearchResults([hit], 1);
      expect(audit.results[0], `${name} audit projection`).toEqual({
        id: hit.id,
        memory: SPOOF_TEXT,
        score: 0.91,
        created_at: "2026-10-01T10:00:00.000Z",
        updated_at: "2026-10-02T10:00:00.000Z",
        tags: SPOOF_TAGS,
        path: "/tmp/ordinary-path",
        isStale: false,
        staleSince: "2026-10-01T09:00:00.000Z",
        contradictedBy: "replacement-wire",
        active: true,
        inactiveReason: "ordinary delivery data",
        supersededById: "replacement-wire",
        lineageRootId: "root-business-wire",
        confidence: 0.87,
        tier: "working",
        category: "cases",
      });
      expect(Reflect.ownKeys(audit.results[0] ?? {}), `${name} audit keys`).toEqual(auditKeys);
      expect(Object.getOwnPropertySymbols(audit.results[0] ?? {}), `${name} audit symbols`).toHaveLength(0);
      expect(audit.results[0]?.lineageRootId, `${name} business lineageRootId`).toBe("root-business-wire");

      const injected = formatRecallInjection([hit], 1);
      expect(injected, `${name} text projection`).toContain(SPOOF_TEXT);
      expect(injected, `${name} text private canary`).not.toContain(PRIVATE_CANARY);
      expect(JSON.stringify(tool)).not.toContain(PRIVATE_CANARY);
      expect(JSON.stringify(audit)).not.toContain(PRIVATE_CANARY);
      expect(hit.client, `${name} client data`).toBe("processing_lineage-client");
      expect(hit.tags, `${name} spoof tags`).toEqual(SPOOF_TAGS);
    }

    const rendered = formatRecallInjectionFromRendered([SPOOF_TEXT]);
    expect(rendered).toContain(SPOOF_TEXT);
    expect(rendered).not.toContain(PRIVATE_CANARY);

    const collector = new TraceCollector();
    collector.startStage("wire-stage", ["hit-wire", "hit-restricted"]);
    collector.endStage(["hit-wire"], [0.91]);
    const trace = collector.finalize("processing_lineage as literal query", "hybrid");
    expect(trace.stages).toEqual([{
      name: "wire-stage",
      inputCount: 2,
      outputCount: 1,
      droppedIds: ["hit-restricted"],
      scoreRange: [0.91, 0.91],
      durationMs: expect.any(Number),
    }]);
    expect(publicKeys(trace)).toEqual(["query", "mode", "startedAt", "stages", "finalCount", "totalMs"]);
    expect(JSON.stringify(trace)).not.toContain(PRIVATE_CANARY);
  });

  it("retains carrier evidence inside capture packets while JSON/debug projections omit it", async () => {
    seedCaptureContext();

    const packet = await buildCaptureContextPacket({
      db: mocks.db as never,
      userId: "u-wire",
      identity: CANONICAL_IDENTITY,
      retrievalTraceId: "trace-wire",
    });

    expect(getSearchHitLineage(packet.recent_facts[0])).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(packet.nearby_existing[0])).toMatchObject({ state: "minni_verified" });
    expect(packet.retrieval_footprint?.shownMemoryIds).toEqual(["hit-wire"]);
    expect(packet.debug.slotCounts).toEqual({ recentFacts: 1, shownMemoryIds: 1, nearbyExisting: 1, relationHints: 0 });
    expect(packet.debug.stateAnchorState).toBe("present");

    const publicPacket = JSON.parse(JSON.stringify(packet)) as Record<string, any>;
    expect(getSearchHitLineage(publicPacket.recent_facts[0])).toMatchObject({ state: "unavailable" });
    expect(getSearchHitLineage(publicPacket.nearby_existing[0])).toMatchObject({ state: "unavailable" });
    expect(publicPacket.recent_facts[0].text).toBe(SPOOF_TEXT);
    expect(publicPacket.recent_facts[0].tags).toEqual(SPOOF_TAGS);
    expect(publicPacket.recent_facts[0]).not.toHaveProperty("processing_lineage");
    expect(publicPacket.nearby_existing[0]).not.toHaveProperty("processing_lineage");
    expect(publicPacket.debug).toEqual(packet.debug);
  });

  it("keeps the memory search and lineage HTTP projections carrier-free", async () => {
    const hit = attachVerified(makeHit());
    mocks.runHybridQueryWithEvidenceTable.mockResolvedValue([hit]);
    mocks.runHybridQueryWithEvidenceTableAndEntityTrace.mockResolvedValue({
      hits: [hit],
      entityMatches: [{ queryMention: "processing_lineage as data", linkedMemoryIds: ["hit-wire"] }],
      legRanks: { "hit-wire": { vector: 1, bm25: 2, rrf: 1 } },
    });
    mocks.getMemoryLineage.mockResolvedValue([hit]);

    const app = makeMemoryApp();
    const searchResponse = await app.request("/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-wire", query: "ordinary query", limit: 1 }),
    });
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json();
    expect(search.results).toEqual([{
      id: "hit-wire",
      memory: SPOOF_TEXT,
      score: 0.91,
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-02T10:00:00.000Z",
      tags: SPOOF_TAGS,
    }]);
    expect(search.results[0]).not.toHaveProperty("processing_lineage");

    process.env.RUNIR_DEBUG = "1";
    const debugResponse = await app.request("/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-wire", query: "ordinary query", includeInactive: true, debug: true }),
    });
    expect(debugResponse.status).toBe(200);
    const debug = await debugResponse.json();
    expect(debug.debug.trace.stages).toEqual([]);
    expect(debug.debug.entityMatches).toEqual([{ queryMention: "processing_lineage as data", linkedMemoryIds: ["hit-wire"] }]);
    expect(debug.debug.legRanks).toEqual({ "hit-wire": { vector: 1, bm25: 2, rrf: 1 } });
    expect(debug.results[0].lineageRootId).toBe("root-business-wire");
    expect(debug.results[0]).not.toHaveProperty("processing_lineage");

    const lineageResponse = await app.request("/memory/lineage/hit-wire?userId=u-wire");
    expect(lineageResponse.status).toBe(200);
    const lineage = await lineageResponse.json();
    expect(lineage).toMatchObject({ memoryId: "hit-wire", chainLength: 1 });
    expect(lineage.lineage[0]).toMatchObject({
      id: "hit-wire",
      text: SPOOF_TEXT,
      lineageRootId: "root-business-wire",
    });
    expect(lineage.lineage[0]).not.toHaveProperty("processing_lineage");
  });

  it("keeps trace and capture HTTP responses on their established fields", async () => {
    const hit = attachVerified(makeHit());
    const traceRecord = {
      id: "trace-wire",
      userId: "u-wire",
      prompt: SPOOF_TEXT,
      sessionId: "session-wire",
      items: [hit],
      rating: "helped",
      captureReceipt: { memoryIds: ["hit-wire"], path: "/tmp/ordinary-path" },
    };
    mocks.listRetrievalTraces.mockResolvedValue([traceRecord]);
    mocks.getRetrievalTrace.mockResolvedValue(traceRecord);

    const app = makeHooksApp();
    const listResponse = await app.request("/hooks/traces?userId=u-wire&limit=20");
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.traces[0]).toMatchObject({ id: "trace-wire", rating: "helped" });
    expect(listed.traces[0].items[0]).not.toHaveProperty("processing_lineage");
    expect(listed.traces[0].items[0].text).toBe(SPOOF_TEXT);

    const detailResponse = await app.request("/hooks/traces/trace-wire?userId=u-wire");
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.trace.captureReceipt).toEqual({ memoryIds: ["hit-wire"], path: "/tmp/ordinary-path" });
    expect(detail.trace.items[0]).not.toHaveProperty("processing_lineage");

    process.env.RUNIR_DEBUG = "1";
    process.env.RUNIR_TEST_MODE = "1";
    seedCaptureContext();
    const captureResponse = await app.request("/hooks/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "u-wire",
        sessionId: "session-wire",
        client: "processing_lineage-client",
        retrievalTraceId: "trace-wire",
        messages: [{ role: "user", content: SPOOF_TEXT }],
        captureFixtureFacts: [{ l2: SPOOF_TEXT, confidence: 0.9 }],
      }),
    });
    expect(captureResponse.status).toBe(200);
    const capture = await captureResponse.json() as Record<string, any>;
    expect(capture.units[0]).toMatchObject({ id: "capture-wire", content: SPOOF_TEXT, outcome: "create" });
    expect(capture._debug.captureContext).toEqual({
      slotCounts: { recentFacts: 1, shownMemoryIds: 1, nearbyExisting: 1, relationHints: 0 },
      stateAnchorState: "present",
      identityMatchedFootprint: true,
    });
    expect(capture._debug.captureContext).not.toHaveProperty("processing_lineage");
    expect(JSON.stringify(capture)).not.toContain(PRIVATE_CANARY);
    expect(JSON.stringify(capture)).toContain(SPOOF_TEXT);
  });
});
