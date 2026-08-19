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

import { elidePaths, renderHtml, renderJson, renderMarkdown, runContinuityReport, sanitizeForDisk } from "../lifecycle/archive/continuity-report.js";
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
    evidence: [{
      sourceType: "semiote",
      sourceId: "semiote:default-gap",
      label: "default gap evidence",
      sensitivity: "normal",
    }],
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

  it("sanitizeForDisk fail-closes common private paths and credential assignments", () => {
    const stripeLiveKey = ["sk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const stripeRestrictedKey = ["rk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const out = sanitizeForDisk([
      "RUNIR_EVIDENCE_SECRET=private-value",
      "token=private-token",
      "token=\"quoted-private-token\"",
      "token=\"escaped-quote-\\\"still-secret\"",
      "TOKEN=\\\"ESCAPED_ASSIGNMENT_SECRET\\\"",
      "PASSWORD=\\\\'ESCAPED PASSWORD SECRET 123\\\\'",
      "\\\"api_key\\\":\\\"ESCAPED_JSON_SECRET_123\\\"",
      "TOKEN=&quot;HTML ENTITY SECRET 123&quot;",
      "TOKEN=alpha\\ beta",
      "TOKEN=alpha'beta'gamma",
      "password='quoted-password'",
      "CLIENT_SECRET=`quoted-client-secret`",
      "DATABASE_URL=postgres://user:pass@host/db",
      "postgresql://user:pass@host/db",
      "mysql://user:pass@host/db",
      "redis://:pass@host/0",
      "mongodb://user:pass@host/db",
      "mssql://user:topsecret@host/db",
      "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=azure-secret;EndpointSuffix=core.windows.net",
      "/tmp/runir/private.json",
      "/etc/runir/private.conf",
      "/opt/Private Project/secret.txt",
      "path:/srv/Private Project/secret.txt",
      "C:\\Users\\brooks\\secret.txt",
      "\\\\server\\share\\secret.txt",
      "~/.ssh/id_rsa",
      ".env",
      ".styrir/runs/private/report.json",
      "repo:.styrir/runs/private/report.json",
      "private/client/secret.txt",
      ".npmrc",
      "[/srv/Bracket Path/secret.txt",
      ",/srv/Comma Path/secret.txt",
      "\\\\server\\Shared Folder\\secret.txt",
      "~/.ssh/Private Key",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "github_pat_abcdefghijklmnopqrstuvwxyz_123456",
      "glpat-abcdefghijklmnopqrstuvwxyz123456",
      "npm_abcdefghijklmnopqrstuvwxyz123456",
      stripeLiveKey,
      stripeRestrictedKey,
      "whsec_abcdefghijklmnopqrstuvwxyz123456",
      "xapp-1-abcdefghijklmnopqrstuvwxyz123456",
      "GOCSPX-abcdefghijklmnopqrstuvwxyz123456",
      "hf_abcdefghijklmnopqrstuvwxyz123456",
      "https://example.invalid/blob?sv=1&sig=azure-sas-secret",
      "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
    ].join(" "));
    expect(out).not.toContain("private-value");
    expect(out).not.toContain("private-token");
    expect(out).not.toContain("quoted-private-token");
    expect(out).not.toContain("still-secret");
    expect(out).not.toContain("ESCAPED_ASSIGNMENT_SECRET");
    expect(out).not.toContain("ESCAPED PASSWORD SECRET 123");
    expect(out).not.toContain("ESCAPED_JSON_SECRET_123");
    expect(out).not.toContain("HTML ENTITY SECRET 123");
    expect(out).not.toContain("alpha");
    expect(out).not.toContain("beta");
    expect(out).not.toContain("quoted-password");
    expect(out).not.toContain("quoted-client-secret");
    expect(out).not.toContain("postgres://user:pass@host/db");
    expect(out).not.toContain("postgresql://user:pass@host/db");
    expect(out).not.toContain("mysql://user:pass@host/db");
    expect(out).not.toContain("redis://:pass@host/0");
    expect(out).not.toContain("mongodb://user:pass@host/db");
    expect(out).not.toContain("mssql://user:topsecret@host/db");
    expect(out).not.toContain("azure-secret");
    expect(out).not.toContain("private-key-material");
    expect(out).not.toContain("/tmp/runir/");
    expect(out).not.toContain("/etc/runir/");
    expect(out).not.toContain("/opt/Private Project/");
    expect(out).not.toContain("/srv/Private Project/");
    expect(out).not.toContain("C:\\Users\\brooks\\");
    expect(out).not.toContain("\\\\server\\share\\");
    expect(out).not.toContain("~/.ssh/");
    expect(out).not.toContain(".env");
    expect(out).not.toContain(".styrir/runs/private/");
    expect(out).not.toContain("private/client/");
    expect(out).not.toContain(".npmrc");
    expect(out).not.toContain("/srv/Bracket Path/");
    expect(out).not.toContain("/srv/Comma Path/");
    expect(out).not.toContain("\\\\server\\Shared Folder\\");
    expect(out).not.toContain("~/.ssh/Private Key");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz_123456");
    expect(out).not.toContain("glpat-abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("npm_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain(stripeLiveKey);
    expect(out).not.toContain(stripeRestrictedKey);
    expect(out).not.toContain("whsec_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("xapp-1-abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("GOCSPX-abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("hf_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("azure-sas-secret");
  });

  it("renderMarkdown sanitizes top-level values before adding Markdown escapes", () => {
    const out = renderMarkdown({
      date: "2026-07-04",
      userId: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      lookbackDays: 7,
      notYetEvaluated: ["api_key=\"top-level-secret\""],
      projects: [],
      skippedProjects: ["github_pat_abcdefghijklmnopqrstuvwxyz_123456"],
      pendingProjects: [],
    } as any);
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("github_pat_");
    expect(out).not.toContain("top-level-secret");
  });

  it("the HTML render/write sanitizer removes entity-encoded credentials", () => {
    const html = renderHtml({
      date: "2026-07-04",
      userId: "TOKEN=&quot;LANE SECRET 123&quot;",
      lookbackDays: 7,
      notYetEvaluated: [],
      projects: [],
      skippedProjects: [],
      pendingProjects: [],
    } as any);
    const disk = sanitizeForDisk(html);
    expect(disk).not.toContain("LANE SECRET 123");
  });

  it("renderJson sanitizes values without corrupting JSON structure", () => {
    const json = renderJson({
      date: "2026-07-04",
      userId: "TOKEN=alpha\\ beta",
      lookbackDays: 7,
      notYetEvaluated: [],
      projects: [],
      skippedProjects: [],
      pendingProjects: [],
    } as any);
    const parsed = JSON.parse(json);
    expect(parsed.userId).toBe("[redacted: sensitive]");
    expect(json).not.toContain("alpha");
    expect(json).not.toContain("beta");
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
    for (const [format, doc] of [["md", md], ["json", json], ["html", html]] as const) {
      const visible = format === "md" ? doc.replaceAll("\\", "") : doc;
      expect(visible).not.toContain("VERBATIM_SECRET_TEXT");
      expect(visible).not.toContain("UNMARKED_SENSITIVE_TEXT"); // fail-closed
      expect(visible).not.toContain("/Users/brooks/private/");
      expect(visible).toContain("notes.md"); // private_path elided to basename, not omitted
    }
  });
});

describe("runContinuityReport — §11.2 not-yet-evaluated + HTML lane", () => {
  it("always renders the 4 collector-blocked kinds as not-yet-evaluated", async () => {
    store.listProjectEnrollments.mockResolvedValue([{ userId: "u1", workspaceId: "-", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" }]);
    store.getProjectContinuityState.mockResolvedValue(makeState());
    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const { md } = await readAll("2026-07-04");
    const visible = md.replaceAll("\\", "");
    expect(visible).toContain("Not yet evaluated");
    for (const kind of ["orphaned_change", "bead_stale", "doc_drift", "stale_agent_run"]) expect(visible).toContain(kind);
    expect(visible).not.toContain("no gaps found");
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

describe("runContinuityReport — source-anchor gate", () => {
  it("renders only supported items with equivalent source metadata in Markdown, JSON, and HTML", async () => {
    store.listProjectEnrollments.mockResolvedValue([
      { userId: "u1", workspaceId: "ws-a", projectKey: "project:runir", source: "manual", id: "e", enrolledAt: "x" },
    ]);
    store.getProjectContinuityState.mockResolvedValue(makeState({
      workspaceId: "ws-a",
      currentFocus: [
        "FOCUS_REJECTED",
        "FOCUS_SUPPORTED",
        "FOCUS_UNBACKED_A",
        "FOCUS_UNBACKED_B",
        "FOCUS_INVALID_FALLBACK",
        "FOCUS_BLANK_TYPE_FALLBACK",
        "FOCUS_INVALID_ID_FALLBACK",
        "FOCUS_COLLISION_A",
        "FOCUS_COLLISION_B",
      ],
      latestProgress: [
        "PROGRESS_UNAVAILABLE",
        "PROGRESS_INVALID_UNAVAILABLE",
        "PROGRESS_MALFORMED_UNAVAILABLE",
        "PROGRESS_LEGACY_COORDINATES",
      ],
      nextSteps: ["NEXT_REJECTED", "NEXT_SUPPORTED"],
      openLoops: ["LOOP_SUPPORTED"],
      blockers: ["BLOCKER_SUPPORTED"],
      sourceEvidenceRefs: [
        {
          itemClass: "focus",
          itemIndex: 1,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "semiote:focus",
          knownAt: "2026-07-03T01:00:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "progress",
          itemIndex: 0,
          sourceState: "unavailable",
          knownAt: "2026-07-03T02:00:00.000Z",
          conflictOrStaleness: "unknown",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "progress",
          itemIndex: 3,
          sourceState: "unavailable",
          kind: "semiote",
          id: "semiote:legacy-must-not-publish",
          knownAt: "2026-07-03T02:32:00.000Z",
          conflictOrStaleness: "unknown",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "progress",
          itemIndex: 2,
          sourceState: "unavailable",
          sourceType: "unsupported",
          knownAt: "2026-07-03T02:31:00.000Z",
          conflictOrStaleness: "unknown",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "progress",
          itemIndex: 1,
          sourceState: "unavailable",
          sourceType: "semiote",
          sourceId: "semiote:must-not-publish",
          knownAt: "2026-07-03T02:30:00.000Z",
          conflictOrStaleness: "unknown",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "next_steps",
          itemIndex: 1,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "semiote:next",
          knownAt: "2026-07-03T03:00:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "open_loops",
          itemIndex: 0,
          sourceState: "resolved",
          sourceType: "session_summary",
          sourceId: "session-summary:loop",
          knownAt: "2026-07-03T04:00:00.000Z",
          conflictOrStaleness: "open",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "blockers",
          itemIndex: 0,
          sourceState: "resolved",
          sourceType: "doc_artifact",
          sourceId: "[click](https://attacker.invalid/) <img src=x>",
          knownAt: "2026-07-03T05:00:00.000Z",
          conflictOrStaleness: "active",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 2,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "/tmp/a/invented",
          knownAt: "2026-07-03T01:30:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 3,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "/var/b/invented",
          knownAt: "2026-07-03T01:31:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 4,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "semiote:fallback-must-reject",
          knownAt: "2026-07-03T01:32:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 5,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "semiote:blank-type-must-reject",
          knownAt: "2026-07-03T01:33:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 6,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "semiote:invalid-id-must-reject",
          knownAt: "2026-07-03T01:34:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 7,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "/tmp/a/shared",
          knownAt: "2026-07-03T01:35:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        {
          itemClass: "focus",
          itemIndex: 8,
          sourceState: "resolved",
          sourceType: "semiote",
          sourceId: "/var/b/shared",
          knownAt: "2026-07-03T01:36:00.000Z",
          conflictOrStaleness: "current",
          derivationVersion: "continuity-v1",
        },
        { kind: "semiote", id: "semiote:focus", at: "2026-07-03T01:00:00.000Z" },
        { kind: "semiote", id: "semiote:next", at: "2026-07-03T03:00:00.000Z" },
        { kind: "session_summary", id: "session-summary:loop", at: "2026-07-03T04:00:00.000Z" },
        { kind: "doc_artifact", id: "[click](https://attacker.invalid/) <img src=x>", at: "2026-07-03T05:00:00.000Z" },
        {
          sourceType: "unsupported",
          kind: "semiote",
          id: "semiote:fallback-must-reject",
          at: "2026-07-03T01:32:00.000Z",
        },
        {
          sourceType: "",
          kind: "semiote",
          id: "semiote:blank-type-must-reject",
          at: "2026-07-03T01:33:00.000Z",
        },
        {
          kind: "semiote",
          sourceId: 42,
          id: "semiote:invalid-id-must-reject",
          at: "2026-07-03T01:34:00.000Z",
        },
        { kind: "semiote", id: "/tmp/a/shared", at: "2026-07-03T01:35:00.000Z" },
        { kind: "semiote", id: "/var/b/shared", at: "2026-07-03T01:36:00.000Z" },
      ],
      supportingSemioteIds: ["semiote:focus", "semiote:next"],
    }));
    store.getContinuityGaps.mockResolvedValue([
      makeGap({
        id: "gap-rejected",
        title: "GAP_REJECTED",
        dedupeKey: "unfiled_intent:rejected",
        evidence: [],
      }),
      makeGap({
        id: "gap-supported",
        title: "GAP_SUPPORTED",
        evidence: [
          {
            sourceType: "unsupported",
            sourceId: "invalid",
            label: "invalid mixed evidence",
          } as any,
          {
            sourceType: "semiote",
            sourceId: "semiote:gap",
            label: "gap evidence",
            timestamp: "2026-07-03T06:00:00.000Z",
            sensitivity: "normal",
          },
        ],
      }),
      makeGap({
        id: "gap-invalid",
        title: "GAP_INVALID",
        dedupeKey: "unfiled_intent:invalid",
        evidence: [{
          sourceType: "semiote",
          sourceId: "",
          label: "blank source id",
        }],
      }),
    ]);

    await runContinuityReport(DB, { userId: "u1", reportDir: dir, date: "2026-07-04" });
    const { md, json, html } = await readAll("2026-07-04");
    for (const doc of [md.replaceAll("\\", ""), json, html]) {
      for (const accepted of [
        "FOCUS_SUPPORTED",
        "PROGRESS_UNAVAILABLE",
        "NEXT_SUPPORTED",
        "LOOP_SUPPORTED",
        "BLOCKER_SUPPORTED",
        "GAP_SUPPORTED",
      ]) {
        expect(doc).toContain(accepted);
      }
      for (const rejected of [
        "FOCUS_REJECTED",
        "FOCUS_UNBACKED_A",
        "FOCUS_UNBACKED_B",
        "FOCUS_INVALID_FALLBACK",
        "FOCUS_BLANK_TYPE_FALLBACK",
        "FOCUS_INVALID_ID_FALLBACK",
        "PROGRESS_INVALID_UNAVAILABLE",
        "PROGRESS_MALFORMED_UNAVAILABLE",
        "PROGRESS_LEGACY_COORDINATES",
        "NEXT_REJECTED",
        "GAP_REJECTED",
        "GAP_INVALID",
        "semiote:must-not-publish",
      ]) {
        expect(doc).not.toContain(rejected);
      }
      expect(doc).not.toContain("semiote:semiote:");
      expect(doc).toContain("continuity-v1");
    }
    expect(md.replaceAll("\\", "")).toMatch(/semiote:src-[a-f0-9]{24}/u);
    expect(html).toMatch(/semiote:src-[a-f0-9]{24}/u);
    expect(json).toContain('"sourceType": "semiote"');
    expect(json).toMatch(/"sourceId": "src-[a-f0-9]{24}"/u);
    expect(md).not.toContain("[click](");
    expect(md).not.toContain("<img src=x>");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("&lt;img src=x&gt;");
    expect(md).toContain("source unavailable");
    expect(html).toContain("source unavailable");
    expect(json).toContain('"sourceState": "unavailable"');
    for (const human of [md.replaceAll("\\", ""), html]) {
      expect(human).toContain("item-class:");
      expect(human).toContain("item-index:");
      expect(human).toContain("source-item-index:");
      expect(human).toContain("scope: user=u1, workspace=ws-a, project=project:runir");
      expect(human).toContain("conflict-or-staleness:");
    }

    const model = JSON.parse(json);
    const project = model.projects[0];
    expect(project.currentFocus).toEqual([
      "FOCUS_SUPPORTED",
      "FOCUS_COLLISION_A",
      "FOCUS_COLLISION_B",
    ]);
    expect(project.nextSteps).toEqual(["NEXT_SUPPORTED"]);
    expect(project.gaps.map((gap: { title: string }) => gap.title)).toEqual(["GAP_SUPPORTED"]);
    expect(project.itemEvidence).toHaveLength(8);
    for (const item of project.itemEvidence) {
      expect(item.safeScope).toEqual({
        userId: "u1",
        workspaceId: "ws-a",
        projectKey: "project:runir",
      });
      expect(item).toHaveProperty("sourceState");
      expect(item).toHaveProperty("sourceItemIndex");
      expect(item).toHaveProperty("knownTime");
      expect(item).toHaveProperty("conflictOrStaleness");
      expect(item).toHaveProperty("derivationVersion");
      expect(item.generationDigest).toBe(project.contentHash);
    }
    expect(project.itemEvidence.find((item: { itemClass: string }) => item.itemClass === "focus"))
      .toMatchObject({ itemIndex: 0, sourceItemIndex: 1 });
    expect(project.itemEvidence.find((item: { itemClass: string }) => item.itemClass === "next_steps"))
      .toMatchObject({ itemIndex: 0, sourceItemIndex: 1 });
    expect(project.itemEvidence.find((item: { itemClass: string }) => item.itemClass === "gaps"))
      .toMatchObject({ itemIndex: 0, sourceItemIndex: 1 });
    expect(project.gaps[0].evidence).toHaveLength(1);
    const collisionSources = project.itemEvidence
      .filter((item: { text: string }) => item.text.startsWith("FOCUS_COLLISION_"))
      .map((item: { sources: Array<{ sourceId: string }> }) => item.sources[0].sourceId);
    expect(new Set(collisionSources).size).toBe(2);
    expect(collisionSources.every((sourceId: string) => /^src-[a-f0-9]{24}$/u.test(sourceId))).toBe(true);
  });
});
