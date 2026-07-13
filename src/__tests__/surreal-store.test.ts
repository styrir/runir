
import { describe, expect, it, vi } from "vitest";
import { compareAndSwapProjectState, getProjectState, getProjectStateForCaptureContext, listNearbyExistingForCaptureContext, listRecentFactsForCaptureContext, updateMemoryText, upsertMemory, upsertProjectState } from "../storage/surreal/surreal-store.js";

describe("upsertMemory continuity datetime casting", () => {
  it("casts valid_at and invalid_at to datetime when metadata uses ISO strings", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;

    await upsertMemory(
      db,
      "mem-1",
      "Current status: working on session opener continuity.",
      "user-1",
      [0, 1, 2],
      {
        path: "/Users/brooks/Code/runir",
        memoryRole: "current_status",
        validAt: "2026-04-01T20:00:00.000Z",
        invalidAt: "2026-04-01T21:00:00.000Z",
        confidence: 0.9,
      },
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, vars] = db.query.mock.calls[0];
    expect(sql).toContain("valid_at: IF $validAt != NONE THEN <datetime>$validAt ELSE NONE END");
    expect(sql).toContain("invalid_at: IF $invalidAt != NONE THEN <datetime>$invalidAt ELSE NONE END");
    expect(vars.validAt).toBe("2026-04-01T20:00:00.000Z");
    expect(vars.invalidAt).toBe("2026-04-01T21:00:00.000Z");
  });
});

describe("getProjectState", () => {
  it("hydrates typed directives while preserving legacy blockers and next_steps", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce([[{
        id: "project_state:project-key",
        user_id: "user-1",
        project_key: "project:runir",
        path: "/Users/brooks/Code/runir",
        current_focus: "storage directive persistence",
        active_ticket_ids: [],
        latest_progress: "project_state stores typed continuity directives",
        blockers: ["waiting on CI"],
        next_steps: ["finish storage tests"],
        directives: [
          {
            kind: "verification",
            polarity: "verify",
            status: "open",
            text: "CI is green",
            source: "explicit",
            confidence: 0.9,
            evidence: "verify CI",
          },
          { kind: "invalid", text: "" },
        ],
        updated_at: "2026-05-11T08:00:00.000Z",
        source_session_id: "sess-1",
        supporting_memory_ids: ["m-1"],
        confidence: 0.95,
        version: 3,
      }]]),
    } as any;

    const result = await getProjectState(db, "user-1", "/Users/brooks/Code/runir", "project:runir");

    expect(result).toEqual(expect.objectContaining({
      blockers: ["waiting on CI"],
      nextSteps: ["finish storage tests"],
      directives: [
        expect.objectContaining({
          kind: "verification",
          polarity: "verify",
          status: "open",
          text: "CI is green",
        }),
      ],
    }));
  });

  it("prefers canonical project_key lookups before legacy path fallbacks", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{
          id: "project_state:project-key",
          user_id: "user-1",
          project_key: "project:runir",
          path: "/Users/brooks/Code/runir",
          current_focus: "canonical project lookup",
          active_ticket_ids: ["MIM-201"],
          latest_progress: "project_state now resolves by project_key first",
          blockers: [],
          next_steps: ["verify fallback behavior"],
          updated_at: "2026-04-15T20:00:00.000Z",
          source_session_id: "sess-1",
          supporting_memory_ids: ["m-1"],
          confidence: 0.95,
        }]]),
    } as any;

    const result = await getProjectState(db, "user-1", "/Users/brooks/Code/runir", "project:runir");

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain("WHERE user_id = $userId AND project_key = $projectKey");
    expect(result).toEqual(expect.objectContaining({
      userId: "user-1",
      projectKey: "project:runir",
      currentFocus: "canonical project lookup",
    }));
  });

  it("checks the pathless singleton first, then falls back to latest-by-user without a computed ORDER BY", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{
          id: "project_state:user-1:*",
          user_id: "user-1",
          path: "/Users/brooks/Code/runir",
          current_focus: "continuity-first recall",
          active_ticket_ids: ["MIM-201"],
          latest_progress: "session opener simulation in progress",
          blockers: [],
          next_steps: ["review raw prependContext artifact"],
          updated_at: "2026-04-02T12:00:00.000Z",
          source_session_id: "sim-1",
          supporting_memory_ids: ["m-1"],
          confidence: 0.9,
        }]]),
    } as any;

    const result = await getProjectState(db, "user-1");

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0]).toContain("WHERE id = type::record('project_state', $singletonId)");
    expect(db.query.mock.calls[0][0]).not.toContain("ORDER BY (");
    expect(db.query.mock.calls[1][0]).toContain("WHERE user_id = $userId");
    expect(result).toEqual(expect.objectContaining({
      userId: "user-1",
      currentFocus: "continuity-first recall",
      latestProgress: "session opener simulation in progress",
    }));
  });
});

describe("upsertProjectState", () => {
  it("reuses a legacy path row when adding canonical project_key migration data", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: "project_state:legacy_path_only" }]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const result = await upsertProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/Users/brooks/Code/runir",
      currentFocus: "canonical project lookup",
      activeTicketIds: ["MIM-201"],
      latestProgress: "project_state now resolves by project_key first",
      blockers: [],
      nextSteps: ["verify fallback behavior"],
      updatedAt: "2026-04-15T20:00:00.000Z",
      sourceSessionId: "sess-1",
      supportingMemoryIds: ["m-1"],
      confidence: 0.95,
      version: 2,
      previousProjectStateId: "project_state:prev",
    });

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[0][0]).toContain("WHERE user_id = $userId AND project_key = $projectKey");
    expect(db.query.mock.calls[1][0]).toContain("WHERE user_id = $userId AND path = $path");
    expect(db.query.mock.calls[2][1].recordId).toBe("legacy_path_only");
    expect(db.query.mock.calls[2][1].projectKey).toBe("project:runir");
    expect(db.query.mock.calls[2][1].version).toBe(2);
    expect(db.query.mock.calls[2][1].previousProjectStateId).toBe("project_state:prev");
    expect(result).toEqual(expect.objectContaining({
      id: "legacy_path_only",
      projectKey: "project:runir",
      version: 2,
      previousProjectStateId: "project_state:prev",
    }));
  });

  it("defaults a new project_state version to 1 when absent", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const result = await upsertProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: [],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: [],
      confidence: 0.7,
      updatedAt: "2026-04-20T08:00:00.000Z",
    });

    expect(db.query.mock.calls[2][1].version).toBe(1);
    expect(result.version).toBe(1);
  });

  it("persists normalized typed directives without changing legacy blockers or next_steps", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const result = await upsertProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: [],
      blockers: ["blocked on staging"],
      nextSteps: ["finish rollout"],
      directives: [
        {
          kind: "dependency",
          polarity: "wait_for",
          status: "blocked",
          text: "Staging rollout lands",
          target: "staging rollout",
          source: "explicit",
          confidence: 0.91,
          evidence: "blocked until staging rollout lands",
        },
        { kind: "invalid" as any, text: "" } as any,
      ],
      supportingMemoryIds: [],
      confidence: 0.7,
      updatedAt: "2026-05-11T08:00:00.000Z",
    });

    expect(db.query.mock.calls[2][1]).toEqual(expect.objectContaining({
      blockers: ["blocked on staging"],
      nextSteps: ["finish rollout"],
      directives: [
        expect.objectContaining({
          kind: "dependency",
          polarity: "wait_for",
          status: "blocked",
          text: "Staging rollout lands",
        }),
      ],
    }));
    expect(result).toEqual(expect.objectContaining({
      blockers: ["blocked on staging"],
      nextSteps: ["finish rollout"],
      directives: [
        expect.objectContaining({
          kind: "dependency",
          text: "Staging rollout lands",
        }),
      ],
    }));
  });
});

describe("compareAndSwapProjectState", () => {
  it("creates version 1 project_state when no current row exists and expected version is 0", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{
          id: "project_state:new",
          version: 1,
        }]]),
    } as any;

    const result = await compareAndSwapProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: [],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: ["m-1"],
      confidence: 0.9,
      updatedAt: "2026-04-20T08:00:00.000Z",
      expectedVersion: 0,
    });

    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("CREATE type::record('project_state', $recordId) CONTENT"),
      expect.objectContaining({
        version: 1,
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      version: 1,
    }));
  });

  it("increments version and writes lineage only when the expected version matches", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{
          id: "project_state:current",
          version: 3,
        }]])
        .mockResolvedValueOnce([[{
          id: "project_state:current",
          version: 4,
        }]]),
    } as any;

    const result = await compareAndSwapProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: ["MIM-201"],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: ["m-1"],
      confidence: 0.9,
      updatedAt: "2026-04-20T08:00:00.000Z",
      expectedVersion: 3,
      sourceSessionId: "sess-1",
    });

    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("AND (version = $expectedVersion OR (version = NONE AND $expectedVersion = 1))"),
      expect.objectContaining({
        recordId: "current",
        expectedVersion: 3,
        version: 4,
        previousProjectStateId: "current",
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      id: "current",
      version: 4,
      previousProjectStateId: "current",
    }));
  });

  it("treats legacy project_state rows without version as version 1 during CAS", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{
          id: "project_state:legacy",
        }]])
        .mockResolvedValueOnce([[{
          id: "project_state:legacy",
          version: 2,
        }]]),
    } as any;

    const result = await compareAndSwapProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: [],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: ["m-1"],
      confidence: 0.9,
      updatedAt: "2026-04-20T08:00:00.000Z",
      expectedVersion: 1,
    });

    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("(version = $expectedVersion OR (version = NONE AND $expectedVersion = 1))"),
      expect.objectContaining({
        recordId: "legacy",
        expectedVersion: 1,
        version: 2,
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      id: "legacy",
      version: 2,
    }));
  });

  it("reports version mismatch when the conditional update affects no rows", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{
          id: "project_state:current",
          version: 3,
        }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{
          id: "project_state:current",
          version: 4,
        }]]),
    } as any;

    const result = await compareAndSwapProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: [],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: ["m-1"],
      confidence: 0.9,
      updatedAt: "2026-04-20T08:00:00.000Z",
      expectedVersion: 3,
    });

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: false,
      reason: "version_mismatch",
      currentVersion: 4,
      recordId: "current",
    });
  });

  it("returns a version mismatch without mutating when the expected version is stale", async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[{
          id: "project_state:current",
          version: 4,
        }]]),
    } as any;

    const result = await compareAndSwapProjectState(db, {
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      activeTicketIds: [],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: [],
      confidence: 0.7,
      updatedAt: "2026-04-20T08:00:00.000Z",
      expectedVersion: 3,
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      reason: "version_mismatch",
      currentVersion: 4,
      recordId: "current",
    });
  });
});

// Shared mock factory for the CREATE-failure discrimination trio (Rúnir-sfzl,
// porting 78sy.8 C2's continuity-state-store.test.ts template): the FIRST
// `SELECT id, version FROM project_state` call always misses (forcing the
// CREATE branch), the CREATE always rejects with `createError`, and the
// SECOND `SELECT id, version FROM project_state` call (the discriminating
// re-read) varies per test via `reReadOutcome`: a raced row ("hit"), no row
// ("miss"), or a thrown re-read failure ("throws").
function makeProjectStateCreateFailureDb(
  createError: Error,
  reReadOutcome: "hit" | "miss" | "throws",
  reReadError?: Error,
): { db: any; preReadCalls: () => number } {
  let preReadCalls = 0;
  const db = {
    query: vi.fn((sql: string) => {
      if (sql.includes("SELECT id, version") && sql.includes("FROM project_state")) {
        preReadCalls++;
        if (preReadCalls === 1) return Promise.resolve([[]]); // pre-read miss → CREATE branch
        // Discriminating re-read (2nd+ call):
        if (reReadOutcome === "hit") return Promise.resolve([[{ id: "project_state:x", version: 3 }]]);
        if (reReadOutcome === "throws") return Promise.reject(reReadError ?? new Error("re-read failed"));
        return Promise.resolve([[]]); // "miss"
      }
      if (sql.includes("CREATE type::record('project_state'")) {
        return Promise.reject(createError);
      }
      return Promise.resolve([[]]);
    }),
  };
  return { db, preReadCalls: () => preReadCalls };
}

describe("compareAndSwapProjectState CREATE-failure discrimination (Rúnir-sfzl)", () => {
  function baseCasWrite(overrides: Partial<Parameters<typeof compareAndSwapProjectState>[1]> = {}) {
    return {
      userId: "user-1",
      projectKey: "project:runir",
      // path intentionally omitted: findExistingProjectStateVersionedRow
      // falls through to a second `path`-keyed query when projectKey misses
      // AND path is set, which would double the call count per re-read and
      // break the mock factory's 1st-call/2nd-call discrimination below.
      activeTicketIds: [],
      blockers: [],
      nextSteps: [],
      supportingMemoryIds: [],
      confidence: 0.9,
      updatedAt: "2026-04-20T08:00:00.000Z",
      expectedVersion: 0,
      ...overrides,
    };
  }

  it("CREATE rejection WITH an existing row on re-read → version_mismatch preserved (genuine race)", async () => {
    const { db } = makeProjectStateCreateFailureDb(new Error("duplicate id"), "hit");

    const result = await compareAndSwapProjectState(db, baseCasWrite());
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: "version_mismatch",
      currentVersion: 3,
    }));
  });

  it("CREATE rejection with NO existing row on re-read → the original error is thrown (not version_mismatch)", async () => {
    const { db, preReadCalls } = makeProjectStateCreateFailureDb(new Error("simulated schema rejection"), "miss");

    await expect(compareAndSwapProjectState(db, baseCasWrite())).rejects.toThrow("simulated schema rejection");
    expect(preReadCalls()).toBeGreaterThanOrEqual(2); // pre-read + discriminating re-read
  });

  it("CREATE rejection + the discriminating re-read ALSO throws → original error surfaces (no synthesized version 0)", async () => {
    const { db } = makeProjectStateCreateFailureDb(
      new Error("simulated create failure"),
      "throws",
      new Error("re-read connection lost"),
    );

    await expect(compareAndSwapProjectState(db, baseCasWrite())).rejects.toThrow("simulated create failure");
  });
});

describe("updateMemoryText", () => {
  it("passes undefined, not null, for absent continuity datetime metadata", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;

    await updateMemoryText(
      db,
      "mem-1",
      "updated text",
      [0, 1, 2],
      "session_summary",
      "retain",
    );

    const [, vars] = db.query.mock.calls[0];
    expect(vars.validAt).toBeUndefined();
    expect(vars.memoryRole).toBeUndefined();
    expect(vars.continuitySubjectKey).toBeUndefined();
  });
});

describe("capture-context loaders", () => {
  it("fails closed for agent-scoped identities because semiote rows do not carry an agent discriminator", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;

    const recent = await listRecentFactsForCaptureContext(db, "user-1", {
      userId: "user-1",
      contextScopeKind: "agent",
      raw: {},
      derivation: {
        contextScopeKind: { value: "agent", source: "default" },
        agentId: { source: "absent" },
        resolvedTaskId: { source: "absent" },
        projectKey: { source: "absent" },
      },
    } as any);

    const nearby = await listNearbyExistingForCaptureContext(db, "user-1", {
      userId: "user-1",
      contextScopeKind: "agent",
      raw: {},
      derivation: {
        contextScopeKind: { value: "agent", source: "default" },
        agentId: { source: "absent" },
        resolvedTaskId: { source: "absent" },
        projectKey: { source: "absent" },
      },
    } as any);

    expect(recent).toEqual([]);
    expect(nearby).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fails closed for project-scoped identities without a path discriminator", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;

    const recent = await listRecentFactsForCaptureContext(db, "user-1", {
      userId: "user-1",
      contextScopeKind: "project",
      projectKey: "project:runir",
      raw: { projectId: "runir" },
      derivation: {
        contextScopeKind: { value: "project", source: "projectId" },
        agentId: { source: "absent" },
        resolvedTaskId: { source: "absent" },
        projectKey: { value: "project:runir", source: "projectId" },
      },
    } as any);

    expect(recent).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("state-anchor lookup fails closed for agent scope without falling back to latest-by-user", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;

    const result = await getProjectStateForCaptureContext(db, "user-1", {
      userId: "user-1",
      contextScopeKind: "agent",
      raw: {},
      derivation: {
        contextScopeKind: { value: "agent", source: "default" },
        agentId: { source: "absent" },
        resolvedTaskId: { source: "absent" },
        projectKey: { source: "absent" },
      },
    } as any);

    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("state-anchor lookup uses exact project_key match without latest-by-user fallback", async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce([[{
        id: "project_state:project-key",
        user_id: "user-1",
        project_key: "project:runir",
        path: "/Users/brooks/Code/runir",
        current_focus: "strict capture-state anchor",
        active_ticket_ids: ["MIM-201"],
        latest_progress: "project_state exact lookup only",
        blockers: [],
        next_steps: [],
        updated_at: "2026-04-15T20:00:00.000Z",
        source_session_id: "sess-1",
        supporting_memory_ids: ["m-1"],
        confidence: 0.95,
      }]]),
    } as any;

    const result = await getProjectStateForCaptureContext(db, "user-1", {
      userId: "user-1",
      contextScopeKind: "project",
      projectKey: "project:runir",
      raw: { projectId: "runir" },
      derivation: {
        contextScopeKind: { value: "project", source: "projectId" },
        agentId: { source: "absent" },
        resolvedTaskId: { source: "absent" },
        projectKey: { value: "project:runir", source: "projectId" },
      },
    } as any);

    expect(result).toEqual(expect.objectContaining({
      userId: "user-1",
      projectKey: "project:runir",
      currentFocus: "strict capture-state anchor",
    }));
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain("WHERE user_id = $userId AND project_key = $projectKey");
  });
});
