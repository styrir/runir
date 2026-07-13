// Detector-logic tests for the continuity-gap detectors (Rúnir-78sy.4).
//
// Stub-DB + mocked store fns: verifies WHICH gaps each deterministic detector
// fires, their confidence/dedupeKey, the missing_handoff session-scoped
// negatives, reconciliation (supersede stale/emptied active gaps), and the
// per-project cap. The real unique-index dedupe + lifecycle live in the
// continuity-gap-store-repro test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  upsertContinuityGap: vi.fn(),
  listActiveGapsForKind: vi.fn(),
  setGapStatus: vi.fn(),
  writeGapEvaluatedThrough: vi.fn(),
  getProjectContinuityState: vi.fn(),
  listProjectEnrollments: vi.fn(),
}));

vi.mock("../storage/surreal/continuity-gap-store.js", () => ({
  upsertContinuityGap: store.upsertContinuityGap,
  listActiveGapsForKind: store.listActiveGapsForKind,
  setGapStatus: store.setGapStatus,
  writeGapEvaluatedThrough: store.writeGapEvaluatedThrough,
}));

vi.mock("../storage/surreal/continuity-state-store.js", () => ({
  getProjectContinuityState: store.getProjectContinuityState,
  listProjectEnrollments: store.listProjectEnrollments,
}));

import { normalizedListFingerprint, runGapDetectionStep } from "../lifecycle/semion/continuity-gaps.js";
import type { ProjectContinuityStateRecord, ProjectEnrollmentRecord } from "../domain/memory/continuity.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

function makeEnrollment(overrides: Partial<ProjectEnrollmentRecord> = {}): ProjectEnrollmentRecord {
  return {
    id: "project_enrollment_a",
    userId: "u1",
    workspaceId: "-",
    projectKey: "project:runir",
    projectId: "runir",
    repoRootFingerprint: "wf-abc",
    source: "manual",
    enrolledAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(overrides: Partial<ProjectContinuityStateRecord> = {}): ProjectContinuityStateRecord {
  return {
    id: "project_continuity_state_x",
    userId: "u1",
    workspaceId: "-",
    projectKey: "project:runir",
    projectId: "runir",
    currentFocus: [],
    latestProgress: [],
    nextSteps: [],
    blockers: [],
    openLoops: [],
    unfiledIntentions: [],
    pendingVerification: [],
    recentlyChangedArtifacts: [],
    likelyStaleBeads: [],
    activeAgentRuns: [],
    sourceEvidenceRefs: [{ kind: "semiote", id: "semiote:ev1", at: "2026-07-03T00:00:00.000Z" }],
    confidence: 0.7,
    sourceSessionIds: [],
    supportingSemioteIds: [],
    version: 1,
    validAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

/** DB stub for the missing_handoff raw queries only (runir_session + semiote).
 *  `hasHandoff` simulates the stored-role fast path OR a broadened-cue hit —
 *  both routes fire through the SAME broadened sessionHasHandoff query
 *  (F19: the OR-clause still contains both "FROM semiote" and the literal
 *  "session_handoff" substring since the fast path is kept), so a single knob
 *  models "the query returned a hit" regardless of which leg matched. */
function makeStubDb(opts: {
  // F4/F7 (Rúnir-78sy.13): the raw query now selects last_closed_at (not
  // closed_at) with no status filter — every fixture row reaching this stub
  // represents a row the live WHERE clause already required to have
  // last_closed_at set, so the default below is a fixed ISO rather than null
  // (a null here would produce the F7 dedupeKey's "unknown" fallback, which
  // is meant to guard an invariant violation, not model the normal case).
  endedSessions?: Array<{ id: string; last_closed_at?: string; close_reason?: string }>;
  didWork?: Record<string, boolean>;
  hasHandoff?: Record<string, boolean>;
} = {}): SurrealClient {
  const { endedSessions = [], didWork = {}, hasHandoff = {} } = opts;
  const query = async (sql: string, vars?: Record<string, unknown>): Promise<any[]> => {
    if (sql.includes("FROM runir_session")) {
      return [endedSessions.map((s) => ({
        id: s.id,
        last_closed_at: s.last_closed_at ?? "2026-07-04T00:00:00.000Z",
        close_reason: s.close_reason ?? null,
      }))];
    }
    if (sql.includes("count() FROM semiote")) {
      const sid = String(vars?.sessionId ?? "");
      return [[{ count: didWork[sid] ? 1 : 0 }]];
    }
    if (sql.includes("FROM semiote") && sql.includes("session_handoff")) {
      const sid = String(vars?.sessionId ?? "");
      return [hasHandoff[sid] ? [{ id: "semiote:handoff" }] : []];
    }
    return [[]];
  };
  return { query } as unknown as SurrealClient;
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  store.upsertContinuityGap.mockImplementation(async (_db: unknown, w: any) => ({ ...w, id: `gap_${w.dedupeKey}` }));
  store.listActiveGapsForKind.mockResolvedValue([]);
  store.setGapStatus.mockResolvedValue(undefined);
  store.writeGapEvaluatedThrough.mockResolvedValue(undefined);
  delete process.env.RUNIR_CONTINUITY_GAP_MAX_PROJECTS_PER_RUN;
  delete process.env.CONSOLIDATION_GAP_BUDGET_MS;
});

afterEach(() => vi.clearAllMocks());

function firedGaps(): any[] {
  return store.upsertContinuityGap.mock.calls.map((c) => c[1]);
}

describe("normalizedListFingerprint", () => {
  it("is order- and case-insensitive", () => {
    expect(normalizedListFingerprint(["B item", "a item"])).toBe(normalizedListFingerprint(["a ITEM", "b item"]));
  });
  it("changes when content changes", () => {
    expect(normalizedListFingerprint(["a"])).not.toBe(normalizedListFingerprint(["a", "b"]));
  });
});

describe("runGapDetectionStep detectors", () => {
  it("skips a project with no continuity state (nothing evaluated)", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(null);
    const result = await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    expect(result.projectsSkipped).toBe(1);
    expect(store.upsertContinuityGap).not.toHaveBeenCalled();
    expect(store.writeGapEvaluatedThrough).not.toHaveBeenCalled();
  });

  it("fires unfiled_intent (weak) when unfiledIntentions is non-empty", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState({ unfiledIntentions: ["ship X", "wire Y"] }));
    await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    const gap = firedGaps().find((g) => g.kind === "unfiled_intent");
    expect(gap).toBeTruthy();
    expect(gap.confidence).toBe("weak");
    expect(gap.dedupeKey).toContain("unfiled_intent:");
  });

  it("fires started_unfinished (weak) from open loops / pending / active runs", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState({ openLoops: ["refactor"], pendingVerification: ["test Z"] }));
    await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    const gap = firedGaps().find((g) => g.kind === "started_unfinished");
    expect(gap).toBeTruthy();
    expect(gap.confidence).toBe("weak");
  });

  it("fires missing_handoff (developing) for an ended session that did work with no handoff", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const db = makeStubDb({
      endedSessions: [{ id: "sess-1", close_reason: "user_exit" }],
      didWork: { "sess-1": true },
      hasHandoff: { "sess-1": false },
    });
    await runGapDetectionStep({ db, userId: "u1" });
    const gap = firedGaps().find((g) => g.kind === "missing_handoff");
    expect(gap).toBeTruthy();
    expect(gap.confidence).toBe("developing");
    // F7: the dedupeKey now carries a close-GENERATION suffix (the
    // last_closed_at ISO of the close event), not just the bare session id.
    expect(gap.dedupeKey).toBe("missing_handoff:sess-1:2026-07-04T00:00:00.000Z");
  });

  it("missing_handoff NEGATIVE: session with a bound handoff does NOT fire", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const db = makeStubDb({
      endedSessions: [{ id: "sess-1" }],
      didWork: { "sess-1": true },
      hasHandoff: { "sess-1": true },
    });
    await runGapDetectionStep({ db, userId: "u1" });
    expect(firedGaps().find((g) => g.kind === "missing_handoff")).toBeUndefined();
  });

  it("missing_handoff NEGATIVE: session that did no work does NOT fire", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const db = makeStubDb({
      endedSessions: [{ id: "sess-1" }],
      didWork: { "sess-1": false },
      hasHandoff: { "sess-1": false },
    });
    await runGapDetectionStep({ db, userId: "u1" });
    expect(firedGaps().find((g) => g.kind === "missing_handoff")).toBeUndefined();
  });

  it("Part A: sessionHasHandoff's query broadens with the cue OR-fragment (still routes via the F19 stub dispatch)", async () => {
    // A session whose captured text matches a NEW cue (e.g. "resume point")
    // but has no stored memory_role='session_handoff' must NOT fire a gap —
    // proving the broadened query, not just the legacy fast path, suppresses it.
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    let capturedSql = "";
    const db = {
      query: async (sql: string, vars?: Record<string, unknown>) => {
        capturedSql = sql;
        if (sql.includes("FROM runir_session")) {
          return [[{ id: "sess-1", last_closed_at: "2026-07-04T00:00:00.000Z", close_reason: null }]];
        }
        if (sql.includes("count() FROM semiote")) return [[{ count: 1 }]];
        if (sql.includes("FROM semiote") && sql.includes("session_handoff")) {
          // Simulate the cue leg matching (no stored role, cue-only hit).
          return [[{ id: "semiote:cue-match" }]];
        }
        return [[]];
      },
    } as unknown as SurrealClient;
    await runGapDetectionStep({ db, userId: "u1" });
    expect(firedGaps().find((g) => g.kind === "missing_handoff")).toBeUndefined();
    // The query shape must actually carry the OR-broadened cue fragment
    // (not just the legacy 3-phrase substring) — proves Part A's wiring, not
    // just that the stub happens to return a hit for any semiote+handoff query.
    expect(capturedSql).toContain("string::contains");
    expect(capturedSql).toContain("memory_role");
  });

  it("stamps the gap-evaluation cursor after evaluating a project", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState({ updatedAt: "2026-07-04T00:00:00.000Z" }));
    await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    expect(store.writeGapEvaluatedThrough).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "-",
      "project:runir",
      "2026-07-04T00:00:00.000Z",
    );
  });
});

describe("runGapDetectionStep reconciliation", () => {
  it("supersedes a stale active gap whose dedupeKey the detector did not fire", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState({ unfiledIntentions: ["new intent"] }));
    // The unfiled_intent lane has one OLD active gap (different content) plus the
    // one the detector will fire this run.
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "unfiled_intent") {
        return [
          { id: "gap_old", dedupeKey: "unfiled_intent:OLDHASH", status: "active" },
          { id: "gap_new", dedupeKey: `unfiled_intent:${normalizedListFingerprint(["new intent"])}`, status: "active" },
        ];
      }
      return [];
    });
    const result = await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    expect(store.setGapStatus).toHaveBeenCalledWith(expect.anything(), "gap_old", "superseded");
    expect(store.setGapStatus).not.toHaveBeenCalledWith(expect.anything(), "gap_new", "superseded");
    expect(result.superseded).toBeGreaterThanOrEqual(1);
  });

  it("supersedes ALL active gaps of a kind when its list has emptied (no fired key)", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState()); // no lists → nothing fires
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "started_unfinished") return [{ id: "gap_stale", dedupeKey: "started_unfinished:X", status: "active" }];
      return [];
    });
    await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    expect(store.setGapStatus).toHaveBeenCalledWith(expect.anything(), "gap_stale", "superseded");
  });

  // ── Part B: window-aware missing_handoff reconciliation (Rúnir-78sy.7) ──────
  // reconcileKind's supersede-eligibility for missing_handoff is now gated by
  // BOTH "not fired this run" AND "its session WAS evaluated this run"
  // (F15-F17). A gap whose session aged past the LIMIT window (never appears
  // in this run's fetchRecentlyEndedSessions result) must survive — it was
  // simply never re-evaluated, not proven resolved.

  it("a missing_handoff gap whose session aged out of the window SURVIVES reconciliation (not superseded)", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    // This run's ended-sessions set does NOT include "sess-aged-out" — it fell
    // outside RUNIR_CONTINUITY_GAP_MAX_SESSIONS_PER_PROJECT / the lookback window.
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "missing_handoff") {
        return [{ id: "gap_aged_out", dedupeKey: "missing_handoff:sess-aged-out", status: "active" }];
      }
      return [];
    });
    const db = makeStubDb({ endedSessions: [] }); // nothing evaluated this run
    const result = await runGapDetectionStep({ db, userId: "u1" });
    expect(store.setGapStatus).not.toHaveBeenCalledWith(expect.anything(), "gap_aged_out", "superseded");
    expect(result.superseded).toBe(0);
  });

  it("a missing_handoff gap for a session RE-EVALUATED this run that gained a handoff STILL supersedes", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "missing_handoff") {
        return [{ id: "gap_resolved", dedupeKey: "missing_handoff:sess-1", status: "active" }];
      }
      return [];
    });
    // sess-1 IS in this run's evaluated set (endedSessions) AND now has a handoff
    // (hasHandoff:true) → detector does not fire it → must be superseded (not
    // aged out; genuinely re-evaluated and resolved).
    const db = makeStubDb({
      endedSessions: [{ id: "sess-1" }],
      didWork: { "sess-1": true },
      hasHandoff: { "sess-1": true },
    });
    const result = await runGapDetectionStep({ db, userId: "u1" });
    expect(store.setGapStatus).toHaveBeenCalledWith(expect.anything(), "gap_resolved", "superseded");
    expect(result.superseded).toBeGreaterThanOrEqual(1);
  });

  it("colon-bearing session id: eligibility membership is on the WHOLE dedupeKey, never split on ':' (Codex MAJOR-2)", async () => {
    // Session ids are record-like and may contain colons (e.g. `runir_session:abc`).
    // The eligible-key set must be built from evaluated session ids joined as
    // `missing_handoff:${sessionId}` and membership-tested on the full string —
    // splitting the dedupeKey on ":" would truncate this id and break eligibility.
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const colonId = "runir_session:abc";
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "missing_handoff") {
        return [{ id: "gap_colon", dedupeKey: `missing_handoff:${colonId}`, status: "active" }];
      }
      return [];
    });
    // Evaluated this run, now has a handoff → the colon-bearing gap must supersede.
    const db = makeStubDb({
      endedSessions: [{ id: colonId }],
      didWork: { [colonId]: true },
      hasHandoff: { [colonId]: true },
    });
    await runGapDetectionStep({ db, userId: "u1" });
    expect(store.setGapStatus).toHaveBeenCalledWith(expect.anything(), "gap_colon", "superseded");
  });

  it("colon-bearing session id NOT evaluated this run SURVIVES (aged-out eligibility also whole-key)", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const colonId = "runir_session:xyz";
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "missing_handoff") {
        return [{ id: "gap_colon_aged", dedupeKey: `missing_handoff:${colonId}`, status: "active" }];
      }
      return [];
    });
    const db = makeStubDb({ endedSessions: [] }); // colonId not in this run's window
    await runGapDetectionStep({ db, userId: "u1" });
    expect(store.setGapStatus).not.toHaveBeenCalledWith(expect.anything(), "gap_colon_aged", "superseded");
  });

  it("rolling kinds (unfiled_intent/started_unfinished) are UNAFFECTED by the eligibility gate (no eligibleDedupeKeys passed)", async () => {
    // Confirms F16: eligibleDedupeKeys is undefined for rolling kinds, so their
    // reconciliation behaves identically to before Part B (all-active supersede
    // when the fired set doesn't cover them) — no window-aware gating applies.
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]); // empty lists this run
    store.getProjectContinuityState.mockResolvedValue(makeState());
    store.listActiveGapsForKind.mockImplementation(async (_db, _u, _w, _p, kind) => {
      if (kind === "unfiled_intent") return [{ id: "gap_rolling_stale", dedupeKey: "unfiled_intent:OLD", status: "active" }];
      return [];
    });
    await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    expect(store.setGapStatus).toHaveBeenCalledWith(expect.anything(), "gap_rolling_stale", "superseded");
  });

  it("upsertContinuityGap is called with reopenIfSuperseded for missing_handoff fires (reopen-on-refire, Codex MAJOR-1)", async () => {
    // The handoff signal is not monotonic: a gap superseded while a handoff
    // signal existed can become valid again when that signal disappears. The
    // detector must pass the reopen flag on every missing_handoff upsert so
    // the store can reopen a superseded row rather than leaving it sticky.
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const db = makeStubDb({
      endedSessions: [{ id: "sess-1" }],
      didWork: { "sess-1": true },
      hasHandoff: { "sess-1": false },
    });
    await runGapDetectionStep({ db, userId: "u1" });
    const call = store.upsertContinuityGap.mock.calls.find((c) => c[1]?.kind === "missing_handoff");
    expect(call).toBeTruthy();
    expect(call?.[2]).toEqual(expect.objectContaining({ reopenIfSuperseded: true }));
  });

  it("upsertContinuityGap for rolling kinds does NOT set reopenIfSuperseded (scoped to missing_handoff only)", async () => {
    store.listProjectEnrollments.mockResolvedValue([makeEnrollment()]);
    store.getProjectContinuityState.mockResolvedValue(makeState({ unfiledIntentions: ["ship X"] }));
    await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    const call = store.upsertContinuityGap.mock.calls.find((c) => c[1]?.kind === "unfiled_intent");
    expect(call).toBeTruthy();
    expect(call?.[2]?.reopenIfSuperseded).toBeFalsy();
  });
});

describe("runGapDetectionStep bounds", () => {
  it("honors the per-run project cap", async () => {
    process.env.RUNIR_CONTINUITY_GAP_MAX_PROJECTS_PER_RUN = "1";
    store.listProjectEnrollments.mockResolvedValue([
      makeEnrollment({ projectKey: "project:a" }),
      makeEnrollment({ projectKey: "project:b" }),
    ]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const result = await runGapDetectionStep({ db: makeStubDb(), userId: "u1" });
    expect(result.projectsConsidered).toBe(1);
  });
});
