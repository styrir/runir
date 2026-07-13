// Store-level unit tests for continuity-state-store.ts (Rúnir-78sy.8), mocked
// SurrealClient (no real DB — see continuity-state-store-repro.test.ts for the
// live-DB CAS/schema coverage). Covers:
//   - CAS CREATE-failure discrimination (C2): a real race (row exists on
//     re-read) still reports version_mismatch; a non-race failure (no row on
//     re-read) rethrows the original create error; a re-read failure ALSO
//     rethrows the original create error (never a synthesized version 0).
//   - The source_evidence_refs mapper (C1), exercised indirectly through
//     getProjectContinuityState's row mapping (mapContinuityStateRow /
//     parseSourceEvidenceRefs are private, matching the continuity-gap-store.ts
//     mapGapRow/parseEvidence convention of no direct export for tests).

import { describe, expect, it } from "vitest";
import {
  compareAndSwapProjectContinuityState,
  getProjectContinuityState,
} from "../storage/surreal/continuity-state-store.js";
import type { ProjectContinuityStateWrite } from "../domain/memory/continuity.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

function baseWrite(overrides: Partial<ProjectContinuityStateWrite> = {}): ProjectContinuityStateWrite {
  return {
    userId: "u1",
    workspaceId: "-",
    projectKey: "project:runir",
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
    sourceEvidenceRefs: [],
    confidence: 0.7,
    sourceSessionIds: [],
    supportingSemioteIds: [],
    ...overrides,
  };
}

/**
 * Shared mock factory for the C2 CREATE-failure discrimination trio (Rúnir-78sy.8
 * simplify S3): the FIRST `SELECT id, version` call always misses (forcing the
 * CREATE branch), the CREATE always rejects with `createError`, and the SECOND
 * `SELECT id, version` call (the discriminating re-read) varies per test via
 * `reReadOutcome`: a raced row ("hit"), no row ("miss"), or a thrown re-read
 * failure ("throws"). Tracks and exposes `preReadCalls` for the assertion that
 * both the pre-read and the discriminating re-read actually ran.
 */
function makeCreateFailureDb(
  createError: Error,
  reReadOutcome: "hit" | "miss" | "throws",
  reReadError?: Error,
): { db: SurrealClient; preReadCalls: () => number } {
  let preReadCalls = 0;
  const db = {
    query: (sql: string) => {
      if (sql.includes("SELECT id, version FROM project_continuity_state")) {
        preReadCalls++;
        if (preReadCalls === 1) return Promise.resolve([[]]); // pre-read miss → CREATE branch
        // Discriminating re-read (2nd+ call):
        if (reReadOutcome === "hit") return Promise.resolve([[{ id: "project_continuity_state_x", version: 3 }]]);
        if (reReadOutcome === "throws") return Promise.reject(reReadError ?? new Error("re-read failed"));
        return Promise.resolve([[]]); // "miss"
      }
      if (sql.includes("CREATE type::record('project_continuity_state'")) {
        return Promise.reject(createError);
      }
      return Promise.resolve([[]]);
    },
  } as unknown as SurrealClient;
  return { db, preReadCalls: () => preReadCalls };
}

describe("compareAndSwapProjectContinuityState CREATE-failure discrimination (Rúnir-78sy.8 C2)", () => {
  it("CREATE rejection WITH an existing row on re-read → version_mismatch preserved (genuine race)", async () => {
    const { db } = makeCreateFailureDb(new Error("duplicate id"), "hit");

    const result = await compareAndSwapProjectContinuityState(db, { ...baseWrite(), expectedVersion: 0 });
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("version_mismatch");
      expect(result.currentVersion).toBe(3);
    }
  });

  it("CREATE rejection with NO existing row on re-read → the original error is thrown (not version_mismatch)", async () => {
    const { db, preReadCalls } = makeCreateFailureDb(new Error("simulated schema rejection"), "miss");

    await expect(compareAndSwapProjectContinuityState(db, { ...baseWrite(), expectedVersion: 0 })).rejects.toThrow(
      "simulated schema rejection",
    );
    expect(preReadCalls()).toBeGreaterThanOrEqual(2); // pre-read + discriminating re-read
  });

  it("CREATE rejection + the discriminating re-read ALSO throws → original error surfaces (no synthesized version 0)", async () => {
    const { db } = makeCreateFailureDb(new Error("simulated create failure"), "throws", new Error("re-read connection lost"));

    await expect(compareAndSwapProjectContinuityState(db, { ...baseWrite(), expectedVersion: 0 })).rejects.toThrow(
      "simulated create failure",
    );
  });
});

describe("getProjectContinuityState source_evidence_refs mapping (Rúnir-78sy.8 C1)", () => {
  function dbReturning(sourceEvidenceRefs: unknown): SurrealClient {
    return {
      query: () =>
        Promise.resolve([
          [
            {
              id: "project_continuity_state_x",
              user_id: "u1",
              workspace_id: "-",
              project_key: "project:runir",
              project_id: null,
              default_namespace_id: null,
              current_focus: [],
              latest_progress: [],
              next_steps: [],
              blockers: [],
              open_loops: [],
              unfiled_intentions: [],
              pending_verification: [],
              recently_changed_artifacts: [],
              likely_stale_beads: [],
              active_agent_runs: [],
              source_evidence_refs: sourceEvidenceRefs,
              confidence: 0.7,
              source_session_ids: [],
              supporting_semiote_ids: [],
              version: 1,
              valid_at: "2026-07-04T00:00:00.000Z",
              updated_at: "2026-07-04T00:00:00.000Z",
            },
          ],
        ]),
    } as unknown as SurrealClient;
  }

  it("parses a valid JSON string into the refs array", async () => {
    const refs = [{ kind: "semiote", id: "semiote:a", at: "2026-07-01T00:00:00.000Z" }];
    const read = await getProjectContinuityState(dbReturning(JSON.stringify(refs)), "u1", "-", "project:runir");
    expect(read?.sourceEvidenceRefs).toEqual(refs);
  });

  it("a malformed JSON string falls back to []", async () => {
    const read = await getProjectContinuityState(dbReturning("{not json"), "u1", "-", "project:runir");
    expect(read?.sourceEvidenceRefs).toEqual([]);
  });

  it("a legacy array value (pre-retype rows) passes through as-is", async () => {
    const refs = [{ kind: "semiote", id: "semiote:legacy", at: "2026-07-01T00:00:00.000Z" }];
    const read = await getProjectContinuityState(dbReturning(refs), "u1", "-", "project:runir");
    expect(read?.sourceEvidenceRefs).toEqual(refs);
  });

  it("null falls back to []", async () => {
    const read = await getProjectContinuityState(dbReturning(null), "u1", "-", "project:runir");
    expect(read?.sourceEvidenceRefs).toEqual([]);
  });
});
