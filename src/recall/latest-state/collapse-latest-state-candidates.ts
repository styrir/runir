import type { SearchHit } from "../../domain/memory/types.js";

export interface LatestStateCandidateGroup {
  identityKey: string;
  continuitySubjectKey?: string;
  lineageRootId?: string;
  bestScore: number;
  hits: SearchHit[];
}

export function getLatestStateIdentityKey(hit: SearchHit): string {
  return hit.continuitySubjectKey ?? hit.lineageRootId ?? hit.id;
}

export function collapseLatestStateCandidates(hits: SearchHit[]): LatestStateCandidateGroup[] {
  const groups = new Map<string, LatestStateCandidateGroup>();

  for (const hit of hits) {
    const identityKey = getLatestStateIdentityKey(hit);
    const current = groups.get(identityKey);
    if (current) {
      current.hits.push(hit);
      current.bestScore = Math.max(current.bestScore, hit.score);
      if (!current.continuitySubjectKey && hit.continuitySubjectKey) current.continuitySubjectKey = hit.continuitySubjectKey;
      if (!current.lineageRootId && hit.lineageRootId) current.lineageRootId = hit.lineageRootId;
      continue;
    }

    groups.set(identityKey, {
      identityKey,
      continuitySubjectKey: hit.continuitySubjectKey,
      lineageRootId: hit.lineageRootId,
      bestScore: hit.score,
      hits: [hit],
    });
  }

  return [...groups.values()].sort((a, b) => b.bestScore - a.bestScore || a.identityKey.localeCompare(b.identityKey));
}
