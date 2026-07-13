import { describe, expect, it } from "vitest";
import { collapseLatestStateCandidates } from "../recall/latest-state/collapse-latest-state-candidates.js";
import {
  compareLatestStateRepresentatives,
  resolveLatestStateRepresentatives,
} from "../recall/latest-state/resolve-latest-state-representatives.js";
import type { SearchHit } from "../domain/memory/types.js";

function makeHit(overrides: Partial<SearchHit> & { id: string; text?: string; score?: number }): SearchHit {
  return {
    text: overrides.text ?? overrides.id,
    score: overrides.score ?? 0,
    ...overrides,
  };
}

describe("latest-state lane", () => {
  it("collapses candidates by continuitySubjectKey then lineageRootId then id", () => {
    const groups = collapseLatestStateCandidates([
      makeHit({ id: "a1", continuitySubjectKey: "subject:a", score: 0.9 }),
      makeHit({ id: "a2", continuitySubjectKey: "subject:a", score: 0.8 }),
      makeHit({ id: "b1", lineageRootId: "lineage:b", score: 0.7 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.identityKey).toBe("subject:a");
    expect(groups[0]?.hits).toHaveLength(2);
    expect(groups[1]?.identityKey).toBe("lineage:b");
  });

  it("prefers active lineage-backed representatives over stale higher-scoring seeds", () => {
    const groups = collapseLatestStateCandidates([
      makeHit({ id: "stale-1", continuitySubjectKey: "subject:x", score: 0.98, active: false, updatedAt: "2026-04-10T00:00:00Z" }),
    ]);

    const resolution = resolveLatestStateRepresentatives(groups, [
      makeHit({ id: "active-1", continuitySubjectKey: "subject:x", score: 0.2, active: true, validAt: "2026-04-12T00:00:00Z" }),
    ]);

    expect(resolution.representatives[0]?.id).toBe("active-1");
    expect(resolution.hydratedIds).toContain("active-1");
    expect(resolution.droppedSeedIds).toContain("stale-1");
  });

  it("uses validAt then updatedAt then createdAt then id as tie-breakers", () => {
    const newer = makeHit({ id: "b", continuitySubjectKey: "subject:y", score: 0.8, active: true, validAt: "2026-04-13T00:00:00Z" });
    const older = makeHit({ id: "a", continuitySubjectKey: "subject:y", score: 0.8, active: true, validAt: "2026-04-12T00:00:00Z" });
    expect(compareLatestStateRepresentatives(older, newer)).toBeGreaterThan(0);
  });
});
