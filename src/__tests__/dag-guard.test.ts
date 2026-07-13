import { describe, it, expect, vi } from "vitest";
import { wouldCreateCycle } from "../lifecycle/semion/dag-guard.js";

type MockDb = {
  query: ReturnType<typeof vi.fn>;
};

function makeDb(responses: Array<Array<{ supersedes: string | null }> | []>): MockDb {
  let callIndex = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const result = responses[callIndex] ?? [];
      callIndex++;
      return Promise.resolve([result]);
    }),
  };
}

const USER = "user-1";

describe("wouldCreateCycle", () => {
  it("detects immediate self-cycle (A supersedes A)", async () => {
    // newMemoryId = "mem:A", targetId = "mem:A" — trivial self-loop
    const db = makeDb([]); // no query needed — caught before first DB call
    const result = await wouldCreateCycle(db as any, "mem:A", "mem:A", USER, "memories");
    expect(result).toBe(true);
  });

  it("returns false for a simple chain with no cycle (A supersedes B, B has no supersedes)", async () => {
    // newMemoryId = "A", targetId = "B"
    // B.supersedes = null → chain terminates, A not found → no cycle
    const db = makeDb([
      [{ supersedes: null }], // B.supersedes = null
    ]);
    const result = await wouldCreateCycle(db as any, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(false);
  });

  it("binds the record lookup via type::record, not a bare-string WHERE id (Rúnir-xxa9)", async () => {
    const db = makeDb([
      [{ supersedes: null }],
    ]);
    await wouldCreateCycle(db as any, "aaa-uuid", "bbb-uuid", USER, "memories");
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("type::record('memories', $id)");
    expect(sql).not.toContain("WHERE id = $id");
    expect(params).toEqual({ id: "bbb-uuid", userId: USER });
  });

  it("detects a cycle: A→B→C→A", async () => {
    // newMemoryId = "mem:A", targetId = "mem:B"
    // Walk: B.supersedes = C, C.supersedes = A → A is in visited (equals newMemoryId) → cycle!
    const db = makeDb([
      [{ supersedes: "mem:C" }], // B.supersedes = C
      [{ supersedes: "mem:A" }], // C.supersedes = A (= newMemoryId → cycle)
    ]);
    const result = await wouldCreateCycle(db as any, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(true);
  });

  it("handles orphaned pointer gracefully (non-existent record returns empty)", async () => {
    // B.supersedes = "mem:ghost" but ghost doesn't exist (empty result)
    const db = makeDb([
      [{ supersedes: "mem:ghost" }], // B.supersedes = ghost
      [],                             // ghost not found → orphaned pointer
    ]);
    const result = await wouldCreateCycle(db as any, "mem:A", "mem:B", USER, "memories");
    // Orphaned pointer: log corruption, return false (don't block write)
    expect(result).toBe(false);
  });

  it("hits 50-hop corruption ceiling and returns true", async () => {
    // Build a chain of 52 records, all with a supersedes pointer (no cycle, just very long)
    const responses = Array.from({ length: 52 }, (_, i) => [
      { supersedes: `mem:node${i + 1}` },
    ]);
    const db = makeDb(responses);
    const result = await wouldCreateCycle(db as any, "mem:A", "mem:B", USER, "memories");
    // After 50 hops, treat as corruption and return true
    expect(result).toBe(true);
  });
});
