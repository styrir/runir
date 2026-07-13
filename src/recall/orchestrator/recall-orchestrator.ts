/**
 * recall-orchestrator.ts — extracted /hooks/recall orchestration (Rúnir-qjn4.2).
 *
 * This module owns the recall orchestration that previously lived inline in the
 * /hooks/recall handler (src/app/routes/hooks/index.ts): the adaptive-skip
 * short-circuit, the deterministic-continuity branch, the hybrid branch, the
 * hexis comparison, the audit assembly, and the Layer-2 debug-attribution
 * envelope. The route now parses the body, resolves the user, calls
 * `orchestrateRecall`, and serializes the returned `body` 1:1 via `c.json`.
 *
 * Contract: RANKING- AND RESPONSE-NEUTRAL. The returned `body` on every path is
 * byte-identical to the pre-extraction `c.json` payload; `statusCode` carries
 * the non-200 cases (the 500 error path) so the route can pass it straight to
 * `c.json(body, statusCode)`.
 *
 * No Hono imports. Runtime singletons (db, provider, overlayRegistry, cfg,
 * debugLogger, retrievalStats) are injected via `deps`, so the orchestrator is
 * testable without an HTTP server. The pure dependency modules
 * (memory-query, scope-predicate, recall-selection, surreal-store, phase2-store,
 * …) are imported directly, so existing vi.mock interception is unchanged.
 */
import type {
  MemoryRole,
  RerankerConfig,
  SearchHit,
} from "../../domain/memory/types.js";
import type { HexisHint, HexisState } from "../../hexis/runtime-hexis.js";
import {
  hasAdditionalHexisHintSignal,
  resolveActiveHexisCached,
} from "../../hexis/active-hexis-cache.js";
import { analyzeIntent, isStatusClassIntent } from "../intent/intent-analyzer.js";
import { shouldSkipRetrieval } from "../intent/adaptive-retrieval.js";
import { DEFAULT_RANKING_PLAN, executeRankingPlan, resolveExactQaPreserveFloor } from "./ranking-plan.js";
import { runLatestStateLane } from "../latest-state/run-latest-state-lane.js";
import { buildRecipeTraceMetadata } from "../policy/recipe-registry.js";
import { buildRetrievalCalibrationTelemetry } from "../policy/calibration-telemetry.js";
import { resolveNoemaRetrievalPolicy } from "../policy/noema-retrieval-policy.js";
import { applyHexisByPolicy, resolveRetrievalController } from "../policy/retrieval-controller.js";
import { buildSessionOpenerPayload, formatSessionOpenerInjection } from "../continuity/session-opener.js";
import {
  compactionProfileForLabel,
  fitCompactionProjectionToBudget,
} from "../continuity/compaction-projection.js";
import { runHybridQueryWithEvidenceTable } from "../query/memory-query.js";
import type { LegRanks, RecallCandidateStages } from "../query/memory-query.js";
import { getLearnedNoiseProfile, resolveRankingProfile } from "../policy/ranking-profile.js";
import { queryLearnedStatusNoiseIds } from "../../storage/surreal/phase2-store.js";
import {
  mergeFilters,
  resolveAttributionFilter,
  resolveAttrField,
  resolvePathRecallFilter,
  resolveScopeFilter,
  type RecallScopeFilter,
  type ScopeFilter,
} from "../query/scope-predicate.js";
import {
  formatRecallInjectionFromRendered,
  postProcessRecallResults,
} from "../selection/recall-selection.js";
import { relevanceGateDrops, RECALL_RELEVANCE_FLOOR } from "../selection/relevance-gate.js";
import { TraceCollector } from "../selection/retrieval-trace.js";
import {
  extractId,
  getProjectStateForRecall,
  listContinuityMemoryHits,
} from "../../storage/surreal/surreal-store.js";
import type {
  HexisGateDecision,
  RecallAttributionEnvelope,
  RetrievalAuditRecord,
  RetrievalPathKind,
  RetrievalRecipeSourceName,
} from "../policy/policy-types.js";
import {
  createRetrievalTrace,
  toRetrievalFootprintIdentitySnapshot,
  getPrimaryMemoryRowsByIds,
} from "../../storage/surreal/phase2-store.js";
import {
  formatCanonicalContextForDebug,
  type CanonicalContextIdentity,
} from "../../identity/canonical-context.js";
import { resolveRunirSession } from "../../storage/surreal/runir-session-store.js";
import { resolveBodyCanonicalContext } from "../body-resolution.js";
import type * as Runtime from "../../app/runtime.js";

// ---------------------------------------------------------------------------
// Injected runtime singletons. Types are derived (compile-time only) from the
// runtime module's exports so they cannot drift; `import type` is fully erased
// at runtime, so the orchestrator never captures the actual singletons itself.
// ---------------------------------------------------------------------------
export interface RecallOrchestratorDeps {
  db: typeof Runtime.db;
  provider: typeof Runtime.provider;
  overlayRegistry: typeof Runtime.overlayRegistry;
  cfg: typeof Runtime.cfg;
  debugLogger: typeof Runtime.debugLogger;
  retrievalStats: typeof Runtime.retrievalStats;
  // Hexis resolution lives in runtime.js (it touches the persistence layer); it
  // is the cache-miss callback for resolveActiveHexisCached. Injected (not
  // imported) so the orchestrator does not capture a runtime singleton.
  resolveActiveHexis: typeof Runtime.resolveActiveHexis;
}

export interface RecallOrchestratorRequest {
  body: Record<string, unknown> & { [key: string]: any };
  prompt: string;
  uid: string;
}

/**
 * Result envelope. The route maps `body` 1:1 onto `c.json(body)` (or
 * `c.json(body, statusCode)` when `statusCode` is set). `kind` is informational
 * for callers/tests; the response shape lives entirely in `body`.
 */
export type RecallOrchestratorResult = {
  kind:
    | "skipped"
    | "deterministic_opener"
    | "deterministic_compaction"
    | "deterministic_plain"
    | "embed_error"
    | "hybrid_debug"
    | "hybrid_plain"
    | "error";
  body: Record<string, unknown>;
  statusCode?: 500;
};

type HexisResolutionSource = "explicit" | "session" | "project" | "agent" | "off";

// ---------------------------------------------------------------------------
// Recall-only helpers (moved verbatim from src/app/routes/hooks/index.ts).
// ---------------------------------------------------------------------------

function resolveRecallRerankerConfig(reranker: RerankerConfig | undefined): RerankerConfig | undefined {
  // Recall runs in the user prompt path, so it must never make an LLM reranker
  // request. Capture/session-end paths still own LLM extraction separately.
  return reranker?.provider === "llm" ? { provider: "off" } : reranker;
}

function shouldDisableHexis(body: Record<string, unknown>): boolean {
  return body.disableHexis === true;
}

function resolveHexisHint(value: unknown): HexisHint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as HexisHint;
}

function resolveHexisResolutionSource(
  body: Record<string, unknown>,
  path: string | undefined,
  activeHexis: HexisState | null,
): HexisResolutionSource {
  if (shouldDisableHexis(body)) return "off";
  const hint = resolveHexisHint(body.hexis);
  if (
    hint
    && (
      (typeof hint.id === "string" && activeHexis?.id === hint.id)
      || hasAdditionalHexisHintSignal(hint)
    )
  ) {
    return "explicit";
  }
  if (typeof body.sessionId === "string" && body.sessionId.trim()) return "session";
  if (
    (typeof body.projectId === "string" && body.projectId.trim())
    || (typeof body.gitRemoteUrl === "string" && body.gitRemoteUrl.trim())
    || (typeof body.gitRepoRoot === "string" && body.gitRepoRoot.trim())
    || (typeof path === "string" && path.trim())
  ) {
    return "project";
  }
  return "agent";
}

function sameProjectSessionOpenerRow(
  row: any,
  projectKey?: string,
  requestedPath?: string,
): boolean {
  const payload = row?.payload ?? {};
  const rowProjectKey = payload?.provenance?.derivation?.projectKey;
  const rowPath = payload?.path ?? row?.path;

  if (projectKey) {
    if (typeof rowProjectKey === "string" && rowProjectKey) {
      return rowProjectKey === projectKey;
    }
    if (requestedPath) {
      return rowPath === requestedPath;
    }
    return false;
  }

  if (requestedPath) {
    return rowPath === requestedPath;
  }

  return true;
}

function dedupeSearchHitsById(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const deduped: SearchHit[] = [];
  for (const hit of hits) {
    if (!hit.id || seen.has(hit.id)) continue;
    seen.add(hit.id);
    deduped.push(hit);
  }
  return deduped;
}

function rowToSessionOpenerHit(row: any): SearchHit {
  const payload = row?.payload ?? {};
  return {
    id: extractId(row?.id),
    text: payload?.l2 ?? payload?.data ?? "",
    score: Number(row?.score ?? 0),
    createdAt: payload?.createdAt ?? row?.created_at,
    updatedAt: payload?.updatedAt ?? row?.updated_at,
    tags: payload?.tags,
    category: payload?.category,
    memoryRole: payload?.memoryRole,
    validAt: payload?.validAt ?? row?.valid_at,
    invalidAt: payload?.invalidAt ?? row?.invalid_at,
    scope: payload?.scope ?? row?.scope,
    sessionId: payload?.sessionId ?? row?.session_id,
    confidence: payload?.confidence,
    l0: payload?.l0,
    l1: payload?.l1,
    path: payload?.path,
    client: payload?.client,
    continuitySubjectKey: payload?.continuitySubjectKey,
    active: row?.active,
    inactiveReason: row?.inactive_reason,
    supersededById: row?.superseded_by ? extractId(row.superseded_by) : payload?.supersededById,
    lineageRootId: row?.lineage_root_id ? extractId(row.lineage_root_id) : payload?.lineageRootId,
  };
}

function buildSessionOpenerOverlayHits(args: {
  rows: any[];
  projectKey?: string;
  requestedPath?: string;
}): SearchHit[] {
  return dedupeSearchHitsById(
    args.rows
      .filter((row) => sameProjectSessionOpenerRow(row, args.projectKey, args.requestedPath))
      .map((row) => rowToSessionOpenerHit(row)),
  );
}

function cloneHits(hits: SearchHit[]): SearchHit[] {
  return hits.map((hit) => ({
    ...hit,
    tags: hit.tags ? [...hit.tags] : hit.tags,
    scoreStages: hit.scoreStages ? { ...hit.scoreStages } : hit.scoreStages,
    rankingExplanation: hit.rankingExplanation ? [...hit.rankingExplanation] : hit.rankingExplanation,
  }));
}

function countStagesBySource(
  stages: ReadonlyArray<{ name: string; outputCount: number }> | undefined,
): Partial<Record<RetrievalRecipeSourceName, number>> {
  if (!stages || stages.length === 0) {
    return {};
  }
  const sourceCounts: Partial<Record<RetrievalRecipeSourceName, number>> = {};

  for (const stage of stages) {
    switch (stage.name) {
      case "vector_search":
        sourceCounts.vector = stage.outputCount;
        break;
      case "bm25_search":
        sourceCounts.bm25 = stage.outputCount;
        break;
      case "recency_search":
        sourceCounts.recency = stage.outputCount;
        break;
      case "entity_search":
        sourceCounts.entity = stage.outputCount;
        break;
      case "latest_state_resolution":
        sourceCounts.latest_state_representatives = stage.outputCount;
        break;
      default:
        break;
    }
  }

  return sourceCounts;
}

function summarizeHitsForHexisDebug(hits: SearchHit[]): Array<Record<string, unknown>> {
  return hits.map((hit, index) => ({
    id: hit.id,
    rank: index + 1,
    score: hit.score,
    title: hit.l0 ?? null,
    memoryRole: hit.memoryRole,
    path: hit.path,
    client: hit.client ?? null,
    scoreStages: hit.scoreStages
      ? {
        ...hit.scoreStages,
        entity: hit.scoreStages.entity
          ? {
            ...hit.scoreStages.entity,
            linkedMemoryIds: undefined,
          }
          : undefined,
      }
      : null,
    rankingExplanation: hit.rankingExplanation ?? [],
    hexisFit: hit.hexisFit ?? null,
    preHexisScore: hit.preHexisScore ?? null,
    postHexisScore: hit.postHexisScore ?? null,
    poolRank: hit.poolRank ?? null,
    boundaryGap: hit.boundaryGap ?? null,
    gateValue: hit.gateValue ?? null,
    hexisMode: hit.hexisMode ?? null,
    laneLambda: hit.laneLambda ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Hexis / session resolution (recall-only thin wrappers, moved verbatim —
// capture/session-end keep their own copies in hooks/index.ts). The pure
// body-fragment resolvers (readNestedString / git helpers /
// resolveBodyCanonicalContext) live in ../body-resolution.js, shared with the
// route so the two copies cannot drift.
// ---------------------------------------------------------------------------

function resolveHexisContext(
  resolveActiveHexis: RecallOrchestratorDeps["resolveActiveHexis"],
  args: {
    userId: string;
    sessionId?: string;
    path?: string;
    projectId?: string;
    agentId?: string;
    hexisHint?: HexisHint;
    persistHint?: boolean;
  },
): Promise<HexisState | null> {
  return resolveActiveHexis({
    userId: args.userId,
    sessionId: args.sessionId,
    path: args.path,
    projectId: args.projectId,
    agentId: args.agentId,
    hint: args.hexisHint,
    persistHint: args.persistHint,
  });
}

function resolveBodyHexisContext(
  deps: RecallOrchestratorDeps,
  body: Record<string, unknown>,
  userId: string,
  path: string | undefined,
  sessionId?: string,
  options?: {
    persistHint?: boolean;
    allowHintRichCacheRead?: boolean;
  },
): Promise<HexisState | null> {
  if (shouldDisableHexis(body)) {
    return Promise.resolve(null);
  }
  const contextIdentity = resolveBodyCanonicalContext(body, userId, path, sessionId);
  const hexisHint = resolveHexisHint(body.hexis);
  const projectId = contextIdentity.raw.projectId;
  const agentId = contextIdentity.raw.agentId;
  return resolveActiveHexisCached({
    userId,
    sessionId,
    path,
    projectId,
    agentId,
    hexisHint,
    allowHintRichCacheRead: options?.allowHintRichCacheRead,
  }, () => resolveHexisContext(deps.resolveActiveHexis, {
    userId,
    sessionId,
    path,
    projectId,
    agentId,
    hexisHint,
    persistHint: options?.persistHint,
  }));
}

async function resolveBodyRunirSession(
  deps: RecallOrchestratorDeps,
  body: Record<string, unknown>,
  userId: string,
  identity: CanonicalContextIdentity,
  path: string | undefined,
  sessionId?: string,
) {
  const clientKind = resolveAttrField(body.client, "RUNIR_SCOPE_CLIENT");
  return resolveRunirSession(deps.db, {
    userId,
    projectKey: identity.projectKey,
    projectIdentitySource: identity.derivation.projectKey.marker ?? "absent",
    clientKind: clientKind ?? undefined,
    nativeSessionId: sessionId,
    workspacePath: path,
    workspaceFingerprint: typeof body.workspaceFingerprint === "string" ? body.workspaceFingerprint : undefined,
    hostId: typeof body.hostId === "string" ? body.hostId : undefined,
    deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : undefined,
    status: "active",
  });
}

// ---------------------------------------------------------------------------
// Orchestrator entrypoint.
// ---------------------------------------------------------------------------

export async function orchestrateRecall(
  deps: RecallOrchestratorDeps,
  request: RecallOrchestratorRequest,
): Promise<RecallOrchestratorResult> {
  const { db, provider, overlayRegistry, cfg, debugLogger, retrievalStats } = deps;
  const { body, prompt, uid } = request;

  // Stage 4 (Codex finding #4): sessionKind="opener" bypass MUST run before
  // shouldSkipRetrieval — empty-prompt openers from Claude Code's SessionStart
  // hook would otherwise short-circuit to {skipped: true, reason: "adaptive"}
  // because shouldSkipRetrieval("") returns true.
  const sessionKind = typeof body.sessionKind === "string" ? body.sessionKind : undefined;
  const hasOpenerHint = sessionKind === "opener";
  // OM-2 (Rúnir-tfxt.2): compaction lifecycle recalls are requested ONLY via
  // these exact sessionKind values — any other string behaves exactly like an
  // absent sessionKind (identity gate). Deliberate local literal, NOT an
  // intent-analyzer import: intent-analyzer.js is vi.mock'ed with explicit
  // export lists in 8 harnesses, where a new import edge resolves `undefined`
  // (the OM-1 inline-typeof precedent; drift-guard test asserts agreement
  // with COMPACTION_INTENTS).
  const compactionHint = sessionKind === "pre_compaction" || sessionKind === "post_compaction_validation"
    ? sessionKind
    : undefined;

  // The manufactured session opener is RETIRED (2026-06-13 — see
  // docs/agent-guidance/architecture-canon.md §1 maxim decision +
  // docs/analysis/2026-06-13-session-opener-project-attribution-brief.md). A
  // standing session-start briefing replayed every fact attributed to the cwd as
  // continuity, surfacing ambient tooling/environment chatter as the "project"
  // (a directory is not a topic). The field plurality has no opener; continuity
  // comes from per-turn query-time recall on real prompts, not a front-loaded
  // block. So a session-start opener returns NO injectable content — but it still
  // performs the legitimate session bookkeeping the start ping carried:
  // reactivating the runir session (a closed session becomes active when the user
  // returns). No opener composition, no recall.
  if (hasOpenerHint) {
    const openerDebug = process.env.RUNIR_DEBUG === "1" || body.hexisDebug === true;
    let runirSessionDebug: { id: string; projectIdentitySource: string; status: string; closeReason: string | null } | undefined;
    // Session bookkeeping is best-effort — never fail the (content-less) opener
    // ping on it.
    try {
      const openerReqPath = resolveAttrField(body.path, "RUNIR_SCOPE_PATH");
      const openerIdentity = resolveBodyCanonicalContext(body, uid, openerReqPath, body.sessionId);
      const openerSession = await resolveBodyRunirSession(deps, body, uid, openerIdentity, openerReqPath, body.sessionId);
      if (openerDebug) {
        runirSessionDebug = {
          id: openerSession.id,
          projectIdentitySource: openerSession.projectIdentitySource,
          status: openerSession.status,
          closeReason: openerSession.closeReason ?? null,
        };
      }
    } catch (err) {
      console.warn("runir-service: opener session reactivation failed:", err);
    }
    return {
      kind: "skipped",
      body: {
        skipped: true,
        reason: "opener_retired",
        ...(runirSessionDebug ? { _debug: { runirSession: runirSessionDebug } } : {}),
      },
    };
  }

  // Compaction pings carry no user prompt — bypass the adaptive skip the same
  // way the opener bypass above runs before it (OM-1 Codex finding #4 class:
  // an empty prompt would otherwise short-circuit the lifecycle recall).
  if (!compactionHint && shouldSkipRetrieval(prompt)) {
    return { kind: "skipped", body: { skipped: true, reason: "adaptive" } };
  }

  try {
    const intent = analyzeIntent(prompt, { hint: hasOpenerHint ? "opener" : compactionHint });
    // Local literal for the same mock-hazard reason as compactionHint above.
    // Label-derived (not hint-derived) so the guard holds however the intent
    // was produced.
    const isCompactionRecall = intent.label === "pre_compaction" || intent.label === "post_compaction_validation";
    const compactionProfile = isCompactionRecall
      ? compactionProfileForLabel(intent.label as "pre_compaction" | "post_compaction_validation")
      : "pre";
    const { policy, recipe } = resolveRetrievalController(intent);
    const noemaPolicy = resolveNoemaRetrievalPolicy(intent);
    const reqPath = resolveAttrField(body.path, "RUNIR_SCOPE_PATH");
    // OM-1 (Rúnir-tfxt.1): optional budget-aware projection. Parsed with the
    // same inline typeof idiom as body.nowMs — deliberately NOT a call into
    // recall-selection: that module is vi.mock'ed with explicit export lists in
    // a dozen route/hook test harnesses, and a new orchestrator-level import
    // from it resolves to undefined under those mocks (TypeError → the 500
    // catch path → selected[] vanished; the tfxt.1 landing regression). Full
    // normalization (NaN/Infinity/zero/negative → undefined = no-budget)
    // happens inside postProcessRecallResults via resolveBudgetTokens; this
    // typeof guard alone can never throw.
    const budgetTokens = typeof body.budgetTokens === "number" ? body.budgetTokens : undefined;
    // Resolve the per-tenant ranking profile ONCE per request (Rúnir-mmg2) and
    // thread the SAME object into every seam (query tuning + postProcess), so
    // ranking is consistent across paths and no seam re-resolves.
    const rankingProfile = resolveRankingProfile(uid);
    // Resolve the LEARNED status-noise membership ONCE per request (Rúnir-mmg2.2),
    // threaded into postProcess alongside the static profile. Only status-class
    // intents consume the learned leg (the demotion union gates it on
    // isStatusClassIntent), so we skip the DB round-trip entirely on QA/general
    // recalls — and the TTL WeakMap-per-client cache absorbs repeat status
    // recalls within 60s. On a fresh tenant the set is empty (no-op union, R4).
    const learnedNoiseIds = isStatusClassIntent(intent.label)
      ? (await getLearnedNoiseProfile(
          deps.db,
          uid,
          rankingProfile,
          (userId, threshold) => queryLearnedStatusNoiseIds(deps.db, userId, threshold),
        )).learnedNoiseIds
      : undefined;
    // Resolve the exact-QA preserve floor ONCE from the declared ranking plan
    // (Rúnir-qjn4.3 R3). undefined for the default plan (the fix entry is
    // disabled) → byte-identical preserve behavior on the rerank path.
    const exactQaPreserveFloor = resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN);
    const contextIdentity = resolveBodyCanonicalContext(body, uid, reqPath, body.sessionId);
    const fallbackRetrievalPath: RetrievalPathKind = policy.useDeterministicContinuity
      ? "hybrid"
      : policy.retrievalPath;
    const activeHexis = await resolveBodyHexisContext(deps, body, uid, reqPath, body.sessionId, {
      persistHint: false,
      allowHintRichCacheRead: true,
    });
    const runirSession = await resolveBodyRunirSession(deps, body, uid, contextIdentity, reqPath, body.sessionId);
    const hexisResolutionSource = resolveHexisResolutionSource(body, reqPath, activeHexis);
    function buildSelectedPayload(hits: SearchHit[]) {
      return hits.map((hit, i) => ({
        id: hit.id,
        content: hit.text,
        score: hit.score,
        rank: i + 1,
        ...(hit.sourceKind !== undefined ? { sourceKind: hit.sourceKind } : {}),
        ...(hit.memoryRole !== undefined ? { role: hit.memoryRole } : {}),
        ...(hit.rankingExplanation !== undefined ? { supportSummary: hit.rankingExplanation } : {}),
      }));
    }
    // Entity-leg mentions that failed to contribute on this recall — the demand
    // signal for the nightly entity-repair job (Rúnir-b40x.2). Captured by the
    // always-on onEntityTrace below (hybrid branch only; stays undefined on the
    // deterministic-continuity branch, which runs no entity leg).
    let capturedEntityMisses: Array<{ mention: string; normalized: string; reason: string }> | undefined;
    const persistTrace = async (
      identity: CanonicalContextIdentity,
      selected: SearchHit[],
      accessTrackedIds: string[],
      retrievalPath: string,
      retrievalAudit?: RetrievalAuditRecord,
      prependContext?: string | null,
    ) => {
      if (selected.length === 0) return undefined;
      return createRetrievalTrace(db, {
        userId: uid,
        sessionId: body.sessionId,
        prompt,
        intentLabel: intent.label,
        laneLabel: policy.lane,
        retrievalPath,
        requestedPath: reqPath,
        hexisId: activeHexis?.id,
        hexisVersion: activeHexis?.version,
        hexisLabel: activeHexis?.label,
        footprintKind: "turn",
        canonicalIdentity: toRetrievalFootprintIdentitySnapshot(identity),
        accessTrackedIds,
        retrievalAudit,
        entityMisses: capturedEntityMisses,
        prependContext: prependContext ?? undefined,
        items: selected.map((hit) => ({
          id: hit.id,
          score: hit.score,
          memoryRole: hit.memoryRole,
          path: hit.path,
          hexisFit: hit.hexisFit,
          rankingExplanation: hit.rankingExplanation,
        })),
      });
    };
    const isDebug = process.env.RUNIR_DEBUG === "1" || body.hexisDebug === true;
    if (policy.useDeterministicContinuity) {
      try {
        const [{ projectState, usedPathFallback: usedProjectStateFallback }, exactContinuityHits] = await Promise.all([
          getProjectStateForRecall(db, uid, reqPath, contextIdentity.projectKey),
          listContinuityMemoryHits(db, uid, { path: reqPath, limit: 5, tableName: "semiote" }),
        ]);
        let continuityHits = exactContinuityHits;
        let usedPathFallback = usedProjectStateFallback;

        if (intent.label === "session_opener" || isCompactionRecall) {
          const overlayRows = projectState?.supportingMemoryIds?.length
            ? await getPrimaryMemoryRowsByIds(db, projectState.supportingMemoryIds, "semiote")
            : [];
          const overlayHits = buildSessionOpenerOverlayHits({
            rows: overlayRows,
            projectKey: projectState?.projectKey,
            requestedPath: projectState?.path ?? reqPath,
          });
          continuityHits = dedupeSearchHitsById([...overlayHits, ...exactContinuityHits]);
        } else if (reqPath && continuityHits.length === 0) {
          const pathlessContinuityHits = await listContinuityMemoryHits(db, uid, { limit: 5, tableName: "semiote" });
          if (pathlessContinuityHits.length > 0) {
            continuityHits = pathlessContinuityHits;
            usedPathFallback = true;
          }
        }

        if (projectState || continuityHits.length > 0) {
          const continuityResults: SearchHit[] = [...continuityHits];
          if (projectState) {
            continuityResults.unshift({
              id: projectState.id,
              text: projectState.latestProgress ?? projectState.currentFocus ?? "",
              score: 1,
              memoryRole: "project_state" as MemoryRole,
              validAt: projectState.updatedAt,
              updatedAt: projectState.updatedAt,
              path: projectState.path,
              tags: [],
            });
          }
          const { selected, renderedText, accessTrackedIds, admissibility, budgetFit } = postProcessRecallResults(continuityResults, {
            intent,
            topK: cfg.topK,
            requestedPath: reqPath,
            selectorProfile: policy.selectorProfile,
            admissibilityContract: policy.admissibilityContract,
            nowMs: typeof body.nowMs === "number" ? body.nowMs : undefined,
            rankingProfile,
            learnedNoiseIds,
            budgetTokens,
          });
          const continuityAudit: RetrievalAuditRecord = {
            lane: policy.lane,
            baseCandidateCount: continuityResults.length,
            baseCandidateIds: continuityResults.map((hit) => hit.id),
            finalSelectedIds: selected.map((hit) => hit.id),
            admissibility,
            clientScope: {
              mode: "none",
            },
            recipe: buildRecipeTraceMetadata({
              recipe,
              policy,
              retrievalPath: "deterministic",
              topK: cfg.topK,
              sourceCounts: {
                project_state: projectState ? 1 : 0,
                continuity_memory: continuityHits.length,
              },
            }),
            hexis: {
              enabled: false,
              applied: false,
              reason: "lane_disabled",
              reorderWindow: 0,
              ambiguityGap: 0,
              admissibleIds: [],
            },
          };
          // Debug payload builder parameterized on (audit, shown hits) so the
          // compaction branch can rebuild it from the FITTED set — debug
          // trace.hits/finalSelectedIds must never expose budget-dropped ids
          // (Codex round-2 finding 1). Existing paths pass the pre-existing
          // (audit, selected) pair → byte-identical output.
          const buildContinuityDebugPayload = (audit: RetrievalAuditRecord, shownHits: SearchHit[]) => (isDebug
            ? {
              _debug: {
                trace: {
                  mode: "deterministic",
                  recipe: audit.recipe,
                  hits: shownHits.map((hit) => ({ id: hit.id, score: hit.score })),
                },
                hexisComparison: {
                  resolutionSource: "deterministic_continuity",
                  applied: false,
                  resolvedHexisId: null,
                  resolvedHexisLabel: null,
                  candidatePool: summarizeHitsForHexisDebug(
                    [...cloneHits(continuityResults)].sort((a, b) => b.score - a.score),
                  ),
                  withoutHexis: {
                    rankedPool: summarizeHitsForHexisDebug(shownHits),
                    selected: summarizeHitsForHexisDebug(shownHits),
                    count: shownHits.length,
                  },
                  withHexis: {
                    rankedPool: summarizeHitsForHexisDebug(shownHits),
                    selected: summarizeHitsForHexisDebug(shownHits),
                    count: shownHits.length,
                  },
                },
                retrievalAudit: audit,
                runirSession: {
                  id: runirSession.id,
                  projectIdentitySource: runirSession.projectIdentitySource,
                  status: runirSession.status,
                  closeReason: runirSession.closeReason ?? null,
                },
              },
            }
            : {});
          const continuityDebugPayload = buildContinuityDebugPayload(continuityAudit, selected);
          if (intent.label === "session_opener") {
            const selectedIds = new Set(selected.map((hit) => hit.id));
            const sessionOpener = buildSessionOpenerPayload({
              projectState,
              hits: selected.filter((hit) => hit.memoryRole !== "project_state"),
              supplementalHits: continuityResults.filter(
                (hit) => hit.memoryRole !== "project_state" && !selectedIds.has(hit.id),
              ),
              requestedPath: reqPath,
              usedPathFallback,
            });
            const prependContext = sessionOpener ? formatSessionOpenerInjection(sessionOpener) : null;
            if (prependContext) {
              const retrievalTraceId = await persistTrace(contextIdentity, selected, accessTrackedIds, "deterministic", continuityAudit, prependContext);
              if (process.env.RUNIR_RECALL_DEBUG === "1") {
                process.stderr.write(`[recall-debug] selected.length=${selected.length}\n`);
              }
              return {
                kind: "deterministic_opener",
                body: {
                  prependContext,
                  count: selected.length,
                  continuitySource: "deterministic",
                  sessionOpener,
                  retrievalTraceId,
                  selected: buildSelectedPayload(selected),
                  ...continuityDebugPayload,
                },
              };
            }
          }
          if (isCompactionRecall) {
            // OM-2 (Rúnir-tfxt.2): compaction-render projection. Built WITHOUT
            // supplemental hits — everything rendered must be auditable in the
            // trace/selected set (Codex brief-review finding 4).
            const projectStateHits = selected.filter((hit) => hit.memoryRole === "project_state");
            const fit = fitCompactionProjectionToBudget({
              projectState,
              hits: selected.filter((hit) => hit.memoryRole !== "project_state"),
              requestedPath: reqPath,
              usedPathFallback,
              profile: compactionProfile,
              intentDepth: intent.depth,
              budgetTokens,
            });
            // The fitted set REPLACES the selection everywhere downstream:
            // trace items, finalSelectedIds, access tracking, and the response
            // selected[] all derive from it — usefulness accrual reads trace
            // items, so a budget-dropped hit must never appear shown (Codex
            // brief-review finding 3).
            const fittedSelected = fit.payload ? [...projectStateHits, ...fit.keptHits] : [];
            const fittedIdSet = new Set(fittedSelected.map((hit) => hit.id));
            const fittedAccessTracked = accessTrackedIds.filter((id) => fittedIdSet.has(id));
            const compactionAudit: RetrievalAuditRecord = {
              ...continuityAudit,
              finalSelectedIds: fittedSelected.map((hit) => hit.id),
            };
            const retrievalTraceId = fit.prependContext
              ? await persistTrace(contextIdentity, fittedSelected, fittedAccessTracked, "deterministic", compactionAudit, fit.prependContext)
              : undefined;
            return {
              kind: "deterministic_compaction",
              body: {
                prependContext: fit.prependContext,
                count: fittedSelected.length,
                continuitySource: "deterministic",
                ...(fit.payload ? { sessionOpener: fit.payload } : {}),
                ...(retrievalTraceId ? { retrievalTraceId } : {}),
                selected: buildSelectedPayload(fittedSelected),
                ...(fit.budgetFit ? { budgetFit: fit.budgetFit } : {}),
                ...buildContinuityDebugPayload(compactionAudit, fittedSelected),
              },
            };
          }
          const nonEmptyRendered = renderedText.filter((l) => l.trim() !== "");
          const prependContext = nonEmptyRendered.length > 0 ? formatRecallInjectionFromRendered(renderedText) : null;
          if (prependContext) {
            const retrievalTraceId = await persistTrace(contextIdentity, selected, accessTrackedIds, "deterministic", continuityAudit, prependContext);
            if (process.env.RUNIR_RECALL_DEBUG === "1") {
              process.stderr.write(`[recall-debug] selected.length=${selected.length}\n`);
            }
            return {
              kind: "deterministic_plain",
              body: {
                prependContext,
                count: nonEmptyRendered.length,
                continuitySource: "deterministic",
                retrievalTraceId,
                selected: buildSelectedPayload(selected),
                ...(budgetFit ? { budgetFit } : {}),
                ...continuityDebugPayload,
              },
            };
          }
          // OM-1 no-refill guard (Rúnir-tfxt.1, Codex finding #1): when the
          // budget fit is what emptied an otherwise non-empty deterministic
          // payload (droppedIds non-empty, nothing left to render), return the
          // honest empty under-budget response instead of falling through to
          // the hybrid lane. Refilling budget-dropped continuity content with
          // DIFFERENT hybrid content would violate the fit's prefix-only
          // contract — budget is a ceiling, not a target to fill. The
          // pre-existing no-budget fall-throughs (no candidates, rendering
          // empty without a fit) are untouched: budgetFit is only ever set
          // when a valid budget applied.
          if (budgetFit && budgetFit.droppedIds.length > 0) {
            return {
              kind: "deterministic_plain",
              body: {
                prependContext: null,
                count: 0,
                continuitySource: "deterministic",
                selected: buildSelectedPayload(selected),
                budgetFit,
                ...continuityDebugPayload,
              },
            };
          }
        }
      } catch (continuityErr) {
        console.warn("runir-service: continuity lookup failed, falling through to embedder:", continuityErr);
      }
    }

    if (isCompactionRecall) {
      // OM-2 (Codex brief-review finding 2): compaction recalls NEVER fall
      // through to hybrid — a compaction lifecycle ping has no user prompt
      // worth embedding, and refilling an empty deterministic projection with
      // hybrid content would break the projection's audit story. Reaching
      // here means the deterministic lane yielded nothing (no project state,
      // no continuity hits) or the continuity lookup failed (warned above):
      // return the honest empty projection. Running the fit over empty inputs
      // keeps the budgetFit audit semantics identical to the non-empty path.
      const emptyFit = fitCompactionProjectionToBudget({
        projectState: null,
        hits: [],
        requestedPath: reqPath,
        usedPathFallback: false,
        profile: compactionProfile,
        intentDepth: intent.depth,
        budgetTokens,
      });
      return {
        kind: "deterministic_compaction",
        body: {
          prependContext: null,
          count: 0,
          continuitySource: "deterministic",
          selected: [],
          ...(emptyFit.budgetFit ? { budgetFit: emptyFit.budgetFit } : {}),
        },
      };
    }

    let embedding: number[];
    try {
      embedding = await provider.embedQuery(prompt);
    } catch (embErr) {
      return { kind: "embed_error", body: { prependContext: null, count: 0, warning: String(embErr) } };
    }
    const sessionId: string | undefined = body.sessionId;
    void runirSession;
    const reqClient = resolveAttrField(body.client, "RUNIR_SCOPE_CLIENT");
    const preferredClient = resolveAttrField(body.preferredClient, "RUNIR_PREFERRED_CLIENT");
    const clientScopeMode: "none" | "prefer" | "strict" = preferredClient
      ? "prefer"
      : reqClient
        ? "strict"
        : "none";
    const staleExclusionFilter: ScopeFilter = {
      whereClause: "AND (payload.isStale = NONE OR payload.isStale = false)",
      vars: {},
    };
    const scopeFilter = mergeFilters(
      resolveScopeFilter(undefined, sessionId),
      resolvePathRecallFilter(reqPath),
      clientScopeMode === "strict" && reqClient
        ? resolveAttributionFilter(undefined, reqClient)
        : { whereClause: "", vars: {} },
      staleExclusionFilter,
    );
    const traceCollector = isDebug ? new TraceCollector() : undefined;
    // Debug-only Layer-2 attribution capture (Rúnir-x41m.10). Populated only when isDebug,
    // via the read-only onLegRanks/onCandidateStages callbacks; never affects ranking.
    let capturedLegRanks: LegRanks = {};
    let capturedStages: RecallCandidateStages | undefined;
    const recallStartedAtMs = performance.now();
    const rawResults = await runHybridQueryWithEvidenceTable({
      db,
      userId: uid,
      query: prompt,
      embedding,
      limit: cfg.topK,
      scopeFilter,
      warn: console.warn,
      rerankerConfig: resolveRecallRerankerConfig(cfg.reranker),
      embeddingProvider: provider,
      trace: traceCollector,
      evidenceTable: "semiote",
      tuning: {
        rrfWeights: policy.rrfWeights,
        recencyWindowHours: policy.recencyWindowHours,
        nowMs: typeof body.nowMs === "number" ? body.nowMs : undefined,
        rankingProfile,
        // Exact-QA preserve floor (Rúnir-qjn4.3 R3): undefined unless the plan's
        // default-OFF exact_qa_preserve_floor entry is enabled. undefined →
        // byte-identical preserve behavior (the default plan path).
        ...(exactQaPreserveFloor !== undefined ? { exactQaPreserveFloor } : {}),
        // NOT debug-gated: failed-mention capture is tiny (a few strings per
        // recall) and must accumulate on real traffic for the nightly repair
        // job to have demand data (Rúnir-b40x.2).
        onEntityTrace: (matches) => {
          const misses = matches
            .filter((m) => m.ignoredReason)
            .map((m) => ({ mention: m.queryMention, normalized: m.normalizedMention, reason: String(m.ignoredReason) }));
          capturedEntityMisses = misses.length > 0 ? misses : undefined;
        },
        ...(isDebug
          ? {
              onLegRanks: (lr) => { capturedLegRanks = lr; },
              onCandidateStages: (st) => { capturedStages = st; },
            }
          : {}),
      },
      overlay: { registry: overlayRegistry },
      noemaRetrieval: { policy: noemaPolicy, requestedPath: reqPath },
    });
    const recallFilter: RecallScopeFilter = {
      since: body.since,
      tier: body.tier,
      tags: body.tags,
      confidence: body.confidence,
    };

    const buildAdmissiblePool = (hits: SearchHit[]) => {
      // RELOCATED into the declared ranking plan (Rúnir-qjn4.3). The plan's
      // orchestrator-executor stages reproduce the previous inline sequence
      // EXACTLY: path_score_penalty → path_penalty_resort → category_boost →
      // recall_soft_filters. cloneHits is preserved (the old code cloned before
      // the first mutation) so the engine never aliases the caller's hits.
      return executeRankingPlan(cloneHits(hits), DEFAULT_RANKING_PLAN, {
        intent,
        requestedPath: reqPath,
        recallFilter,
      });
    };
    const buildSelectedViewFromPool = (hits: SearchHit[]) => {
      const processed = postProcessRecallResults(hits, {
        intent,
        topK: cfg.topK,
        requestedPath: reqPath,
        selectorProfile: policy.selectorProfile,
        admissibilityContract: policy.admissibilityContract,
        preferredClient,
        clientScopeMode,
        nowMs: typeof body.nowMs === "number" ? body.nowMs : undefined,
        rankingProfile,
        learnedNoiseIds,
        budgetTokens,
      });
      return {
        filtered: hits,
        ...processed,
      };
    };

    let baselinePool: SearchHit[] = [];
    let withoutHexisView: ReturnType<typeof buildSelectedViewFromPool> | null = null;
    let withHexisView: ReturnType<typeof buildSelectedViewFromPool>;
    let hexisReorderWindowIds: string[] = [];
    let hexisGateForTelemetry: HexisGateDecision;
    let retrievalAudit: RetrievalAuditRecord;

    if (policy.useLatestStateResolution) {
      const latestStateLane = await runLatestStateLane({
        db,
        userId: uid,
        scopeFilter,
        tableName: "semiote",
        hits: rawResults,
        policy,
        activeHexis,
        buildAdmissiblePool,
        buildSelectedViewFromPool,
        traceCollector,
      });
      baselinePool = latestStateLane.baselinePool;
      hexisGateForTelemetry = latestStateLane.hexisGate;
      hexisReorderWindowIds = latestStateLane.hexisGate.admissibleIds;
      withoutHexisView = isDebug
        ? buildSelectedViewFromPool(latestStateLane.preHexisRepresentativePool)
        : null;
      withHexisView = latestStateLane.selectedView;
      retrievalAudit = latestStateLane.audit;
    } else {
      baselinePool = buildAdmissiblePool(rawResults);
      const hexisApplied = applyHexisByPolicy(cloneHits(baselinePool), activeHexis, policy);
      hexisGateForTelemetry = hexisApplied.gate;
      hexisReorderWindowIds = hexisApplied.gate.admissibleIds;
      withoutHexisView = isDebug ? buildSelectedViewFromPool(baselinePool) : null;
      if (traceCollector && activeHexis && hexisApplied.gate.enabled) {
        traceCollector.startStage("hexis_rerank", baselinePool.map((hit) => hit.id));
        traceCollector.endStage(
          hexisApplied.hits.map((hit) => hit.id),
          hexisApplied.hits.map((hit) => hit.score),
        );
      }
      withHexisView = buildSelectedViewFromPool(hexisApplied.hits);
      retrievalAudit = {
        lane: policy.lane,
        baseCandidateCount: baselinePool.length,
        baseCandidateIds: baselinePool.map((hit) => hit.id),
        finalSelectedIds: withHexisView.selected.map((hit) => hit.id),
        clientScope: {
          mode: clientScopeMode,
          requestedClient: preferredClient ?? reqClient ?? undefined,
        },
        hexis: {
          enabled: policy.hexis.enabled,
          applied: Boolean(activeHexis) && hexisApplied.gate.enabled,
          reason: hexisApplied.gate.reason,
          reorderWindow: hexisApplied.gate.reorderWindow,
          ambiguityGap: hexisApplied.gate.ambiguityGap,
          admissibleIds: hexisApplied.gate.admissibleIds,
        },
      };
    }
    let { selected, renderedText, accessTrackedIds } = withHexisView;

    // Relevance gate (Rúnir-2i8k): TURN-path TOP-HIT floor. If the best selected memory's
    // POST-RERANK COSINE score is below RECALL_RELEVANCE_FLOOR, the query has nothing relevant —
    // return an empty result instead of injecting the weak top-K tail. Applied ONLY when (a) the
    // floor is enabled (>0), (b) the top hit carries a reranker cosine score (scoreStages.reranker
    // — never the uncalibrated RRF fallback), and (c) this is not the (retired) opener intent.
    // DEFAULT floor 0 = OFF (no behavior change). The dropped hits are NOT access-tracked (nothing
    // was shown to the agent). See src/recall/selection/relevance-gate.ts (RECALL_RELEVANCE_FLOOR).
    let relevanceGate: { floor: number; topScore: number; droppedIds: string[] } | undefined;
    if (relevanceGateDrops(selected[0], RECALL_RELEVANCE_FLOOR, intent.label)) {
      relevanceGate = {
        floor: RECALL_RELEVANCE_FLOOR,
        topScore: selected[0].scoreStages?.reranker?.score ?? selected[0].score,
        droppedIds: selected.map((h) => h.id),
      };
      selected = [];
      renderedText = [];
      accessTrackedIds = [];
      // Keep the debug/calibration audit consistent with the empty response — finalSelectedIds was
      // assembled from the pre-gate selection above, so it must be zeroed when the gate fires.
      retrievalAudit.finalSelectedIds = [];
    }

    retrievalAudit.admissibility = withHexisView.admissibility;
    retrievalAudit.noema = {
      policyId: noemaPolicy.id,
      mode: noemaPolicy.mode,
      reason: noemaPolicy.reason,
      candidateCount: rawResults.filter((hit) => hit.sourceKind === "noema").length,
      candidateIds: rawResults.filter((hit) => hit.sourceKind === "noema").map((hit) => hit.id),
    };

    retrievalAudit.recipe = buildRecipeTraceMetadata({
      recipe,
      policy,
      retrievalPath: fallbackRetrievalPath,
      topK: cfg.topK,
      sourceCounts: countStagesBySource(traceCollector?.stages),
    });

    const finalTrace = traceCollector?.finalize(prompt, "hybrid");
    if (finalTrace) {
      finalTrace.intentLabel = intent.label;
      finalTrace.recipe = retrievalAudit.recipe;
      retrievalStats.recordQuery(finalTrace, "recall");
      debugLogger.retrievalTrace({
        session: body.sessionId ?? "default",
        summary: `${traceCollector!.summarize()} recipe=${recipe.id}@${recipe.version} ${formatCanonicalContextForDebug(contextIdentity)}`,
      });
    }

    debugLogger.recallResults({
      session: body.sessionId ?? "default",
      query: prompt,
      count: selected.length,
      topScore: selected[0]?.score ?? 0,
    });

    if (accessTrackedIds.length > 0) {
      const now = new Date().toISOString();
      const trackedRefs = accessTrackedIds.map((id) => `semiote:${id.replace(/^semiote:/, "")}`);
      db.query(
        `UPDATE semiote SET payload.accessCount = (payload.accessCount ?? 0) + 1, payload.lastAccessedAt = $now, retrieved_count = (retrieved_count ?? 0) + 1, last_retrieved_at = <datetime>$now WHERE id INSIDE $ids;`,
        { ids: trackedRefs, now },
      ).catch((err) => console.warn("runir-service: access tracking update failed:", err));
    }

    const nonEmptyRendered = renderedText.filter((l) => l.trim() !== "");
    const sessionOpener = intent.label === "session_opener"
      ? buildSessionOpenerPayload({
          projectState: null,
          hits: selected,
          requestedPath: reqPath,
        })
      : null;
    const prependContext = sessionOpener
      ? formatSessionOpenerInjection(sessionOpener)
      : nonEmptyRendered.length > 0 ? formatRecallInjectionFromRendered(renderedText) : null;
    retrievalAudit.calibration = buildRetrievalCalibrationTelemetry({
      policy,
      candidatePool: withHexisView.filtered,
      gate: hexisGateForTelemetry,
      safeLimit: Math.max(1, Math.min(Math.floor(cfg.topK * 3), 200)),
      recallLatencyMs: performance.now() - recallStartedAtMs,
      emittedContextSize: prependContext?.length ?? 0,
    });
    const retrievalTraceId = prependContext
      ? await persistTrace(contextIdentity, selected, accessTrackedIds, fallbackRetrievalPath, retrievalAudit, prependContext)
      : undefined;
    const overlaySnapshotCount = overlayRegistry.forUser(uid).snapshot().length;
    const rywDiagnostic = {
      routeOverlayWired: true,
      overlaySnapshotCount,
      rawCandidateCount: rawResults.length,
      filteredCandidateCount: baselinePool.length,
      selectedCount: selected.length,
      renderedCount: nonEmptyRendered.length,
      hexisApplied: Boolean(retrievalAudit.hexis?.applied),
      emptyReason: relevanceGate
        ? "relevance_gated"
        : rawResults.length === 0
        ? (overlaySnapshotCount > 0 ? "committed_or_overlay_not_candidate" : "no_overlay_entries_or_durable_candidates")
        : baselinePool.length === 0
          ? "scope_or_soft_filter_removed_candidates"
          : selected.length === 0
            ? "selector_or_admissibility_filtered"
            : !prependContext
              ? "candidate_selected_but_rendering_empty"
              : retrievalAudit.hexis?.applied
                ? "hexis_reranked"
                : "selected_and_rendered",
    };
    if (isDebug && finalTrace) {
      // --- Layer-2 recall attribution envelope (Rúnir-x41m.10 / Option A+): debug-only and
      // RESPONSE-only. Built on the `debugRetrievalAudit` clone below — NEVER on `retrievalAudit`,
      // which was already persisted (line ~1129) — so attribution is never written to the DB.
      // All IDs bare (extractId) so leg/pre/post/base/final/access-tracked/rendered are mutually joinable. ---
      const bareId = (id: string) => extractId(id);
      const rrfFusedIds = Object.entries(capturedLegRanks)
        .filter(([, r]) => typeof r.rrf === "number")
        .sort((a, b) => a[1].rrf! - b[1].rrf!)
        .map(([id]) => id);
      const rawBareIds = rawResults.map((h) => bareId(h.id));
      const baselineBareSet = new Set(baselinePool.map((h) => bareId(h.id)));
      const softFilteredIds = rawBareIds.filter((id) => !baselineBareSet.has(id));
      const candidatePoolIds = capturedStages?.candidatePoolIds ?? rawBareIds;
      const preRerankerIds = capturedStages?.preRerankerIds ?? rawBareIds;
      const postRerankerIds = capturedStages?.postRerankerIds ?? rawBareIds;
      const postRerankerSet = new Set(postRerankerIds);
      const rerankerDroppedIds = preRerankerIds.filter((id) => !postRerankerSet.has(id));
      const noemaSupport: Record<string, string[]> = {};
      for (const h of [...baselinePool, ...selected]) {
        if (h.sourceKind === "noema" && h.noemaSupportSemioteIds?.length) {
          noemaSupport[bareId(h.id)] = h.noemaSupportSemioteIds.map(bareId);
        }
      }
      const attribution: RecallAttributionEnvelope = {
        schemaVersion: 1,
        lane: policy.lane,
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        retrievalPath: fallbackRetrievalPath,
        window: {
          topK: cfg.topK,
          candidateLimit: capturedStages?.candidateLimit ?? rawResults.length,
          ...(capturedStages?.legFetchLimit !== undefined ? { legFetchLimit: capturedStages.legFetchLimit } : {}),
          ...(capturedStages?.fusionCandidateLimit !== undefined ? { fusionCandidateLimit: capturedStages.fusionCandidateLimit } : {}),
          ...(capturedStages?.rerankCandidateLimit !== undefined ? { rerankCandidateLimit: capturedStages.rerankCandidateLimit } : {}),
        },
        legRanks: capturedLegRanks,
        rrfFusedIds,
        candidatePoolIds,
        overlaySnapshotCount,
        preRerankerIds,
        postRerankerIds,
        reranker: {
          active: capturedStages?.rerankerActive ?? false,
          ...(capturedStages?.rerankerThreshold !== undefined ? { threshold: capturedStages.rerankerThreshold } : {}),
          droppedIds: rerankerDroppedIds,
          // Per-id reranker scores (architect Layer-2 requires "reranker score?"): lets a
          // gold unit dropped between pre/post-reranker be diagnosed against the threshold.
          scores: capturedStages?.rerankerScores ?? {},
        },
        softFilteredIds,
        baseCandidateIds: (retrievalAudit.baseCandidateIds ?? baselinePool.map((h) => h.id)).map(bareId),
        finalSelectedIds: (retrievalAudit.finalSelectedIds ?? selected.map((h) => h.id)).map(bareId),
        accessTrackedIds: accessTrackedIds.map(bareId),
        renderedSelectedIds: selected
          .filter((_hit, i) => renderedText[i]?.trim())
          .map((hit) => bareId(hit.id)),
        ...(Object.keys(noemaSupport).length > 0 ? { noemaSupport } : {}),
      };
      const debugRetrievalAudit: RetrievalAuditRecord = { ...retrievalAudit, attribution };
      const debugHits = selected.map((h) => ({
        id: h.id,
        score: h.score,
        isStale: h.isStale,
        staleSince: h.staleSince,
        contradictedBy: h.contradictedBy,
      }));
      const baselineView = withoutHexisView ?? withHexisView;
      const baselineRanks = new Map(baselineView.selected.map((hit, index) => [hit.id, index + 1]));
      const hexisRanks = new Map(withHexisView.selected.map((hit, index) => [hit.id, index + 1]));
      const deltaIds = new Set([
        ...baselineView.selected.map((hit) => hit.id),
        ...withHexisView.selected.map((hit) => hit.id),
      ]);
      const rankDeltas = [...deltaIds].map((id) => {
        const baselineRank = baselineRanks.get(id) ?? null;
        const finalRank = hexisRanks.get(id) ?? null;
        const baselineHit = baselineView.selected.find((hit) => hit.id === id);
        const finalHit = withHexisView.selected.find((hit) => hit.id === id);
        const scoreDelta = (finalHit?.score ?? 0) - (baselineHit?.score ?? 0);
        let reason = "unchanged";
        if (baselineRank == null && finalRank != null) reason = "promoted_into_topk";
        else if (baselineRank != null && finalRank == null) reason = "demoted_out_of_topk";
        else if (baselineRank != null && finalRank != null && finalRank < baselineRank) reason = "promoted";
        else if (baselineRank != null && finalRank != null && finalRank > baselineRank) reason = "demoted";
        return {
          id,
          baselineRank,
          finalRank,
          scoreDelta,
          hexisFit: finalHit?.hexisFit ?? null,
          reason,
        };
      });
      if (process.env.RUNIR_RECALL_DEBUG === "1") {
        process.stderr.write(`[recall-debug] selected.length=${selected.length}\n`);
      }
      return {
        kind: "hybrid_debug",
        body: {
          prependContext,
          count: sessionOpener ? selected.length : nonEmptyRendered.length,
          ...(sessionOpener ? { sessionOpener } : {}),
          ...(retrievalTraceId ? { retrievalTraceId } : {}),
          selected: buildSelectedPayload(selected),
          ...(withHexisView.budgetFit ? { budgetFit: withHexisView.budgetFit } : {}),
          _debug: {
            trace: { ...finalTrace, hits: debugHits },
            hexisComparison: {
              resolutionSource: hexisResolutionSource,
              applied: Boolean(retrievalAudit.hexis?.applied),
              resolvedHexisId: activeHexis?.id ?? null,
              resolvedHexisLabel: activeHexis?.label ?? null,
              candidatePool: summarizeHitsForHexisDebug(
                [...cloneHits(baselinePool)].sort((a, b) => b.score - a.score),
              ),
              withoutHexis: {
                rankedPool: summarizeHitsForHexisDebug(baselineView.filtered),
                selected: summarizeHitsForHexisDebug(baselineView.selected),
                count: baselineView.selected.length,
              },
              withHexis: {
                rankedPool: summarizeHitsForHexisDebug(withHexisView.filtered),
                selected: summarizeHitsForHexisDebug(withHexisView.selected),
                count: withHexisView.selected.length,
              },
              reorderWindow: {
                candidatePoolSize: baselinePool.length,
                admissibleIds: hexisReorderWindowIds,
              },
              rankDeltas,
            },
            retrievalAudit: debugRetrievalAudit,
            rywDiagnostic,
            footprint: {
              retrievalTraceId: retrievalTraceId ?? null,
              selectedCount: selected.length,
              shownCount: accessTrackedIds.length,
              selectedNotShownCount: Math.max(0, selected.length - accessTrackedIds.length),
              identity: formatCanonicalContextForDebug(contextIdentity),
            },
            ...(relevanceGate ? { relevanceGate } : {}),
          },
        },
      };
    }
    if (process.env.RUNIR_RECALL_DEBUG === "1") {
      process.stderr.write(`[recall-debug] selected.length=${selected.length}\n`);
    }
    return {
      kind: "hybrid_plain",
      body: {
        prependContext,
        count: sessionOpener ? selected.length : nonEmptyRendered.length,
        ...(sessionOpener ? { sessionOpener } : {}),
        ...(retrievalTraceId ? { retrievalTraceId } : {}),
        selected: buildSelectedPayload(selected),
        ...(withHexisView.budgetFit ? { budgetFit: withHexisView.budgetFit } : {}),
      },
    };
  } catch (err) {
    return { kind: "error", body: { prependContext: null, count: 0, error: String(err) }, statusCode: 500 };
  }
}
