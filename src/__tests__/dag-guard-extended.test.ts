import { describe, it, expect, vi } from "vitest";
import { wouldCreateCycle } from "../lifecycle/semion/dag-guard.js";

const USER = "user-1";

function makeDb(responses: Array<Array<{ supersedes: string | null }> | [] | "error">): any {
  let callIndex = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const result = responses[callIndex] ?? [];
      callIndex++;
      if (result === "error") return Promise.reject(new Error("db connection lost"));
      return Promise.resolve([result]);
    }),
  };
}

describe("wouldCreateCycle extended", () => {
  it("returns false on query error (does not block write)", async () => {
    // B query throws error
    const db = makeDb(["error"]);
    const result = await wouldCreateCycle(db, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(false);
  });

  it("detects unexpected revisit (internal cycle not involving newMemoryId)", async () => {
    // Chain: B→C→D→C (revisit of C without ever hitting A)
    const db = makeDb([
      [{ supersedes: "mem:C" }], // B.supersedes = C
      [{ supersedes: "mem:D" }], // C.supersedes = D
      [{ supersedes: "mem:C" }], // D.supersedes = C (revisit!)
    ]);
    const result = await wouldCreateCycle(db, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(true);
  });

  it("returns false for two-hop chain terminating cleanly", async () => {
    // B→C, C.supersedes=null
    const db = makeDb([
      [{ supersedes: "mem:C" }],
      [{ supersedes: null }],
    ]);
    const result = await wouldCreateCycle(db, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(false);
  });

  it("detects cycle at second hop (A→B→A)", async () => {
    // newMemoryId = A, targetId = B, B.supersedes = A
    const db = makeDb([
      [{ supersedes: "mem:A" }], // B.supersedes = A → cycle
    ]);
    const result = await wouldCreateCycle(db, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(true);
  });

  it("query error mid-chain returns false", async () => {
    // B→C succeeds, C query errors
    const db = makeDb([
      [{ supersedes: "mem:C" }],
      "error",
    ]);
    const result = await wouldCreateCycle(db, "mem:A", "mem:B", USER, "memories");
    expect(result).toBe(false);
  });
});
