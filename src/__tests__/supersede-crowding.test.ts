/**
 * MIM-50: Supersede crowding regression test.
 * Equivalent of memory-lancedb-pro's temporal-facts.test.mjs.
 * Proves the active fact survives when 8+ inactive versions exist.
 */
import { describe, it, expect } from "vitest";
import { ACTIVE_MEMORY_FILTER } from "../storage/surreal/surreal-store.js";

// ---------------------------------------------------------------------------
// Simulate the ACTIVE_MEMORY_FILTER SQL logic in memory.
// SQL: AND (active = NONE OR active = true)
// JavaScript equivalent: record.active === undefined || record.active === null || record.active === true
// ---------------------------------------------------------------------------

type SimulatedMemory = {
  id: string;
  text: string;
  active?: boolean | null;
  createdAt: string;
  score?: number;
};

/** Mirrors the SQL ACTIVE_MEMORY_FILTER: include if active is NONE/null/undefined or true. */
function filterActive(memories: SimulatedMemory[]): SimulatedMemory[] {
  return memories.filter(
    (m) => m.active === undefined || m.active === null || m.active === true,
  );
}

/** Simulates topK retrieval: filter active, sort by score desc, take topK. */
function retrieve(memories: SimulatedMemory[], topK: number): SimulatedMemory[] {
  return filterActive(memories)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// Test data: 1 active fact + 8 inactive superseded versions
// ---------------------------------------------------------------------------
function buildSupersedingScenario(): SimulatedMemory[] {
  const inactive: SimulatedMemory[] = Array.from({ length: 8 }, (_, i) => ({
    id: `inactive-${i}`,
    text: `User's preferred language is Python (version ${i + 1})`,
    active: false,
    createdAt: new Date(Date.now() - (8 - i) * 3600 * 1000).toISOString(),
    score: 0.95 - i * 0.02,  // inactive versions have higher similarity scores
  }));

  const active: SimulatedMemory = {
    id: "active-current",
    text: "User's preferred language is TypeScript",
    active: true,
    createdAt: new Date().toISOString(),
    score: 0.88,  // active fact has slightly lower score — would lose without filtering
  };

  return [...inactive, active];
}

describe("supersede crowding — active fact survives 8 inactive versions", () => {
  it("topK=5: active fact is present in results", () => {
    const memories = buildSupersedingScenario();
    const results = retrieve(memories, 5);
    const ids = results.map((m) => m.id);
    expect(ids).toContain("active-current");
  });

  it("topK=5: NONE of the 8 inactive versions appear in results", () => {
    const memories = buildSupersedingScenario();
    const results = retrieve(memories, 5);
    const ids = results.map((m) => m.id);
    for (let i = 0; i < 8; i++) {
      expect(ids).not.toContain(`inactive-${i}`);
    }
  });

  it("topK=5: exactly 1 result (only the active fact)", () => {
    const memories = buildSupersedingScenario();
    const results = retrieve(memories, 5);
    // Only 1 active memory in the set, so topK=5 returns 1
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("active-current");
  });

  it("topK=1: returns the active fact, NOT the most-recent inactive", () => {
    const memories = buildSupersedingScenario();
    const results = retrieve(memories, 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("active-current");
    // The most recent inactive had id 'inactive-7' — must not appear
    expect(results[0].id).not.toBe("inactive-7");
  });

  it("topK=1: the most-similar inactive (score=0.95) does NOT crowd out the active", () => {
    const memories = buildSupersedingScenario();
    const results = retrieve(memories, 1);
    // inactive-0 had score 0.95 — highest raw score — but is filtered out
    expect(results[0].id).not.toBe("inactive-0");
    expect(results[0].id).toBe("active-current");
  });
});

describe("ACTIVE_MEMORY_FILTER SQL constant", () => {
  it("contains the expected SurrealQL filter expression", () => {
    expect(ACTIVE_MEMORY_FILTER).toContain("active = NONE OR active = true");
  });

  it("is a non-empty WHERE fragment starting with AND", () => {
    expect(ACTIVE_MEMORY_FILTER.trim()).toMatch(/^AND/);
  });
});

describe("edge cases: all inactive, multiple active", () => {
  it("if ALL memories are inactive: returns empty set", () => {
    const allInactive: SimulatedMemory[] = Array.from({ length: 9 }, (_, i) => ({
      id: `inactive-${i}`,
      text: `Version ${i}`,
      active: false,
      createdAt: new Date().toISOString(),
      score: 0.9,
    }));
    const results = retrieve(allInactive, 5);
    expect(results).toHaveLength(0);
  });

  it("active=null treated as active (legacy records)", () => {
    const legacy: SimulatedMemory = {
      id: "legacy-no-active-field",
      text: "Legacy record with active=null",
      active: null,
      createdAt: new Date().toISOString(),
      score: 0.9,
    };
    const results = filterActive([legacy]);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("legacy-no-active-field");
  });

  it("active=undefined treated as active (NONE in SurrealDB)", () => {
    const legacy: SimulatedMemory = {
      id: "legacy-undefined",
      text: "Legacy record",
      active: undefined,
      createdAt: new Date().toISOString(),
      score: 0.9,
    };
    const results = filterActive([legacy]);
    expect(results).toHaveLength(1);
  });

  it("active=false is explicitly excluded by the JS mirror of ACTIVE_MEMORY_FILTER", () => {
    const inactive: SimulatedMemory = {
      id: "inactive-explicit",
      text: "Explicitly inactive record",
      active: false,
      createdAt: new Date().toISOString(),
      score: 0.99,
    };
    const results = filterActive([inactive]);
    expect(results).toHaveLength(0);
  });

  it("multiple active facts: all returned up to topK", () => {
    const active1: SimulatedMemory = { id: "a1", text: "Fact 1", active: true, createdAt: new Date().toISOString(), score: 0.9 };
    const active2: SimulatedMemory = { id: "a2", text: "Fact 2", active: true, createdAt: new Date().toISOString(), score: 0.85 };
    const inactive: SimulatedMemory = { id: "i1", text: "Old fact", active: false, createdAt: new Date().toISOString(), score: 0.99 };
    const results = retrieve([active1, active2, inactive], 5);
    expect(results.map((m) => m.id)).toContain("a1");
    expect(results.map((m) => m.id)).toContain("a2");
    expect(results.map((m) => m.id)).not.toContain("i1");
  });
});
