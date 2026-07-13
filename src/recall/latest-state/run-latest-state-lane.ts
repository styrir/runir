import type { MemoryRecordTable, SearchHit } from "../../domain/memory/types.js";
import type { HexisState } from "../../hexis/runtime-hexis.js";
import { hydrateLatestStateRepresentativeHits, type SurrealClient } from "../../storage/surreal/surreal-store.js";
import type { ScopeFilter } from "../query/scope-predicate.js";
import { collapseLatestStateCandidates } from "./collapse-latest-state-candidates.js";
import { resolveLatestStateRepresentatives } from "./resolve-latest-state-representatives.js";
import type { PostProcessResult } from "../selection/recall-selection.js";
import type { RetrievalPolicy, RetrievalAuditRecord } from "../policy/policy-types.js";
import { applyHexisByPolicy } from "../policy/retrieval-controller.js";
import type { TraceCollector } from "../selection/retrieval-trace.js";
import type { HexisGateDecision } from "../policy/policy-types.js";

export interface LatestStateLaneResult {
  baselinePool: SearchHit[];
  preHexisRepresentativePool: SearchHit[];
  representativePool: SearchHit[];
  selectedView: PostProcessResult & { filtered: SearchHit[] };
  audit: RetrievalAuditRecord;
  hexisGate: HexisGateDecision;
}

interface RunLatestStateLaneArgs {
  db: SurrealClient;
  userId: string;
  scopeFilter?: ScopeFilter;
  tableName?: MemoryRecordTable;
  hits: SearchHit[];
  policy: RetrievalPolicy;
  activeHexis?: HexisState | null;
  buildAdmissiblePool: (hits: SearchHit[]) => SearchHit[];
  buildSelectedViewFromPool: (hits: SearchHit[]) => PostProcessResult & { filtered: SearchHit[] };
  traceCollector?: TraceCollector;
}

export async function runLatestStateLane({
  db,
  userId,
  scopeFilter,
  tableName = "semiote",
  hits,
  policy,
  activeHexis,
  buildAdmissiblePool,
  buildSelectedViewFromPool,
  traceCollector,
}: RunLatestStateLaneArgs): Promise<LatestStateLaneResult> {
  const baselinePool = buildAdmissiblePool(hits);
  const groups = collapseLatestStateCandidates(baselinePool);
  const hydratedHits = await hydrateLatestStateRepresentativeHits(db, userId, {
    continuitySubjectKeys: groups.map((group) => group.continuitySubjectKey).filter((value): value is string => Boolean(value)),
    lineageRootIds: groups.map((group) => group.lineageRootId).filter((value): value is string => Boolean(value)),
    scopeFilter,
    tableName,
  });

  const { representatives, hydratedIds, droppedSeedIds } = resolveLatestStateRepresentatives(groups, hydratedHits);
  if (traceCollector) {
    traceCollector.startStage("latest_state_resolution", baselinePool.map((hit) => hit.id));
    traceCollector.endStage(representatives.map((hit) => hit.id), representatives.map((hit) => hit.score));
  }

  const hexisApplied = applyHexisByPolicy(representatives, activeHexis, policy);
  if (traceCollector && activeHexis) {
    traceCollector.startStage("hexis_rerank", representatives.map((hit) => hit.id));
    traceCollector.endStage(hexisApplied.hits.map((hit) => hit.id), hexisApplied.hits.map((hit) => hit.score));
  }

  const selectedView = buildSelectedViewFromPool(hexisApplied.hits);
  return {
    baselinePool,
    preHexisRepresentativePool: representatives,
    representativePool: hexisApplied.hits,
    selectedView,
    audit: {
      lane: policy.lane,
      baseCandidateCount: baselinePool.length,
      baseCandidateIds: baselinePool.map((hit) => hit.id),
      finalSelectedIds: selectedView.selected.map((hit) => hit.id),
      latestState: {
        collapsedGroupCount: groups.length,
        collapsedIdentityKeys: groups.map((group) => group.identityKey),
        hydratedIds,
        representativeIds: representatives.map((hit) => hit.id),
        droppedSeedIds,
      },
      hexis: {
        enabled: policy.hexis.enabled,
        applied: Boolean(activeHexis) && hexisApplied.gate.enabled,
        reason: hexisApplied.gate.reason,
        reorderWindow: hexisApplied.gate.reorderWindow,
        ambiguityGap: hexisApplied.gate.ambiguityGap,
        admissibleIds: hexisApplied.gate.admissibleIds,
      },
    },
    hexisGate: hexisApplied.gate,
  };
}
