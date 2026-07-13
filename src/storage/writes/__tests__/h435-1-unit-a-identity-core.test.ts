/**
 * Rúnir-h435.1 Unit A — identity core acceptance boundaries A-1..A-3.
 *
 * Mock surface (binding brief §Tests): ONLY DB-call boundary exports of surreal-store
 * via vi.mock — findSimilarMemories, supersedeMemory, updateMemoryText, upsertMemory,
 * logSupersedeShadow — plus a stubbed SurrealClient. Everything else (resolveDecision,
 * findSupersedeTarget, proveReferentIdentity, referent-keys, write-signals,
 * supersede-guards, flag readers via process.env) runs REAL.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  logSupersedeShadow: vi.fn().mockResolvedValue(undefined),
  ensureSupersedeShadowTable: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import {
  atomicFactIdentity,
  mergeAtomicFactAction,
} from "../referent-keys.js";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
  updateMemoryText,
  upsertMemory,
} from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

const mockLogSupersedeShadow = logSupersedeShadow as Mock;

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(
  o: Partial<SimilarCandidate> & { l2: string; similarity: number },
): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "cand-1", createdAt: now, updatedAt: now, ...o };
}

/** Clear every supersede flip flag + the new identity-proof flag to defaults. */
function clearAllFlags() {
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
}

async function arb(opts: {
  text: string;
  candidates?: SimilarCandidate[];
  recentWrites?: Map<string, RecentWrite[]>;
  metadata?: Record<string, unknown>;
  nowMs?: number;
}) {
  (findSimilarMemories as Mock).mockResolvedValue(opts.candidates ?? []);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(),
    text: opts.text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: opts.recentWrites ?? new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
}

// Shared F1-nominating atomic-only pair (same statement key, value change, no factKey/anchors).
// Correction MARKER on incoming tags (A-1 fixture pin): blocked-F1 fall-through reaches
// the marker-break create ("tagged correction with no compatible supersede target").
const ATOMIC_FACT_BASE = { subject: "Atlas datastore", predicate: "primary_engine" };
const ATOMIC_CAND_TEXT = "primary engine: SurrealDB for Atlas";
const ATOMIC_INC_TEXT = "primary engine: Dragonfly for Atlas";

beforeEach(() => {
  vi.clearAllMocks();
  clearAllFlags();
  mockLogSupersedeShadow.mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue("new-id");
});
afterEach(() => {
  clearAllFlags();
});

// ─────────────────────────────────────────────────────────────────────────────
// A-1 quarantine
// ─────────────────────────────────────────────────────────────────────────────
describe("A-1 quarantine (atomicFactIdentity authority)", () => {
  it("A-1(i) flag OFF + atomic-only F1 pair → supersedeMemory never; create via marker; WOULD keeps proof evidence", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // All older flags at defaults (cleared in beforeEach). Identity proof OFF.
    const candidate = makeCandidate({
      id: "atomic-only-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const r = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [candidate],
      metadata: {
        tags: ["update"], // correction MARKER — fixture pin for stable create fall-through
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });

    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/tagged correction with no compatible supersede target/);
    // WOULD forces atomicAuthority ON — quarantine never suppresses the evidence slice 3 consumes.
    expect(mockLogSupersedeShadow).toHaveBeenCalled();
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.referentProof).toBe("key:atomicFactIdentity");
    expect(call.liveFlags.atomicIdentityProof).toBe(false);
  });

  it("A-1(ii) same pair + RUNIR_ATOMICFACT_IDENTITY_PROOF=1 → supersedeMemory once with that candidate", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    const candidate = makeCandidate({
      id: "atomic-only-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const r = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [candidate],
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });

    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalledTimes(1);
    const prev = (supersedeMemory as Mock).mock.calls[0][1] as SimilarCandidate;
    expect(prev.id).toBe("atomic-only-cand");
  });

  it("A-1(iii) preservation: factKey-proven F1 with identity flag OFF still supersedes", async () => {
    const candidate = makeCandidate({
      id: "factkey-cand",
      l2: "deploy target: staging cluster",
      similarity: 0.9,
      factKey: "config:deploy-target-abc123",
    });
    const r = await arb({
      text: "deploy target: production cluster",
      candidates: [candidate],
      metadata: { factKey: "config:deploy-target-abc123" },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalledTimes(1);
    expect((supersedeMemory as Mock).mock.calls[0][1].id).toBe("factkey-cand");
  });

  it("A-1(iii) preservation: anchor-shared-proven F1 with identity flag OFF still supersedes", async () => {
    // Shared proof-grade labeled_id (Task bly4ezhko) + F1-nominating same statement key.
    const candidate = makeCandidate({
      id: "anchor-cand",
      l2: "build gate: Task bly4ezhko step H3 passed",
      similarity: 0.9,
    });
    const r = await arb({
      text: "build gate: Task bly4ezhko final gate passed with zero failures",
      candidates: [candidate],
    });
    // wouldSupersedeTexts needs same statement key + value change — "build gate" key,
    // values differ. Anchor-shared proves identity without atomicAuthority.
    // If F1 doesn't nominate (value inclusion), marker-free path may merge/create.
    // Use opposing-state form to force F1 nomination:
    const cand2 = makeCandidate({
      id: "anchor-cand-2",
      l2: "feature toggle: Task bly4ezhko is enabled",
      similarity: 0.9,
    });
    (supersedeMemory as Mock).mockClear();
    const r2 = await arb({
      text: "feature toggle: Task bly4ezhko is disabled",
      candidates: [cand2],
    });
    expect(r2.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalledTimes(1);
    expect((supersedeMemory as Mock).mock.calls[0][1].id).toBe("anchor-cand-2");
    // First fixture is informational (may not F1-nominate); r is unused intentionally.
    void r;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A-2 unconditional guard unit (atomic-proven F1 only)
// ─────────────────────────────────────────────────────────────────────────────
describe("A-2 unconditional guard unit for key:atomicFactIdentity F1", () => {
  it("A-2(i) older flags OFF + identity ON + transient-over-durable atomic pair → create, no supersede", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    // temporal / keepBoth / etc. all OFF (cleared).
    const candidate = makeCandidate({
      id: "durable-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      tier: "durable",
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const r = await arb({
      text: "primary engine: Dragonfly for Atlas for now", // transience cue
      candidates: [candidate],
      metadata: {
        tier: "working",
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/durability guard/);
  });

  it("A-2(ii) temporal leg: strictly-older explicitly-dated incoming → keep-both", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    const candidate = makeCandidate({
      id: "newer-cand",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      validAt: "2026-06-15T00:00:00.000Z",
      createdAt: "2026-06-15T00:00:00.000Z",
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const r = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [candidate],
      metadata: {
        validAt: "2026-06-01T00:00:00.000Z", // strictly older
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/temporal-ordering guard/);
  });

  it("A-2(ii) occasion leg: same-type different-value anchors → keep-both", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    const candidate = makeCandidate({
      id: "q1-cand",
      l2: "primary engine: SurrealDB for Atlas in Q1",
      similarity: 0.9,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const r = await arb({
      text: "primary engine: Dragonfly for Atlas in Q2",
      candidates: [candidate],
      metadata: {
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/distinct-occasion/);
  });

  it("A-2(ii-b) temporal-guard clock seam: laneClockMs, not wall-now or arbitrationNowMs=0", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    // Injected historical clock. Both candidates stay inside the merge-window of
    // laneClockMs so recency is not the discriminating factor — only the temporal
    // guard's comparison against laneClockMs is.
    // Candidate AFTER laneClockMs → keep-both older-incoming (a wall-clock-anchored
    // guard would wrongly permit — wall-now is 2026-07). Candidate BEFORE → supersede
    // (a 0-anchored guard would wrongly keep-both — every real candidate is after 1970).
    const laneClockMs = Date.parse("2026-03-01T12:00:00.000Z");
    const afterClock = "2026-03-01T18:00:00.000Z"; // +6h after laneClockMs, well before wall-now
    const beforeClock = "2026-03-01T06:00:00.000Z"; // -6h before laneClockMs

    // (1) candidate created AFTER laneClockMs → keep-both older-incoming
    const candAfter = makeCandidate({
      id: "after-clock",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      createdAt: afterClock,
      updatedAt: afterClock,
      validAt: afterClock,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const rAfter = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [candAfter],
      metadata: {
        // NO incoming validAt — temporal leg anchors to laneClockMs
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
      nowMs: laneClockMs,
    });
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(rAfter.outcome).toBe("create");
    expect(rAfter.reason).toMatch(/older-incoming/);

    (supersedeMemory as Mock).mockClear();

    // (2) candidate created BEFORE laneClockMs → supersede permitted
    const candBefore = makeCandidate({
      id: "before-clock",
      l2: ATOMIC_CAND_TEXT,
      similarity: 0.9,
      createdAt: beforeClock,
      updatedAt: beforeClock,
      validAt: beforeClock,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const rBefore = await arb({
      text: ATOMIC_INC_TEXT,
      candidates: [candBefore],
      metadata: {
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
      nowMs: laneClockMs,
    });
    expect(rBefore.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalledTimes(1);
    expect((supersedeMemory as Mock).mock.calls[0][1].id).toBe("before-clock");
  });

  it("A-2(iii) no-leak: factKey-proven F1 (older flags OFF, identity OFF) still supersedes", async () => {
    const candidate = makeCandidate({
      id: "fk-noleak",
      l2: "deploy target: staging cluster",
      similarity: 0.9,
      factKey: "config:deploy-target-noleak",
    });
    const r = await arb({
      text: "deploy target: production cluster",
      candidates: [candidate],
      metadata: { factKey: "config:deploy-target-noleak" },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("A-2(iii) no-leak: anchor-shared F1 + identity ON + transient-over-durable still supersedes (unit is atomic-only)", async () => {
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    // Anchor-shared proof (NOT atomic). Transient-over-durable shape — unconditional
    // unit must NOT apply; temporal flag is OFF so durability is not gated either.
    const candidate = makeCandidate({
      id: "anchor-transient",
      l2: "feature toggle: Task bly4ezhko is enabled",
      similarity: 0.9,
      tier: "durable",
    });
    const r = await arb({
      text: "feature toggle: Task bly4ezhko is disabled for now",
      candidates: [candidate],
      metadata: { tier: "working" },
    });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A-3 merge-clear — pure / wiring / (live SQL in separate describe)
// ─────────────────────────────────────────────────────────────────────────────
describe("A-3(i) mergeAtomicFactAction pure helper", () => {
  const complete = { subject: "Redis", predicate: "role", value: "cache" };

  it("equal complete triple (canonical subj/pred, trim-only value) → retain", () => {
    expect(
      mergeAtomicFactAction(
        { subject: "  Redis  ", predicate: "Role", value: "  cache  " },
        { subject: "redis", predicate: "role", value: "cache" },
      ),
    ).toBe("retain");
  });

  it("value case-difference → clear", () => {
    expect(
      mergeAtomicFactAction(complete, { ...complete, value: "Cache" }),
    ).toBe("clear");
  });

  it("value punctuation-difference → clear", () => {
    expect(
      mergeAtomicFactAction(complete, { ...complete, value: "cache." }),
    ).toBe("clear");
  });

  it("incoming partial/missing/malformed → clear", () => {
    expect(mergeAtomicFactAction(complete, { subject: "Redis", predicate: "role" })).toBe(
      "clear",
    );
    expect(mergeAtomicFactAction(complete, undefined)).toBe("clear");
    expect(mergeAtomicFactAction(complete, "not-an-object")).toBe("clear");
    expect(mergeAtomicFactAction(complete, { subject: "a|b", predicate: "role", value: "x" })).toBe(
      "clear",
    );
  });

  it("identity mismatch → clear", () => {
    expect(
      mergeAtomicFactAction(complete, {
        subject: "Dragonfly",
        predicate: "role",
        value: "cache",
      }),
    ).toBe("clear");
  });

  it("stored absent → clear", () => {
    expect(mergeAtomicFactAction(undefined, complete)).toBe("clear");
    expect(mergeAtomicFactAction(null, complete)).toBe("clear");
  });
});

describe("A-3(i) atomicFactIdentity eligibility + canonicalization", () => {
  it("complete triple → canonical lowercase identity; value excluded", () => {
    expect(
      atomicFactIdentity({
        subject: "  Runir Service  ",
        predicate: "Uses_Port",
        value: "7700",
      }),
    ).toBe("runir service|uses_port");
  });

  it("partial / missing value / delimiter-bearing → undefined", () => {
    expect(atomicFactIdentity({ subject: "a", predicate: "b" })).toBeUndefined();
    expect(atomicFactIdentity({ subject: "a", predicate: "b", value: "" })).toBeUndefined();
    expect(
      atomicFactIdentity({ subject: "a|b", predicate: "c", value: "v" }),
    ).toBeUndefined();
    expect(
      atomicFactIdentity({ subject: "a", predicate: "b|c", value: "v" }),
    ).toBeUndefined();
  });
});

describe("A-3(ii) merge-update wiring — REAL arbitrateWrite → spied updateMemoryText", () => {
  // Merge band: similarity in [mergeThreshold, skipThreshold) = [0.85, 0.95),
  // texts that fold (not exact-dup, not containment, no marker, no F1 signal).
  const STORED_TRIPLE = {
    subject: "Atlas datastore",
    predicate: "primary_engine",
    value: "SurrealDB",
  };

  it("clear fixture: value differs → atomicFactAction 'clear'; no incoming triple as write value", async () => {
    const candidate = makeCandidate({
      id: "merge-clear-cand",
      l2: "the user prefers dark mode in the editor for long coding sessions",
      similarity: 0.88,
      atomicFact: { ...STORED_TRIPLE },
    });
    // Incoming is a related additive detail that merges (high overlap, no F1 value-swap
    // statement-key pair). Different atomic value → clear.
    const r = await arb({
      text: "the user prefers dark mode in the editor for long coding sessions and also uses a large font",
      candidates: [candidate],
      metadata: {
        atomicFact: { ...STORED_TRIPLE, value: "Dragonfly" },
      },
    });
    expect(r.outcome).toBe("merge-update");
    expect(updateMemoryText).toHaveBeenCalledTimes(1);
    const args = (updateMemoryText as Mock).mock.calls[0];
    // updateMemoryText(db, id, text, emb, writeSource, atomicFactAction, continuity, table)
    expect(args[1]).toBe("merge-clear-cand");
    expect(args[5]).toBe("clear");
    // No captured call carries the incoming triple as a write value.
    for (const call of (updateMemoryText as Mock).mock.calls) {
      for (const arg of call) {
        if (arg && typeof arg === "object" && "value" in (arg as object)) {
          expect(arg).not.toEqual(expect.objectContaining({ value: "Dragonfly" }));
        }
        // atomicFactAction is the string "clear"/"retain", never the triple.
        if (arg && typeof arg === "object" && "subject" in (arg as object)) {
          throw new Error("updateMemoryText must not receive an atomicFact triple as a write value");
        }
      }
    }
  });

  it("retain fixture: equal complete triple → atomicFactAction 'retain'", async () => {
    const candidate = makeCandidate({
      id: "merge-retain-cand",
      l2: "the user prefers dark mode in the editor for long coding sessions",
      similarity: 0.88,
      atomicFact: { ...STORED_TRIPLE },
    });
    const r = await arb({
      text: "the user prefers dark mode in the editor for long coding sessions and also uses a large font",
      candidates: [candidate],
      metadata: {
        // Same complete triple under canonical subj/pred + trim-only value.
        atomicFact: {
          subject: "  Atlas datastore  ",
          predicate: "Primary_Engine",
          value: "  SurrealDB  ",
        },
      },
    });
    expect(r.outcome).toBe("merge-update");
    expect(updateMemoryText).toHaveBeenCalledTimes(1);
    const args = (updateMemoryText as Mock).mock.calls[0];
    expect(args[5]).toBe("retain");
  });
});
