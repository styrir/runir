import type { SearchHit } from "../domain/memory/types.js";
import type { CanonicalContextIdentity } from "../identity/canonical-context.js";
import {
  getRetrievalFootprintFromTrace,
  retrievalFootprintIdentityMatches,
  toRetrievalFootprintIdentitySnapshot,
  type RetrievalFootprint,
  type RetrievalFootprintIdentitySnapshot,
} from "../storage/surreal/phase2-store.js";
import {
  getProjectStateForCaptureContext,
  listNearbyExistingForCaptureContext,
  listRecentFactsForCaptureContext,
  type SurrealClient,
} from "../storage/surreal/surreal-store.js";

export type StateAnchor = {
  projectStateId: string;
  currentFocus?: string;
  latestProgress?: string;
  blockers: string[];
  nextSteps: string[];
  updatedAt: string;
  confidence: number;
  freshness: "fresh" | "stale";
};

export type CaptureContextPacket = {
  identity: RetrievalFootprintIdentitySnapshot;
  recent_facts: SearchHit[];
  retrieval_footprint: RetrievalFootprint | null;
  nearby_existing: SearchHit[];
  state_anchor: StateAnchor | null;
  relation_hints: [];
  debug: {
    slotCounts: {
      recentFacts: number;
      shownMemoryIds: number;
      nearbyExisting: number;
      relationHints: number;
    };
    stateAnchorState: "present" | "stale" | "omitted";
    identityMatchedFootprint: boolean | null;
  };
};

function resolveStateAnchorFreshness(updatedAt: string): "fresh" | "stale" {
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (Number.isNaN(ageMs)) return "stale";
  return ageMs <= 24 * 3600 * 1000 ? "fresh" : "stale";
}

export async function buildCaptureContextPacket(args: {
  db: SurrealClient;
  userId: string;
  identity: CanonicalContextIdentity;
  retrievalTraceId?: string;
  onTiming?: (name: string, durationMs: number) => void;
}): Promise<CaptureContextPacket> {
  const identity = toRetrievalFootprintIdentitySnapshot(args.identity);
  const timed = async <T>(name: string, promise: Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await promise;
    } finally {
      args.onTiming?.(name, Date.now() - startedAt);
    }
  };

  const [recentFacts, nearbyExisting, projectState, retrievalFootprintCandidate] = await Promise.all([
    timed("recent_facts", listRecentFactsForCaptureContext(args.db, args.userId, args.identity, { limit: 5, maxAgeHours: 72 })),
    timed("nearby_existing", listNearbyExistingForCaptureContext(args.db, args.userId, args.identity, { limit: 5 })),
    timed("project_state", getProjectStateForCaptureContext(args.db, args.userId, args.identity)),
    args.retrievalTraceId
      ? timed("retrieval_footprint", getRetrievalFootprintFromTrace(args.db, args.retrievalTraceId, args.userId))
      : Promise.resolve(null),
  ]);

  const identityMatchedFootprint = retrievalFootprintCandidate
    ? retrievalFootprintIdentityMatches(args.identity, retrievalFootprintCandidate)
    : null;
  const retrievalFootprint = identityMatchedFootprint === false ? null : retrievalFootprintCandidate;

  const stateAnchor: StateAnchor | null = projectState
    ? {
        projectStateId: projectState.id,
        currentFocus: projectState.currentFocus,
        latestProgress: projectState.latestProgress,
        blockers: projectState.blockers,
        nextSteps: projectState.nextSteps,
        updatedAt: projectState.updatedAt,
        confidence: projectState.confidence,
        freshness: resolveStateAnchorFreshness(projectState.updatedAt),
      }
    : null;

  return {
    identity,
    recent_facts: recentFacts,
    retrieval_footprint: retrievalFootprint,
    nearby_existing: nearbyExisting,
    state_anchor: stateAnchor,
    relation_hints: [],
    debug: {
      slotCounts: {
        recentFacts: recentFacts.length,
        shownMemoryIds: retrievalFootprint?.shownMemoryIds.length ?? 0,
        nearbyExisting: nearbyExisting.length,
        relationHints: 0,
      },
      stateAnchorState: stateAnchor ? stateAnchor.freshness === "stale" ? "stale" : "present" : "omitted",
      identityMatchedFootprint,
    },
  };
}
