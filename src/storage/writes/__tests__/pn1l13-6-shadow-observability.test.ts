import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.13.6 — shadow-observability Item B: capture full untruncated incoming
// text, incoming tags, and a point-in-time candidate content snapshot inline in the
// supersede_shadow row, so guard-blocked / veto-blocked rows are replayable offline
// through mergeKeepBothReason (guard rows) / proveReferentIdentity (anchor-conflict
// rows) without re-fetching a since-mutated candidate from the live DB.
//
// House pattern mirrors referent-gate-arbitration.test.ts / merge-keepboth-guard.test.ts:
// mocked store + makeCandidate/arb, assertions on the captured logSupersedeShadow call.

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
  SurrealClient: class { query = vi.fn().mockResolvedValue([[]]); },
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
} from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

const mockLogSupersedeShadow = logSupersedeShadow as Mock;

function makeDb() { return { query: vi.fn().mockResolvedValue([[]]) } as any; }
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(o: Partial<SimilarCandidate> & { l2: string; similarity: number }): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "seed-id", createdAt: now, updatedAt: now, ...o };
}
async function arb(opts: {
  text: string;
  candidates?: SimilarCandidate[];
  metadata?: Record<string, unknown>;
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
    recentWrites: new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  mockLogSupersedeShadow.mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
});

// A conflict pair sharing a statement key (so F1 nominates, forcing the merge-band
// veto to be the thing that stops the supersede) — reused shape from
// referent-gate-arbitration.test.ts's CONFLICT_CANDIDATE_TEXT/CONFLICT_INCOMING_TEXT.
const CONFLICT_CANDIDATE_TEXT = "parser bug: continuity-report.ts:84";
const CONFLICT_INCOMING_TEXT = "parser bug: continuity-report.ts:419";

const LONG_TAIL = "distinguishable-tail-marker-past-two-hundred-characters";
function buildLongIncomingText(): string {
  // >200 chars total, with a distinct tail past char 200 that the truncated
  // incoming_text_trunc (.slice(0, 200)) would never carry.
  const padding = "x".repeat(220);
  return `parser bug: continuity-report.ts:419 ${padding} ${LONG_TAIL}`;
}

describe("pn1l.13.6 Item B — full incoming text + tags + candidate snapshot capture", () => {
  it("merge-band veto: shadowCandidateSnapshot carries the pre-arbitration candidate content", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      l2: CONFLICT_CANDIDATE_TEXT,
      similarity: 0.90,
      tags: ["component:parser"],
      factKey: "parser-bug-key-1",
      noemaClaimKey: "claim-1",
      atomicFact: { subject: "parser", predicate: "has_bug", value: "true" },
    });
    const incomingText = buildLongIncomingText();
    const r = await arb({
      text: incomingText,
      candidates: [candidate],
      metadata: { tags: ["project:atlas", "role:tech-lead"] },
    });
    expect(r.outcome).toBe("create");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;

    // (a) full untruncated incoming text.
    expect(call.incomingTextFull).toBe(incomingText);
    expect(call.incomingTextFull.length).toBeGreaterThan(200);
    expect(call.incomingTextFull).toContain(LONG_TAIL);
    // incoming_text_trunc stays truncated — the full field must be a DIFFERENT value.
    expect(call.incomingTextFull).not.toBe(call.incomingTextTrunc);

    // (b) incoming tags, JSON-string encoded, surviving round-trip.
    expect(call.incomingTagsJson).toBe(JSON.stringify(["project:atlas", "role:tech-lead"]));
    expect(JSON.parse(call.incomingTagsJson)).toEqual(["project:atlas", "role:tech-lead"]);

    // (c) candidate snapshot — JSON-string of {id,l2,tags,factKey,noemaClaimKey,atomicFact}
    // AS AT ARBITRATION TIME, not null.
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    expect(snapshot.id).toBe("seed-id");
    expect(snapshot.l2).toBe(CONFLICT_CANDIDATE_TEXT);
    expect(snapshot.tags).toEqual(["component:parser"]);
    expect(snapshot.factKey).toBe("parser-bug-key-1");
    expect(snapshot.noemaClaimKey).toBe("claim-1");
    expect(snapshot.atomicFact).toEqual({ subject: "parser", predicate: "has_bug", value: "true" });
  });

  it("store-near-dup skip-band veto: shadowCandidateSnapshot carries the pre-arbitration candidate content", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const candidate = makeCandidate({
      l2: CONFLICT_CANDIDATE_TEXT,
      similarity: 0.97,
      tags: ["component:parser"],
    });
    const r = await arb({ text: CONFLICT_INCOMING_TEXT, candidates: [candidate] });
    expect(r.outcome).toBe("create");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.candidateSnapshotJson).not.toBeNull();
    const snapshot = JSON.parse(call.candidateSnapshotJson);
    expect(snapshot.l2).toBe(CONFLICT_CANDIDATE_TEXT);
    expect(snapshot.tags).toEqual(["component:parser"]);
  });

  it("no candidates at all: incomingTextFull/incomingTagsJson still populate; candidateSnapshotJson is null", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const incomingText = buildLongIncomingText();
    const r = await arb({ text: incomingText, metadata: { tags: ["solo:tag"] } });
    expect(r.outcome).toBe("create");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.incomingTextFull).toBe(incomingText);
    expect(call.incomingTagsJson).toBe(JSON.stringify(["solo:tag"]));
    expect(call.candidateSnapshotJson).toBeNull();
  });

  it("no incoming tags: incomingTagsJson is explicitly null (not the string \"undefined\")", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const r = await arb({ text: "a fresh incoming fact with no similar candidates at all here" });
    expect(r.outcome).toBe("create");
    const call = mockLogSupersedeShadow.mock.calls[0][1] as any;
    expect(call.incomingTagsJson).toBeNull();
  });
});
