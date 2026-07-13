import { describe, expect, it } from "vitest";
import {
  deriveNoemaClaimContract,
  isValidNoemaStatusTransition,
  normalizeNoemaClaimStatus,
} from "../noema/claim-contract.js";

describe("Noema claim identity contract", () => {
  it("keeps claim_key stable across value revisions while revision_hash changes", () => {
    const base = deriveNoemaClaimContract({
      userId: "u1",
      scope: "user",
      path: "/repo",
      memoryRole: "preference",
      factKey: "preferences:editor",
      canonicalText: "User prefers Vim for quick edits.",
      claimSubject: "editor",
      claimPredicate: "preference",
    });
    const revised = deriveNoemaClaimContract({
      userId: "u1",
      scope: "user",
      path: "/repo",
      memoryRole: "preference",
      factKey: "preferences:editor",
      canonicalText: "User prefers Helix for quick edits.",
      claimSubject: "editor",
      claimPredicate: "preference",
    });

    expect(revised.claimKey).toBe(base.claimKey);
    expect(revised.revisionHash).not.toBe(base.revisionHash);
    expect(revised.stableClaim).toEqual({
      subject: "editor",
      predicate: "preference",
      value: "User prefers Helix for quick edits.",
    });
  });

  it("uses factKey as a seed without making it the whole identity rule", () => {
    const first = deriveNoemaClaimContract({
      userId: "u1",
      scope: "user",
      path: "/repo/a",
      memoryRole: "preference",
      factKey: "preferences:editor",
      canonicalText: "User prefers Vim.",
      claimSubject: "editor",
      claimPredicate: "preference",
    });
    const second = deriveNoemaClaimContract({
      userId: "u1",
      scope: "user",
      path: "/repo/b",
      memoryRole: "preference",
      factKey: "preferences:editor",
      canonicalText: "User prefers Vim.",
      claimSubject: "editor",
      claimPredicate: "preference",
    });

    expect(second.factKeySeed).toBe("preferences:editor");
    expect(second.claimKey).not.toBe(first.claimKey);
  });

  it("normalizes status and rejects terminal-state transitions", () => {
    expect(normalizeNoemaClaimStatus("conflicted")).toBe("conflicted");
    expect(normalizeNoemaClaimStatus("unknown")).toBe("active");
    expect(isValidNoemaStatusTransition("active", "conflicted")).toBe(true);
    expect(isValidNoemaStatusTransition("conflicted", "active")).toBe(true);
    expect(isValidNoemaStatusTransition("superseded", "active")).toBe(false);
    expect(isValidNoemaStatusTransition("rejected", "active")).toBe(false);
  });
});
