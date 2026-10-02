import { describe, expect, it, vi } from "vitest";
import { RecordId } from "surrealdb";
import type { SearchHit } from "../domain/memory/types.js";
import {
  PROCESSING_LINEAGE_VERSION,
} from "../domain/memory/processing-lineage.js";
import {
  attachSearchHitLineage,
  attachSelectedSearchHitLineage,
  getSearchHitLineage,
} from "../domain/memory/search-hit-lineage.js";
import { mergeNoemaRetrievalLeg } from "../recall/policy/noema-retrieval-policy.js";
import { rerankCurrentStatusHits } from "../recall/continuity/recall-status-policy.js";
import { resolveLatestStateRepresentatives } from "../recall/latest-state/resolve-latest-state-representatives.js";
import {
  DEFAULT_RANKING_PLAN,
  executeRankingPlan,
} from "../recall/orchestrator/ranking-plan.js";
import { applyRerankScores } from "../recall/selection/recall-selection.js";
import { applyHexisToHits } from "../hexis/runtime-hexis.js";
import {
  createOverlayRegistry,
  type OverlayEntry,
} from "../storage/overlay/overlay-store.js";
import type { OverlayLockKey } from "../storage/writes/overlay-supersession.js";
import { mergeOverlayLeg } from "../recall/query/overlay-merge.js";

const USER = "user.sourcec.r3";
const FIXED_NOW_MS = 1_700_000_000_000;

const VALID_LINEAGE = {
  state: "minni_verified",
  origin: "minni",
  producer_principal_ref: "principal.sourcec.r3",
  producer_registration_ref: "registration.sourcec.r3",
  processing_policy_version: "runir.minni.local/v1",
  admitted_operation: "capture_ingest",
  target_user_id: USER,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "ordinary",
    restrictions: [],
  },
} as const;

const RESTRICTED_LINEAGE = {
  ...VALID_LINEAGE,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "local_only",
    restrictions: ["audio_derived", "excluded_source", "producer_local_only"],
  },
} as const;

const INVALID_LINEAGE = { ...VALID_LINEAGE, state: "forged" };

function hit(id: string, processingLineage: unknown): SearchHit {
  return attachSelectedSearchHitLineage(
    {
      id,
      text: `synthetic ${id}`,
      score: 0.8,
      active: true,
      continuitySubjectKey: `subject:${id}`,
      memoryRole: "current_status",
    },
    processingLineage,
  );
}

function entry(
  memoryId: string,
  userId = USER,
  active = true,
): OverlayEntry {
  const lockKey: OverlayLockKey = {
    factKey: `fact:${memoryId}`,
    continuitySubjectKey: `subject:${memoryId}`,
  };
  return {
    memoryId,
    text: `overlay ${memoryId}`,
    lockKey,
    userId,
    score: 0.95,
    committedAtMs: FIXED_NOW_MS,
    expiresAtMs: FIXED_NOW_MS + 120_000,
    lastAccessedAtMs: FIXED_NOW_MS,
    active,
    outcome: "create",
  };
}

function registry() {
  return createOverlayRegistry({
    perTenantCap: 256,
    ttlMs: 120_000,
    globalAggregateCap: 5_000,
    now: () => FIXED_NOW_MS,
  });
}

describe("R3 lineage carrier propagation", () => {
  it("keeps valid/restricted/legacy/invalid/unavailable states neutral and non-wire", () => {
    expect(getSearchHitLineage(hit("valid", VALID_LINEAGE))).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(hit("restricted", RESTRICTED_LINEAGE))).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(hit("legacy", undefined))).toEqual({ state: "legacy_unknown" });
    expect(getSearchHitLineage(hit("invalid", INVALID_LINEAGE))).toMatchObject({ state: "invalid" });

    const spoofed = attachSearchHitLineage({
      id: "foreign",
      text: "minni_verified",
      score: 1,
      processing_lineage: VALID_LINEAGE,
    });
    expect(getSearchHitLineage(spoofed)).toEqual({ state: "unavailable" });
    expect(JSON.stringify(hit("valid", VALID_LINEAGE))).not.toContain("processing_lineage");
    expect(JSON.stringify(hit("valid", VALID_LINEAGE))).not.toContain("minni_verified");
    expect(getSearchHitLineage({ ...hit("valid", VALID_LINEAGE) })).toMatchObject({ state: "minni_verified" });
  });

  it("uses one current-user durable fallback and preserves overlay precedence plus current lineage", async () => {
    const overlays = registry();
    const currentStore = overlays.forUser(USER);
    const entries = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"].map((id) => entry(id));
    // M1's overlay active bit is deliberately spoofed; current durable active
    // state must win. M2's overlay also carries a spoofed lineage field.
    (entries[0] as { active: boolean }).active = false;
    (entries[1] as OverlayEntry & { processing_lineage?: unknown }).processing_lineage = INVALID_LINEAGE;
    entries.forEach((item) => currentStore.put(item.lockKey, item));
    const dbQuery = vi.fn().mockResolvedValueOnce([[
      { id: "M2", user_id: USER, payload_user_id: USER, active: true, processing_lineage: VALID_LINEAGE },
      { id: "M3", user_id: USER, payload_user_id: USER, active: true },
      { id: "M4", user_id: USER, payload_user_id: USER, active: true, processing_lineage: INVALID_LINEAGE },
      { id: "M5", user_id: "other-user", payload_user_id: "other-user", active: true, processing_lineage: VALID_LINEAGE },
      { id: "M6", user_id: USER, payload_user_id: USER, active: false, processing_lineage: VALID_LINEAGE },
    ]]);

    const merged = await mergeOverlayLeg({
      db: { query: dbQuery } as any,
      userId: USER,
      overlay: { registry: overlays },
      durableHits: [hit("M1", VALID_LINEAGE)],
      tableName: "semiote",
    });

    expect(dbQuery).toHaveBeenCalledOnce();
    expect(dbQuery.mock.calls[0][0]).toContain("user_id");
    expect(dbQuery.mock.calls[0][0]).toContain("payload.userId AS payload_user_id");
    expect(dbQuery.mock.calls[0][0]).toContain("processing_lineage");
    const params = dbQuery.mock.calls[0][1] as { ids: RecordId<string>[]; requestedUser: string };
    expect(params.requestedUser).toBe(USER);
    expect(params.ids.map((id) => id.toJSON())).toEqual([
      "semiote:M2",
      "semiote:M3",
      "semiote:M4",
      "semiote:M5",
      "semiote:M6",
      "semiote:M7",
    ]);
    expect(merged.map((item) => item.id)).toEqual(["M1", "M2", "M3", "M4"]);

    const m1 = merged.find((item) => item.id === "M1")!;
    expect(m1).toMatchObject({ text: "overlay M1", score: 0.95, active: true });
    expect(getSearchHitLineage(m1)).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(merged.find((item) => item.id === "M2"))).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(merged.find((item) => item.id === "M3"))).toEqual({ state: "legacy_unknown" });
    expect(getSearchHitLineage(merged.find((item) => item.id === "M4"))).toMatchObject({ state: "invalid" });
    expect(JSON.stringify(merged)).not.toContain("processing_lineage");
  });

  it("drops missing, malformed, foreign, inactive, unrequested, and trapped rows before lineage selection", async () => {
    const overlays = registry();
    const ids = [
      "valid",
      "legacy",
      "invalid",
      "missing",
      "null",
      "bad-type",
      "mismatch",
      "foreign",
      "inactive",
      "unrequested",
      "getter",
      "absent",
    ];
    for (const id of ids) {
      const item = entry(id);
      overlays.forUser(USER).put(item.lockKey, item);
    }

    const row = (id: string, fields: Record<string, unknown>): Record<string, unknown> => ({
      id: new RecordId("semiote", id),
      ...fields,
    });
    const trapped = (base: Record<string, unknown>): Record<string, unknown> => {
      Object.defineProperty(base, "processing_lineage", {
        enumerable: true,
        get: () => { throw new Error("selected lineage getter must not run"); },
      });
      return base;
    };
    const dbQuery = vi.fn().mockResolvedValueOnce([[
      row("valid", { user_id: USER, payload_user_id: USER, active: true, processing_lineage: VALID_LINEAGE }),
      row("legacy", { user_id: USER, payload_user_id: USER, active: true }),
      row("invalid", { user_id: USER, payload_user_id: USER, active: true, processing_lineage: INVALID_LINEAGE }),
      trapped(row("missing", { active: true })),
      trapped(row("null", { user_id: null, payload_user_id: null, active: true })),
      trapped(row("bad-type", { user_id: 42, payload_user_id: USER, active: true })),
      trapped(row("mismatch", { user_id: "other-user", payload_user_id: USER, active: true })),
      trapped(row("foreign", { user_id: "other-user", payload_user_id: "other-user", active: true })),
      trapped(row("inactive", { user_id: USER, payload_user_id: USER, active: false })),
      trapped(row("unrequested", { user_id: USER, payload_user_id: USER, active: true })),
      trapped(row("getter", { user_id: USER, payload_user_id: USER, active: true })),
    ]]);

    const merged = await mergeOverlayLeg({
      db: { query: dbQuery } as any,
      userId: USER,
      overlay: { registry: overlays },
      durableHits: [],
      tableName: "semiote",
    });

    expect(merged.map((item) => item.id)).toEqual(["valid", "legacy", "invalid"]);
    expect(getSearchHitLineage(merged.find((item) => item.id === "valid"))).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(merged.find((item) => item.id === "legacy"))).toEqual({ state: "legacy_unknown" });
    expect(getSearchHitLineage(merged.find((item) => item.id === "invalid"))).toMatchObject({ state: "invalid" });
    expect(dbQuery).toHaveBeenCalledOnce();
    const [sql, params] = dbQuery.mock.calls[0] as [string, { ids: RecordId<string>[]; requestedUser: string }];
    expect(sql).toContain("id IN $ids");
    expect(sql).toContain("user_id = $requestedUser");
    expect(sql).toContain("payload.userId = $requestedUser");
    expect(params.requestedUser).toBe(USER);
    expect(params.ids.map((id) => id.toJSON())).toEqual(
      ids.map((id) => new RecordId("semiote", id).toJSON()),
    );
    expect(JSON.stringify(merged)).not.toContain("processing_lineage");
  });

  it("keeps the carrier through noema/latest-state/status/hexis/ranking/score stages and overlay storage clones", () => {
    const original = hit("stage", VALID_LINEAGE);
    const noema = mergeNoemaRetrievalLeg([], [{ ...original, sourceKind: "noema" }], {
      id: "noema",
      mode: "annotation",
      reason: "test",
      preferNoemaOverSupportingSemiote: false,
      fallbackOnly: true,
    }, 1);
    expect(getSearchHitLineage(noema[0])).toMatchObject({ state: "minni_verified" });

    const latest = resolveLatestStateRepresentatives([{
      identityKey: "subject:stage",
      continuitySubjectKey: "subject:stage",
      bestScore: 0.8,
      hits: [original],
    }], []);
    expect(getSearchHitLineage(latest.representatives[0])).toMatchObject({ state: "minni_verified" });

    expect(getSearchHitLineage(rerankCurrentStatusHits([original], undefined, FIXED_NOW_MS)[0]))
      .toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(applyHexisToHits([original], null, { lambda: 0 })[0]))
      .toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(executeRankingPlan([original], DEFAULT_RANKING_PLAN, {
      intent: { label: "recall", categories: [] } as any,
      requestedPath: undefined,
      recallFilter: {} as any,
    })[0])).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(applyRerankScores([original], new Map([["stage", 0.9]]), 0.5)[0]))
      .toMatchObject({ state: "minni_verified" });

    const carriedEntry = attachSelectedSearchHitLineage(entry("STORE"), RESTRICTED_LINEAGE) as unknown as OverlayEntry;
    const store = registry().forUser(USER);
    store.put(carriedEntry.lockKey, carriedEntry);
    expect(getSearchHitLineage(store.get(carriedEntry.lockKey))).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(store.snapshot()[0])).toMatchObject({ state: "minni_verified" });
    expect(JSON.stringify(store.snapshot()[0])).not.toContain("minni_verified");
  });

  it("reconstructs and carries selected lineage through the real deterministic session-opener orchestrator path", async () => {
    vi.resetModules();
    const captured: { hits?: SearchHit[] } = {};
    const canonicalIdentity = {
      userId: USER,
      contextScopeKind: "session",
      projectKey: "project.r3",
      raw: { sessionId: "session.r3", path: undefined, projectId: undefined, agentId: undefined, gitRemoteUrl: undefined, gitRepoRoot: undefined },
      derivation: {
        contextScopeKind: { value: "session", source: "sessionId" },
        agentId: { value: undefined, source: "absent" },
        resolvedTaskId: { value: undefined, source: "absent" },
        projectKey: { value: "project.r3", marker: "sessionId" },
      },
    };
    const mocks = {
      analyzeIntent: vi.fn(() => ({ label: "session_opener", categories: [] })),
      shouldSkipRetrieval: vi.fn(() => false),
      resolveRetrievalController: vi.fn(() => ({
        policy: {
          useDeterministicContinuity: true,
          useLatestStateResolution: false,
          retrievalPath: "hybrid",
          hexis: { enabled: false },
          lane: "continuity",
          selectorProfile: "default",
          admissibilityContract: undefined,
          rrfWeights: {},
          recencyWindowHours: 0,
        },
        recipe: { id: "r3-test", version: 1 },
      })),
      resolveNoemaRetrievalPolicy: vi.fn(() => ({
        id: "noema-admissibility-v1",
        mode: "disabled",
        reason: "test",
        preferNoemaOverSupportingSemiote: false,
        fallbackOnly: true,
      })),
      resolveActiveHexisCached: vi.fn(async () => null),
      resolveRankingProfile: vi.fn(() => undefined),
      getLearnedNoiseProfile: vi.fn(async () => ({ learnedNoiseIds: new Set<string>(), threshold: 5 })),
      resolveRunirSession: vi.fn(async () => ({ id: "session.r3", projectIdentitySource: "session", status: "open", closeReason: null })),
      getProjectStateForRecall: vi.fn(async () => ({
        projectState: {
          id: "project-state.r3",
          projectKey: "project.r3",
          path: "/synthetic/r3",
          supportingMemoryIds: ["S1"],
          currentFocus: "lineage propagation",
          latestProgress: "lineage propagation",
          blockers: [],
          directives: [],
          updatedAt: "2026-10-01T21:00:00.000Z",
        },
        usedPathFallback: false,
      })),
      listContinuityMemoryHits: vi.fn(async () => []),
      getPrimaryMemoryRowsByIds: vi.fn(async () => [{
        id: "S1",
        payload: {
          l2: "session opener evidence",
          userId: USER,
          path: "/synthetic/r3",
          continuitySubjectKey: "subject:S1",
          memoryRole: "current_status",
        },
        processing_lineage: VALID_LINEAGE,
        active: true,
      }]),
      postProcessRecallResults: vi.fn((hits: SearchHit[]) => ({
        selected: hits,
        renderedText: ["session opener evidence"],
        accessTrackedIds: hits.map((item) => item.id),
        admissibility: {},
      })),
      buildSessionOpenerPayload: vi.fn((args: { hits: SearchHit[] }) => {
        captured.hits = args.hits;
        return { intent: "continue_previous_work" } as any;
      }),
      formatSessionOpenerInjection: vi.fn(() => "<opener />"),
      createRetrievalTrace: vi.fn(async () => "trace.r3"),
      toRetrievalFootprintIdentitySnapshot: vi.fn(() => ({})),
      buildRecipeTraceMetadata: vi.fn(() => ({ id: "r3-test", version: 1 })),
      formatCanonicalContextForDebug: vi.fn(() => "ctx:r3"),
    };

    vi.doMock("../recall/intent/intent-analyzer.js", () => ({
      analyzeIntent: mocks.analyzeIntent,
      isStatusClassIntent: vi.fn(() => true),
      applyCategoryBoost: vi.fn((hits: SearchHit[]) => hits),
    }));
    vi.doMock("../recall/intent/adaptive-retrieval.js", () => ({ shouldSkipRetrieval: mocks.shouldSkipRetrieval }));
    vi.doMock("../recall/policy/retrieval-controller.js", () => ({
      resolveRetrievalController: mocks.resolveRetrievalController,
      applyHexisByPolicy: vi.fn((hits: SearchHit[]) => ({
        hits,
        gate: { enabled: false, reason: "disabled", admissibleIds: [], reorderWindow: 5, ambiguityGap: 0 },
      })),
    }));
    vi.doMock("../recall/policy/noema-retrieval-policy.js", () => ({ resolveNoemaRetrievalPolicy: mocks.resolveNoemaRetrievalPolicy }));
    vi.doMock("../recall/policy/ranking-profile.js", () => ({
      resolveRankingProfile: mocks.resolveRankingProfile,
      getLearnedNoiseProfile: mocks.getLearnedNoiseProfile,
    }));
    vi.doMock("../hexis/active-hexis-cache.js", () => ({
      resolveActiveHexisCached: mocks.resolveActiveHexisCached,
      hasAdditionalHexisHintSignal: vi.fn(() => false),
    }));
    vi.doMock("../storage/surreal/surreal-store.js", () => ({
      extractId: (id: unknown) => String(id),
      getProjectStateForRecall: mocks.getProjectStateForRecall,
      listContinuityMemoryHits: mocks.listContinuityMemoryHits,
    }));
    vi.doMock("../storage/surreal/phase2-store.js", () => ({
      createRetrievalTrace: mocks.createRetrievalTrace,
      toRetrievalFootprintIdentitySnapshot: mocks.toRetrievalFootprintIdentitySnapshot,
      getPrimaryMemoryRowsByIds: mocks.getPrimaryMemoryRowsByIds,
      queryLearnedStatusNoiseIds: vi.fn(async () => []),
    }));
    vi.doMock("../storage/surreal/runir-session-store.js", () => ({ resolveRunirSession: mocks.resolveRunirSession }));
    vi.doMock("../recall/body-resolution.js", () => ({ resolveBodyCanonicalContext: vi.fn(() => canonicalIdentity) }));
    vi.doMock("../recall/continuity/session-opener.js", () => ({
      buildSessionOpenerPayload: mocks.buildSessionOpenerPayload,
      formatSessionOpenerInjection: mocks.formatSessionOpenerInjection,
    }));
    vi.doMock("../recall/selection/recall-selection.js", () => ({
      postProcessRecallResults: mocks.postProcessRecallResults,
      formatRecallInjectionFromRendered: vi.fn(() => ""),
    }));
    vi.doMock("../recall/policy/recipe-registry.js", () => ({ buildRecipeTraceMetadata: mocks.buildRecipeTraceMetadata }));
    vi.doMock("../recall/policy/calibration-telemetry.js", () => ({ buildRetrievalCalibrationTelemetry: vi.fn(() => ({})) }));

    const { orchestrateRecall } = await import("../recall/orchestrator/recall-orchestrator.js");
    const { getSearchHitLineage: getDynamicSearchHitLineage } = await import("../domain/memory/search-hit-lineage.js");
    const result = await orchestrateRecall({
      db: { query: vi.fn(async () => []) } as any,
      provider: { embedQuery: vi.fn() } as any,
      overlayRegistry: { forUser: vi.fn(() => ({ snapshot: vi.fn(() => []) })) } as any,
      cfg: { topK: 5, reranker: undefined } as any,
      debugLogger: { recallResults: vi.fn(), retrievalTrace: vi.fn() } as any,
      retrievalStats: { recordQuery: vi.fn() } as any,
      resolveActiveHexis: vi.fn(async () => null) as any,
    }, {
      body: { sessionId: "session.r3" },
      prompt: "resume",
      uid: USER,
    });

    expect(result.kind).toBe("deterministic_opener");
    expect(mocks.getPrimaryMemoryRowsByIds).toHaveBeenCalledOnce();
    expect(captured.hits).toHaveLength(1);
    expect(captured.hits?.[0].id).toBe("S1");
    expect(getDynamicSearchHitLineage(captured.hits?.[0])).toMatchObject({ state: "minni_verified" });
  });
});
