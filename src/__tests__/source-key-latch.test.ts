import { describe, expect, it } from "vitest";
import { assertSourceKeyFingerprint, SourceKeyMismatchError } from "../storage/surreal/session-turn-store.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

describe("source key latch", () => {
  it("runs the three table predicates once per writing client and refuses a new key", async () => {
    const queries: string[] = [];
    const db = { query: async (sql: string) => { queries.push(sql); return [[]]; } } as unknown as SurrealClient;
    await Promise.all(Array.from({ length: 10 }, () => assertSourceKeyFingerprint(db, "configured")));
    expect(queries).toHaveLength(3);
    expect(queries.every((sql) => sql.includes("GROUP BY"))).toBe(true);
    await assertSourceKeyFingerprint(db, "configured");
    expect(queries).toHaveLength(3);
    await expect(assertSourceKeyFingerprint(db, "rotated")).rejects.toBeInstanceOf(SourceKeyMismatchError);
    expect(queries).toHaveLength(3);
  });

  it("does not latch a mismatched stored fingerprint", async () => {
    let scans = 0;
    const db = { query: async () => { scans++; return [["old"]]; } } as unknown as SurrealClient;
    await expect(assertSourceKeyFingerprint(db, "new")).rejects.toBeInstanceOf(SourceKeyMismatchError);
    await expect(assertSourceKeyFingerprint(db, "new")).rejects.toBeInstanceOf(SourceKeyMismatchError);
    expect(scans).toBe(2);
  });
});
