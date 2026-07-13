import { describe, expect, it } from "vitest";
import {
  cloneAdmissibilityContract,
  resolveAdmissibilityContractForSelectorProfile,
} from "../admissibility-contract.js";
import type { SelectorProfile } from "../policy-types.js";

const PINNED_SELECTOR_PROFILES: ReadonlyArray<SelectorProfile> = [
  "guidance_reference",
  "workflow_posture",
  "recent_work",
  "status_continuity",
];

describe("admissibility-contract snapshot — locks 4 contract definitions", () => {
  for (const profile of PINNED_SELECTOR_PROFILES) {
    it(`pins shape for selector profile: ${profile}`, () => {
      const contract = resolveAdmissibilityContractForSelectorProfile(profile);
      expect(contract).toBeDefined();
      expect(contract).toMatchSnapshot();
    });
  }

  it("returns undefined for unsupported selector profile (mixed_default)", () => {
    expect(
      resolveAdmissibilityContractForSelectorProfile("mixed_default" as SelectorProfile),
    ).toBeUndefined();
  });

  it("cloneAdmissibilityContract deep-clones — mutating the clone does not leak back to source", () => {
    const before = resolveAdmissibilityContractForSelectorProfile("recent_work");
    expect(before).toBeDefined();
    const cloned = cloneAdmissibilityContract(before!);
    cloned.primaryGroups.pop();
    cloned.barredGroups.length = 0;
    cloned.cappedGroups.length = 0;
    cloned.cappedGroups.push({ group: "operational_noise", max: 99 });
    cloned.continuityClasses.durable_guidance = "disallowed";

    const after = resolveAdmissibilityContractForSelectorProfile("recent_work");
    expect(after).toEqual(before);
  });
});
