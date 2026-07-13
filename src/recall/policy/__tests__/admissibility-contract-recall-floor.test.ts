import { describe, expect, it } from "vitest";
import { resolveAdmissibilityContractForSelectorProfile } from "../admissibility-contract.js";
import type { SelectorProfile } from "../policy-types.js";

/**
 * Recall-floor regression — pins the per-profile admission shape (primary +
 * secondary slot count) anchored to the values present at PRD-WB-4 close
 * (2026-04-27). Any future deletion of a primary/secondary/barred predicate
 * trips this test, complementing the kill criterion in PRD-WB-4 meta.
 *
 * additive-only refactors keep these floors intact; deletions break them.
 */

type RecallFloor = {
  primary: number;
  secondary: number;
  barred: number;
  capped: number;
};

const PINNED_FLOORS: Partial<Record<SelectorProfile, RecallFloor>> = {
  guidance_reference: { primary: 2, secondary: 2, barred: 4, capped: 0 },
  workflow_posture: { primary: 2, secondary: 2, barred: 3, capped: 1 },
  recent_work: { primary: 3, secondary: 2, barred: 3, capped: 1 },
  status_continuity: { primary: 4, secondary: 2, barred: 0, capped: 0 },
};

const TOTAL_ADMISSIBLE_FLOOR = 4 + 4 + 5 + 6; // primary+secondary across the 4 contracts = 19

describe("admissibility-contract recall-floor regression", () => {
  for (const [profile, floor] of Object.entries(PINNED_FLOORS) as Array<
    [SelectorProfile, RecallFloor]
  >) {
    it(`pinned floor holds for selector profile: ${profile}`, () => {
      const contract = resolveAdmissibilityContractForSelectorProfile(profile);
      expect(contract, `contract resolution for ${profile}`).toBeDefined();
      expect(contract!.primaryGroups.length).toBeGreaterThanOrEqual(floor.primary);
      expect(contract!.secondaryGroups.length).toBeGreaterThanOrEqual(floor.secondary);
      expect(contract!.barredGroups.length).toBeGreaterThanOrEqual(floor.barred);
      expect(contract!.cappedGroups.length).toBeGreaterThanOrEqual(floor.capped);
    });
  }

  it("total admissible slots (primary+secondary) across 4 contracts ≥ pinned floor", () => {
    let total = 0;
    for (const profile of Object.keys(PINNED_FLOORS) as SelectorProfile[]) {
      const contract = resolveAdmissibilityContractForSelectorProfile(profile);
      if (!contract) continue;
      total += contract.primaryGroups.length + contract.secondaryGroups.length;
    }
    expect(total).toBeGreaterThanOrEqual(TOTAL_ADMISSIBLE_FLOOR);
  });

  it("ADMISSIBILITY_CONTRACT_VERSION pin survives — at least one contract reports the frozen version", () => {
    // Anchors the contract-version constant at admissibility-contract.ts:3 — a
    // version bump is allowed only as part of an explicit ADR amendment cycle,
    // which would also re-baseline this test. This exists to catch silent drift.
    const contract = resolveAdmissibilityContractForSelectorProfile("recent_work");
    expect(contract).toBeDefined();
    expect(contract!.version).toBe("2026-04-18-v1");
  });
});
