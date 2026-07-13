import type { SearchHit } from "../../domain/memory/types.js";
import type { LatestStateCandidateGroup } from "./collapse-latest-state-candidates.js";
import { getLatestStateIdentityKey } from "./collapse-latest-state-candidates.js";

export interface LatestStateResolution {
  representatives: SearchHit[];
  hydratedIds: string[];
  droppedSeedIds: string[];
}

function isActiveLineageBacked(hit: SearchHit): boolean {
  return hit.active !== false && Boolean(hit.continuitySubjectKey || hit.lineageRootId);
}

function parseDate(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareLatestStateRepresentatives(a: SearchHit, b: SearchHit): number {
  const aTruth = isActiveLineageBacked(a) ? 1 : 0;
  const bTruth = isActiveLineageBacked(b) ? 1 : 0;
  if (aTruth !== bTruth) return bTruth - aTruth;

  if (a.score !== b.score) return b.score - a.score;

  const aValid = parseDate(a.validAt) || parseDate(a.updatedAt) || parseDate(a.createdAt);
  const bValid = parseDate(b.validAt) || parseDate(b.updatedAt) || parseDate(b.createdAt);
  if (aValid !== bValid) return bValid - aValid;

  return a.id.localeCompare(b.id);
}

function mergeRepresentativeScore(hit: SearchHit, bestScore: number): SearchHit {
  return {
    ...hit,
    score: Math.max(hit.score, bestScore),
    rankingExplanation: [
      ...(hit.rankingExplanation ?? []),
      isActiveLineageBacked(hit)
        ? "latest_state:active_lineage_representative"
        : "latest_state:seed_candidate",
    ].slice(0, 8),
  };
}

export function resolveLatestStateRepresentatives(
  groups: LatestStateCandidateGroup[],
  hydratedHits: SearchHit[],
): LatestStateResolution {
  const hydratedByIdentity = new Map<string, SearchHit[]>();
  for (const hit of hydratedHits) {
    const identityKey = getLatestStateIdentityKey(hit);
    const bucket = hydratedByIdentity.get(identityKey);
    if (bucket) bucket.push(hit);
    else hydratedByIdentity.set(identityKey, [hit]);
  }

  const representatives: SearchHit[] = [];
  const hydratedIds = new Set<string>();
  const droppedSeedIds = new Set<string>();

  for (const group of groups) {
    const hydrated = hydratedByIdentity.get(group.identityKey) ?? [];
    hydrated.forEach((hit) => hydratedIds.add(hit.id));
    const candidates = [...group.hits, ...hydrated].map((hit) => mergeRepresentativeScore(hit, group.bestScore));
    candidates.sort(compareLatestStateRepresentatives);
    const representative = candidates[0];
    if (!representative) continue;
    representatives.push(representative);
    for (const seed of group.hits) {
      if (seed.id !== representative.id) droppedSeedIds.add(seed.id);
    }
  }

  representatives.sort(compareLatestStateRepresentatives);
  return {
    representatives,
    hydratedIds: [...hydratedIds],
    droppedSeedIds: [...droppedSeedIds],
  };
}
