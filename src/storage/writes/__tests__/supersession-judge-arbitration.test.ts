import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l Layer 2 — arbitrator wiring for the injected OLD/NEW judge HANDLE.
// The judge fires ONLY on the Layer-0-abstain set: in-band, currentness-cued,
// positive same-subject evidence, non-conflicting-subjects. Gate off OR no judge
// injected ⇒ byte-for-byte today's behavior, judge never called.
// Rúnir-pn1l.13.7: handle returns JudgeOutcome; floor from handle.identity.

vi.mock("../../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));
vi.mock("../../surreal/supersession-judge-ledger.js", () => ({
  logSupersessionJudgeLedger: vi.fn().mockResolvedValue(undefined),
  ensureSupersessionJudgeLedgerTable: vi.fn().mockResolvedValue(undefined),
  noteLedgerWriteFailure: vi.fn(),
  getLedgerWriteFailures: vi.fn(() => 0),
  resetLedgerWriteFailuresForTests: vi.fn(),
  setLedgerFailureLogger: vi.fn(),
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import { findSimilarMemories, supersedeMemory } from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";
import type {
  JudgeOutcome,
  SupersessionJudgeHandle,
  SupersessionVerdict,
} from "../supersession-judge.js";
import {
  DEFAULT_JUDGE_CONFIDENCE_FLOOR,
  emptyJudgeCounters,
  JUDGE_PROMPT_VERSION,
} from "../supersession-judge.js";

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(overrides: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  return {
    id: "existing-id",
    l2: "The Atlas datastore is SurrealDB",
    similarity: 0.88,
    createdAt: now,
    updatedAt: now,
    tags: ["project:atlas", "datastore:surrealdb"],
    ...overrides,
  };
}

function makeHandle(
  outcome: JudgeOutcome | (() => Promise<JudgeOutcome>),
  floor = DEFAULT_JUDGE_CONFIDENCE_FLOOR,
): SupersessionJudgeHandle & { judge: Mock } {
  const counters = emptyJudgeCounters();
  const judgeFn =
    typeof outcome === "function"
      ? vi.fn(outcome)
      : vi.fn().mockResolvedValue(outcome);
  return {
    judge: judgeFn,
    identity: {
      model: "test-model",
      promptVersion: JUDGE_PROMPT_VERSION,
      promptSha256: "a".repeat(64),
      confidenceFloor: floor,
      temperature: 0.1,
      effectiveJsonMode: true,
      baseUrl: "https://test.example",
      timeoutMs: 30_000,
    },
    getCounters: () => ({ ...counters }),
    noteResolution: vi.fn((r: "confirmed" | "vetoed" | "duplicate") => {
      counters[r] += 1;
    }),
    noteLedgerWriteFailure: vi.fn(() => {
      counters.ledger_write_failures += 1;
    }),
  };
}

const verdict = (v: SupersessionVerdict): JudgeOutcome => ({ status: "verdict", verdict: v });

// A named_value migration that Layer 0 abstains on (no marker, cue gate off):
// shares subject (atlas), names the candidate's changed value (surrealdb), cued.
const MIGRATION_TEXT = "We migrated the Atlas datastore off SurrealDB to Postgres";
const MIGRATION_TAGS = ["project:atlas", "datastore:postgres"];

async function arb(opts: {
  text: string;
  candidate: SimilarCandidate;
  tags?: string[];
  judge?: SupersessionJudgeHandle;
}) {
  (findSimilarMemories as Mock).mockResolvedValue([opts.candidate]);
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
    ...(opts.tags ? { metadata: { tags: opts.tags } } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
  });
}

describe("Rúnir-pn1l Layer 2 — judge gate OFF (default)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
    delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
    delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });

  it("never calls the judge and never supersedes when the gate is off", async () => {
    const judge = makeHandle(verdict({ verdict: "supersede", confidence: 0.99 }));
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(judge.judge).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

describe("Rúnir-pn1l Layer 2 — judge gate ON", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNIR_SUPERSEDE_JUDGE_GATE = "1";
    delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
    delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  });

  it("escalates the named_value migration to the judge and supersedes on a supersede verdict", async () => {
    const judge = makeHandle(verdict({ verdict: "supersede", confidence: 0.9 }));
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(judge.judge).toHaveBeenCalledWith("The Atlas datastore is SurrealDB", MIGRATION_TEXT);
    expect(result.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("maps a duplicate verdict to skip", async () => {
    const judge = makeHandle(verdict({ verdict: "duplicate", confidence: 0.9 }));
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(judge.judge).toHaveBeenCalled();
    expect(result.outcome).toBe("skip");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("maps an independent verdict to create (keep both)", async () => {
    const judge = makeHandle(verdict({ verdict: "independent", confidence: 0.9 }));
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(judge.judge).toHaveBeenCalled();
    expect(result.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("keeps both on transport_error (never a wrong supersede)", async () => {
    const judge = makeHandle({ status: "transport_error", detail: "llm down" });
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(result.outcome).toBe("create");
    expect(result.reason).toMatch(/transport_error/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("keeps both when the gate is on but no judge is injected", async () => {
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS });
    expect(result.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("does NOT escalate a cued, untagged, high-similarity cross-entity handoff (Codex #5 / w077)", async () => {
    const judge = makeHandle(verdict({ verdict: "supersede", confidence: 0.99 }));
    const candidate = makeCandidate({ l2: "Priya Nair is the Atlas tech lead", tags: undefined });
    const result = await arb({
      text: "Marcus Webb is now the Atlas tech lead",
      candidate,
      judge,
    });
    expect(judge.judge).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("does NOT escalate when the incoming text has no currentness cue", async () => {
    const judge = makeHandle(verdict({ verdict: "supersede", confidence: 0.99 }));
    const result = await arb({
      text: "The Atlas datastore uses Postgres and SurrealDB together",
      candidate: makeCandidate(),
      tags: MIGRATION_TAGS,
      judge,
    });
    expect(judge.judge).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe("supersede");
  });

  it("does NOT supersede on a sub-floor supersede verdict — floor from handle identity", async () => {
    const judge = makeHandle(verdict({ verdict: "supersede", confidence: 0.3 }), 0.6);
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(judge.judge).toHaveBeenCalled();
    expect(result.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("does NOT skip on a sub-floor duplicate verdict (keeps both instead)", async () => {
    const judge = makeHandle(verdict({ verdict: "duplicate", confidence: 0.3 }), 0.6);
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(result.outcome).toBe("create");
  });

  it("does NOT escalate when the extractor named disjoint subjects (conflicting-subjects)", async () => {
    const judge = makeHandle(verdict({ verdict: "supersede", confidence: 0.99 }));
    const candidate = makeCandidate({
      l2: "The Speki datastore is SurrealDB",
      tags: ["project:speki", "datastore:surrealdb"],
    });
    const result = await arb({
      text: "We migrated the Atlas datastore off SurrealDB to Postgres",
      candidate,
      tags: ["project:atlas", "datastore:postgres"],
      judge,
    });
    expect(judge.judge).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("maps invalid_response to create with class-distinct reason (never labeled independent)", async () => {
    const judge = makeHandle({ status: "invalid_response", detail: "malformed_json" });
    const result = await arb({ text: MIGRATION_TEXT, candidate: makeCandidate(), tags: MIGRATION_TAGS, judge });
    expect(result.outcome).toBe("create");
    expect(result.reason).toMatch(/invalid_response/);
    expect(result.reason).not.toMatch(/verdict independent/);
  });
});
