/**
 * vault-exporter-v2.test.ts — Rúnir-78sy.2 (Archeion v2 re-point)
 *
 * Covers the v2 exporter contract:
 *  - semiote field mapping (top-level snake_case, payload fallback, real
 *    `ORDER BY created_at` sort key)
 *  - tenant scoping: foreign-tenant rows never reach the vault
 *  - §9.2 redaction-before-disk (bearer-token / key-shaped strings)
 *  - diff-based cleanup: stale managed files removed at the END, no pre-clean,
 *    unmanaged files untouched
 *  - PARA project routing via project_key / path
 *  - manifest source row counts + cursor
 *  - one-time legacy `memories` snapshot, guarded on file absence
 *  - continuity (project_state) + noema exports
 *  - stage-level progress logging to stderr
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm, access, mkdir, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  runVaultExport,
  mapRow,
  redactExportText,
} from "../lifecycle/archive/vault-exporter.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

const OWN_USER = "brooks";
const FOREIGN_USER = "w077-probe";

function semioteRow(overrides: Record<string, unknown> = {}): any {
  const payloadOverrides = (overrides.payload as Record<string, unknown> | undefined) ?? {};
  return {
    id: { id: randomUUID() },
    user_id: OWN_USER,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
    scope: "user",
    active: true,
    confidence: 0.9,
    ...overrides,
    payload: {
      l2: "Semiote detail body.",
      l0: "Semiote title",
      l1: "Semiote overview",
      category: "cases",
      tier: "working",
      tags: [],
      source: "memory-hybrid",
      writeSource: "capture",
      ...payloadOverrides,
    },
  };
}

/** Emulates the tenant-scoped v2 queries and records every SQL statement. */
class V2MockClient {
  readonly queries: Array<{ sql: string; vars?: Record<string, unknown> }> = [];
  failSynthesis = false;
  synthNotes: any[] = [];

  constructor(
    private readonly semiotes: any[] = [],
    private readonly entities: any[] = [],
    private readonly projectStates: any[] = [],
    private readonly noemas: any[] = [],
    private readonly legacyMemories: any[] = [],
  ) {}

  private byTenant(rows: any[], vars?: Record<string, unknown>): any[] {
    const userId = String(vars?.userId ?? "");
    return rows.filter((r) =>
      (r?.user_id ?? r?.userId ?? r?.payload?.userId ?? "") === userId);
  }

  async query(sql: string, vars?: Record<string, unknown>): Promise<any[][]> {
    this.queries.push({ sql, vars });
    if (sql.includes("synthesis_notes")) {
      if (this.failSynthesis) throw new Error("synthesis fetch outage");
      return [this.synthNotes];
    }
    if (sql.includes("FROM semiote") && sql.includes("(active = NONE OR active = true)")) {
      return [this.byTenant(this.semiotes.filter((r) => r.active !== false), vars)];
    }
    if (sql.includes("FROM semiote") && sql.includes("active = false")) {
      return [this.byTenant(this.semiotes.filter((r) => r.active === false), vars)];
    }
    if (sql.includes("FROM entities")) {
      return [this.byTenant(this.entities, vars)];
    }
    if (sql.includes("GROUP BY in")) {
      // Rúnir-78sy.6 C3: the batched aggregation, multi-row {in, count} shape.
      // No test in this file asserts mention-count values — empty is safe.
      return [[]];
    }
    if (sql.includes("FROM project_state")) {
      return [this.byTenant(this.projectStates, vars)];
    }
    if (sql.includes("FROM noema")) {
      return [this.byTenant(this.noemas, vars)];
    }
    if (sql.includes("FROM memories")) {
      return [this.legacyMemories];
    }
    return [[]];
  }
}

async function collectAllFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const full = join(root, entry.name);
      return entry.isDirectory() ? collectAllFiles(full) : [full];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

describe("vault-exporter v2 (Rúnir-78sy.2)", () => {
  const tmpBase = join(tmpdir(), `vault-v2-test-${randomUUID()}`);
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await rm(tmpBase, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Field mapping
  // -------------------------------------------------------------------------

  it("mapRow maps top-level snake_case semiote fields (created_at, user_id, superseded_by, …)", () => {
    const id = randomUUID();
    const mapped = mapRow({
      id: { id },
      user_id: OWN_USER,
      created_at: "2026-06-15T08:00:00.000Z",
      updated_at: "2026-06-16T09:00:00.000Z",
      scope: "user",
      session_id: "sess-top-level",
      confidence: 0.77,
      active: false,
      inactive_at: "2026-06-17T00:00:00.000Z",
      inactive_reason: "superseded",
      superseded_by: "semiote:⟨99999999-9999-9999-9999-999999999999⟩",
      lineage_root_id: "11111111-1111-1111-1111-111111111111",
      memory_role: "current_status",
      path: "/Users/brooks/Code/runir",
      project_key: "runir",
      source_client: "claude-code",
      valid_at: "2026-06-15T08:00:00.000Z",
      payload: { l0: "Title", l1: "", l2: "Body", category: "cases", tier: "working", tags: [] },
    });

    expect(mapped).not.toBeNull();
    expect(mapped!.userId).toBe(OWN_USER);
    expect(mapped!.createdAt).toBe("2026-06-15");
    expect(mapped!.updatedAt).toBe("2026-06-16T09:00:00.000Z");
    expect(mapped!.sessionId).toBe("sess-top-level");
    expect(mapped!.confidence).toBe(0.77);
    expect(mapped!.active).toBe(false);
    expect(mapped!.inactiveReason).toBe("superseded");
    expect(mapped!.supersededById).toBe("99999999-9999-9999-9999-999999999999");
    expect(mapped!.lineageRootId).toBe("11111111-1111-1111-1111-111111111111");
    expect(mapped!.memoryRole).toBe("current_status");
    expect(mapped!.path).toBe("/Users/brooks/Code/runir");
    expect(mapped!.projectKey).toBe("runir");
    expect(mapped!.sourceClient).toBe("claude-code");
  });

  it("mapRow never maps payload.raw_source_text (§9.2 — verbatim session text stays out)", () => {
    const mapped = mapRow(semioteRow({
      payload: { raw_source_text: "VERBATIM-SESSION-TEXT-MUST-NOT-EXPORT" },
    }));
    expect(mapped).not.toBeNull();
    expect(JSON.stringify(mapped)).not.toContain("VERBATIM-SESSION-TEXT-MUST-NOT-EXPORT");
  });

  it("queries semiote with the real snake_case sort key (ORDER BY created_at), never createdAt", async () => {
    const db = new V2MockClient([semioteRow()]);
    await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    const semioteQueries = db.queries.filter((q) => q.sql.includes("FROM semiote"));
    expect(semioteQueries.length).toBeGreaterThanOrEqual(2);
    for (const q of semioteQueries) {
      expect(q.sql).toContain("ORDER BY created_at");
      expect(q.sql).not.toContain("createdAt");
      expect(q.sql).toContain("user_id = $userId");
      expect(q.vars?.userId).toBe(OWN_USER);
    }
    // The legacy memories table is only read by the one-time snapshot path.
    const memoriesQueries = db.queries.filter((q) => q.sql.includes("FROM memories"));
    expect(memoriesQueries.length).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Tenant scoping
  // -------------------------------------------------------------------------

  it("foreign-tenant semiote/project_state/entity rows never appear anywhere in the vault", async () => {
    const db = new V2MockClient(
      [
        semioteRow({ payload: { l2: "OWN-TENANT-FACT alpha." } }),
        semioteRow({ user_id: FOREIGN_USER, payload: { l2: "FOREIGN-TENANT-FACT beta." } }),
      ],
      [
        {
          id: "entities:own", kind: "concept", canonicalName: "Own Concept",
          nameNorm: "own concept", aliases: ["OWN-ENTITY-ALIAS"], aliasesNorm: [],
          sourceProject: "runir", firstSeenAt: "2026-07-01T00:00:00Z", lastSeenAt: "2026-07-01T00:00:00Z",
          confidence: 0.9, scope: "user", userId: OWN_USER,
          createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
          aliases_enriched_at: "2026-07-01T00:00:00Z",
        },
        {
          id: "entities:foreign", kind: "concept", canonicalName: "FOREIGN-ENTITY-NAME",
          nameNorm: "foreign entity", aliases: [], aliasesNorm: [],
          sourceProject: "runir", firstSeenAt: "2026-07-01T00:00:00Z", lastSeenAt: "2026-07-01T00:00:00Z",
          confidence: 0.9, scope: "user", userId: FOREIGN_USER,
          createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
          aliases_enriched_at: "2026-07-01T00:00:00Z",
        },
      ],
      [
        { id: "project_state:own", user_id: OWN_USER, project_key: "runir", current_focus: "OWN-FOCUS", updated_at: "2026-07-01T00:00:00Z", version: 1 },
        { id: "project_state:foreign", user_id: FOREIGN_USER, project_key: "harness", current_focus: "FOREIGN-FOCUS", updated_at: "2026-07-01T00:00:00Z", version: 1 },
      ],
      [
        { id: { id: "noema-own" }, user_id: OWN_USER, canonical_text: "OWN-CLAIM text.", active: true, updated_at: "2026-07-01T00:00:00Z" },
        { id: { id: "noema-foreign" }, user_id: FOREIGN_USER, canonical_text: "FOREIGN-CLAIM text.", active: true, updated_at: "2026-07-01T00:00:00Z" },
      ],
    );

    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    expect(result.memoriesExported).toBe(1);
    expect(result.entitiesExported).toBe(1);
    expect(result.continuityStatesExported).toBe(1);
    expect(result.noemasExported).toBe(1);

    const files = await collectAllFiles(tmpBase);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf-8");
      expect(content).not.toContain("FOREIGN-TENANT-FACT");
      expect(content).not.toContain("FOREIGN-ENTITY-NAME");
      expect(content).not.toContain("FOREIGN-FOCUS");
      expect(content).not.toContain("FOREIGN-CLAIM");
    }
    const combined = (await Promise.all(files.map((f) => readFile(f, "utf-8")))).join("\n");
    expect(combined).toContain("OWN-TENANT-FACT");
    expect(combined).toContain("OWN-FOCUS");
    expect(combined).toContain("OWN-CLAIM");
  });

  // -------------------------------------------------------------------------
  // Redaction-before-disk (§9.2)
  // -------------------------------------------------------------------------

  it("redactExportText strips bearer-token and key-shaped strings but keeps paths/URLs/emails", () => {
    const input =
      "Use Bearer abcDEF123456789 with key sk-abcdefghijklmnopqrstuv and password: hunter2 "
      + "at https://example.com/docs from /Users/brooks/Code/runir (mail brooks@example.com)";
    const out = redactExportText(input);
    expect(out).not.toContain("abcDEF123456789");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[BEARER_TOKEN_1]");
    expect(out).toContain("[API_KEY_1]");
    expect(out).toContain("[PASSWORD_ASSIGNMENT_1]");
    // Personal-vault content stays readable — PII kinds are NOT redacted here.
    expect(out).toContain("https://example.com/docs");
    expect(out).toContain("/Users/brooks/Code/runir");
    expect(out).toContain("brooks@example.com");
  });

  it("secret-shaped strings in memory bodies never reach the exported md or items.json", async () => {
    const db = new V2MockClient([
      semioteRow({
        payload: {
          l0: "Auth fix",
          l2: "Set the header to Bearer secrettoken12345 and rotate sk-zzzzyyyyxxxxwwwwvvvvuuuu.",
        },
      }),
    ]);
    await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    const files = await collectAllFiles(tmpBase);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, "utf-8");
      expect(content).not.toContain("secrettoken12345");
      expect(content).not.toContain("sk-zzzzyyyyxxxxwwwwvvvvuuuu");
    }
    const itemsFiles = files.filter((f) => f.endsWith("items.json"));
    expect(itemsFiles.length).toBeGreaterThan(0);
    // Redaction of items.json keeps it valid JSON.
    for (const itemsFile of itemsFiles) {
      const parsed = JSON.parse(await readFile(itemsFile, "utf-8"));
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Diff-based cleanup
  // -------------------------------------------------------------------------

  it("removes stale managed files at the end without a pre-clean and leaves unmanaged files alone", async () => {
    // Pre-existing state: a stale managed file, a stale managed meta file,
    // and an unmanaged user note that must survive.
    await mkdir(join(tmpBase, "02 Areas", "cases"), { recursive: true });
    await writeFile(join(tmpBase, "02 Areas", "cases", "stale-note.md"), "# stale\n", "utf-8");
    await mkdir(join(tmpBase, "99 Meta", "02 Areas", "cases"), { recursive: true });
    await writeFile(join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"), "[]", "utf-8");
    await mkdir(join(tmpBase, "97 My Notes"), { recursive: true });
    await writeFile(join(tmpBase, "97 My Notes", "keep-me.md"), "# mine\n", "utf-8");

    const db = new V2MockClient([
      semioteRow({ payload: { l0: "Fresh case", l2: "Fresh case body." } }),
    ]);
    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    // Stale managed file is gone; the fresh export exists; unmanaged survives.
    await expect(access(join(tmpBase, "02 Areas", "cases", "stale-note.md"))).rejects.toThrow();
    await access(join(tmpBase, "97 My Notes", "keep-me.md"));
    const freshItems = await readFile(join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"), "utf-8");
    expect(JSON.parse(freshItems)).toHaveLength(1);
    expect(result.staleFilesRemoved).toBeGreaterThanOrEqual(1);
  });

  it("second run keeps freshly produced files (idempotent overwrite, no delete-then-rewrite window)", async () => {
    const db = new V2MockClient([
      semioteRow({ payload: { l0: "Stable memory", l2: "Stable body." } }),
    ]);
    await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });
    const firstFiles = (await collectAllFiles(tmpBase)).sort();
    const result2 = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });
    const secondFiles = (await collectAllFiles(tmpBase)).sort();

    expect(secondFiles).toEqual(firstFiles);
    expect(result2.staleFilesRemoved).toBe(0);
  });

  // -------------------------------------------------------------------------
  // PARA project routing (project_key / path)
  // -------------------------------------------------------------------------

  it("routes memories to 01 Projects/<slug>/ via project_key, falling back to path basename", async () => {
    const db = new V2MockClient([
      semioteRow({ project_key: "runir", payload: { l0: "Keyed memory", l2: "Keyed body." } }),
      semioteRow({ path: "/Users/brooks/Code/leit", payload: { l0: "Pathed memory", l2: "Pathed body." } }),
      semioteRow({ payload: { l0: "Projectless memory", l2: "No project discriminator." } }),
    ]);
    await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    const keyed = await readFile(join(tmpBase, "99 Meta", "01 Projects", "runir", "items.json"), "utf-8");
    expect(JSON.parse(keyed)).toHaveLength(1);
    const pathed = await readFile(join(tmpBase, "99 Meta", "01 Projects", "leit", "items.json"), "utf-8");
    expect(JSON.parse(pathed)).toHaveLength(1);
    // Projectless working/cases memory keeps the PARA structure (02 Areas/cases).
    const areas = await readFile(join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"), "utf-8");
    expect(JSON.parse(areas)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Manifest: source counts + cursor
  // -------------------------------------------------------------------------

  it("manifest carries per-table source row counts and the max semiote timestamp cursor", async () => {
    const db = new V2MockClient(
      [
        semioteRow({ created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-02T00:00:00.000Z" }),
        semioteRow({
          active: false,
          created_at: "2026-07-02T12:34:56.000Z",
          updated_at: "2026-07-02T12:34:56.000Z",
          payload: { l0: "Archived", l2: "Archived body." },
        }),
      ],
      [],
      [{ id: "project_state:x", user_id: OWN_USER, project_key: "runir", updated_at: "2026-07-01T00:00:00Z", version: 1 }],
      [{ id: { id: "n1" }, user_id: OWN_USER, canonical_text: "A claim.", active: true, updated_at: "2026-07-01T00:00:00Z" }],
    );
    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    const manifest = JSON.parse(
      await readFile(join(tmpBase, "99 Meta", "export-manifest.json"), "utf-8"),
    );
    expect(manifest.userId).toBe(OWN_USER);
    expect(manifest.sourceCounts).toEqual({
      semiote_active: 1,
      semiote_archived: 1,
      entities: 0,
      synthesis_notes: 0,
      noema: 1,
      project_state: 1,
    });
    expect(manifest.cursor).toBe("2026-07-02T12:34:56.000Z");
    expect(result.cursor).toBe("2026-07-02T12:34:56.000Z");
  });

  // -------------------------------------------------------------------------
  // Legacy memories snapshot
  // -------------------------------------------------------------------------

  it("writes the legacy memories snapshot once, then never overwrites it", async () => {
    const legacyRows = [
      { id: { id: randomUUID() }, user_id: "sim-2026-04-02-v3", created_at: "2026-04-01T20:18:53.902Z", payload: { l2: "sim debris" } },
    ];
    const db = new V2MockClient([semioteRow()], [], [], [], legacyRows);
    const snapPath = join(tmpBase, "99 Meta", "legacy-memories-snapshot.json");

    const first = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });
    expect(first.legacySnapshotWritten).toBe(true);
    const snapshot = JSON.parse(await readFile(snapPath, "utf-8"));
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.rows).toHaveLength(1);

    // Tamper-mark the file: a second run must NOT rewrite it.
    const marked = { ...snapshot, marker: "do-not-overwrite" };
    await writeFile(snapPath, JSON.stringify(marked), "utf-8");
    const second = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });
    expect(second.legacySnapshotWritten).toBe(false);
    const after = JSON.parse(await readFile(snapPath, "utf-8"));
    expect(after.marker).toBe("do-not-overwrite");
  });

  it("skips the legacy snapshot when the memories table is empty (fresh vaults)", async () => {
    const db = new V2MockClient([semioteRow()]);
    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });
    expect(result.legacySnapshotWritten).toBe(false);
    await expect(access(join(tmpBase, "99 Meta", "legacy-memories-snapshot.json"))).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Continuity + stage logging
  // -------------------------------------------------------------------------

  it("writes project_state rows into 07 Continuity/projects/ with focus/progress/next steps", async () => {
    const db = new V2MockClient(
      [],
      [],
      [{
        id: "project_state:runir",
        user_id: OWN_USER,
        project_key: "runir",
        path: "/Users/brooks/Code/runir",
        current_focus: "Ship the Archeion v2 exporter re-point",
        latest_progress: "Audit landed; re-point in flight",
        blockers: ["waiting on live verification"],
        next_steps: ["run the orchestrator's live export"],
        active_ticket_ids: ["Rúnir-78sy.2"],
        updated_at: "2026-07-03T00:00:00Z",
        version: 3,
      }],
    );
    await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    const content = await readFile(join(tmpBase, "07 Continuity", "projects", "runir.md"), "utf-8");
    expect(content).toContain("type: project-continuity");
    expect(content).toContain("projectKey: runir");
    expect(content).toContain("Ship the Archeion v2 exporter re-point");
    expect(content).toContain("- waiting on live verification");
    expect(content).toContain("- run the orchestrator's live export");
    expect(content).toContain("- Rúnir-78sy.2");
  });

  // -------------------------------------------------------------------------
  // Codex adversarial-review follow-ups (Rúnir-78sy.2 commit 3)
  // -------------------------------------------------------------------------

  it("mapRow falls back to payload supersede provenance", () => {
    const mapped = mapRow(semioteRow({
      payload: { supersedeProvenance: "payload-provenance" },
    }));
    expect(mapped!.supersedeProvenance).toBe("payload-provenance");
  });

  it("rejects empty, relative, and root vault paths before touching anything", async () => {
    const db = new V2MockClient([semioteRow()]);
    await expect(runVaultExport(db as unknown as SurrealClient, "", { userId: OWN_USER })).rejects.toThrow(/invalid vault path/);
    await expect(runVaultExport(db as unknown as SurrealClient, "relative/vault", { userId: OWN_USER })).rejects.toThrow(/invalid vault path/);
    await expect(runVaultExport(db as unknown as SurrealClient, "/", { userId: OWN_USER })).rejects.toThrow(/invalid vault path/);
  });

  it("skips synthesis notes referencing memories the tenant does not own, without suppressing raw export", async () => {
    const owned = semioteRow({ payload: { l0: "Owned memory", l2: "Owned body." } });
    const db = new V2MockClient([owned]);
    const ownedId = String(owned.id.id);
    db.synthNotes = [{
      id: "syn-foreign",
      l0: "Foreign synthesis",
      l1: "",
      l2: "Covers a foreign memory",
      clusterId: "c1",
      // references the owned memory AND a foreign one -> not fully tenant-owned
      memoryIds: [ownedId, "99999999-9999-9999-9999-999999999999"],
      entityIds: [],
      tags: [],
      para_placement: "02 Areas",
      lastMemoryCount: 2,
      updateCount: 0,
      createdAt: "2026-07-01T00:00:00Z",
    }];

    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    expect(result.synthesisNotesExported).toBe(0);
    // The owned memory is NOT suppressed by the skipped foreign note.
    const items = await readFile(join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"), "utf-8");
    expect(JSON.parse(items)).toHaveLength(1);
    const files = await collectAllFiles(tmpBase);
    for (const file of files) {
      expect(await readFile(file, "utf-8")).not.toContain("Foreign synthesis");
    }
  });

  it("a transient synthesis failure disables the stale sweep for that run", async () => {
    // Seed a stale managed file that WOULD be swept on a healthy run.
    await mkdir(join(tmpBase, "02 Areas", "synthesis"), { recursive: true });
    await writeFile(join(tmpBase, "02 Areas", "synthesis", "previous.md"), "# prior synthesis\n", "utf-8");

    const db = new V2MockClient([semioteRow()]);
    db.failSynthesis = true;
    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    await access(join(tmpBase, "02 Areas", "synthesis", "previous.md"));
    expect(result.staleFilesRemoved).toBe(0);
    const lines: string[] = stderrSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l) => l.includes("stage=clean") && l.includes("skipped=true") && l.includes("reason=stage_failure"))).toBe(true);
  });

  it("an empty-output run (wrong tenant / empty DB) never guts a previously good vault", async () => {
    await mkdir(join(tmpBase, "02 Areas", "cases"), { recursive: true });
    await writeFile(join(tmpBase, "02 Areas", "cases", "good-note.md"), "# keep\n", "utf-8");

    const db = new V2MockClient([]); // nothing for any tenant
    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: "nonexistent-user" });

    await access(join(tmpBase, "02 Areas", "cases", "good-note.md"));
    expect(result.staleFilesRemoved).toBe(0);
    const lines: string[] = stderrSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l) => l.includes("stage=clean") && l.includes("skipped=true") && l.includes("reason=empty_output"))).toBe(true);
  });

  it("refuses writes escaping the vault root (DB-controlled para_placement) without poisoning the sweep", async () => {
    const escapeDir = `escape-${randomUUID()}`;
    const owned = semioteRow();
    const db = new V2MockClient([owned]);
    db.synthNotes = [{
      id: "syn-escape",
      l0: "Escape attempt",
      l1: "",
      l2: "should never land outside the vault",
      clusterId: "c1",
      // Tenant-owned reference so the note reaches the write path.
      memoryIds: [String(owned.id.id)],
      entityIds: [],
      tags: [],
      para_placement: join("..", escapeDir),
      lastMemoryCount: 1,
      updateCount: 0,
      createdAt: "2026-07-01T00:00:00Z",
    }];

    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    // Nothing escaped the vault root...
    await expect(access(join(tmpBase, "..", escapeDir))).rejects.toThrow();
    // ...the bad note was skipped per-note and the run completed.
    expect(result.ok).toBe(true);
    expect(result.synthesisNotesExported).toBe(0);
    const lines: string[] = stderrSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l) => l.includes("stage=synthesis") && l.includes("skipped_invalid=1"))).toBe(true);
    // A deterministic bad row must NOT disable stale sweeping (Codex round-2).
    expect(lines.some((l) => l.includes("stage=clean") && l.includes("stale_removed="))).toBe(true);
  });

  it("skips synthesis notes with empty memoryIds (no provenance = not tenant-ownable)", async () => {
    const db = new V2MockClient([semioteRow()]);
    db.synthNotes = [{
      id: "syn-empty",
      l0: "Unattributable synthesis",
      l1: "",
      l2: "no memory provenance",
      clusterId: "c1",
      memoryIds: [],
      entityIds: [],
      tags: [],
      para_placement: "02 Areas",
      lastMemoryCount: 0,
      updateCount: 0,
      createdAt: "2026-07-01T00:00:00Z",
    }];

    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    expect(result.synthesisNotesExported).toBe(0);
    const files = await collectAllFiles(tmpBase);
    for (const file of files) {
      expect(await readFile(file, "utf-8")).not.toContain("Unattributable synthesis");
    }
  });

  it("the legacy snapshot alone never licenses a sweep (wrong-tenant run with legacy rows)", async () => {
    await mkdir(join(tmpBase, "02 Areas", "cases"), { recursive: true });
    await writeFile(join(tmpBase, "02 Areas", "cases", "good-note.md"), "# keep\n", "utf-8");

    const legacyRows = [
      { id: { id: randomUUID() }, user_id: "sim-2026-04-02-v3", created_at: "2026-04-01T20:18:53.902Z", payload: { l2: "sim debris" } },
    ];
    const db = new V2MockClient([], [], [], [], legacyRows); // no tenant content at all
    const result = await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: "nonexistent-user" });

    // Snapshot written (produced.size > 0) — but managed folders survive.
    expect(result.legacySnapshotWritten).toBe(true);
    await access(join(tmpBase, "02 Areas", "cases", "good-note.md"));
    expect(result.staleFilesRemoved).toBe(0);
    const lines: string[] = stderrSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l) => l.includes("stage=clean") && l.includes("skipped=true") && l.includes("reason=empty_output"))).toBe(true);
  });

  it("emits one stderr progress line per stage with timings", async () => {
    const db = new V2MockClient([semioteRow()]);
    await runVaultExport(db as unknown as SurrealClient, tmpBase, { userId: OWN_USER });

    const lines: string[] = stderrSpy.mock.calls.map((c: any[]) => String(c[0]));
    for (const stage of ["synthesis", "fetch", "notes", "entities", "continuity", "noema", "legacy_snapshot", "clean", "manifest"]) {
      // Match the stage-TIMING line specifically (` ms=`), not the separate
      // per-N ` progress=` lines notes/entities also emit (Rúnir-78sy.6 C2) —
      // both share the `stage=<name>` prefix by the brief's own log format.
      const stageLines = lines.filter((l: string) => l.includes(`[vault-exporter] stage=${stage} ms=`));
      expect(stageLines, `stage=${stage}`).toHaveLength(1);
      expect(stageLines[0]).toMatch(new RegExp(`stage=${stage} ms=\\d+`));
    }
  });
});
