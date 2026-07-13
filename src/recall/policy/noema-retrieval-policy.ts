import type { SearchHit } from "../../domain/memory/types";
import type { IntentSignal } from "../intent/intent-analyzer";

export type NoemaRetrievalMode = "primary" | "annotation" | "disabled";

export type NoemaRetrievalPolicy = {
  id: "noema-admissibility-v1";
  mode: NoemaRetrievalMode;
  reason: string;
  preferNoemaOverSupportingSemiote: boolean;
  fallbackOnly: boolean;
};

const PRIMARY_NOEMA_INTENTS = new Set<IntentSignal["label"]>([
  "preference",
  "fact",
  "schema",
  "architecture",
  "exact_lookup",
  "exploratory_topic",
  "entity",
]);

// Annotation-fallback hits are demoted 40% (score * 0.6) because they surface only when NO
// fresher semiote evidence exists for an annotation-only intent (e.g. current_status,
// debugging) — the Noema fact is stale-by-design relative to what the intent actually wants,
// so it should rank below any hit that could compete on fresher grounds.
const NOEMA_ANNOTATION_FALLBACK_DEMOTION = 0.6;

const ANNOTATION_ONLY_INTENTS = new Set<IntentSignal["label"]>([
  "current_status",
  "recent_work",
  "debugging",
  "decision_trace",
  "latest_state",
  "session_opener",
  "event",
  "workflow_posture",
  "decision",
]);

export function resolveNoemaRetrievalPolicy(intent: IntentSignal): NoemaRetrievalPolicy {
  if (PRIMARY_NOEMA_INTENTS.has(intent.label)) {
    return {
      id: "noema-admissibility-v1",
      mode: "primary",
      reason: `stable_or_reference_intent:${intent.label}`,
      preferNoemaOverSupportingSemiote: true,
      fallbackOnly: false,
    };
  }
  if (ANNOTATION_ONLY_INTENTS.has(intent.label)) {
    return {
      id: "noema-admissibility-v1",
      mode: "annotation",
      reason: `fresh_evidence_first:${intent.label}`,
      preferNoemaOverSupportingSemiote: false,
      fallbackOnly: true,
    };
  }
  return {
    id: "noema-admissibility-v1",
    mode: "disabled",
    reason: `unsupported_intent:${intent.label}`,
    preferNoemaOverSupportingSemiote: false,
    fallbackOnly: true,
  };
}

function isActiveNoema(hit: SearchHit): boolean {
  return hit.sourceKind === "noema"
    && (hit.active ?? true) !== false
    && (hit.noemaStatus ?? "active") === "active";
}

function supportIdsFor(hit: SearchHit): Set<string> {
  return new Set((hit.noemaSupportSemioteIds ?? []).map((id) => id.replace(/^semiote:/, "")));
}

export function mergeNoemaRetrievalLeg(
  semioteHits: SearchHit[],
  noemaCandidates: SearchHit[],
  policy: NoemaRetrievalPolicy,
  limit: number,
): SearchHit[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  const activeNoema = noemaCandidates.filter(isActiveNoema);
  if (policy.mode === "disabled" || activeNoema.length === 0) {
    return semioteHits.slice(0, safeLimit);
  }
  if (policy.mode === "annotation") {
    return semioteHits.length > 0
      ? semioteHits.slice(0, safeLimit)
      : activeNoema.slice(0, safeLimit).map((hit) => ({
        ...hit,
        score: hit.score * NOEMA_ANNOTATION_FALLBACK_DEMOTION,
        rankingExplanation: [...(hit.rankingExplanation ?? []), "noema:fallback_only"],
      }));
  }

  const blockedSemioteIds = new Set<string>();
  const noemaClaimKeys = new Set<string>();
  for (const noemaHit of activeNoema) {
    if (noemaHit.noemaClaimKey) noemaClaimKeys.add(noemaHit.noemaClaimKey);
    for (const id of supportIdsFor(noemaHit)) blockedSemioteIds.add(id);
  }
  const filteredSemiote = semioteHits.filter((hit) => {
    const normalizedId = hit.id.replace(/^semiote:/, "");
    return !blockedSemioteIds.has(normalizedId)
      && (!hit.noemaClaimKey || !noemaClaimKeys.has(hit.noemaClaimKey));
  });
  return [...activeNoema, ...filteredSemiote]
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);
}
