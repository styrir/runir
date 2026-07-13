import { describe, expect, it } from "vitest";
import {
  buildSeedAndVerifyPlan,
  collectResultIds,
  evaluateIdAssertions,
  evaluateTextAssertions,
  resolveExecutionMode,
  summarizeCheckResults,
  type CheckResult,
} from "../../scripts/seed-and-verify.js";

describe("buildSeedAndVerifyPlan", () => {
  const anchor = "2026-04-11T12:00:00.000Z";
  const plan = buildSeedAndVerifyPlan(anchor, {
    port: 7799,
    namespace: "verify_ns",
    database: "verify_db",
    outputPath: ".pipeline/test-seed-and-verify.json",
  });

  it("builds a multi-tenant corpus with varied scopes, paths, and clients", () => {
    expect(plan.port).toBe(7799);
    expect(plan.namespace).toBe("verify_ns");
    expect(plan.database).toBe("verify_db");

    const userIds = new Set(plan.memories.map((record) => record.userId));
    const scopes = new Set(plan.memories.map((record) => record.scope));
    const clients = new Set(plan.memories.map((record) => record.client).filter(Boolean));
    const paths = new Set(plan.memories.map((record) => record.path).filter(Boolean));

    expect(userIds).toEqual(new Set(["owner", "sim-2026-04-02-v4", "analyst-tenant"]));
    expect(scopes).toEqual(new Set(["user", "session"]));
    expect(clients).toEqual(new Set(["claude-code", "hermes", "cursor"]));
    expect(paths.size).toBe(2);
  });

  it("includes deterministic tenant and client probe fixtures", () => {
    const ownerPlan = plan.memories.find((record) => record.id === "verify-owner-plan");
    const simArchitecture = plan.memories.find((record) => record.id === "verify-sim-architecture");
    const hermesNote = plan.memories.find((record) => record.id === "verify-owner-hermes-note");
    const claudeNote = plan.memories.find((record) => record.id === "verify-owner-claude-note");
    const untaggedNote = plan.memories.find((record) => record.id === "verify-owner-untagged-note");

    expect(ownerPlan?.text).toContain("tenant-isolation-probe-f1c8");
    expect(simArchitecture?.text).toContain("tenant-isolation-probe-f1c8");
    expect(hermesNote?.text).toContain("hermes-filter-token-9f3a");
    expect(claudeNote?.client).toBe("claude-code");
    expect(untaggedNote?.client).toBeUndefined();
  });

  it("includes an active/inactive lineage pair for owner", () => {
    const oldRecord = plan.memories.find((record) => record.id === "verify-owner-lineage-old");
    const newRecord = plan.memories.find((record) => record.id === "verify-owner-lineage-new");

    expect(oldRecord?.active).toBe(false);
    expect(oldRecord?.supersededById).toBe("semiote:verify-owner-lineage-new");
    expect(newRecord?.supersedesId).toBe("semiote:verify-owner-lineage-old");
    expect(oldRecord?.lineageRootId).toBe("verify-owner-lineage-root");
    expect(newRecord?.lineageRootId).toBe("verify-owner-lineage-root");
  });

  it("keeps project-state supporting IDs aligned with seeded memory IDs", () => {
    const memoryIds = new Set(plan.memories.map((record) => record.id));
    expect(plan.projectStates).toHaveLength(1);

    for (const memoryId of plan.projectStates[0]!.supportingMemoryIds) {
      expect(memoryIds.has(memoryId)).toBe(true);
    }
  });
});

describe("summarizeCheckResults", () => {
  it("counts passed and failed checks", () => {
    const results: CheckResult[] = [
      { name: "db:ok", ok: true, details: {} },
      { name: "http:ok", ok: true, details: {} },
      { name: "http:fail", ok: false, details: { reason: "mismatch" } },
    ];

    expect(summarizeCheckResults(results)).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      failedChecks: ["http:fail"],
    });
  });
});

describe("collectResultIds", () => {
  it("drops undefined ids from search rows", () => {
    expect(collectResultIds([{ id: "memories:a" }, {}, { id: "memories:b" }])).toEqual([
      "memories:a",
      "memories:b",
    ]);
  });
});

describe("evaluateIdAssertions", () => {
  it("requires expected ids and rejects forbidden ids", () => {
    expect(evaluateIdAssertions(["verify-owner-plan"], {
      requiredIds: ["verify-owner-plan"],
      forbiddenIds: ["verify-sim-architecture"],
    })).toEqual({
      ok: true,
      missingRequiredIds: [],
      presentForbiddenIds: [],
    });
  });

  it("reports missing required ids and present forbidden ids", () => {
    expect(evaluateIdAssertions(["verify-owner-plan", "verify-sim-architecture"], {
      requiredIds: ["verify-owner-plan", "verify-owner-status"],
      forbiddenIds: ["verify-sim-architecture"],
    })).toEqual({
      ok: false,
      missingRequiredIds: ["verify-owner-status"],
      presentForbiddenIds: ["verify-sim-architecture"],
    });
  });
});

describe("evaluateTextAssertions", () => {
  it("checks required and forbidden fragments against recall text", () => {
    expect(evaluateTextAssertions("hermes-lane-only-marker", {
      requiredFragments: ["hermes-lane-only-marker"],
      forbiddenFragments: ["claude-lane-only-marker"],
    })).toEqual({
      ok: true,
      missingRequiredFragments: [],
      presentForbiddenFragments: [],
    });
  });

  it("treats missing text as a failed required-fragment check", () => {
    expect(evaluateTextAssertions(null, {
      requiredFragments: ["untagged-client-marker"],
    })).toEqual({
      ok: false,
      missingRequiredFragments: ["untagged-client-marker"],
      presentForbiddenFragments: [],
    });
  });
});

describe("resolveExecutionMode", () => {
  it("prefers isolated mode when DB credentials are available", () => {
    expect(resolveExecutionMode({
      hasDbCredentials: true,
      attachedServiceReachable: true,
    })).toBe("isolated");
  });

  it("falls back to attached local service when DB credentials are missing", () => {
    expect(resolveExecutionMode({
      hasDbCredentials: false,
      attachedServiceReachable: true,
    })).toBe("attached-local-service");
  });

  it("honors explicit local-service reuse even if DB credentials are present", () => {
    expect(resolveExecutionMode({
      hasDbCredentials: true,
      preferAttachedService: true,
      attachedServiceReachable: true,
    })).toBe("attached-local-service");
  });
});
