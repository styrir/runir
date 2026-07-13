import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm, access, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  runVaultExport,
  deriveFilename,
  mapRow,
  validateExport,
} from "../lifecycle/archive/vault-exporter.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import type { EntityRecord } from "../domain/memory/types.js";

const MEM1_ID = "11111111-1111-1111-1111-111111111111";
const MEM2_ID = "22222222-2222-2222-2222-222222222222";
const MEM3_ID = "33333333-3333-3333-3333-333333333333";
const MEM4_ID = "44444444-4444-4444-4444-444444444444";
const MEM5_ID = "55555555-5555-5555-5555-555555555555";
const MEM6_ID = "66666666-6666-6666-6666-666666666666";

function createMemoryRow(overrides: Record<string, unknown> = {}) {
  const payloadOverrides = (overrides.payload as Record<string, unknown> | undefined) ?? {};
  const basePayload = {
    l2: "JWT_EXPIRY race condition fix: Set JWT_EXPIRY=3600.",
    l0: "JWT_EXPIRY: Set to 3600s to fix auth token race",
    l1: "## Problem\nJWT tokens expired before poll.",
    category: "cases",
    tier: "working",
    factKey: "cases:jwt-expiry-a1b2c3",
    tags: ["jwt", "auth"],
    scope: "user",
    userId: "default",
    confidence: 0.95,
    createdAt: "2026-03-24T10:00:00Z",
    updatedAt: "2026-03-24T10:00:00Z",
    active: true,
    source: "memory-hybrid",
    writeSource: "capture",
  };

  return {
    id: { id: MEM1_ID },
    ...overrides,
    payload: {
      ...basePayload,
      ...payloadOverrides,
    },
  };
}

function createEntity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: "entities:alpha",
    kind: "concept",
    canonicalName: "Alpha Concept",
    nameNorm: "alpha concept",
    aliases: [],
    aliasesNorm: [],
    sourceProject: "runir",
    firstSeenAt: "2026-03-24T10:00:00Z",
    lastSeenAt: "2026-03-24T10:00:00Z",
    confidence: 0.9,
    scope: "user",
    userId: "default",
    createdAt: "2026-03-24T10:00:00Z",
    updatedAt: "2026-03-24T10:00:00Z",
    ...overrides,
  };
}

/** Emulates the tenant-scoped v2 queries: semiote/entities/project_state/noema
 *  rows are filtered by the bound $userId exactly like the real DB would. */
class MockSurrealClient {
  constructor(
    private readonly activeRows: any[] = [],
    private readonly archivedRows: any[] = [],
    private readonly entities: EntityRecord[] = [],
    private readonly mentionCounts: Record<string, number> = {},
    private readonly projectStates: any[] = [],
    private readonly legacyMemories: any[] = [],
    private readonly noemas: any[] = [],
  ) {}

  private byTenant(rows: any[], vars?: Record<string, unknown>): any[] {
    const userId = String(vars?.userId ?? "");
    return rows.filter((r) =>
      (r?.user_id ?? r?.userId ?? r?.payload?.userId ?? "") === userId);
  }

  async query(sql: string, vars?: Record<string, unknown>): Promise<any[][]> {
    if (sql.includes("FROM semiote") && sql.includes("(active = NONE OR active = true)")) {
      return [this.byTenant(this.activeRows, vars)];
    }
    if (sql.includes("FROM semiote") && sql.includes("active = false")) {
      return [this.byTenant(this.archivedRows, vars)];
    }
    if (sql.includes("FROM entities")) {
      return [this.byTenant(this.entities, vars)];
    }
    if (sql.includes("GROUP BY in")) {
      // Rúnir-78sy.6 C3: the batched aggregation, multi-row {in, count} shape.
      return [Object.entries(this.mentionCounts).map(([in_, count]) => ({ in: in_, count }))];
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

describe("vault-exporter", () => {
  const tmpBase = join(tmpdir(), `vault-test-${randomUUID()}`);

  afterEach(async () => {
    delete process.env.VAULT_CONFIDENCE_THRESHOLD;
    delete process.env.VAULT_ENTITY_MIN_CONFIDENCE;
    delete process.env.VAULT_ENTITY_MIN_MENTIONS;
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("deriveFilename uses a slug fallback when l0 is empty", () => {
    const memory = mapRow(createMemoryRow({
      id: { id: MEM4_ID },
      payload: {
        l0: "",
        factKey: undefined,
        l2: "Add structured title fallback for vault exports. Extra detail follows.",
      },
    }));

    expect(memory).not.toBeNull();
    expect(deriveFilename(memory!)).toBe(
      "add-structured-title-fallback-for-vault-exports-44444444.md",
    );
  });

  it("routes low-confidence memories to 00 Inbox instead of 02 Areas", async () => {
    const lowConfidence = createMemoryRow({
      id: { id: MEM4_ID },
      payload: {
        l0: "",
        factKey: undefined,
        confidence: 0.2,
        l2: "Investigate capture noise in export staging.",
      },
    });

    const mock = new MockSurrealClient([lowConfidence]) as unknown as SurrealClient;
    const result = await runVaultExport(mock, tmpBase, { userId: "default" });

    const inboxItems = await readFile(
      join(tmpBase, "99 Meta", "00 Inbox", "cases", "items.json"),
      "utf-8",
    );
    expect(JSON.parse(inboxItems)).toHaveLength(1);

    await expect(
      access(join(tmpBase, "02 Areas", "cases", "summary.md")),
    ).rejects.toThrow();

    expect(result.memoriesExported).toBe(1);
    expect(result.foldersWritten).toBe(1);
  });

  it("writes daily notes from createdAt even when sessionId is absent", async () => {
    const sessionless = createMemoryRow({
      id: { id: MEM5_ID },
      payload: {
        l0: "",
        factKey: undefined,
        scope: "session",
        createdAt: "2026-03-26T08:30:00Z",
        l2: "Session capture without session id should still appear in the daily note.",
      },
    });

    const mock = new MockSurrealClient([sessionless]) as unknown as SurrealClient;
    await runVaultExport(mock, tmpBase, { userId: "default" });

    const note = await readFile(
      join(tmpBase, "05 Daily Notes", "2026", "2026-03-26.md"),
      "utf-8",
    );
    expect(note).toContain("# 2026-03-26");
    expect(note).toContain("Session capture without session id should still appear");
  });

  it("renames entities and misc buckets and moves items.json into 99 Meta", async () => {
    const entityNote = createMemoryRow({
      id: { id: MEM4_ID },
      payload: {
        category: "entities",
        factKey: undefined,
        l2: "Entity note content for folder rename coverage.",
        l0: "Entity note title",
      },
    });
    const miscPattern = createMemoryRow({
      id: { id: MEM6_ID },
      payload: {
        category: "misc",
        tier: "working",
        factKey: undefined,
        l2: "Pattern bucket fallback content.",
        l0: "Pattern bucket title",
      },
    });

    const mock = new MockSurrealClient([entityNote, miscPattern]) as unknown as SurrealClient;
    await runVaultExport(mock, tmpBase, { userId: "default" });

    await access(join(tmpBase, "02 Areas", "entity-notes", "summary.md"));
    await access(join(tmpBase, "02 Areas", "patterns", "summary.md"));
    await access(join(tmpBase, "99 Meta", "02 Areas", "entity-notes", "items.json"));
    await access(join(tmpBase, "99 Meta", "02 Areas", "patterns", "items.json"));
    await expect(
      access(join(tmpBase, "02 Areas", "entity-notes", "items.json")),
    ).rejects.toThrow();
    await expect(
      access(join(tmpBase, "02 Areas", "patterns", "items.json")),
    ).rejects.toThrow();
  });

  it("skips low-confidence single-mention session entities", async () => {
    const kept = createEntity({
      id: "entities:kept",
      canonicalName: "Kept Concept",
      confidence: 0.6,
      scope: "user",
    });
    const skipped = createEntity({
      id: "entities:skipped",
      canonicalName: "Skipped Session Concept",
      confidence: 0.6,
      scope: "session",
    });

    const mock = new MockSurrealClient(
      [],
      [],
      [kept, skipped],
      { "entities:kept": 1, "entities:skipped": 1 },
    ) as unknown as SurrealClient;

    const result = await runVaultExport(mock, tmpBase, { userId: "default" });

    await access(join(tmpBase, "06 Entities", "concept", "kept-concept.md"));
    await expect(
      access(join(tmpBase, "06 Entities", "concept", "skipped-session-concept.md")),
    ).rejects.toThrow();
    expect(result.entitiesExported).toBe(1);
  });

  it("a nonzero mention count (not just scope) drives the minMentions filter gate and body text (Rúnir-78sy.6 F12 gap)", async () => {
    // Both entities share confidence/scope (both would be filtered on those
    // alone) — mentionCount is the ONLY variable, proving fetchMentionCounts'
    // batched values actually reach the mentionCount <= minMentions gate and
    // the "Mentioned in N memories" body line, not just scope (the pre-
    // existing "skips low-confidence single-mention session entities" test
    // above never varied mentionCount itself).
    const aboveThreshold = createEntity({
      id: "entities:above-threshold",
      canonicalName: "Above Threshold Concept",
      confidence: 0.6,
      scope: "session",
    });
    const atThreshold = createEntity({
      id: "entities:at-threshold",
      canonicalName: "At Threshold Concept",
      confidence: 0.6,
      scope: "session",
    });

    const mock = new MockSurrealClient(
      [],
      [],
      [aboveThreshold, atThreshold],
      { "entities:above-threshold": 5, "entities:at-threshold": 1 },
    ) as unknown as SurrealClient;

    const result = await runVaultExport(mock, tmpBase, { userId: "default" });

    // mentionCount=5 > minMentions(1) → written, with the count in the body.
    const content = await readFile(
      join(tmpBase, "06 Entities", "concept", "above-threshold-concept.md"),
      "utf-8",
    );
    expect(content).toContain("*Mentioned in 5 memories.*");
    // mentionCount=1 <= minMentions(1) (same confidence/scope) → filtered out.
    await expect(
      access(join(tmpBase, "06 Entities", "concept", "at-threshold-concept.md")),
    ).rejects.toThrow();
    expect(result.entitiesExported).toBe(1);
  });

  it("mapRow rejects malformed table-prefixed ids", () => {
    const mapped = mapRow(createMemoryRow({
      id: { id: `memories:${MEM1_ID}` },
    }));

    expect(mapped).toBeNull();
  });

  it("validateExport warns on blank H1 and UUID filenames", async () => {
    const warningsDir = join(tmpBase, "02 Areas", "cases");
    await mkdir(warningsDir, { recursive: true });
    await writeFile(
      join(warningsDir, `${MEM1_ID}.md`),
      "---\nid: memories:test3\n---\n# \n\n## Detail\nBroken\n",
      "utf-8",
    );

    const warnings = await validateExport(tmpBase);

    expect(warnings.some((warning) => warning.includes("blank H1"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("UUID-only filename"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("table-prefixed id"))).toBe(true);
  });

  it("exports memories to correct PARA folders and writes manifest", async () => {
    const mem1 = createMemoryRow({
      id: { id: MEM1_ID },
      payload: {
        l2: "JWT_EXPIRY race condition fix: Set JWT_EXPIRY=3600.",
        l0: "JWT_EXPIRY: Set to 3600s to fix auth token race",
        l1: "## Problem\nJWT tokens expired before poll.",
        category: "cases",
        tier: "working",
        factKey: "cases:jwt-expiry-a1b2c3",
        tags: ["jwt", "auth"],
        scope: "user",
        confidence: 0.95,
      },
    });

    const mem2 = createMemoryRow({
      id: { id: MEM2_ID },
      payload: {
        l2: "SurrealDB debugging pattern: check JS SDK driver first.",
        l0: "Pattern: SurrealDB driver divergence check",
        l1: "## Trigger\nSurrealDB query fails via JS SDK.",
        category: "patterns",
        tier: "durable",
        factKey: "patterns:surreal-debug-b2c3d4",
        tags: ["surrealdb", "debugging"],
        createdAt: "2026-03-25T10:00:00Z",
        updatedAt: "2026-03-25T10:00:00Z",
        confidence: 0.9,
      },
    });

    const mem3 = createMemoryRow({
      id: { id: MEM3_ID },
      payload: {
        l2: "Old JWT fix: Set JWT_EXPIRY=600.",
        l0: "JWT_EXPIRY: old value 600s",
        l1: "## Superseded\nReplaced by 3600s fix.",
        category: "cases",
        tier: "working",
        factKey: "cases:jwt-old-c3d4e5",
        tags: ["jwt"],
        confidence: 0.7,
        createdAt: "2026-03-20T10:00:00Z",
        updatedAt: "2026-03-23T10:00:00Z",
        active: false,
        inactiveAt: "2026-03-23T10:00:00Z",
        inactiveReason: "superseded",
        supersededById: MEM1_ID,
      },
    });

    const mock = new MockSurrealClient([mem1, mem2], [mem3]) as unknown as SurrealClient;
    const result = await runVaultExport(mock, tmpBase, { userId: "default" });

    const casesItems = await readFile(
      join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"),
      "utf-8",
    );
    const casesData = JSON.parse(casesItems);
    expect(casesData).toHaveLength(1);
    expect(casesData[0].id).toBe(MEM1_ID);

    const patternsSummary = await readFile(
      join(tmpBase, "03 Resources", "patterns", "summary.md"),
      "utf-8",
    );
    expect(patternsSummary).toContain("# patterns");
    expect(patternsSummary).toContain("Total memories:** 1");

    const archiveItems = await readFile(
      join(tmpBase, "99 Meta", "04 Archives", "superseded", "items.json"),
      "utf-8",
    );
    const archiveData = JSON.parse(archiveItems);
    expect(archiveData).toHaveLength(1);
    expect(archiveData[0].id).toBe(MEM3_ID);

    const manifestRaw = await readFile(
      join(tmpBase, "99 Meta", "export-manifest.json"),
      "utf-8",
    );
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.ok).toBe(true);
    expect(manifest.memoriesExported).toBe(3);
    expect(manifest.entitiesExported).toBe(0);
    expect(manifest.foldersWritten).toBe(3);
    expect(manifest.vaultPath).toBe(tmpBase);
    expect(typeof manifest.runDurationMs).toBe("number");
    expect(manifest.runDurationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(manifest.validationWarnings)).toBe(true);
    expect(typeof manifest.validationWarningsCount).toBe("number");

    expect(result.ok).toBe(true);
    expect(result.memoriesExported).toBe(3);
    expect(result.entitiesExported).toBe(0);
    expect(result.foldersWritten).toBe(3);
  });
});
