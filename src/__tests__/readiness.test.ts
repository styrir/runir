import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBm25Index: vi.fn(),
  ensureEmbeddingMetadataTable: vi.fn(),
  ensureMemoryEnrichmentSchema: vi.fn(),
  ensureProjectStateTable: vi.fn(),
  ensureRejectionLogTable: vi.fn(),
  ensureSessionWatermarksTable: vi.fn(),
  ensureAttributionFields: vi.fn(),
  ensureSupersedeShadowTable: vi.fn(),
  backfillHasPath: vi.fn(),
  ensureSynthesisSchema: vi.fn(),
  ensureEntityTables: vi.fn(),
  ensureConsolidationLogTable: vi.fn(),
  ensureConsolidationStateTable: vi.fn(),
  ensureDedupStateTable: vi.fn(),
  ensureConsolidationLockTable: vi.fn(),
  ensureStalenessBacklogTable: vi.fn(),
  ensureSalienceSchema: vi.fn(),
  ensurePhase2Schema: vi.fn(),
  ensureRunirSessionTable: vi.fn(),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  ensureBm25Index: mocks.ensureBm25Index,
  ensureEmbeddingMetadataTable: mocks.ensureEmbeddingMetadataTable,
  ensureMemoryEnrichmentSchema: mocks.ensureMemoryEnrichmentSchema,
  ensureProjectStateTable: mocks.ensureProjectStateTable,
  ensureRejectionLogTable: mocks.ensureRejectionLogTable,
  ensureSessionWatermarksTable: mocks.ensureSessionWatermarksTable,
  ensureAttributionFields: mocks.ensureAttributionFields,
  ensureSupersedeShadowTable: mocks.ensureSupersedeShadowTable,
  backfillHasPath: mocks.backfillHasPath,
}));

vi.mock("../storage/surreal/migrations/synthesis-schema.js", () => ({
  ensureSynthesisSchema: mocks.ensureSynthesisSchema,
}));

vi.mock("../entities/entity-store.js", () => ({
  ensureEntityTables: mocks.ensureEntityTables,
}));

vi.mock("../lifecycle/semion/consolidation.js", () => ({
  ensureConsolidationLogTable: mocks.ensureConsolidationLogTable,
  ensureConsolidationStateTable: mocks.ensureConsolidationStateTable,
  ensureDedupStateTable: mocks.ensureDedupStateTable,
}));

vi.mock("../lifecycle/semion/lock.js", () => ({
  ensureConsolidationLockTable: mocks.ensureConsolidationLockTable,
  ensureStalenessBacklogTable: mocks.ensureStalenessBacklogTable,
}));

vi.mock("../capture/continuity/salience-schema.js", () => ({
  ensureSalienceSchema: mocks.ensureSalienceSchema,
}));

vi.mock("../storage/surreal/phase2-store.js", () => ({
  ensurePhase2Schema: mocks.ensurePhase2Schema,
}));

vi.mock("../storage/surreal/runir-session-store.js", () => ({
  ensureRunirSessionTable: mocks.ensureRunirSessionTable,
}));

import { probeDatabaseReady, runDeploymentPreflight } from "../app/readiness.js";

describe("readiness", () => {
  const originalApiKey = process.env.RUNIR_API_KEY;
  const db = { query: vi.fn().mockResolvedValue([[1]]) } as any;
  const provider = { embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]) } as any;

  beforeEach(() => {
    process.env.RUNIR_API_KEY = "test-api-key";
    db.query.mockClear();
    provider.embedQuery.mockClear();
    [
      mocks.ensureBm25Index,
      mocks.ensureEmbeddingMetadataTable,
      mocks.ensureMemoryEnrichmentSchema,
      mocks.ensureProjectStateTable,
      mocks.ensureRejectionLogTable,
      mocks.ensureSessionWatermarksTable,
      mocks.ensureAttributionFields,
      mocks.backfillHasPath,
      mocks.ensureSynthesisSchema,
      mocks.ensureEntityTables,
      mocks.ensureConsolidationLogTable,
      mocks.ensureConsolidationStateTable,
      mocks.ensureConsolidationLockTable,
      mocks.ensureStalenessBacklogTable,
      mocks.ensureSalienceSchema,
      mocks.ensurePhase2Schema,
      mocks.ensureRunirSessionTable,
    ].forEach((fn) => fn.mockReset().mockResolvedValue(undefined));
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.RUNIR_API_KEY;
    else process.env.RUNIR_API_KEY = originalApiKey;
  });

  it("probes the database with a cheap query", async () => {
    await probeDatabaseReady(db);
    expect(db.query).toHaveBeenCalledWith("RETURN 1;");
  });

  it("returns a ready report when all deployment checks pass", async () => {
    const report = await runDeploymentPreflight({ db, provider, strict: true });

    expect(report.ready).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(provider.embedQuery).toHaveBeenCalledWith("runir deploy preflight");
    expect(mocks.ensureRunirSessionTable).toHaveBeenCalledTimes(1);
  });

  it("records failures without throwing in non-strict mode", async () => {
    mocks.ensurePhase2Schema.mockRejectedValueOnce(new Error("DDL failed"));

    const report = await runDeploymentPreflight({ db, strict: false });

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "phase2-schema", ok: false, details: "DDL failed" }),
    ]));
  });

  it("throws immediately in strict mode when a required check fails", async () => {
    mocks.ensureProjectStateTable.mockRejectedValueOnce(new Error("project_state missing"));

    await expect(runDeploymentPreflight({ db, strict: true })).rejects.toThrow("project_state missing");
  });

  it("fails when RUNIR_API_KEY is not configured", async () => {
    delete process.env.RUNIR_API_KEY;

    const report = await runDeploymentPreflight({ db, strict: false });

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "api-auth-config", ok: false }),
    ]));
    await expect(runDeploymentPreflight({ db, strict: true })).rejects.toThrow("RUNIR_API_KEY is not set");
  });
});
