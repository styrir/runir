import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logSupersessionJudgeLedger,
  noteLedgerWriteFailure,
  getLedgerWriteFailures,
  resetLedgerWriteFailuresForTests,
  setLedgerFailureLogger,
  type SupersessionJudgeLedgerRow,
} from "../supersession-judge-ledger.js";

// Rúnir-pn1l.13.7 P0#2 — create-once / conflict-as-success ledger semantics.
// arch-r2 P1#1 — handle-independent default logger.

function baseRow(overrides: Partial<SupersessionJudgeLedgerRow> = {}): SupersessionJudgeLedgerRow {
  return {
    decisionId: "dec-stable-1",
    ts: "2026-07-09T12:00:00.000Z",
    userId: "u1",
    scope: "user",
    candidateId: "cand-1",
    candidateSha256: "a".repeat(64),
    incomingSha256: "b".repeat(64),
    signal: "extractor_correction:slot",
    band: "correction-supersede",
    cosine: 0.88,
    result: "confirmed",
    confidence: 0.9,
    judgeIdentity: null,
    identityStatus: "no_handle",
    appliedOutcome: "supersede",
    ...overrides,
  };
}

describe("logSupersessionJudgeLedger create-once semantics (P0#2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("two appends same decisionId different payloads → stored row identical to first (conflict = success)", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const db = {
      query: vi.fn(async (sql: string, vars: Record<string, unknown>) => {
        if (sql.includes("CREATE type::record('supersession_judge_ledger'")) {
          const id = String(vars.id);
          if (store.has(id)) {
            // Surreal-style duplicate-record rejection
            throw new Error(
              `Database index already contains record supersession_judge_ledger:${id}`,
            );
          }
          // Capture the full row as first-write wins
          store.set(id, { ...vars });
          return [[{ id }]];
        }
        return [[]];
      }),
    };

    const first = baseRow({ result: "confirmed", appliedOutcome: "supersede", confidence: 0.9 });
    const second = baseRow({
      result: "vetoed", // different payload — must NOT overwrite
      appliedOutcome: "create",
      confidence: 0.1,
      ts: "2026-07-09T99:99:99.000Z", // would-be rewrite
    });

    await logSupersessionJudgeLedger(db as any, first);
    // Conflict-as-success: must not throw
    await expect(logSupersessionJudgeLedger(db as any, second)).resolves.toBeUndefined();

    expect(db.query).toHaveBeenCalledTimes(2);
    // Stored row identical to the FIRST append
    const stored = store.get("dec-stable-1")!;
    expect(stored).toBeDefined();
    expect(stored.result).toBe("confirmed");
    expect(stored.applied_outcome).toBe("supersede");
    expect(stored.confidence).toBe(0.9);
    expect(stored.ts).toBe("2026-07-09T12:00:00.000Z");
    // Second payload never landed
    expect(stored.result).not.toBe("vetoed");
  });

  it("uses CREATE not UPSERT, and passes caller-minted ts (not time::now())", async () => {
    const db = { query: vi.fn().mockResolvedValue([[]]) };
    await logSupersessionJudgeLedger(db as any, baseRow());
    const [sql, vars] = db.query.mock.calls[0];
    expect(sql).toContain("CREATE type::record('supersession_judge_ledger'");
    expect(sql).not.toMatch(/\bUPSERT\b/);
    expect(sql).toContain("ts=<datetime>$ts");
    expect(sql).not.toContain("time::now()");
    expect(vars.ts).toBe("2026-07-09T12:00:00.000Z");
  });
});

// arch-r2 P1#1 — every failure both logs and counts, handle or not.
describe("noteLedgerWriteFailure handle-independent logging (P1#1)", () => {
  afterEach(() => {
    resetLedgerWriteFailuresForTests();
    setLedgerFailureLogger(undefined); // restore default
  });

  it("default logger logs + counts without any prior setLedgerFailureLogger / handle", () => {
    resetLedgerWriteFailuresForTests();
    // Spy the injectable seam by replacing, then restoring default, then spying
    // console.warn only for the default path once — proves the module default
    // is console.warn-shaped without requiring a handle factory call.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteLedgerWriteFailure("db down");
    expect(getLedgerWriteFailures()).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "supersession-judge-ledger: append failed: db down",
    );
    warnSpy.mockRestore();
  });

  it("injected logger replaces default; one log + one count per failure", () => {
    resetLedgerWriteFailuresForTests();
    const injected = vi.fn();
    setLedgerFailureLogger(injected);
    noteLedgerWriteFailure("gateway timeout");
    expect(getLedgerWriteFailures()).toBe(1);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected).toHaveBeenCalledWith(
      "supersession-judge-ledger: append failed: gateway timeout",
    );
    // Default console.warn not used while injected logger is active.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteLedgerWriteFailure("second");
    expect(getLedgerWriteFailures()).toBe(2);
    expect(injected).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("setLedgerFailureLogger(undefined) restores default logger", () => {
    resetLedgerWriteFailuresForTests();
    const injected = vi.fn();
    setLedgerFailureLogger(injected);
    setLedgerFailureLogger(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteLedgerWriteFailure("restored");
    expect(injected).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "supersession-judge-ledger: append failed: restored",
    );
    warnSpy.mockRestore();
  });
});
