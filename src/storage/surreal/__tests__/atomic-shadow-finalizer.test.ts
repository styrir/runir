/**
 * Rúnir-h435.1 F3 finalizer — pure unit tests at the db.query boundary.
 * No SurrealDB required: mock returns the SELECT rows; assert finalize decision.
 */
import { describe, it, expect, vi } from "vitest";
import { finalizeAtomicShadowAttemptIfComplete } from "../atomic-shadow-store.js";

describe("finalizeAtomicShadowAttemptIfComplete exact-set", () => {
  it("R1: three raw rows with one malformed nomination_candidate_id vs two-id manifest → NOT finalized", async () => {
    // rows = [a, b, missing-id] must NOT finalize against manifest [a, b].
    // Filtering malformed ids before the length check would false-green here.
    const query = vi.fn().mockResolvedValue([
      [
        { nomination_candidate_id: "cand-a" },
        { nomination_candidate_id: "cand-b" },
        { nomination_candidate_id: undefined }, // malformed / missing id
      ],
    ]);
    const db = { query } as any;
    const finalized = await finalizeAtomicShadowAttemptIfComplete(db, "we-malformed", [
      "cand-a",
      "cand-b",
    ]);
    expect(finalized).toBe(false);
    // Only the SELECT — no UPDATE finalize write.
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(/SELECT nomination_candidate_id/);
  });
});
