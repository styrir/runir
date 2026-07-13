import { describe, it, expect } from "vitest";
import {
  CONTINUITY_MEMORY_ROLES,
  CONTINUITY_STATE_MEMORY_ROLES,
  isContinuityMemoryRole,
  isContinuityStateMemoryRole,
  isMemoryRole,
  type MemoryRole,
} from "../src/domain/memory/boundary.js";

const ALL_VALID_ROLES: MemoryRole[] = [
  "project_state",
  "current_status",
  "session_handoff",
  "recent_work",
  "debugging_active",
  "planning_active",
  "architecture_reference",
  "research_context",
  "deploy_ops",
  "admin_process",
  "operational_noise",
];

describe("isMemoryRole", () => {
  it("accepts every documented MemoryRole", () => {
    for (const role of ALL_VALID_ROLES) {
      expect(isMemoryRole(role)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isMemoryRole("foo")).toBe(false);
    expect(isMemoryRole("")).toBe(false);
    expect(isMemoryRole("PROJECT_STATE")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isMemoryRole(undefined)).toBe(false);
    expect(isMemoryRole(null)).toBe(false);
    expect(isMemoryRole(123)).toBe(false);
    expect(isMemoryRole({})).toBe(false);
    expect(isMemoryRole([])).toBe(false);
    expect(isMemoryRole(true)).toBe(false);
  });
});

describe("CONTINUITY_MEMORY_ROLES", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(CONTINUITY_MEMORY_ROLES)).toBe(true);
    expect(CONTINUITY_MEMORY_ROLES.length).toBeGreaterThan(0);
  });

  it("contains only valid roles", () => {
    for (const role of CONTINUITY_MEMORY_ROLES) {
      expect(isMemoryRole(role)).toBe(true);
    }
  });

  it("includes project_state and current_status", () => {
    expect(CONTINUITY_MEMORY_ROLES).toContain("project_state");
    expect(CONTINUITY_MEMORY_ROLES).toContain("current_status");
  });
});

describe("CONTINUITY_STATE_MEMORY_ROLES", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(CONTINUITY_STATE_MEMORY_ROLES)).toBe(true);
    expect(CONTINUITY_STATE_MEMORY_ROLES.length).toBeGreaterThan(0);
  });

  it("is a subset of CONTINUITY_MEMORY_ROLES", () => {
    for (const role of CONTINUITY_STATE_MEMORY_ROLES) {
      expect(CONTINUITY_MEMORY_ROLES).toContain(role);
    }
  });

  it("excludes project_state and recent_work", () => {
    expect(CONTINUITY_STATE_MEMORY_ROLES).not.toContain("project_state");
    expect(CONTINUITY_STATE_MEMORY_ROLES).not.toContain("recent_work");
  });
});

describe("isContinuityMemoryRole", () => {
  it("returns true for every CONTINUITY_MEMORY_ROLES entry", () => {
    for (const role of CONTINUITY_MEMORY_ROLES) {
      expect(isContinuityMemoryRole(role)).toBe(true);
    }
  });

  it("returns false for non-continuity roles", () => {
    expect(isContinuityMemoryRole("architecture_reference")).toBe(false);
    expect(isContinuityMemoryRole("research_context")).toBe(false);
    expect(isContinuityMemoryRole("operational_noise")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isContinuityMemoryRole(undefined)).toBe(false);
  });
});

describe("isContinuityStateMemoryRole", () => {
  it("returns true for every CONTINUITY_STATE_MEMORY_ROLES entry", () => {
    for (const role of CONTINUITY_STATE_MEMORY_ROLES) {
      expect(isContinuityStateMemoryRole(role)).toBe(true);
    }
  });

  it("returns false for project_state (continuity but not state)", () => {
    expect(isContinuityStateMemoryRole("project_state")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isContinuityStateMemoryRole(undefined)).toBe(false);
  });
});
