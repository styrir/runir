// Real-DB integration tests for the continuity-evidence store (Rúnir-78sy.9).
//
// The unique-index dedupe (userId, workspaceId, projectKey, sourceType,
// sourceId), the first_seen_at-once / last_seen_at-each-write read-then-branch
// upsert, the ref JSON-string round-trip with varying nested keys, both
// listing branches (with/without sourceType — F4's two indexes), and the
// project-anchor-filtered session-binding matrix (F2/F6) only manifest against
// a real store — a mocked db.query cannot catch a duplicate-index rejection
// or execute real SurrealDB SQL. Skipped when no local SurrealDB is reachable
// (the continuity-gap-store-repro pattern). 0 skipped = acceptance.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  bindEvidenceToSession,
  buildContinuityEvidenceRecordId,
  ensureContinuityEvidenceTable,
  listEvidenceForProject,
  upsertContinuityEvidence,
} from "../storage/surreal/continuity-evidence-store.js";
import { ensureRunirSessionTable } from "../storage/surreal/runir-session-store.js";
import type { ContinuityEvidenceWrite } from "../domain/memory/continuity.js";

// ── Schema content-pin (mock db, always runs) ────────────────────────────────

function mockDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as unknown as SurrealClient;
}

describe("continuity-evidence ensure* schema", () => {
  it("ensureContinuityEvidenceTable defines the dedupe + two reporting indexes", async () => {
    const db = mockDb();
    await ensureContinuityEvidenceTable(db);
    expect((db.query as any)).toHaveBeenCalledWith(expect.stringContaining("DEFINE TABLE IF NOT EXISTS continuity_evidence SCHEMAFULL"));
    expect((db.query as any)).toHaveBeenCalledWith(
      expect.stringContaining("idx_ce_dedupe ON TABLE continuity_evidence COLUMNS user_id, workspace_id, project_key, source_type, source_id UNIQUE"),
    );
    expect((db.query as any)).toHaveBeenCalledWith(
      expect.stringContaining("idx_ce_kind_report ON TABLE continuity_evidence COLUMNS user_id, workspace_id, project_key, source_type, last_seen_at"),
    );
    expect((db.query as any)).toHaveBeenCalledWith(
      expect.stringContaining("idx_ce_project_report ON TABLE continuity_evidence COLUMNS user_id, workspace_id, project_key, last_seen_at"),
    );
  });
});

describe("buildContinuityEvidenceRecordId workspaceId canonicalization (Codex F2)", () => {
  it("canonicalizes workspaceId internally: '-' / undefined / '' all produce the SAME record id", () => {
    const withSentinel = buildContinuityEvidenceRecordId("u1", "-", "project:x", "git_commit", "sha1");
    const withUndefined = buildContinuityEvidenceRecordId("u1", undefined as unknown as string, "project:x", "git_commit", "sha1");
    const withEmpty = buildContinuityEvidenceRecordId("u1", "", "project:x", "git_commit", "sha1");
    expect(withUndefined).toBe(withSentinel);
    expect(withEmpty).toBe(withSentinel);
  });

  it("a real workspaceId is trimmed the same way canonicalizeWorkspaceId trims it", () => {
    const trimmed = buildContinuityEvidenceRecordId("u1", "ws-1", "project:x", "git_commit", "sha1");
    const untrimmed = buildContinuityEvidenceRecordId("u1", "  ws-1  ", "project:x", "git_commit", "sha1");
    expect(untrimmed).toBe(trimmed);
  });
});

// ── Real-DB behavior ──────────────────────────────────────────────────────────

const TEST_DB = "continuity_evidence_78sy9_repro_test";
const USER = "_78sy9_repro_user";
const WORKSPACE_FP = "78sy9repro0000000000wsfp";

function makeDb(): SurrealClient {
  return new SurrealClient({
    // 127.0.0.1 (IPv4), not localhost — the native install binds IPv4 only.
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

function makeWrite(over: Partial<ContinuityEvidenceWrite> = {}): ContinuityEvidenceWrite {
  return {
    userId: USER,
    workspaceId: "-",
    projectKey: "project:runir",
    projectId: "leit-proj-1",
    sourceType: "git_commit",
    sourceId: "sha-A",
    ref: { sourceType: "git_commit", sourceId: "sha-A", label: "fix: bug", timestamp: "2026-07-01T00:00:00.000Z" },
    ...over,
  };
}

let db: SurrealClient;
let dbAvailable = false;

async function createSession(params: {
  id: string;
  openedAt: string;
  closedAt?: string;
  workspaceFingerprint?: string;
}): Promise<void> {
  const closedAtClause = params.closedAt !== undefined ? "closed_at = <datetime>$closedAt," : "closed_at = NONE,";
  const vars: Record<string, unknown> = {
    id: params.id,
    userId: USER,
    wf: params.workspaceFingerprint ?? WORKSPACE_FP,
    status: params.closedAt ? "closed" : "active",
    openedAt: params.openedAt,
    resolverKey: `resolver-${params.id}`,
  };
  if (params.closedAt !== undefined) vars.closedAt = params.closedAt;
  await db.query(
    `CREATE type::record('runir_session', $id) SET
       user_id = $userId,
       project_key = NONE,
       project_identity_source = NONE,
       client_kind = NONE,
       native_session_id = NONE,
       native_session_key = NONE,
       native_session_aliases = [],
       workspace_path = NONE,
       workspace_fingerprint = $wf,
       host_id = NONE,
       device_label = NONE,
       status = $status,
       opened_at = <datetime>$openedAt,
       last_seen_at = <datetime>$openedAt,
       ${closedAtClause}
       close_reason = NONE,
       resolver_key = $resolverKey;`,
    vars,
  );
}

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await db.query(
    "REMOVE TABLE IF EXISTS continuity_evidence; REMOVE TABLE IF EXISTS runir_session;",
  );
  await ensureContinuityEvidenceTable(db);
  await ensureRunirSessionTable(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => undefined);
    await db.close().catch(() => undefined);
  }
});

describe("continuity_evidence real-DB dedupe + upsert", () => {
  it("re-posting the same 5-tuple UPDATES (no duplicate); first_seen fixed, last_seen advances", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const recordId = buildContinuityEvidenceRecordId(USER, "-", "project:dedupe", "git_commit", "sha-dedupe");
    const a = await upsertContinuityEvidence(db, makeWrite({ projectKey: "project:dedupe", sourceId: "sha-dedupe", lastSeenAt: "2026-07-03T00:00:00.000Z" }));
    expect(a.outcome).toBe("created");
    const b = await upsertContinuityEvidence(
      db,
      makeWrite({
        projectKey: "project:dedupe",
        sourceId: "sha-dedupe",
        ref: { sourceType: "git_commit", sourceId: "sha-dedupe", label: "updated label" },
        lastSeenAt: "2026-07-04T00:00:00.000Z",
      }),
    );
    expect(b.outcome).toBe("updated");
    expect(b.record.id).toBe(a.record.id);
    expect(b.record.id).toBe(recordId);

    const rows = await listEvidenceForProject(db, USER, "-", "project:dedupe");
    const matching = rows.filter((r) => r.sourceId === "sha-dedupe");
    expect(matching.length).toBe(1); // no duplicate row
    expect(matching[0].firstSeenAt).toBe(a.record.firstSeenAt); // set once
    expect(new Date(matching[0].lastSeenAt).getTime()).toBeGreaterThan(new Date(a.record.lastSeenAt).getTime());
    expect(matching[0].ref.label).toBe("updated label");
  });

  it("ref JSON round-trips with varying nested keys across items", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const pk = "project:refshape";
    await upsertContinuityEvidence(db, makeWrite({
      projectKey: pk,
      sourceId: "sha-minimal",
      ref: { sourceType: "git_commit", sourceId: "sha-minimal", label: "minimal ref, no optional fields" },
    }));
    await upsertContinuityEvidence(db, makeWrite({
      projectKey: pk,
      sourceType: "doc_artifact",
      sourceId: "doc-full",
      ref: {
        sourceType: "doc_artifact",
        sourceId: "doc-full",
        label: "full ref",
        uri: "docs/foo.md",
        excerpt: "some excerpt text",
        timestamp: "2026-07-02T00:00:00.000Z",
        confidence: 0.8,
        sensitivity: "normal",
      },
    }));
    const rows = await listEvidenceForProject(db, USER, "-", pk);
    const minimal = rows.find((r) => r.sourceId === "sha-minimal");
    const full = rows.find((r) => r.sourceId === "doc-full");
    expect(minimal?.ref).toEqual({ sourceType: "git_commit", sourceId: "sha-minimal", label: "minimal ref, no optional fields" });
    expect(full?.ref).toEqual({
      sourceType: "doc_artifact",
      sourceId: "doc-full",
      label: "full ref",
      uri: "docs/foo.md",
      excerpt: "some excerpt text",
      timestamp: "2026-07-02T00:00:00.000Z",
      confidence: 0.8,
      sensitivity: "normal",
    });
  });

  it("[F4] listEvidenceForProject executes real SQL both WITH and WITHOUT sourceType (both indexes exercised)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const pk = "project:listing";
    await upsertContinuityEvidence(db, makeWrite({ projectKey: pk, sourceType: "git_commit", sourceId: "sha-list-1" }));
    await upsertContinuityEvidence(db, makeWrite({ projectKey: pk, sourceType: "bead", sourceId: "bead-list-1", ref: { sourceType: "bead", sourceId: "bead-list-1", label: "bead" } }));

    const all = await listEvidenceForProject(db, USER, "-", pk);
    expect(all.length).toBeGreaterThanOrEqual(2);

    const commitsOnly = await listEvidenceForProject(db, USER, "-", pk, { sourceType: "git_commit" });
    expect(commitsOnly.every((r) => r.sourceType === "git_commit")).toBe(true);
    expect(commitsOnly.some((r) => r.sourceId === "sha-list-1")).toBe(true);
    expect(commitsOnly.some((r) => r.sourceId === "bead-list-1")).toBe(false);
  });
});

describe("bindEvidenceToSession real-DB binding matrix (F2/F6)", () => {
  const enrollment = { repoRootFingerprint: WORKSPACE_FP };

  it("binds to an in-window CLOSED session", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await createSession({ id: "bind_closed", openedAt: "2026-07-01T00:00:00.000Z", closedAt: "2026-07-01T02:00:00.000Z" });
    const bound = await bindEvidenceToSession(db, USER, enrollment, "2026-07-01T01:00:00.000Z");
    expect(bound).toBe("bind_closed");
  });

  it("[F6] binds to an OPEN session (closed_at NONE)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const openedAt = new Date(Date.now() - 3600_000).toISOString(); // opened 1h ago, still open
    await createSession({ id: "bind_open", openedAt });
    const occurredAt = new Date(Date.now() - 1800_000).toISOString(); // 30m ago — inside [openedAt, now]
    const bound = await bindEvidenceToSession(db, USER, enrollment, occurredAt);
    expect(bound).toBe("bind_open");
  });

  it("picks the NARROWEST window on overlap", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Wide session: 00:00 - 10:00. Narrow session: 04:00 - 05:00. Both contain 04:30.
    await createSession({ id: "bind_wide", openedAt: "2026-06-01T00:00:00.000Z", closedAt: "2026-06-01T10:00:00.000Z", workspaceFingerprint: `${WORKSPACE_FP}n` });
    await createSession({ id: "bind_narrow", openedAt: "2026-06-01T04:00:00.000Z", closedAt: "2026-06-01T05:00:00.000Z", workspaceFingerprint: `${WORKSPACE_FP}n` });
    const bound = await bindEvidenceToSession(db, USER, { repoRootFingerprint: `${WORKSPACE_FP}n` }, "2026-06-01T04:30:00.000Z");
    expect(bound).toBe("bind_narrow");
  });

  it("[F6] equal-width overlap tie -> most recently started session wins", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}tie`;
    // Two 2h-wide sessions, both containing 05:30: 04:00-06:00 and 05:00-07:00.
    await createSession({ id: "bind_tie_early", openedAt: "2026-06-02T04:00:00.000Z", closedAt: "2026-06-02T06:00:00.000Z", workspaceFingerprint: wf });
    await createSession({ id: "bind_tie_late", openedAt: "2026-06-02T05:00:00.000Z", closedAt: "2026-06-02T07:00:00.000Z", workspaceFingerprint: wf });
    const bound = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, "2026-06-02T05:30:00.000Z");
    expect(bound).toBe("bind_tie_late"); // most recently started of the equal-width overlap
  });

  it("out-of-window timestamp -> unbound (undefined)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}oow`;
    await createSession({ id: "bind_oow", openedAt: "2026-06-03T00:00:00.000Z", closedAt: "2026-06-03T01:00:00.000Z", workspaceFingerprint: wf });
    const bound = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, "2026-06-03T05:00:00.000Z");
    expect(bound).toBeUndefined();
  });

  it("[F1] missing timestamp -> occurredAt NONE + unbound", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const bound = await bindEvidenceToSession(db, USER, enrollment, undefined);
    expect(bound).toBeUndefined();
  });

  it("[F1] future timestamp -> unbound (no clock-skew fudge)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}fut`;
    await createSession({ id: "bind_future_open", openedAt: new Date(Date.now() - 3600_000).toISOString(), workspaceFingerprint: wf });
    const farFuture = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    const bound = await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, farFuture);
    expect(bound).toBeUndefined();
  });

  it("[F2] a concurrent session from an UNRELATED project never binds (cross-project negative)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const unrelatedWf = `${WORKSPACE_FP}unrelated`;
    await createSession({ id: "bind_unrelated", openedAt: "2026-07-01T00:00:00.000Z", closedAt: "2026-07-01T23:00:00.000Z", workspaceFingerprint: unrelatedWf });
    // Anchor by a DIFFERENT fingerprint than the unrelated session's — even
    // though the timestamp falls inside the unrelated session's window, the
    // project-anchor filter excludes it before the window check ever runs.
    const bound = await bindEvidenceToSession(db, USER, { repoRootFingerprint: `${WORKSPACE_FP}anchor-only` }, "2026-07-01T12:00:00.000Z");
    expect(bound).toBeUndefined();
  });

  it("binding creates/updates ZERO session rows (pure reads only, never resolveRunirSession)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const wf = `${WORKSPACE_FP}purecheck`;
    await createSession({ id: "bind_purecheck", openedAt: "2026-07-01T00:00:00.000Z", closedAt: "2026-07-01T02:00:00.000Z", workspaceFingerprint: wf });
    const before = await db.query<{ id: unknown; last_seen_at: unknown }>(
      "SELECT id, last_seen_at FROM runir_session WHERE user_id = $userId;",
      { userId: USER },
    );
    const beforeCount = (before[0] ?? []).length;
    const beforeRow = (before[0] ?? []).find((r: any) => String((r.id as any)?.id ?? r.id).includes("bind_purecheck"));

    await bindEvidenceToSession(db, USER, { repoRootFingerprint: wf }, "2026-07-01T01:00:00.000Z");

    const after = await db.query<{ id: unknown; last_seen_at: unknown }>(
      "SELECT id, last_seen_at FROM runir_session WHERE user_id = $userId;",
      { userId: USER },
    );
    const afterCount = (after[0] ?? []).length;
    const afterRow = (after[0] ?? []).find((r: any) => String((r.id as any)?.id ?? r.id).includes("bind_purecheck"));

    expect(afterCount).toBe(beforeCount); // zero rows created
    expect(String(afterRow?.last_seen_at)).toBe(String(beforeRow?.last_seen_at)); // zero rows mutated
  });
});
