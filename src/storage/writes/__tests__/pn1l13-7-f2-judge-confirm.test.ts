import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Rúnir-pn1l.13.7 — F2 continuation-retirement → judge-vetoed F2 supersession (Slice 1).
// Covers D0–D4b, D6, D7 service behavior at the arbitrateWrite boundary.
// Replay-specific shadowJudge strict policy (Slice 2) is out of scope here; we still
// assert judge_pending emission and shadow-writes-no-ledger.

vi.mock("../../../lifecycle/semion/dag-guard.js", () => ({
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
const ledgerMocks = vi.hoisted(() => {
  let failures = 0;
  // Mirror production default-logger posture (arch-r2 P1#1): always log, no handle required.
  const defaultLogger = vi.fn();
  let logger: (msg: string) => void = defaultLogger;
  return {
    defaultLogger,
    logSupersessionJudgeLedger: vi.fn().mockResolvedValue(undefined),
    ensureSupersessionJudgeLedgerTable: vi.fn().mockResolvedValue(undefined),
    noteLedgerWriteFailure: vi.fn((detail?: string) => {
      failures += 1;
      logger(`supersession-judge-ledger: append failed: ${detail ?? "unknown"}`);
    }),
    getLedgerWriteFailures: vi.fn(() => failures),
    resetLedgerWriteFailuresForTests: vi.fn(() => {
      failures = 0;
    }),
    setLedgerFailureLogger: vi.fn((fn?: (msg: string) => void) => {
      logger = fn ?? defaultLogger;
    }),
    _reset() {
      failures = 0;
      logger = defaultLogger;
      defaultLogger.mockClear();
    },
  };
});
vi.mock("../../surreal/supersession-judge-ledger.js", () => ({
  logSupersessionJudgeLedger: ledgerMocks.logSupersessionJudgeLedger,
  ensureSupersessionJudgeLedgerTable: ledgerMocks.ensureSupersessionJudgeLedgerTable,
  noteLedgerWriteFailure: ledgerMocks.noteLedgerWriteFailure,
  getLedgerWriteFailures: ledgerMocks.getLedgerWriteFailures,
  resetLedgerWriteFailuresForTests: ledgerMocks.resetLedgerWriteFailuresForTests,
  setLedgerFailureLogger: ledgerMocks.setLedgerFailureLogger,
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import * as supersedeGuards from "../supersede-guards.js";
import {
  findSimilarMemories,
  logSupersedeShadow,
  supersedeMemory,
  upsertMemory,
} from "../../surreal/surreal-store.js";
import { logSupersessionJudgeLedger } from "../../surreal/supersession-judge-ledger.js";
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

const mockLogShadow = logSupersedeShadow as Mock;
const mockLedger = logSupersessionJudgeLedger as Mock;

/** Stub Surreal client used by arbitrator + real supersedeMemory (no live DB). */
function makeDb() {
  return {
    // Empty first result-set → replacement does not exist → fresh-id upsert branch.
    query: vi.fn().mockResolvedValue([[]]),
    queryTransaction: vi.fn().mockResolvedValue(undefined),
  } as any;
}
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(o: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  return {
    id: "cand-f2",
    l2: "Priya Nair is the tech lead for the Atlas project.",
    similarity: 0.88,
    createdAt: now,
    updatedAt: now,
    tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
    ...o,
  };
}

function makeHandle(
  outcome: JudgeOutcome | (() => Promise<JudgeOutcome>),
  floor = DEFAULT_JUDGE_CONFIDENCE_FLOOR,
): SupersessionJudgeHandle & { judge: Mock; noteResolution: Mock; noteLedgerWriteFailure: Mock } {
  const counters = emptyJudgeCounters();
  const judgeFn =
    typeof outcome === "function" ? vi.fn(outcome) : vi.fn().mockResolvedValue(outcome);
  return {
    judge: judgeFn,
    identity: {
      model: "test-judge-model",
      promptVersion: JUDGE_PROMPT_VERSION,
      promptSha256: "b".repeat(64),
      confidenceFloor: floor,
      temperature: 0.1,
      effectiveJsonMode: true,
      baseUrl: "https://judge.test",
      timeoutMs: 15_000,
    },
    getCounters: () => ({ ...counters }),
    noteResolution: vi.fn((r: "confirmed" | "vetoed" | "duplicate") => {
      counters[r] += 1;
    }) as Mock,
    noteLedgerWriteFailure: vi.fn(() => {
      counters.ledger_write_failures += 1;
    }) as Mock,
  };
}

const v = (verdict: SupersessionVerdict): JudgeOutcome => ({ status: "verdict", verdict });

// F2 extractor_correction:slot pattern (marker-driven handoff; different statement keys
// so F1 does not nominate). Mirrors referent-gate-arbitration F2 fixture.
const F2_CAND = makeCandidate();
const F2_TEXT = "Marcus Webb is the new Atlas tech lead, replacing Priya.";
const F2_TAGS = ["subject:marcus-webb", "project:atlas", "role:tech-lead", "update"];

async function arb(opts: {
  text?: string;
  candidate?: SimilarCandidate;
  tags?: string[];
  metadata?: Record<string, unknown>;
  judge?: SupersessionJudgeHandle;
  shadowJudge?: SupersessionJudgeHandle;
  recentWrites?: Map<string, RecentWrite[]>;
}) {
  const candidate = opts.candidate ?? F2_CAND;
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0);
  const metadata = {
    ...(opts.tags ? { tags: opts.tags } : { tags: F2_TAGS }),
    ...opts.metadata,
  };
  return arbitrateWrite({
    db: makeDb(),
    text: opts.text ?? F2_TEXT,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: opts.recentWrites ?? new Map(),
    embedText: vi.fn().mockResolvedValue(embedding),
    metadata,
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(opts.shadowJudge ? { shadowJudge: opts.shadowJudge } : {}),
  });
}

function clearFlipFlags() {
  delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerMocks._reset();
  clearFlipFlags();
  mockLogShadow.mockResolvedValue(undefined);
  mockLedger.mockResolvedValue(undefined);
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (upsertMemory as Mock).mockResolvedValue("new-id");
});
afterEach(() => {
  clearFlipFlags();
});

// ── Test 1: both judge flags OFF → F2 direct-retire unchanged ────────────────
// Proves the composed persisted-row shape under flags-off, byte-for-byte at the
// db-call boundary (real supersedeMemory → composeUpsertMemory → queryTransaction).
// Does NOT assert a live SurrealDB round-trip — only the composed transaction vars.
describe("test 1 — both judge flags OFF (composed persisted-row bytes at store boundary)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags-off F2 supersede: composed transaction vars equal pre-change shape at db boundary", async () => {
    // Pin non-determinism so the comparison is total (arch-r3 P1 / arch-r2 P1#2).
    const FIXED_ID = "00000000-0000-4000-8000-0000000000f2";
    const FIXED_NOW = "2026-06-15T12:00:00.000Z";
    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(FIXED_ID as `${string}-${string}-${string}-${string}-${string}`);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    // Cross the REAL store composition boundary (not the pre-persistence DTO).
    // Other tests keep the mocked supersedeMemory; this one alone drives the real
    // path with a stubbed db that captures query + queryTransaction vars.
    const actualStore = await vi.importActual<
      typeof import("../../surreal/surreal-store.js")
    >("../../surreal/surreal-store.js");
    (supersedeMemory as Mock).mockImplementation(actualStore.supersedeMemory);

    const embedding = makeVec(0);
    const judge = makeHandle(v({ verdict: "independent", confidence: 0.99 }));
    const db = makeDb();

    (findSimilarMemories as Mock).mockResolvedValue([F2_CAND]);
    const r = await arbitrateWrite({
      db,
      text: F2_TEXT,
      userId: "u1",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: { tags: F2_TAGS },
      judge,
    });

    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(mockLedger).not.toHaveBeenCalled();

    // Existence pre-check (read before BEGIN) then the atomic supersede transaction.
    expect(db.query).toHaveBeenCalled();
    expect(db.queryTransaction).toHaveBeenCalledOnce();
    const [txnBody, txnVars] = db.queryTransaction.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // Fresh-id arbitration branch: inlined composeUpsertMemory UPSERT + both tails.
    expect(txnBody).toContain("UPSERT type::record('semiote', $sup_recordId)");
    expect(txnBody).toContain("UPDATE type::record('semiote', $id) SET supersede_provenance");
    expect(txnBody).toContain("UPDATE type::record('semiote', $prevRecordId) SET");

    // Full composed transaction variables at the db-call boundary (nothing elided).
    // JSON.stringify drops keys whose values are undefined — matching both sides.
    const expectedTxnVars: Record<string, unknown> = {
      id: FIXED_ID,
      prevRecordId: "cand-f2",
      now: FIXED_NOW,
      lineageRootId: "cand-f2",
      userId: "u1",
      provenance: "deterministic",
      supersede_provenance: "deterministic",
      inactiveReason: "superseded",
      supersededById: FIXED_ID,
      // composeUpsertMemory (paramPrefix "sup_") — createdAt/updatedAt/lifecycle/top-level
      sup_recordId: FIXED_ID,
      sup_embedding: embedding,
      sup_payload: {
        l2: F2_TEXT,
        userId: "u1",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: "memory-hybrid",
        scope: "user",
        sessionId: undefined,
        active: true,
        inactiveAt: undefined,
        inactiveReason: undefined,
        supersededById: undefined,
        supersedesId: "cand-f2",
        lineageRootId: "cand-f2",
        tags: F2_TAGS,
        supersedeSignal: "extractor_correction:slot",
        writeSource: "memory_store",
        arbitrationOutcome: "supersede",
        supersede_provenance: "deterministic",
      },
      sup_text_norm: F2_TEXT.toLowerCase().trim(),
      sup_now: FIXED_NOW,
      sup_userId: "u1",
      sup_scope: "user",
      sup_sessionId: undefined,
      sup_path: undefined,
      sup_memoryRole: undefined,
      sup_validAt: undefined,
      sup_invalidAt: undefined,
      sup_confidence: undefined,
      sup_active: true,
      sup_inactiveAt: undefined,
      sup_inactiveReason: undefined,
      sup_supersededById: undefined,
      sup_supersedesId: "cand-f2",
      sup_lineageRootId: "cand-f2",
    };
    expect(JSON.stringify(txnVars)).toBe(JSON.stringify(expectedTxnVars));

    uuidSpy.mockRestore();
  });
});

// ── Test 2: flag ON + judge supersede → F2 supersede with provenance ─────────
describe("test 2 — flag ON + judge supersede(0.9) → F2 supersede + provenance + ledger", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("supersedes under F2 authority with confirmed provenance and matching decisionId", async () => {
    const judge = makeHandle(v({ verdict: "supersede", confidence: 0.9 }));
    const r = await arb({ judge });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    expect(judge.judge).toHaveBeenCalledOnce();
    expect(judge.noteResolution).toHaveBeenCalledWith("confirmed");

    const replacement = (supersedeMemory as Mock).mock.calls[0][2];
    expect(replacement.metadata.supersedeSignal).toBe("extractor_correction:slot");
    const prov = replacement.metadata.supersessionProvenance;
    expect(prov).toBeDefined();
    expect(prov.authority).toBe("f2_exception");
    expect(prov.appliedOutcome).toBe("supersede");
    expect(prov.f2JudgeCheck.result).toBe("confirmed");
    expect(prov.f2JudgeCheck.confidence).toBe(0.9);
    expect(prov.f2JudgeCheck.identityStatus).toBe("resolved");
    expect(prov.f2JudgeCheck.judgeIdentity).toMatchObject({
      model: "test-judge-model",
      promptVersion: JUDGE_PROMPT_VERSION,
      confidenceFloor: DEFAULT_JUDGE_CONFIDENCE_FLOOR,
    });
    expect(typeof prov.decisionId).toBe("string");
    expect(prov.decisionId.length).toBeGreaterThan(8);

    // Pre-existing 13.4 convention KEPT: referentProof = "signal:<sig>" (signal
    // provenance, NOT identity proof — brief D3 + storage/AGENTS.md + lifecycle.ts).
    // Applied supersedeMemory metadata carries supersedeSignal; the decision stamps
    // referentProof for shadow columns. Assert both surfaces:
    expect(replacement.metadata.supersedeSignal).toBe("extractor_correction:slot");

    expect(mockLedger).toHaveBeenCalledOnce();
    const ledgerRow = mockLedger.mock.calls[0][1];
    expect(ledgerRow.decisionId).toBe(prov.decisionId);
    expect(ledgerRow.result).toBe("confirmed");
    expect(ledgerRow.appliedOutcome).toBe("supersede");
    expect(ledgerRow.signal).toBe("extractor_correction:slot");
    expect(ledgerRow.identityStatus).toBe("resolved");
    expect(ledgerRow.judgeIdentity).toMatchObject({ model: "test-judge-model" });
    expect(ledgerRow.candidateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ledgerRow.incomingSha256).toMatch(/^[a-f0-9]{64}$/);
    // Stable caller-minted ts (ISO), not re-generated on append.
    expect(typeof ledgerRow.ts).toBe("string");
    expect(Number.isNaN(Date.parse(ledgerRow.ts))).toBe(false);
  });

  it("referentProof convention is signal:<sig> on resolved shadow WOULD row", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const shadowJudge = makeHandle(v({ verdict: "supersede", confidence: 0.9 }));
    // Applied flag OFF so applied path is independent of this assertion; WOULD
    // forces f2JudgeConfirm ON and shadowJudge resolves to supersede.
    delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
    await arb({ shadowJudge });
    const call = mockLogShadow.mock.calls[0][1];
    expect(call.wouldOutcome).toBe("supersede");
    // Explicit convention assertion (not mere absence comment):
    expect(call.referentProof).toBe("signal:extractor_correction:slot");
    expect(call.referentVerdict).toBe("f2_exception");
  });
});

// ── Test 3: flag ON + independent → create + vetoed ──────────────────────────
describe("test 3 — flag ON + judge independent → create + vetoed", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("keeps both with vetoed provenance and ledger; referent untouched", async () => {
    const judge = makeHandle(v({ verdict: "independent", confidence: 0.95 }));
    const r = await arb({ judge });
    expect(r.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(upsertMemory).toHaveBeenCalled();
    expect(judge.noteResolution).toHaveBeenCalledWith("vetoed");

    const meta = (upsertMemory as Mock).mock.calls[0][5];
    expect(meta.supersessionProvenance.f2JudgeCheck.result).toBe("vetoed");
    expect(meta.supersessionProvenance.appliedOutcome).toBe("create");
    expect(mockLedger).toHaveBeenCalledOnce();
    expect(mockLedger.mock.calls[0][1].result).toBe("vetoed");
    expect(mockLedger.mock.calls[0][1].decisionId).toBe(meta.supersessionProvenance.decisionId);
  });
});

// ── Test 4: failure classes → create with distinct reasons ───────────────────
describe("test 4 — flag ON + unavailable/transport_error/invalid_response → create", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it.each([
    [{ status: "unavailable" as const }, "unavailable"],
    [{ status: "transport_error" as const, detail: "gateway 500" }, "transport_error"],
    [{ status: "invalid_response" as const, detail: "malformed_json" }, "invalid_response"],
  ])("%j → create with class in reason + ledger (never labeled independent)", async (outcome, cls) => {
    const judge = makeHandle(outcome);
    const r = await arb({ judge });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(new RegExp(cls));
    expect(r.reason).not.toMatch(/verdict independent/);
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(mockLedger).toHaveBeenCalledOnce();
    expect(mockLedger.mock.calls[0][1].result).toBe(cls);
    const meta = (upsertMemory as Mock).mock.calls[0][5];
    expect(meta.supersessionProvenance.f2JudgeCheck.result).toBe(cls);
  });
});

// ── Test 5: duplicate → skip + ledger; ledger create-once durability ─────────
describe("test 5 — flag ON + judge duplicate → skip + ledger", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("skips with ledger result duplicate (no memory record written)", async () => {
    const judge = makeHandle(v({ verdict: "duplicate", confidence: 0.9 }));
    const r = await arb({ judge });
    expect(r.outcome).toBe("skip");
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(upsertMemory).not.toHaveBeenCalled();
    expect(judge.noteResolution).toHaveBeenCalledWith("duplicate");
    expect(mockLedger).toHaveBeenCalledOnce();
    expect(mockLedger.mock.calls[0][1].result).toBe("duplicate");
    expect(mockLedger.mock.calls[0][1].appliedOutcome).toBe("skip");
    // Skip path AWAITS the ledger append before returning (P1#3) — sole durable trace.
    expect(mockLedger.mock.calls[0][1].decisionId).toBeTruthy();
    expect(mockLedger.mock.calls[0][1].ts).toBeTruthy();
  });
});

// ── Test 6: flag ON + NO judge wired → unavailable / no_handle ───────────────
describe("test 6 — flag ON + NO judge wired → escalate + unavailable + no_handle", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("still escalates; resolves unavailable; ledger identityStatus no_handle; no direct-retire", async () => {
    const r = await arb({}); // no judge
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/unavailable/);
    expect(supersedeMemory).not.toHaveBeenCalled(); // old direct-retire unreachable
    expect(mockLedger).toHaveBeenCalledOnce();
    const row = mockLedger.mock.calls[0][1];
    expect(row.result).toBe("unavailable");
    expect(row.judgeIdentity).toBeNull();
    expect(row.identityStatus).toBe("no_handle");
    const meta = (upsertMemory as Mock).mock.calls[0][5];
    expect(meta.supersessionProvenance.f2JudgeCheck.identityStatus).toBe("no_handle");
    expect(meta.supersessionProvenance.f2JudgeCheck.judgeIdentity).toBeNull();
  });
});

// ── Test 7: F1-proven unaffected ─────────────────────────────────────────────
describe("test 7 — F1-proven path unaffected in both flag states", () => {
  const f1Cand = makeCandidate({
    l2: "deploy target: staging cluster",
    similarity: 0.90,
    factKey: "config:deploy-target-abc123",
    tags: undefined,
  });
  const f1Text = "deploy target: production cluster";
  const f1Meta = { factKey: "config:deploy-target-abc123" };

  it("flag OFF: F1 supersedes, no provenance", async () => {
    const judge = makeHandle(v({ verdict: "independent", confidence: 0.99 }));
    const r = await arb({
      text: f1Text,
      candidate: f1Cand,
      tags: undefined,
      metadata: f1Meta,
      judge,
    });
    expect(r.outcome).toBe("supersede");
    expect(judge.judge).not.toHaveBeenCalled();
    const meta = (supersedeMemory as Mock).mock.calls[0][2].metadata;
    expect(meta.supersedeSignal).toBe("deterministic_text");
    expect(meta.supersessionProvenance).toBeUndefined();
    expect(mockLedger).not.toHaveBeenCalled();
  });

  it("flag ON: F1 never escalates, never carries provenance", async () => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
    const judge = makeHandle(v({ verdict: "independent", confidence: 0.99 }));
    const r = await arb({
      text: f1Text,
      candidate: f1Cand,
      tags: undefined,
      metadata: f1Meta,
      judge,
    });
    expect(r.outcome).toBe("supersede");
    expect(judge.judge).not.toHaveBeenCalled();
    const meta = (supersedeMemory as Mock).mock.calls[0][2].metadata;
    expect(meta.supersedeSignal).toBe("deterministic_text");
    expect(meta.supersessionProvenance).toBeUndefined();
    expect(mockLedger).not.toHaveBeenCalled();
  });
});

// ── Test 8: guards once + guardOverride (spy guard FNs, not judge calls) ─────
describe("test 8 — guards run once; guardOverride stamps confirmed + create", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
    process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD = "1";
  });

  it("durability keep-both wins over judge-confirm; durability guard invoked EXACTLY once", async () => {
    const durSpy = vi.spyOn(supersedeGuards, "durableTransientKeepBothReason");
    const tempSpy = vi.spyOn(supersedeGuards, "temporalOrderingKeepBothReason");
    const judge = makeHandle(v({ verdict: "supersede", confidence: 0.95 }));
    const cand = makeCandidate({ tier: "durable" });
    const r = await arb({
      judge,
      candidate: cand,
      text: "Marcus Webb is the new Atlas tech lead for now, replacing Priya.",
      metadata: { tags: F2_TAGS, tier: "working" },
    });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/durability guard/);
    // Count GUARD invocations (not judge calls) — D2 / P1#5 test 8.
    expect(durSpy).toHaveBeenCalledOnce();
    // Durability short-circuits before temporal on this path.
    expect(tempSpy).not.toHaveBeenCalled();
    expect(judge.noteResolution).toHaveBeenCalledWith("confirmed");
    const meta = (upsertMemory as Mock).mock.calls[0][5];
    expect(meta.supersessionProvenance.f2JudgeCheck.result).toBe("confirmed");
    expect(meta.supersessionProvenance.appliedOutcome).toBe("create");
    expect(meta.supersessionProvenance.f2JudgeCheck.guardOverride).toEqual({
      leg: "durability",
      reason: expect.stringMatching(/transient-over-durable|ephemeral/),
    });
    expect(mockLedger.mock.calls[0][1].guardOverride.leg).toBe("durability");
    expect(mockLedger.mock.calls[0][1].result).toBe("confirmed");
    expect(mockLedger.mock.calls[0][1].appliedOutcome).toBe("create");
    durSpy.mockRestore();
    tempSpy.mockRestore();
  });

  it("temporal leg applies for escalated F2; temporal guard invoked once", async () => {
    const durSpy = vi.spyOn(supersedeGuards, "durableTransientKeepBothReason");
    const tempSpy = vi.spyOn(supersedeGuards, "temporalOrderingKeepBothReason");
    const judge = makeHandle(v({ verdict: "supersede", confidence: 0.95 }));
    const cand = makeCandidate({ validAt: "2099-01-01T00:00:00.000Z" });
    const r = await arb({ judge, candidate: cand });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/temporal-ordering guard/);
    expect(durSpy).toHaveBeenCalledOnce(); // durability checked first, permits
    expect(tempSpy).toHaveBeenCalledOnce(); // temporal fires
    const meta = (upsertMemory as Mock).mock.calls[0][5];
    expect(meta.supersessionProvenance.f2JudgeCheck.guardOverride.leg).toBe("temporal");
    durSpy.mockRestore();
    tempSpy.mockRestore();
  });
});

// ── Test 9 (Slice 1 parts): judge_pending + no ledger on shadow ──────────────
describe("test 9 — shadow judge_pending; no service ledger from shadow", () => {
  it("WOULD emits judge_pending with full candidate context; excluded from diverged; no ledger", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    // Applied path: f2 flag OFF → direct F2 supersede (baseline of applied).
    // WOULD forces f2JudgeConfirm ON → escalates → judge_pending (no shadowJudge).
    const r = await arb({});
    expect(r.outcome).toBe("supersede"); // applied unchanged
    expect(mockLogShadow).toHaveBeenCalledOnce();
    const call = mockLogShadow.mock.calls[0][1];
    expect(call.wouldOutcome).toBe("judge_pending");
    expect(call.wouldMatchedId).toBe("cand-f2");
    expect(call.wouldSignal).toBe("extractor_correction:slot");
    expect(call.wouldCosine).toBeCloseTo(0.88);
    expect(call.wouldBand).toBe("correction-supersede");
    expect(call.candidateSnapshotJson).toBeTruthy();
    // Excluded from ordinary diverged pool.
    expect(call.diverged).toBe(false);
    // Shadow writes NO service ledger rows (r3-#4).
    expect(mockLedger).not.toHaveBeenCalled();
  });

  it("shadowJudge resolves WOULD concretely without writing ledger; snapshot retained", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const shadowJudge = makeHandle(v({ verdict: "independent", confidence: 0.9 }));
    const r = await arb({ shadowJudge });
    expect(r.outcome).toBe("supersede"); // applied still direct-retire (flag OFF)
    expect(shadowJudge.judge).toHaveBeenCalled();
    const call = mockLogShadow.mock.calls[0][1];
    // Verdict resolution → concrete create (veto) — not judge_pending.
    expect(call.wouldOutcome).toBe("create");
    // P1#4: original shadowCandidateSnapshot survives resolveJudgeDecision.
    expect(call.candidateSnapshotJson).toBeTruthy();
    const snap = JSON.parse(call.candidateSnapshotJson as string);
    expect(snap.id ?? snap.l2).toBeTruthy();
    expect(mockLedger).not.toHaveBeenCalled();
  });

  it("shadowJudge non-verdict → judge_pending (unresolved) with failure-class detail + snapshot", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    const shadowJudge = makeHandle({
      status: "transport_error",
      detail: "gateway 503",
    });
    await arb({ shadowJudge });
    expect(shadowJudge.judge).toHaveBeenCalled();
    const call = mockLogShadow.mock.calls[0][1];
    // Non-verdict must NOT collapse to ordinary create — strict policy needs
    // an unresolved marker (P1#4 / D5).
    expect(call.wouldOutcome).toBe("judge_pending");
    expect(call.diverged).toBe(false);
    expect(call.wouldReason).toMatch(/transport_error/);
    expect(call.candidateSnapshotJson).toBeTruthy();
    expect(mockLedger).not.toHaveBeenCalled();
  });

  it("BASELINE stays flag-off (no F2 judge escalation)", async () => {
    process.env.RUNIR_SUPERSEDE_SHADOW = "1";
    await arb({});
    const call = mockLogShadow.mock.calls[0][1];
    // Baseline all flags OFF → F2 still supersedes in baseline (flag-off behavior).
    expect(call.baselineOutcome).toBe("supersede");
  });
});

// ── Test 11: flags independent ───────────────────────────────────────────────
describe("test 11 — flags independent (cue path vs F2 confirm)", () => {
  it("cue path works without F2 flag", async () => {
    process.env.RUNIR_SUPERSEDE_JUDGE_GATE = "1";
    // named_value migration abstains Layer 0 → cue/judge path
    const judge = makeHandle(v({ verdict: "supersede", confidence: 0.9 }));
    const cand = makeCandidate({
      l2: "The Atlas datastore is SurrealDB",
      similarity: 0.88,
      tags: ["project:atlas", "datastore:surrealdb"],
    });
    const r = await arb({
      text: "We migrated the Atlas datastore off SurrealDB to Postgres",
      candidate: cand,
      tags: ["project:atlas", "datastore:postgres"],
      judge,
    });
    expect(judge.judge).toHaveBeenCalled();
    expect(r.outcome).toBe("supersede");
    // Cue path does not write F2 ledger/provenance.
    expect(mockLedger).not.toHaveBeenCalled();
    const meta = (supersedeMemory as Mock).mock.calls[0][2].metadata;
    expect(meta.supersedeSignal).toBe("llm_judge:supersede");
    expect(meta.supersessionProvenance).toBeUndefined();
  });

  it("F2 confirm works without cue judge gate", async () => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
    delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
    const judge = makeHandle(v({ verdict: "supersede", confidence: 0.9 }));
    const r = await arb({ judge });
    expect(judge.judge).toHaveBeenCalled();
    expect(r.outcome).toBe("supersede");
    expect(mockLedger).toHaveBeenCalledOnce();
  });
});

// ── Test 13: ledger-append failure swallowed + counted (module-owned) ────────
describe("test 13 — ledger-append failure is swallowed + counted, never fails write", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("write still supersedes when ledger rejects; module counter increments (handle-independent)", async () => {
    mockLedger.mockRejectedValue(new Error("db down"));
    const judge = makeHandle(v({ verdict: "supersede", confidence: 0.9 }));
    const r = await arb({ judge });
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    // Awaited path — no microtask race. Module-owned counter (P1#3), not handle-only.
    expect(ledgerMocks.noteLedgerWriteFailure).toHaveBeenCalled();
    expect(ledgerMocks.getLedgerWriteFailures()).toBeGreaterThanOrEqual(1);
  });

  it("no-handle escalation logs + counts once (module-owned default logger, not handle-gated)", async () => {
    mockLedger.mockRejectedValue(new Error("db down"));
    // No judge handle — still escalates under flag, resolves unavailable, writes ledger.
    // Default logger seam is always active (arch-r2 P1#1); no setLedgerFailureLogger needed.
    const r = await arb({});
    expect(r.outcome).toBe("create");
    expect(ledgerMocks.noteLedgerWriteFailure).toHaveBeenCalledTimes(1);
    expect(ledgerMocks.getLedgerWriteFailures()).toBe(1);
    // ONE log emission via the default logger seam (not console globally).
    expect(ledgerMocks.defaultLogger).toHaveBeenCalledTimes(1);
    expect(ledgerMocks.defaultLogger).toHaveBeenCalledWith(
      expect.stringMatching(/^supersession-judge-ledger: append failed:/),
    );
  });
});

// ── Test 14: write-boundary keep-both documentation (not a recall integration) ─
describe("test 14 — write-boundary keep-both state (stale referent + correction both active)", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("veto create leaves the candidate unsuperseded and writes the incoming (write-boundary doc)", async () => {
    // WRITE-BOUNDARY documentation of the keep-both fallback — not a hybrid-recall
    // integration test. When the judge vetoes, the write path creates a new row and
    // does NOT call supersedeMemory, so the stale referent remains active alongside
    // the landed correction. Subsequent recall would surface both until a later
    // retirement authority acts; this test pins the write-side precondition only.
    const judge = makeHandle(v({ verdict: "independent", confidence: 0.9 }));
    const r = await arb({ judge });
    expect(r.outcome).toBe("create");
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(upsertMemory).toHaveBeenCalledOnce();
    // Candidate id never retired — both rows exist for subsequent recall.
    expect(r.reason).toMatch(/kept both|veto|independent/i);
  });
});

// ── Judge-throw containment (restored — defense-in-depth) ────────────────────
describe("judge-throw containment", () => {
  beforeEach(() => {
    process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM = "1";
  });

  it("a judge function that THROWS is contained as transport_error keep-both", async () => {
    const judge = makeHandle(async () => {
      throw new Error("boom from judge");
    });
    const r = await arb({ judge });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/transport_error/);
    expect(r.reason).toMatch(/boom from judge/);
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(mockLedger).toHaveBeenCalledOnce();
    expect(mockLedger.mock.calls[0][1].result).toBe("transport_error");
  });
});
