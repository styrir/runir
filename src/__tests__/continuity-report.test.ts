// Daily continuity report tests (Rúnir-78sy.5).
//
// Redaction-before-disk on ALL fields (§9.2 / Codex F5), content-hash no-op skip
// + churn-immunity (§R.1 / Codex F4), multi-workspace attribution, the §11.2
// "not yet evaluated" AC, the HTML lane, and the path-safety/elide helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = vi.hoisted(() => ({
  listProjectEnrollments: vi.fn(),
  getProjectContinuityState: vi.fn(),
  getContinuityGaps: vi.fn(),
  readGapEvaluatedThrough: vi.fn(),
  readContinuityReportState: vi.fn(),
  markGapReported: vi.fn(),
  writeContinuityReportState: vi.fn(),
}));

vi.mock("../storage/surreal/continuity-state-store.js", () => ({
  getProjectContinuityState: store.getProjectContinuityState,
  listProjectEnrollments: store.listProjectEnrollments,
}));

vi.mock("../storage/surreal/continuity-gap-store.js", () => ({
  getContinuityGaps: store.getContinuityGaps,
  readGapEvaluatedThrough: store.readGapEvaluatedThrough,
  markGapReported: store.markGapReported,
  readContinuityReportState: store.readContinuityReportState,
  writeContinuityReportState: store.writeContinuityReportState,
}));

import { elidePaths, runContinuityReport, sanitizeForDisk } from "../lifecycle/archive/continuity-report.js";
import { assertWithinRoot, PathEscapeError } from "../lifecycle/archive/path-safety.js";
import type { ContinuityGapRecord, ProjectContinuityStateRecord } from "../domain/memory/continuity.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

const DB = { query: vi.fn() } as unknown as SurrealClient;

function makeState(over: Partial<ProjectContinuityStateRecord> = {}): ProjectContinuityStateRecord {
  return {
    id: "pcs",
    userId: "u1",
    workspaceId: "-",
    projectKey: "project:runir",
    currentFocus: ["ship the report"],
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
    version: 1,
    validAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...over,
  };
}

function makeGap(over: Partial<ContinuityGapRecord> = {}): ContinuityGapRecord {
  return {
    id: "gap1",
    userId: "u1",
    workspaceId: "-",
    projectKey: "project:runir",
    kind: "unfiled_intent",
    title: "Unfiled intentions",
    summary: "some work",
    recommendation: "file it",
    relatedWorkItems: [],
    evidence: [],
    score: 0.2,
    confidence: "weak",
    status: "active",
    dedupeKey: "unfiled_intent:abc",
    firstSeenAt: "2026-07-03T00:00:00.000Z",
    lastSeenAt: "2026-07-03T00:00:00.000Z",
    ...over,
  };
}

let dir: string;

beforeEach(async () => {
  for (const fn of Object.values(store)) fn.mockReset();
  store.readGapEvaluatedThrough.mockResolvedValue("2026-07-03T00:00:00.000Z");
  store.readContinuityReportState.mockResolvedValue(null);
  store.getContinuityGaps.mockResolvedValue([]);
  store.markGapReported.mockResolvedValue(undefined);
  store.writeContinuityReportState.mockResolvedValue(undefined);
  dir = await mkdtemp(join(tmpdir(), "continuity-report-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function readAll(date: string): Promise<{ md: string; json: string; html: string }> {
  const [md, json, html] = await Promise.all([
    readFile(join(dir, `${date}-continuity-report.md`), "utf-8"),
    readFile(join(dir, `${date}-continuity-report.json`), "utf-8"),
    readFile(join(dir, `${date}-continuity-report.html`), "utf-8"),
  ]);
  return { md, json, html };
}

describe("path-safety + redaction helpers", () => {
  it("assertWithinRoot rejects traversal, root-itself, and absolute segments", () => {
    expect(() => assertWithinRoot("/root", "../evil")).toThrow(PathEscapeError);
    expect(() => assertWithinRoot("/root", "sub/../../evil")).toThrow(PathEscapeError);
    expect(() => assertWithinRoot("/root", "")).toThrow(PathEscapeError);
    // An absolute segment is bad DB-/date-controlled input — rejected, not contained (Codex F5).
    expect(() => assertWithinRoot("/root", "/etc/passwd")).toThrow(PathEscapeError);
    expect(assertWithinRoot("/root", "a/b.md")).toBe("/root/a/b.md");
  });

  it("elidePaths reduces a user path to its basename, incl. paths with spaces (parent never leaks)", () => {
    expect(elidePaths("see /Users/brooks/Code/runir/secret.ts here")).toBe("see secret.ts here");
    const withSpaces = elidePaths("open /Users/brooks/Private Project/secret.txt");
    expect(withSpaces).not.toContain("Private Project");
    expect(withSpaces).toContain("secret.txt");
  });

  it("sanitizeForDisk scrubs secrets and elides paths", () => {
    const out = sanitizeForDisk("token Bearer sk-abc123DEADBEEFdeadbeef01 at /Users/x/y.ts");
    expect(out).not.toContain("sk-abc123DEADBEEFdeadbeef01");
    expect(out).toContain("y.ts");
    expect(out).not.toContain("/Users/x/");
  });
});

describe("runContinuityReport — redaction-before-disk (all fields)", () => {
  it("keeps secret-shaped strings out of every rendered field and lane", async () => {
    const secret = "Bearer sk-secretDEADBEEFdeadbeef0001";
    store.listProjectEnrollments.mockResolvedValue([{ userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" }]);
    store.getProjectContinuityState.mockResolvedValue(makeState({ currentFocus: [`focus ${secret}`] }));
    store.getContinuityGaps.mockResolvedValue([
      makeGap({
        summary: `summary ${secret}`,
        recommendation: `rec ${secret}`,
        evidence: [{ sourceType: "semiote", sourceId: "s1", label: `label ${secret}`, excerpt: `body ${secret}`, sensitivity: "normal" }],
      }),
    ]);
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const { md, json, html } = await readAll("2026-07-04");
    for (const doc of [md, json, html]) expect(doc).not.toContain("sk-secretDEADBEEFdeadbeef0001");
  });

  it("omits verbatim_session and undefined-sensitivity excerpts (fail-closed), elides private_path", async () => {
    store.listProjectEnrollments.mockResolvedValue([{ userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" }]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    store.getContinuityGaps.mockResolvedValue([
      makeGap({
        evidence: [
          { sourceType: "session_turn", sourceId: "v", label: "verbatim", excerpt: "VERBATIM_SECRET_TEXT", sensitivity: "verbatim_session" },
          { sourceType: "semiote", sourceId: "u", label: "nosens", excerpt: "UNMARKED_SENSITIVE_TEXT" },
          { sourceType: "doc_artifact", sourceId: "p", label: "path", excerpt: "at /Users/brooks/private/notes.md now", sensitivity: "private_path" },
        ],
      }),
    ]);
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const { md, json, html } = await readAll("2026-07-04");
    for (const doc of [md, json, html]) {
      expect(doc).not.toContain("VERBATIM_SECRET_TEXT");
      expect(doc).not.toContain("UNMARKED_SENSITIVE_TEXT"); // fail-closed
      expect(doc).not.toContain("/Users/brooks/private/");
      expect(doc).toContain("notes.md"); // private_path elided to basename, not omitted
    }
  });
});

describe("runContinuityReport — §11.2 not-yet-evaluated + HTML lane", () => {
  it("always renders the 4 collector-blocked kinds as not-yet-evaluated", async () => {
    store.listProjectEnrollments.mockResolvedValue([{ userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" }]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const { md } = await readAll("2026-07-04");
    expect(md).toContain("Not yet evaluated");
    for (const kind of ["orphaned_change", "bead_stale", "doc_drift", "stale_agent_run"]) expect(md).toContain(kind);
    expect(md).not.toContain("no gaps found");
  });

  it("emits dark-mode HTML with collapsible evidence drawers", async () => {
    store.listProjectEnrollments.mockResolvedValue([{ userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" }]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    store.getContinuityGaps.mockResolvedValue([makeGap({ evidence: [{ sourceType: "semiote", sourceId: "s", label: "ev", sensitivity: "normal" }] })]);
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const { html } = await readAll("2026-07-04");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("<details>");
  });
});

describe("runContinuityReport — content-hash cursor", () => {
  const enrollment = [{ userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" }];

  it("writes a cursor on the initial run and skips when the hash is unchanged", async () => {
    store.listProjectEnrollments.mockResolvedValue(enrollment);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    const r1 = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    expect(r1.projectsRendered).toBe(1);
    const hash = store.writeContinuityReportState.mock.calls[0][4];

    store.readContinuityReportState.mockResolvedValue({ userId: "u1", workspaceId: "-", projectKey: "project:runir", reportedContentHash: hash, reportedThrough: "x", updatedAt: "x" });
    const r2 = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-05" });
    expect(r2.projectsRendered).toBe(0);
    expect(r2.projectsSkipped).toBe(1);
  });

  it("does NOT churn when only state.updatedAt bumps (LLM-fallback), content unchanged", async () => {
    store.listProjectEnrollments.mockResolvedValue(enrollment);
    store.getProjectContinuityState.mockResolvedValue(makeState({ updatedAt: "2026-07-03T00:00:00.000Z" }));
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const hash1 = store.writeContinuityReportState.mock.calls[0][4];

    // Builder LLM-fallback re-stamps updatedAt (later), detector keeps pace, same lists/gaps.
    store.getProjectContinuityState.mockResolvedValue(makeState({ updatedAt: "2026-07-03T09:00:00.000Z" }));
    store.readGapEvaluatedThrough.mockResolvedValue("2026-07-03T09:00:00.000Z");
    store.writeContinuityReportState.mockClear();
    store.readContinuityReportState.mockResolvedValue({ userId: "u1", workspaceId: "-", projectKey: "project:runir", reportedContentHash: hash1, reportedThrough: "x", updatedAt: "x" });
    const r = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    expect(r.projectsRendered).toBe(0); // hash stable despite updatedAt change → no re-render
  });

  it("re-renders when gap content actually changes", async () => {
    store.listProjectEnrollments.mockResolvedValue(enrollment);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const hash1 = store.writeContinuityReportState.mock.calls[0][4];

    store.getContinuityGaps.mockResolvedValue([makeGap({ summary: "a brand new gap appeared" })]);
    store.readContinuityReportState.mockResolvedValue({ userId: "u1", workspaceId: "-", projectKey: "project:runir", reportedContentHash: hash1, reportedThrough: "x", updatedAt: "x" });
    const r = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    expect(r.projectsRendered).toBe(1);
  });

  it("re-renders when only the gap dedupeKey changes (same title/summary — session swap, Codex F3)", async () => {
    store.listProjectEnrollments.mockResolvedValue(enrollment);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    store.getContinuityGaps.mockResolvedValue([makeGap({ kind: "missing_handoff", dedupeKey: "missing_handoff:sessA" })]);
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const hash1 = store.writeContinuityReportState.mock.calls[0][4];

    // Identical rendered fields, DIFFERENT session → different dedupeKey → must re-render.
    store.getContinuityGaps.mockResolvedValue([makeGap({ kind: "missing_handoff", dedupeKey: "missing_handoff:sessB" })]);
    store.readContinuityReportState.mockResolvedValue({ userId: "u1", workspaceId: "-", projectKey: "project:runir", reportedContentHash: hash1, reportedThrough: "x", updatedAt: "x" });
    const r = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    expect(r.projectsRendered).toBe(1);
  });

  it("NEVER skips a gaps-pending project, even when its hash matches the prior report (Codex F1)", async () => {
    store.listProjectEnrollments.mockResolvedValue(enrollment);
    // gaps pending: evaluated_through is behind state.updatedAt.
    store.getProjectContinuityState.mockResolvedValue(makeState({ updatedAt: "2026-07-04T00:00:00.000Z" }));
    store.readGapEvaluatedThrough.mockResolvedValue("2026-07-03T00:00:00.000Z");
    const r1 = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    expect(r1.projectsPending).toBe(1);
    // A pending project does NOT advance the report cursor.
    expect(store.writeContinuityReportState).not.toHaveBeenCalled();
    // Even if a stale cursor happened to carry a matching hash, it is not skipped.
    const view = JSON.parse(await readFile(join(dir, "2026-07-04-continuity-report.json"), "utf-8"));
    store.readContinuityReportState.mockResolvedValue({ userId: "u1", workspaceId: "-", projectKey: "project:runir", reportedContentHash: view.projects[0]?.contentHash ?? "x", reportedThrough: "x", updatedAt: "x" });
    const r2 = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-05" });
    expect(r2.projectsRendered).toBe(1);
    expect(r2.projectsPending).toBe(1);
  });
});

describe("runContinuityReport — multi-workspace", () => {
  it("treats same projectKey under different workspaceId as independent rows", async () => {
    store.listProjectEnrollments.mockResolvedValue([
      { userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e1", enrolledAt: "x" },
      { userId: "u1", workspaceId: "ws-b", projectKey: "project:runir", source: "manual", id: "e2", enrolledAt: "x" },
    ]);
    store.getProjectContinuityState.mockImplementation(async (_db, _u, ws, pk) => makeState({ workspaceId: ws, projectKey: pk }));
    const r = await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    expect(r.projectsRendered).toBe(2);
    // getProjectContinuityState called once per (workspace, project).
    const workspaces = store.getProjectContinuityState.mock.calls.map((c) => c[2]);
    expect(new Set(workspaces)).toEqual(new Set(["-", "ws-b"]));
  });
});
