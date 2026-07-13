// Real-DB integration tests for the continuity-gap store (Rúnir-78sy.4/78sy.5).
//
// The unique-index dedupe (userId, workspaceId, projectKey, dedupeKey), the
// first_seen_at-once / last_seen_at-each-write read-then-branch upsert, the
// sticky-status lifecycle (dismissed never reverts, new evidence surfaces a fresh
// row), reconciliation, and the two cursors only manifest against a real store —
// a mocked db.query cannot catch a duplicate-index rejection. Skipped when no
// local SurrealDB is reachable (the entity-consolidation-repro pattern).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  ensureContinuityGapBuildStateTable,
  ensureContinuityGapTable,
  ensureContinuityReportStateTable,
  getContinuityGaps,
  listActiveGapsForKind,
  markGapReported,
  readContinuityReportState,
  readGapEvaluatedThrough,
  setGapStatus,
  upsertContinuityGap,
  writeContinuityReportState,
  writeGapEvaluatedThrough,
} from "../storage/surreal/continuity-gap-store.js";
import type { ContinuityGapWrite } from "../domain/memory/continuity.js";

// ── Schema content-pin (mock db, always runs) ────────────────────────────────

function mockDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as unknown as SurrealClient;
}

describe("continuity-gap ensure* schema", () => {
  it("ensureContinuityGapTable defines the dedupe + reporting indexes", async () => {
    const db = mockDb();
    await ensureContinuityGapTable(db);
    expect((db.query as any)).toHaveBeenCalledWith(expect.stringContaining("DEFINE TABLE IF NOT EXISTS continuity_gap SCHEMAFULL"));
    expect((db.query as any)).toHaveBeenCalledWith(
      expect.stringContaining("idx_cg_dedupe ON TABLE continuity_gap COLUMNS user_id, workspace_id, project_key, dedupe_key UNIQUE"),
    );
    expect((db.query as any)).toHaveBeenCalledWith(
      expect.stringContaining("idx_cg_report ON TABLE continuity_gap COLUMNS user_id, workspace_id, project_key, status, last_seen_at"),
    );
  });

  it("ensureContinuityGapBuildStateTable + ensureContinuityReportStateTable define their unique indexes", async () => {
    const db1 = mockDb();
    await ensureContinuityGapBuildStateTable(db1);
    expect((db1.query as any)).toHaveBeenCalledWith(expect.stringContaining("evaluated_through"));
    expect((db1.query as any)).toHaveBeenCalledWith(expect.stringContaining("idx_cgbs_user_workspace_project"));
    const db2 = mockDb();
    await ensureContinuityReportStateTable(db2);
    expect((db2.query as any)).toHaveBeenCalledWith(expect.stringContaining("reported_content_hash"));
    expect((db2.query as any)).toHaveBeenCalledWith(expect.stringContaining("idx_crs_user_workspace_project"));
  });
});

// ── Real-DB behavior ──────────────────────────────────────────────────────────

const TEST_DB = "continuity_gap_78sy4_repro_test";
const USER = "_78sy4_repro_user";

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

function makeWrite(over: Partial<ContinuityGapWrite> = {}): ContinuityGapWrite {
  return {
    userId: USER,
    workspaceId: "-",
    projectKey: "project:runir",
    kind: "unfiled_intent",
    title: "Unfiled intentions",
    summary: "some work discussed",
    recommendation: "file it",
    relatedWorkItems: [],
    evidence: [{ sourceType: "semiote", sourceId: "s1", label: "ev", sensitivity: "normal" }],
    score: 0.2,
    confidence: "weak",
    status: "new",
    dedupeKey: "unfiled_intent:hash-A",
    ...over,
  };
}

let db: SurrealClient;
let dbAvailable = false;

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
    "REMOVE TABLE IF EXISTS continuity_gap; REMOVE TABLE IF EXISTS continuity_gap_build_state; REMOVE TABLE IF EXISTS continuity_report_state;",
  );
  await ensureContinuityGapTable(db);
  await ensureContinuityGapBuildStateTable(db);
  await ensureContinuityReportStateTable(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => undefined);
    await db.close().catch(() => undefined);
  }
});

describe("continuity_gap real-DB dedupe + lifecycle", () => {
  it("re-detecting the same dedupeKey UPDATES (no duplicate); first_seen fixed, last_seen advances", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const dk = "unfiled_intent:dedupe-test";
    const a = await upsertContinuityGap(db, makeWrite({ dedupeKey: dk, lastSeenAt: "2026-07-03T00:00:00.000Z" }));
    const b = await upsertContinuityGap(db, makeWrite({ dedupeKey: dk, summary: "updated summary", lastSeenAt: "2026-07-04T00:00:00.000Z" }));

    expect(b.id).toBe(a.id); // same deterministic record id
    const rows = (await getContinuityGaps(db, USER, "-", "project:runir")).filter((g) => g.dedupeKey === dk);
    expect(rows.length).toBe(1); // no duplicate
    expect(rows[0].firstSeenAt).toBe(a.firstSeenAt); // set once
    expect(new Date(rows[0].lastSeenAt).getTime()).toBeGreaterThan(new Date(a.lastSeenAt).getTime());
    expect(rows[0].summary).toBe("updated summary");
    expect(rows[0].status).toBe("active"); // new → active on re-sighting
  });

  it("dismissed rows stay dismissed on same-key re-detect; NEW evidence surfaces a fresh row", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const pk = "project:dismiss";
    const dkOld = "unfiled_intent:old-content";
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, dedupeKey: dkOld }));
    // Dismiss it.
    const existing = (await getContinuityGaps(db, USER, "-", pk)).find((g) => g.dedupeKey === dkOld)!;
    await setGapStatus(db, existing.id, "dismissed");
    // Same-key re-detect → still dismissed (sticky), no resurface into new/active.
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, dedupeKey: dkOld }));
    const active = await getContinuityGaps(db, USER, "-", pk, ["new", "active"]);
    expect(active.find((g) => g.dedupeKey === dkOld)).toBeUndefined();
    const dismissed = await getContinuityGaps(db, USER, "-", pk, ["dismissed"]);
    expect(dismissed.find((g) => g.dedupeKey === dkOld)).toBeTruthy();
    // NEW content → new dedupeKey → a fresh active row surfaces (dismissal never suppresses new evidence).
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, dedupeKey: "unfiled_intent:new-content" }));
    const activeAfter = await getContinuityGaps(db, USER, "-", pk, ["new", "active"]);
    expect(activeAfter.find((g) => g.dedupeKey === "unfiled_intent:new-content")).toBeTruthy();
  });

  it("reopenIfSuperseded: a superseded row REOPENS (status->new, evidence refreshed) on same-key re-detect", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // Rúnir-78sy.7 Part B (Codex MAJOR-1): missing_handoff is NOT monotonic — a
    // gap superseded while a handoff signal existed can become valid again when
    // that signal later disappears. The sticky store must not silence it forever.
    const pk = "project:reopen";
    const dk = "missing_handoff:sess-reopen";
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, kind: "missing_handoff", dedupeKey: dk, summary: "first detect" }));
    const existing = (await getContinuityGaps(db, USER, "-", pk)).find((g) => g.dedupeKey === dk)!;
    await setGapStatus(db, existing.id, "superseded");
    // Refire WITHOUT the reopen flag → stays superseded (today's default behavior, unchanged).
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, kind: "missing_handoff", dedupeKey: dk, summary: "refire no-reopen" }));
    const stillSuperseded = await getContinuityGaps(db, USER, "-", pk, ["superseded"]);
    expect(stillSuperseded.find((g) => g.dedupeKey === dk)).toBeTruthy();
    // Refire WITH the reopen flag → REOPENS to "new", evidence/summary refreshed.
    await upsertContinuityGap(
      db,
      makeWrite({ projectKey: pk, kind: "missing_handoff", dedupeKey: dk, summary: "refire with reopen" }),
      { reopenIfSuperseded: true },
    );
    const activeAfter = await getContinuityGaps(db, USER, "-", pk, ["new", "active"]);
    const reopened = activeAfter.find((g) => g.dedupeKey === dk);
    expect(reopened).toBeTruthy();
    expect(reopened?.status).toBe("new");
    expect(reopened?.summary).toBe("refire with reopen");
    expect(reopened?.id).toBe(existing.id); // same deterministic record id, not a new row
  });

  it("reopenIfSuperseded: dismissed stays terminal even with the reopen flag set (user intent)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const pk = "project:reopen-dismissed";
    const dk = "missing_handoff:sess-dismissed";
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, kind: "missing_handoff", dedupeKey: dk }));
    const existing = (await getContinuityGaps(db, USER, "-", pk)).find((g) => g.dedupeKey === dk)!;
    await setGapStatus(db, existing.id, "dismissed");
    await upsertContinuityGap(
      db,
      makeWrite({ projectKey: pk, kind: "missing_handoff", dedupeKey: dk, summary: "refire after dismiss" }),
      { reopenIfSuperseded: true },
    );
    const dismissedAfter = await getContinuityGaps(db, USER, "-", pk, ["dismissed"]);
    expect(dismissedAfter.find((g) => g.dedupeKey === dk)).toBeTruthy();
    const activeAfter = await getContinuityGaps(db, USER, "-", pk, ["new", "active"]);
    expect(activeAfter.find((g) => g.dedupeKey === dk)).toBeUndefined();
  });

  it("listActiveGapsForKind returns only active/new of that kind", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const pk = "project:list";
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, kind: "unfiled_intent", dedupeKey: "unfiled_intent:k1" }));
    await upsertContinuityGap(db, makeWrite({ projectKey: pk, kind: "started_unfinished", dedupeKey: "started_unfinished:k2" }));
    const unfiled = await listActiveGapsForKind(db, USER, "-", pk, "unfiled_intent");
    expect(unfiled.every((g) => g.kind === "unfiled_intent")).toBe(true);
    expect(unfiled.some((g) => g.dedupeKey === "unfiled_intent:k1")).toBe(true);
  });

  it("markGapReported stamps last_reported_at", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const pk = "project:report";
    const g = await upsertContinuityGap(db, makeWrite({ projectKey: pk, dedupeKey: "unfiled_intent:rep" }));
    await markGapReported(db, g.id, "2026-07-04T00:00:00.000Z");
    const rows = await getContinuityGaps(db, USER, "-", pk);
    expect(rows.find((r) => r.id === g.id)?.lastReportedAt).toBeTruthy();
  });

  it("evaluated_through + report-state cursors round-trip", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    await writeGapEvaluatedThrough(db, USER, "-", "project:cursor", "2026-07-04T00:00:00.000Z");
    expect(await readGapEvaluatedThrough(db, USER, "-", "project:cursor")).toBe("2026-07-04T00:00:00.000Z");
    expect(await readGapEvaluatedThrough(db, USER, "-", "project:none")).toBeNull();

    await writeContinuityReportState(db, USER, "-", "project:cursor", "hash-xyz", "2026-07-04T00:00:00.000Z");
    const rs = await readContinuityReportState(db, USER, "-", "project:cursor");
    expect(rs?.reportedContentHash).toBe("hash-xyz");
  });
});
