import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock dag-guard before importing write-arbitrator
vi.mock("../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

// Mock surreal-store
vi.mock("../storage/surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));

import {
  arbitrateWrite,
  candidateReferentKeys,
  deriveStatementKey,
  incomingReferentKeys,
} from "../storage/writes/write-arbitrator.js";
import {
  findSimilarMemories,
  updateMemoryText,
  upsertMemory,
  supersedeMemory,
} from "../storage/surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../domain/memory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

function makeVec(seed: number, len = 8): number[] {
  // Create unit vector with 1 at position (seed % len), rest 0
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}

function makeCandidate(overrides: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  return {
    id: "existing-id",
    l2: "existing memory text",
    similarity: 0.9,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("write-arbitrator unit tests (MIM-57)", () => {
  beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1]
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (upsertMemory as Mock).mockResolvedValue("new-id");
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });

  it("skip: exact duplicate via in-memory cache", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // First write
    const result1 = await arbitrateWrite({
      db,
      text: "test memory content",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });
    expect(result1.outcome).toBe("create");

    // Second write with exact same text
    const result2 = await arbitrateWrite({
      db,
      text: "test memory content",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });
    expect(result2.outcome).toBe("skip");
    expect(result2.reason).toContain("in-memory");
  });

  it("skip: cosine >= 0.95 within 24h via DB candidate", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({ similarity: 0.96 }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "new memory content",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("skip");
    expect(result.reason).toContain("0.96");
  });

  it("skip does NOT fire when cosine < 0.95 and no exact match", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({ similarity: 0.80, l2: "different text" }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "new memory content that is quite different",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).not.toBe("skip");
  });

  it("merge-update: cosine >= 0.85 within 72h, different values", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.87,
        l2: "user prefers dark mode",
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "user prefers dark mode and reduced motion",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("merge-update");
    expect(updateMemoryText).toHaveBeenCalled();
  });

  it("merge-update does NOT fire when cosine < 0.85", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({ similarity: 0.80, l2: "unrelated memory" }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "completely different memory content here",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).not.toBe("merge-update");
    expect(updateMemoryText).not.toHaveBeenCalled();
  });

  it("supersede: matching subject key, conflicting state", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Rúnir-pn1l.13.4 (U5): F1 is nominate-only, and NO text-similarity arm proves
    // identity (near-verbatim removed, Codex P1). A genuine same-subject state correction
    // proves via a shared atomicFact {subject, predicate} (subject-stable across the
    // flipped value) → key:atomicFactIdentity.
    const featureXFact = { subject: "feature X", predicate: "is" };
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.88,
        l2: "feature X is disabled",
        atomicFact: { ...featureXFact, value: "disabled" },
      }),
    ]);

    const result = await arbitrateWrite({
      db,
      text: "feature X is enabled",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: { atomicFact: { ...featureXFact, value: "enabled" } },
    });

    expect(result.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("preserves both sides of a corrected editor preference through supersession", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);
    const editorFact = { subject: "user", predicate: "prefers_editor" };
    const oldPreference = makeCandidate({
      id: "preference-vim",
      similarity: 0.9,
      l2: "The user's preferred editor is Vim.",
      atomicFact: { ...editorFact, value: "Vim" },
      validAt: "2026-08-18T10:00:00.000Z",
    });
    (findSimilarMemories as Mock).mockResolvedValue([oldPreference]);

    const result = await arbitrateWrite({
      db,
      text: "The user's preferred editor is Helix.",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        atomicFact: { ...editorFact, value: "Helix" },
        validAt: "2026-08-19T10:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      outcome: "supersede",
      matchedMemoryId: "preference-vim",
    });
    const supersedeCall = (supersedeMemory as Mock).mock.calls[0];
    expect(supersedeCall[1]).toMatchObject({
      id: "preference-vim",
      atomicFact: { ...editorFact, value: "Vim" },
    });
    expect(supersedeCall[2]).toMatchObject({
      metadata: {
        atomicFact: { ...editorFact, value: "Helix" },
        validAt: "2026-08-19T10:00:00.000Z",
      },
    });
  });

  it("keeps an exclusive-fact disagreement as two rows when no winner is known", async () => {
    const priorGuard = process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
    try {
      const db = makeDb();
      const recentWrites = new Map<string, RecentWrite[]>();
      const embedding = makeVec(0);
      (findSimilarMemories as Mock).mockResolvedValue([
        makeCandidate({
          id: "atlas-on-call-priya",
          similarity: 0.9,
          l2: "Priya Nair is the on-call lead for Atlas.",
          tags: ["project:atlas", "role:on-call-lead", "person:priya-nair"],
        }),
      ]);

      const result = await arbitrateWrite({
        db,
        text: "Marcus Webb is the on-call lead for Atlas.",
        userId: "user1",
        embedding,
        scope: "user",
        source: "memory_store",
        recentWrites,
        embedText: vi.fn().mockResolvedValue(embedding),
        metadata: {
          tags: ["project:atlas", "role:on-call-lead", "person:marcus-webb"],
        },
      });

      expect(result).toMatchObject({
        outcome: "create",
        reason: expect.stringContaining("ambiguous-slot-change-no-cue"),
      });
      expect(updateMemoryText).not.toHaveBeenCalled();
      expect(supersedeMemory).not.toHaveBeenCalled();

      vi.clearAllMocks();
      (findSimilarMemories as Mock).mockResolvedValue([
        makeCandidate({
          id: "atlas-on-call-marcus",
          similarity: 0.9,
          l2: "Marcus Webb is the on-call lead for Atlas.",
          tags: ["project:atlas", "role:on-call-lead", "person:marcus-webb"],
        }),
      ]);
      const reversed = await arbitrateWrite({
        db,
        text: "Priya Nair is the on-call lead for Atlas.",
        userId: "user1",
        embedding,
        scope: "user",
        source: "memory_store",
        recentWrites: new Map<string, RecentWrite[]>(),
        embedText: vi.fn().mockResolvedValue(embedding),
        metadata: {
          tags: ["project:atlas", "role:on-call-lead", "person:priya-nair"],
        },
      });

      expect(reversed).toMatchObject({
        outcome: "create",
        reason: expect.stringContaining("ambiguous-slot-change-no-cue"),
      });
      expect(updateMemoryText).not.toHaveBeenCalled();
      expect(supersedeMemory).not.toHaveBeenCalled();
    } finally {
      if (priorGuard === undefined) {
        delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
      } else {
        process.env.RUNIR_MERGE_KEEPBOTH_GUARD = priorGuard;
      }
    }
  });

  it("deduplicates a repeated source turn only inside the arbitration window", async () => {
    const db = makeDb();
    const embedding = makeVec(0);
    const importedText = "Atlas deployment completed with release 42.";
    const fixedNow = Date.parse("2026-08-19T12:00:00.000Z");
    const knownSource = {
      factKey: "event:atlas-release-42",
      sourceEventId: "turn-event-4",
      sourceTurnIndex: 4,
      rawSpan: {
        text: importedText,
        sourceTurnIndex: 4,
        cursorStart: 10,
        cursorEnd: 53,
        kind: "source_turn",
      },
    };

    const first = await arbitrateWrite({
      db,
      text: importedText,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map<string, RecentWrite[]>(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: knownSource,
      nowMs: fixedNow,
    });

    expect(first.outcome).toBe("create");
    expect((upsertMemory as Mock).mock.calls[0][5]).toMatchObject(knownSource);

    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        id: "source-turn-first-import",
        similarity: 0.99,
        l2: importedText,
        createdAt: "2026-08-19T11:59:00.000Z",
        updatedAt: "2026-08-19T11:59:00.000Z",
      }),
    ]);
    const duplicate = await arbitrateWrite({
      db,
      text: importedText,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map<string, RecentWrite[]>(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        ...knownSource,
        sourceTurnIndex: 99,
        rawSpan: { text: importedText, sourceTurnIndex: 99 },
      },
      nowMs: fixedNow,
    });

    expect(duplicate).toMatchObject({
      outcome: "skip",
      matchedMemoryId: "source-turn-first-import",
    });
    expect(upsertMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();

    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        id: "source-turn-expired-import",
        similarity: 0.99,
        l2: importedText,
        createdAt: "2026-08-16T10:59:59.000Z",
        updatedAt: "2026-08-16T10:59:59.000Z",
      }),
    ]);
    const outsideWindow = await arbitrateWrite({
      db,
      text: importedText,
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map<string, RecentWrite[]>(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        factKey: "event:atlas-release-42",
        rawSpan: { text: importedText },
      },
      nowMs: fixedNow,
    });

    expect(outsideWindow.outcome).toBe("create");
    expect((upsertMemory as Mock).mock.calls[0][5].rawSpan).not.toHaveProperty("sourceTurnIndex");
  });

  it("create: no match", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    (findSimilarMemories as Mock).mockResolvedValue([]);

    const result = await arbitrateWrite({
      db,
      text: "brand new memory content",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    expect(result.outcome).toBe("create");
    expect(upsertMemory).toHaveBeenCalled();
  });

  it("relation-like metadata does not change arbitration outcomes", async () => {
    const db = makeDb();
    const baseRecentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Rúnir-pn1l.13.4 (U5): shared atomicFact proves referent identity so the F1 state
    // correction supersedes under the nominate-only gate (the point of this test — relation
    // metadata must not change the outcome — is unchanged; the supersede is incidental).
    const featureXFact = { subject: "feature X", predicate: "is" };
    (findSimilarMemories as Mock).mockResolvedValue([
      makeCandidate({
        similarity: 0.88,
        l2: "feature X is disabled",
        atomicFact: { ...featureXFact, value: "disabled" },
      }),
    ]);

    const plainResult = await arbitrateWrite({
      db,
      text: "feature X is enabled",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: baseRecentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        writeSource: "capture",
        atomicFact: { ...featureXFact, value: "enabled" },
      },
    });

    const relationDecoratedResult = await arbitrateWrite({
      db,
      text: "feature X is enabled",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map<string, RecentWrite[]>(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        writeSource: "capture",
        provenance: { sourceKind: "capture", retrievalTraceId: "trace-1" },
        relatedMemoryIds: ["semiote:m1"],
        atomicFact: { ...featureXFact, value: "enabled" },
      },
    });

    expect(plainResult.outcome).toBe("supersede");
    expect(relationDecoratedResult.outcome).toBe("supersede");
    expect(relationDecoratedResult.matchedMemoryId).toBe(plainResult.matchedMemoryId);
  });

  it("in-memory cache TTL: entries older than TTL are pruned", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // Manually add an old entry (6 minutes ago, TTL is 5 min)
    const oldEntry: RecentWrite = {
      text: "old memory",
      normalizedText: "old memory",
      embedding,
      userId: "user1",
      scope: "user",
      sessionId: undefined,
      source: "memory_store",
      writtenAtMs: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    };
    recentWrites.set("user1::user::-", [oldEntry]);

    // Write with same text — should NOT match because entry is expired
    const result = await arbitrateWrite({
      db,
      text: "old memory",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Since entry was pruned, no in-memory match — outcome is create
    expect(result.outcome).toBe("create");
  });

  it("fingerprint mismatch skips vector lookup", async () => {
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    const result = await arbitrateWrite({
      db,
      text: "test memory content",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
      fingerprintOk: false, // Fingerprint mismatch
    });

    expect(findSimilarMemories).not.toHaveBeenCalled();
    expect(result.outcome).toBe("create");
  });

  it("concurrent write safety: same text submitted sequentially shows dedup", async () => {
    // NOTE: True concurrent writes may both "create" due to race condition timing.
    // This test verifies that sequential writes (after first completes) get skipped.
    const db = makeDb();
    const recentWrites = new Map<string, RecentWrite[]>();
    const embedding = makeVec(0);

    // First write
    const result1 = await arbitrateWrite({
      db,
      text: "concurrent test memory",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Second write (after first completes)
    const result2 = await arbitrateWrite({
      db,
      text: "concurrent test memory",
      userId: "user1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites,
      embedText: vi.fn().mockResolvedValue(embedding),
    });

    // Both should resolve
    expect(result1.outcome).toBeDefined();
    expect(result2.outcome).toBeDefined();

    // First should create, second should skip (dedup via in-memory cache)
    expect(result1.outcome).toBe("create");
    expect(result2.outcome).toBe("skip");
  });

  // Bonus: test deriveStatementKey
  describe("deriveStatementKey", () => {
    it("extracts subject key before delimiter", () => {
      expect(deriveStatementKey("feature X is enabled")).toBe("feature x");
      expect(deriveStatementKey("user prefers: dark mode")).toBe("user prefers");
    });

    it("falls back to first 8 words for no delimiter", () => {
      const key = deriveStatementKey("some long text without any standard delimiters here");
      expect(key.split(" ").length).toBeLessThanOrEqual(8);
    });

    it("keys location moves on the subject, not the destination (Rúnir-nanf)", () => {
      // Pre-fix these fell back to the first-8-words key (city included) →
      // DIFFERENT keys → shouldSupersede bailed → opposing location states
      // merge-updated into a fused-history blob (fam02 root cause).
      expect(deriveStatementKey("User has moved to Austin, Texas."))
        .toBe(deriveStatementKey("User has moved to Denver, Colorado."));
      expect(deriveStatementKey("User currently resides in Denver."))
        .toBe(deriveStatementKey("User currently resides in Albuquerque."));
    });

    it("a late subordinate-clause ' is ' cannot hijack the key from an earlier delimiter", () => {
      // Live-caught (Rúnir-nanf): array-order-first scanning keyed this on the
      // " is " inside "which is now…" while its sibling keyed on " moved to ",
      // splitting the pair across different keys. Leftmost-in-text wins now.
      expect(deriveStatementKey("User has moved to Denver, which is now their current place of residence."))
        .toBe(deriveStatementKey("User has moved to Austin, Texas."));
    });

    it("leftmost split picks the actual subject boundary for multi-delimiter texts", () => {
      expect(deriveStatementKey("feature X is enabled")).toBe("feature x");
      expect(deriveStatementKey("project speki uses postgres since the team moved to denver"))
        .toBe("project speki");
    });
  });

  // Rúnir-pn1l.13.4: inert referent-key accessors. These surface the incoming
  // write's metadata keys and a candidate's payload keys into the ReferentKeys
  // shape U5's gate consumes. They MUST be pure reads (no mutation, no decision).
  describe("referent-key accessors (pn1l.13.4)", () => {
    it("incomingReferentKeys projects factKey/continuitySubjectKey off metadata (noemaClaimKey removed, Rúnir-pn1l Q4 U0)", () => {
      expect(
        incomingReferentKeys({
          factKey: "config:port-a1b2c3",
          continuitySubjectKey: "subject:runir-port",
          noemaClaimKey: "claim:runir-port",
          tier: "durable",
        }),
      ).toEqual({
        factKey: "config:port-a1b2c3",
        continuitySubjectKey: "subject:runir-port",
      });
    });

    it("incomingReferentKeys treats missing/empty/non-string values as undefined", () => {
      expect(incomingReferentKeys(undefined)).toEqual({});
      expect(
        incomingReferentKeys({ factKey: "", continuitySubjectKey: 42, noemaClaimKey: null }),
      ).toEqual({
        factKey: undefined,
        continuitySubjectKey: undefined,
      });
    });

    it("candidateReferentKeys mirrors the incoming shape from a SimilarCandidate (makeCandidate optionals; noemaClaimKey removed, Rúnir-pn1l Q4 U0)", () => {
      const candidate = makeCandidate({
        factKey: "config:port-a1b2c3",
        continuitySubjectKey: "subject:runir-port",
        noemaClaimKey: "claim:runir-port",
        atomicFact: { subject: "Runir local service", predicate: "uses_port", value: "7700" },
      });
      expect(candidateReferentKeys(candidate)).toEqual({
        factKey: "config:port-a1b2c3",
        continuitySubjectKey: "subject:runir-port",
        // Rúnir-pn1l.13.4 (U5): candidateReferentKeys now canonicalizes atomicFact →
        // atomicFactIdentity = `${subject}|${predicate}` (value dropped — identity, not value).
        atomicFactIdentity: "runir local service|uses_port",
      });
    });

    it("candidateReferentKeys is empty for a keyless candidate", () => {
      expect(candidateReferentKeys(makeCandidate())).toEqual({
        factKey: undefined,
        continuitySubjectKey: undefined,
      });
    });
  });
});
