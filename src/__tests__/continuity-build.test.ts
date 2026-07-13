// Builder-logic tests for the continuity builder (Rúnir-78sy.3).
//
// Pure binding-key derivation + builder orchestration with a hand-rolled stub
// SurrealClient (no real DB) and a mocked LLM gateway. Verifies: 0-new-semiotes
// = no LLM call + no CAS write, success advances the cursor, LLM failure parks
// the cursor + writes a carry-forward fallback, and the project cap is honored.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const llmMock = vi.fn<(opts: unknown) => Promise<string>>();
vi.mock("../shared/llm-gateway-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/llm-gateway-client.js")>();
  return { ...actual, callLlmGateway: (opts: unknown) => llmMock(opts) };
});

import {
  deriveContinuityBindingKeys,
  runContinuityBuildStep,
} from "../lifecycle/semion/continuity-build.js";
import { fingerprint, normalizeGitRemoteUrl } from "../identity/canonical-context.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

// ── Stub DB ──────────────────────────────────────────────────────────────────

type Enrollment = {
  id: string;
  user_id: string;
  workspace_id: string;
  project_key: string;
  project_id: string | null;
  default_namespace_id: string | null;
  repo_remote: string | null;
  repo_root_fingerprint: string | null;
  source: string;
  enrolled_at: string;
};

type Semiote = { id: string; session_id: string | null; payload: Record<string, unknown> };

interface StubState {
  enrollments: Enrollment[];
  semiotes: Semiote[];
  cursor: string | null;
  continuityRow: { version: number } | null;
  /** Optional warmed project_state row served to getProjectStateByProjectKey. */
  projectStateRow?: Record<string, unknown> | null;
}

interface StubLog {
  createdContinuity: number;
  cursorWrites: string[];
  /** CONTENT vars of the last project_continuity_state CREATE (F2 merge assertions). */
  lastCreateVars: Record<string, unknown> | null;
}

function makeStubDb(state: StubState, log: StubLog): SurrealClient {
  const query = async (sql: string, _vars?: Record<string, unknown>): Promise<any[]> => {
    if (sql.includes("FROM project_enrollment")) {
      return [state.enrollments];
    }
    if (sql.includes("SELECT built_through FROM continuity_build_state")) {
      return [state.cursor ? [{ built_through: state.cursor }] : []];
    }
    if (sql.includes("FROM runir_session")) {
      return [[]]; // no workspace-fingerprint sessions in these fixtures
    }
    if (sql.includes("FROM semiote")) {
      // Model the pushed-down cursor filter + ORDER BY createdAt ASC + LIMIT
      // (F1): the real SQL now filters/sorts/caps server-side, so the stub must
      // too or the "respects the build cursor" assertion is vacuous.
      const cursor = typeof _vars?.cursor === "string" ? _vars.cursor : null;
      const limit = typeof _vars?.limit === "number" ? _vars.limit : state.semiotes.length;
      const rows = state.semiotes
        .filter((s) => {
          const createdAt = (s.payload as { createdAt?: string }).createdAt ?? "";
          return cursor === null || createdAt > cursor;
        })
        .sort((a, b) => {
          const ca = (a.payload as { createdAt?: string }).createdAt ?? "";
          const cb = (b.payload as { createdAt?: string }).createdAt ?? "";
          return ca < cb ? -1 : ca > cb ? 1 : 0;
        })
        .slice(0, limit);
      return [rows];
    }
    if (sql.includes("FROM project_state")) {
      // getProjectStateByProjectKey (F2) — the fresh per-turn warmer row.
      return [state.projectStateRow ? [state.projectStateRow] : []];
    }
    if (sql.includes("SELECT * FROM project_continuity_state")) {
      return [[]]; // getProjectContinuityState — no prior continuity row
    }
    if (sql.includes("SELECT id, version FROM project_continuity_state")) {
      return [state.continuityRow ? [{ id: "project_continuity_state_x", version: state.continuityRow.version }] : []];
    }
    if (sql.includes("FROM noema")) {
      return [[]];
    }
    if (sql.includes("CREATE type::record('project_continuity_state'")) {
      log.createdContinuity++;
      log.lastCreateVars = _vars ?? null;
      state.continuityRow = { version: (state.continuityRow?.version ?? 0) + 1 };
      return [[{ id: "project_continuity_state_x", version: state.continuityRow.version }]];
    }
    if (sql.includes("UPSERT type::record('continuity_build_state'")) {
      const built = _vars?.builtThrough;
      if (typeof built === "string") log.cursorWrites.push(built);
      return [[]];
    }
    return [[]];
  };
  return { query } as unknown as SurrealClient;
}

function makeEnrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    id: "project_enrollment_a",
    user_id: "u1",
    workspace_id: "-",
    project_key: "project:runir",
    project_id: "runir",
    default_namespace_id: null,
    repo_remote: null,
    repo_root_fingerprint: null,
    source: "manual",
    enrolled_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSemiote(id: string, createdAt: string, l2 = `fact ${id}`): Semiote {
  return { id: `semiote:${id}`, session_id: "sess-1", payload: { userId: "u1", l2, createdAt } };
}

const VALID_SYNTHESIS = JSON.stringify({
  currentFocus: ["ship continuity builder"],
  nextSteps: ["wire step 4.5"],
  blockers: [],
});

beforeEach(() => {
  llmMock.mockReset();
  delete process.env.RUNIR_CONTINUITY_MAX_PROJECTS_PER_RUN;
  delete process.env.CONSOLIDATION_CONTINUITY_BUDGET_MS;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("deriveContinuityBindingKeys (Rúnir-78sy.3)", () => {
  it("derives all three candidates with projectId → project:<lowercased>", () => {
    const keys = deriveContinuityBindingKeys({
      projectId: "Runir-Core",
      repoRemote: "git@github.com:AlphaComposite/runir.git",
      repoRootFingerprint: "abc123",
    });
    expect(keys.projectIdKey).toBe("project:runir-core");
    expect(keys.gitRemoteKey).toBe(`git:${fingerprint(normalizeGitRemoteUrl("git@github.com:AlphaComposite/runir.git"))}`);
    expect(keys.repoRootFingerprint).toBe("abc123");
  });

  it("omits absent candidates", () => {
    expect(deriveContinuityBindingKeys({ projectId: "x" })).toEqual({ projectIdKey: "project:x" });
    expect(deriveContinuityBindingKeys({})).toEqual({});
  });

  it("candidate (1) git remote fingerprint is scheme/form invariant", () => {
    const scp = deriveContinuityBindingKeys({ repoRemote: "git@github.com:AlphaComposite/runir.git" });
    const https = deriveContinuityBindingKeys({ repoRemote: "https://github.com/AlphaComposite/runir.git" });
    expect(scp.gitRemoteKey).toBe(https.gitRemoteKey);
  });
});

describe("runContinuityBuildStep (Rúnir-78sy.3)", () => {
  it("skips the LLM AND the CAS write at 0 new semiotes", async () => {
    const state: StubState = { enrollments: [makeEnrollment()], semiotes: [], cursor: null, continuityRow: null };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockResolvedValue(VALID_SYNTHESIS);

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(llmMock).not.toHaveBeenCalled();
    expect(log.createdContinuity).toBe(0);
    expect(log.cursorWrites).toEqual([]);
    expect(result).toEqual({ built: 0, fallbacks: 0, projectsConsidered: 1 });
  });

  it("on success: ONE LLM call, CAS write, and cursor advances to the newest createdAt", async () => {
    const state: StubState = {
      enrollments: [makeEnrollment()],
      semiotes: [makeSemiote("a", "2026-07-02T00:00:00.000Z"), makeSemiote("b", "2026-07-03T00:00:00.000Z")],
      cursor: null,
      continuityRow: null,
    };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockResolvedValue(VALID_SYNTHESIS);

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(log.createdContinuity).toBe(1);
    expect(log.cursorWrites).toEqual(["2026-07-03T00:00:00.000Z"]);
    expect(result.built).toBe(1);
    expect(result.fallbacks).toBe(0);
  });

  it("respects the build cursor — only strictly-newer semiotes are evidence", async () => {
    const state: StubState = {
      enrollments: [makeEnrollment()],
      semiotes: [makeSemiote("old", "2026-07-01T00:00:00.000Z"), makeSemiote("new", "2026-07-05T00:00:00.000Z")],
      cursor: "2026-07-02T00:00:00.000Z",
      continuityRow: null,
    };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockResolvedValue(VALID_SYNTHESIS);

    await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    // Only the "new" (2026-07-05) row is past the cursor.
    expect(log.cursorWrites).toEqual(["2026-07-05T00:00:00.000Z"]);
  });

  it("on LLM failure: writes a fallback row via CAS but PARKS the cursor", async () => {
    const state: StubState = {
      enrollments: [makeEnrollment()],
      semiotes: [makeSemiote("a", "2026-07-02T00:00:00.000Z")],
      cursor: null,
      continuityRow: null,
    };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockRejectedValue(new Error("gateway down"));

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(log.createdContinuity).toBe(1); // fallback row written
    expect(log.cursorWrites).toEqual([]); // cursor PARKED
    expect(result.built).toBe(0);
    expect(result.fallbacks).toBe(1);
  });

  it("F1: full-cap batch with a straddling tie parks the cursor below the boundary", async () => {
    // 39 distinct older rows + 2 rows sharing the newest createdAt = 41 total,
    // but the fetch cap is 40. The oldest 40 come back (39 distinct + ONE of the
    // tied pair), so the tied cohort straddles the LIMIT: the cursor may only
    // advance to the largest createdAt STRICTLY below the tail (the 39th row),
    // never onto the tied timestamp whose partner was not fetched.
    const semiotes: Semiote[] = [];
    for (let i = 0; i < 39; i++) {
      const day = String(i + 1).padStart(2, "0");
      semiotes.push(makeSemiote(`d${i}`, `2026-05-${day}T00:00:00.000Z`));
    }
    const tie = "2026-07-09T00:00:00.000Z";
    semiotes.push(makeSemiote("tieA", tie));
    semiotes.push(makeSemiote("tieB", tie));
    const state: StubState = { enrollments: [makeEnrollment()], semiotes, cursor: null, continuityRow: null };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockResolvedValue(VALID_SYNTHESIS);

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(result.built).toBe(1);
    // 40th row IS the tie (only one partner fetched); advance stops at the 39th
    // row's createdAt (2026-05-39 → clamped: the last distinct day is index 38).
    expect(log.cursorWrites).toEqual(["2026-05-39T00:00:00.000Z"]);
  });

  it("F1: whole-batch same-createdAt cohort at the cap does NOT advance the cursor", async () => {
    // 40 rows all sharing one createdAt == the cap: no strictly-smaller value
    // exists, so the pathological cohort parks (idempotent CAS re-processes it).
    const shared = "2026-07-09T00:00:00.000Z";
    const semiotes: Semiote[] = [];
    for (let i = 0; i < 40; i++) semiotes.push(makeSemiote(`same${i}`, shared));
    const state: StubState = { enrollments: [makeEnrollment()], semiotes, cursor: null, continuityRow: null };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockResolvedValue(VALID_SYNTHESIS);

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(result.built).toBe(1); // row still written
    expect(log.cursorWrites).toEqual([]); // cursor PARKED (no strictly-smaller value)
  });

  it("F2: LLM-failure fallback merges the warmed project_state (not all-empty on first run)", async () => {
    const state: StubState = {
      enrollments: [makeEnrollment()],
      semiotes: [makeSemiote("a", "2026-07-02T00:00:00.000Z")],
      cursor: null,
      continuityRow: null, // first run — no prior continuity row
      projectStateRow: {
        id: "project_state:x",
        user_id: "u1",
        project_key: "project:runir",
        current_focus: "warmed focus",
        latest_progress: "warmed progress",
        next_steps: ["warmed next"],
        blockers: ["warmed blocker"],
        active_ticket_ids: [],
        supporting_memory_ids: [],
        confidence: 0.7,
        version: 1,
        updated_at: "2026-07-02T00:00:00.000Z",
      },
    };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockRejectedValue(new Error("gateway down"));

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(result.fallbacks).toBe(1);
    expect(log.cursorWrites).toEqual([]); // cursor PARKED on failure
    // The fallback row is NOT all-empty: the warmed scalars wrap into arrays and
    // the warmed arrays carry through.
    expect(log.lastCreateVars?.currentFocus).toEqual(["warmed focus"]);
    expect(log.lastCreateVars?.latestProgress).toEqual(["warmed progress"]);
    expect(log.lastCreateVars?.nextSteps).toEqual(["warmed next"]);
    expect(log.lastCreateVars?.blockers).toEqual(["warmed blocker"]);
  });

  it("Rúnir-78sy.8 C2: a create failure with no existing row surfaces as a build error, not cas_lost, and the cursor does NOT advance", async () => {
    const state: StubState = {
      enrollments: [makeEnrollment()],
      semiotes: [makeSemiote("a", "2026-07-02T00:00:00.000Z")],
      cursor: null,
      continuityRow: null,
    };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };
    llmMock.mockResolvedValue(VALID_SYNTHESIS);

    const baseDb = makeStubDb(state, log);
    // Force the CREATE to reject, and the discriminating re-read (SELECT id,
    // version FROM project_continuity_state) to find NO row — the non-race
    // failure path (schema rejection / connection loss), per brief C2.
    const throwingDb: SurrealClient = {
      query: (sql: string, vars?: Record<string, unknown>) => {
        if (sql.includes("CREATE type::record('project_continuity_state'")) {
          return Promise.reject(new Error("simulated non-race create failure"));
        }
        return (baseDb.query as (sql: string, vars?: Record<string, unknown>) => Promise<any[]>)(sql, vars);
      },
    } as unknown as SurrealClient;

    const logLines: string[] = [];
    const result = await runContinuityBuildStep({
      db: throwingDb,
      userId: "u1",
      apiKey: "k",
      logger: (msg) => logLines.push(msg),
    });

    // A build-error log line fired (the continuity-build.ts per-project catch).
    expect(logLines.some((l) => l.includes("continuity build error") && l.includes("simulated non-race create failure"))).toBe(
      true,
    );
    // NOT reported as cas_lost/version_mismatch: neither built nor fallback counted.
    expect(result.built).toBe(0);
    expect(result.fallbacks).toBe(0);
    // Cursor did not advance.
    expect(log.cursorWrites).toEqual([]);
  });

  it("honors RUNIR_CONTINUITY_MAX_PROJECTS_PER_RUN", async () => {
    process.env.RUNIR_CONTINUITY_MAX_PROJECTS_PER_RUN = "2";
    const state: StubState = {
      enrollments: [
        makeEnrollment({ id: "e1", project_key: "project:one", project_id: "one" }),
        makeEnrollment({ id: "e2", project_key: "project:two", project_id: "two" }),
        makeEnrollment({ id: "e3", project_key: "project:three", project_id: "three" }),
      ],
      semiotes: [], // no evidence — every project is a quick skip
      cursor: null,
      continuityRow: null,
    };
    const log: StubLog = { createdContinuity: 0, cursorWrites: [], lastCreateVars: null };

    const result = await runContinuityBuildStep({ db: makeStubDb(state, log), userId: "u1", apiKey: "k" });

    expect(result.projectsConsidered).toBe(2); // capped at 2 of 3
  });
});
