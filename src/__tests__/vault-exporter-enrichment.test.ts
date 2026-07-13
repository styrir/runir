/**
 * vault-exporter-enrichment.test.ts — Per-run alias-enrichment budget for
 * /admin/export (runaway paid loop, discovered-from Rúnir-o75n.4).
 *
 * The enricher module is mocked at file level: NO real LLM call can ever be
 * made from these tests, regardless of the environment's OPENROUTER_API_KEY.
 *
 * Covers:
 *  - RUNIR_EXPORT_ENRICH_BUDGET caps paid enrichment attempts per run
 *  - budget=0 disables enrichment entirely (export otherwise unchanged)
 *  - default budget is 25
 *  - aliases_enriched_at / non-empty aliases skip enrichment without
 *    consuming budget (skip-after-enriched path)
 *  - failed attempts consume budget and the run still completes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

vi.mock("../entities/entity-alias-enricher.js", () => ({
  enrichEntityAliases: vi.fn(async () => {}),
}));

import { enrichEntityAliases } from "../entities/entity-alias-enricher.js";
import { runVaultExport } from "../lifecycle/archive/vault-exporter.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import type { EntityRecord } from "../domain/memory/types.js";

const mockEnrich = vi.mocked(enrichEntityAliases);

function createEntity(n: number, overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: `entities:e${n}`,
    kind: "concept",
    canonicalName: `Concept ${n}`,
    nameNorm: `concept ${n}`,
    aliases: [],
    aliasesNorm: [],
    sourceProject: "runir",
    firstSeenAt: "2026-07-01T10:00:00Z",
    lastSeenAt: "2026-07-01T10:00:00Z",
    confidence: 0.9,
    scope: "user",
    userId: "default",
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

class MockSurrealClient {
  constructor(private readonly entities: EntityRecord[] = []) {}

  async query(sql: string): Promise<any[][]> {
    if (sql.includes("FROM entities")) {
      return [this.entities];
    }
    if (sql.includes("GROUP BY in")) {
      // Rúnir-78sy.6 C3: the batched aggregation, multi-row {in, count} shape.
      // No test in this file asserts mention-count values — empty is safe.
      return [[]];
    }
    return [[]];
  }
}

describe("vault-exporter alias-enrichment budget", () => {
  const tmpBase = join(tmpdir(), `vault-enrich-test-${randomUUID()}`);
  const savedApiKey = process.env.OPENROUTER_API_KEY;
  const savedBudget = process.env.RUNIR_EXPORT_ENRICH_BUDGET;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnrich.mockResolvedValue(undefined);
    process.env.OPENROUTER_API_KEY = "test-key-never-used";
    delete process.env.RUNIR_EXPORT_ENRICH_BUDGET;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
    if (savedBudget === undefined) delete process.env.RUNIR_EXPORT_ENRICH_BUDGET;
    else process.env.RUNIR_EXPORT_ENRICH_BUDGET = savedBudget;
    await rm(tmpBase, { recursive: true, force: true });
  });

  function stderrLines(): string[] {
    return stderrSpy.mock.calls.map((c: any[]) => String(c[0]));
  }

  it("caps paid enrichment attempts at RUNIR_EXPORT_ENRICH_BUDGET and logs one summary line", async () => {
    process.env.RUNIR_EXPORT_ENRICH_BUDGET = "2";
    const entities = [1, 2, 3, 4, 5].map((n) => createEntity(n));
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    const result = await runVaultExport(db, join(tmpBase, "cap"), { userId: "default" });

    expect(mockEnrich).toHaveBeenCalledTimes(2);
    // All 5 entity files still written — the cap only bounds paid calls.
    expect(result.entitiesExported).toBe(5);
    const summaries = stderrLines().filter((l) => l.includes("alias enrichment:"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("attempted=2 succeeded=2 skipped=3 (budget=2)");
  });

  it("RUNIR_EXPORT_ENRICH_BUDGET=0 disables enrichment entirely with no other behavior change", async () => {
    process.env.RUNIR_EXPORT_ENRICH_BUDGET = "0";
    const entities = [1, 2, 3].map((n) => createEntity(n));
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    const result = await runVaultExport(db, join(tmpBase, "disabled"), { userId: "default" });

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(result.entitiesExported).toBe(3);
    expect(stderrLines().some((l) => l.includes("alias enrichment"))).toBe(false);
  });

  it("defaults the budget to 25 when the env var is unset", async () => {
    const entities = Array.from({ length: 27 }, (_, i) => createEntity(i + 1));
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    await runVaultExport(db, join(tmpBase, "default"), { userId: "default" });

    expect(mockEnrich).toHaveBeenCalledTimes(25);
    const summary = stderrLines().find((l) => l.includes("alias enrichment:"));
    expect(summary).toContain("attempted=25 succeeded=25 skipped=2 (budget=25)");
  });

  it("skips entities already stamped aliases_enriched_at without consuming budget", async () => {
    process.env.RUNIR_EXPORT_ENRICH_BUDGET = "1";
    const entities = [
      createEntity(1, { aliases_enriched_at: "2026-07-01T00:00:00Z" }),
      createEntity(2),
    ];
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    await runVaultExport(db, join(tmpBase, "stamped"), { userId: "default" });

    // The stamped entity does not burn the budget — entity 2 gets the slot.
    expect(mockEnrich).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mockEnrich).mock.calls[0][1].canonicalName).toBe("Concept 2");
    const summary = stderrLines().find((l) => l.includes("alias enrichment:"));
    expect(summary).toContain("attempted=1 succeeded=1 skipped=0 (budget=1)");
  });

  it("skips entities that already have aliases (existing guard)", async () => {
    const entities = [createEntity(1, { aliases: ["known"], aliasesNorm: ["known"] })];
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    await runVaultExport(db, join(tmpBase, "aliased"), { userId: "default" });

    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("failed attempts consume budget, are not retried, and the export still completes", async () => {
    process.env.RUNIR_EXPORT_ENRICH_BUDGET = "2";
    mockEnrich
      .mockRejectedValueOnce(new Error("LLM gateway error 429"))
      .mockResolvedValue(undefined);
    const entities = [1, 2, 3].map((n) => createEntity(n));
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    const result = await runVaultExport(db, join(tmpBase, "failure"), { userId: "default" });

    expect(result.ok).toBe(true);
    expect(mockEnrich).toHaveBeenCalledTimes(2);
    expect(stderrLines().some((l) => l.includes("alias enrichment failed for Concept 1"))).toBe(true);
    const summary = stderrLines().find((l) => l.includes("alias enrichment:"));
    expect(summary).toContain("attempted=2 succeeded=1 skipped=1 (budget=2)");
  });

  it("does not enrich when no API key is present", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const entities = [createEntity(1)];
    const db = new MockSurrealClient(entities) as unknown as SurrealClient;

    await runVaultExport(db, join(tmpBase, "nokey"), { userId: "default" });

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(stderrLines().some((l) => l.includes("alias enrichment"))).toBe(false);
  });
});
