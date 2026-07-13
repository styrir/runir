/**
 * MIM-51: Write consistency / rollback behavior tests.
 * Tests what happens when DB operations fail mid-operation.
 *
 * supersedeMemory is now ATOMIC (ADOPT-NOW #4.3): the branch write + both tail
 * UPDATEs run as one queryTransaction, so a mid-sequence failure rolls the whole
 * supersede back. These mocks assert the single-transaction mechanism; the real
 * rollback/commit state transitions are proven in supersede-transaction.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { updateMemoryText, upsertMemory, supersedeMemory } from "../storage/surreal/surreal-store.js";
import type { SimilarCandidate, WriteSource } from "../domain/memory/types.js";

// Mock dag-guard to prevent cycle checks from requiring a real DB
vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

/** Creates a minimal mock DB. */
function makeMockDb(responses: Array<unknown[] | Error>) {
  let callIndex = 0;
  const query = vi.fn().mockImplementation(async () => {
    const resp = responses[callIndex] ?? [[]];
    callIndex++;
    if (resp instanceof Error) throw resp;
    return resp;
  });
  return { query, _callCount: () => callIndex };
}

const DUMMY_EMBEDDING = [0.1, 0.2, 0.3];
const DUMMY_WRITE_SOURCE: WriteSource = "memory_store";
const DUMMY_CANDIDATE: SimilarCandidate = {
  id: "old-memory-id",
  l2: "User's preferred language is Python",
  similarity: 0.92,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
};

// ---------------------------------------------------------------------------
// updateMemoryText — merge-update failure behavior
// ---------------------------------------------------------------------------
describe("merge-update: DB failure leaves state transparent", () => {
  it("db.query throws: error propagates (no silent swallow)", async () => {
    const db = makeMockDb([new Error("DB write failed")]);
    await expect(
      updateMemoryText(db as any, "mem-id", "updated text", DUMMY_EMBEDDING, DUMMY_WRITE_SOURCE, "retain"),
    ).rejects.toThrow("DB write failed");
  });

  it("db.query throws on first call: exactly 1 attempt made", async () => {
    const queryMock = vi.fn().mockRejectedValue(new Error("connection reset"));
    const db = { query: queryMock };
    try {
      await updateMemoryText(db as any, "mem-id", "updated text", DUMMY_EMBEDDING, DUMMY_WRITE_SOURCE, "retain");
    } catch {
      // expected
    }
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// upsertMemory — create failure behavior
// ---------------------------------------------------------------------------
describe("create: DB failure propagates", () => {
  it("upsertMemory throws on DB error", async () => {
    const db = makeMockDb([new Error("disk full")]);
    await expect(
      upsertMemory(db as any, "new-id", "some text", "user1", DUMMY_EMBEDDING, {}, "user"),
    ).rejects.toThrow("disk full");
  });

  it("upsertMemory on success: returns the id", async () => {
    // upsertMemory returns the id string regardless of db response
    const db = makeMockDb([[[]]]); // one successful query
    const result = await upsertMemory(db as any, "my-id", "text", "user1", DUMMY_EMBEDDING, {}, "user");
    expect(result).toBe("my-id");
  });
});

// ---------------------------------------------------------------------------
// supersedeMemory — atomic transaction
// supersedeMemory now does:
//   1. wouldCreateCycle check (read)
//   2. exists-check SELECT (read, before BEGIN)
//   3. ONE queryTransaction = branch write (bookkeeping UPDATE | fresh UPSERT)
//      + tail provenance UPDATE + previous-row inactivation UPDATE
// A mid-sequence failure rolls the whole transaction back.
// ---------------------------------------------------------------------------
function makeSupersedeDb(opts: { exists: boolean; txRejects?: boolean }) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM type::record")) {
      return opts.exists ? [[{ id: "survivor" }]] : [[]];
    }
    return [[]];
  });
  const queryTransaction = vi.fn().mockImplementation(async () => {
    if (opts.txRejects) {
      throw new Error("transaction failed (rolled back, or in-doubt …)");
    }
  });
  return { query, queryTransaction };
}

describe("supersedeMemory — atomic transaction", () => {
  it("propagates a transaction failure (whole supersede rolls back)", async () => {
    const db = makeSupersedeDb({ exists: false, txRejects: true });
    await expect(
      supersedeMemory(
        db as any,
        DUMMY_CANDIDATE,
        {
          id: "new-memory-id",
          text: "User's preferred language is TypeScript",
          userId: "user1",
          embedding: DUMMY_EMBEDDING,
          scope: "user",
          writeSource: DUMMY_WRITE_SOURCE,
        },
        "deterministic",
      ),
    ).rejects.toThrow(/transaction failed/);
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
  });

  it("issues exactly ONE transaction carrying the branch write + provenance + inactivation", async () => {
    const db = makeSupersedeDb({ exists: false });
    await supersedeMemory(
      db as any,
      DUMMY_CANDIDATE,
      {
        id: "new-memory-id",
        text: "User's preferred language is TypeScript",
        userId: "user1",
        embedding: DUMMY_EMBEDDING,
        scope: "user",
        writeSource: DUMMY_WRITE_SOURCE,
      },
      "deterministic",
    );
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    const [body] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("UPSERT"); // fresh row created
    expect(body).toContain("supersede_provenance = $provenance"); // tail provenance
    expect(body).toContain("active = false"); // previous-row inactivation
  });

  it("fresh-id branch: new row active + supersedes the previous, previous inactivated, in one tx", async () => {
    const db = makeSupersedeDb({ exists: false });
    await supersedeMemory(
      db as any,
      DUMMY_CANDIDATE,
      {
        id: "new-memory-id",
        text: "User's preferred language is TypeScript",
        userId: "user1",
        embedding: DUMMY_EMBEDDING,
        scope: "user",
        writeSource: DUMMY_WRITE_SOURCE,
      },
      "deterministic",
    );
    const [body, vars] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("UPSERT");
    // Fresh upsert (prefixed params) marks the new row active + supersedes the previous.
    expect(vars.sup_active).toBe(true);
    expect(vars.sup_supersedesId).toBe("old-memory-id");
    // Tail inactivation keys off the previous id; new id supersedes it.
    expect(vars.prevRecordId).toBe("old-memory-id");
    expect(vars.supersededById).toBe("new-memory-id");
    expect(vars.provenance).toBe("deterministic");
  });
});

// ---------------------------------------------------------------------------
// supersedeMemory — existing-replacement merge branch (Rúnir-xxa9)
// ---------------------------------------------------------------------------
describe("supersedeMemory — existing-replacement merge branch (Rúnir-xxa9)", () => {
  it("EXISTS branch is bookkeeping-only — targeted UPDATE, no CONTENT re-upsert", async () => {
    const db = {
      query: vi.fn().mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("SELECT id FROM type::record") ? [[{ id: "survivor-1" }]] : [[]],
        ),
      ),
      queryTransaction: vi.fn().mockResolvedValue(undefined),
    };
    await supersedeMemory(
      db as any,
      DUMMY_CANDIDATE,
      {
        id: "survivor-1",
        text: "User's preferred language is Python 3",
        userId: "user1",
        embedding: DUMMY_EMBEDDING,
        scope: "user",
        writeSource: DUMMY_WRITE_SOURCE,
        metadata: { inactive_reason: "consolidation-dedup" },
      },
      "llm-generated",
      true,
    );
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    const [body, vars] = db.queryTransaction.mock.calls[0];
    // Bookkeeping UPDATE is present; the survivor is NOT re-upserted via CONTENT.
    expect(body).toContain("payload.supersedesId = $prevId");
    expect(body).not.toContain("CONTENT");
    expect(body).not.toContain("created_at");
    expect(body).not.toContain("payload.l2");
    expect(vars).toMatchObject({
      id: "survivor-1",
      prevId: DUMMY_CANDIDATE.id,
      userId: "user1",
    });
  });

  it("FRESH branch: full upsert when the replacement does not exist", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]), // exists-check returns []
      queryTransaction: vi.fn().mockResolvedValue(undefined),
    };
    await supersedeMemory(
      db as any,
      DUMMY_CANDIDATE,
      {
        id: "brand-new-id",
        text: "User's preferred language is Python 3",
        userId: "user1",
        embedding: DUMMY_EMBEDDING,
        scope: "user",
        writeSource: DUMMY_WRITE_SOURCE,
      },
      "llm-generated",
      true,
    );
    const [body] = db.queryTransaction.mock.calls[0];
    expect(body).toContain("UPSERT");
  });
});

// ---------------------------------------------------------------------------
// supersedeMemory — global scope guard
// ---------------------------------------------------------------------------
describe("supersedeMemory — global scope guard", () => {
  it("global scope without isInternalCaller=true throws", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) };
    await expect(
      supersedeMemory(
        db as any,
        DUMMY_CANDIDATE,
        {
          id: "new-id",
          text: "some text",
          userId: "user1",
          embedding: DUMMY_EMBEDDING,
          scope: "global",
          writeSource: DUMMY_WRITE_SOURCE,
        },
        "deterministic",
        // isInternalCaller NOT passed (defaults to undefined/false)
      ),
    ).rejects.toThrow("global scope requires isInternalCaller flag");
  });
});
