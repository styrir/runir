import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  runVaultExport: vi.fn(),
}));

vi.mock("../app/runtime.js", () => ({
  runtime: {
    cfg: { userId: "cfg-default-user", surrealdb: { namespace: "prod-ns", database: "prod-db" } },
    db: {},
  },
  // Mirrors src/app/resolve-user-id.ts default behavior (no RUNIR_SINGLE_TENANT).
  resolveUserId: (bodyUserId: unknown, cfg: { userId: string }) =>
    (typeof bodyUserId === "string" ? bodyUserId : undefined) ?? cfg.userId,
}));

vi.mock("../lifecycle/archive/vault-exporter.js", () => ({
  runVaultExport: mocks.runVaultExport,
}));

vi.mock("../capture/enrichment/memory-enricher.js", () => ({
  fetchUnenrichedMemories: vi.fn(),
  runEnrichment: vi.fn(),
}));

vi.mock("../lifecycle/compaction/memory-clusterer.js", () => ({
  runClustering: vi.fn(),
}));

vi.mock("../lifecycle/synthesis/synthesis-generator.js", () => ({
  runSynthesis: vi.fn(),
}));

vi.mock("../testing/test-seed.js", () => ({
  loadSeed: vi.fn(),
  resetSeed: vi.fn(),
}));

vi.mock("../shared/db-guard.js", () => ({
  assertNotProdDbForEval: vi.fn(),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  SurrealClient: class {
    async close() {}
  },
}));

import { registerAdminRoutes } from "../app/routes/admin/index.js";

function makeApp() {
  const app = new Hono();
  registerAdminRoutes(app);
  return app;
}

const ENV_KEYS = ["VAULT_EXPORT_PATH", "VAULT_TEST_EXPORT_PATH", "RUNIR_TEST_NS", "RUNIR_TEST_DB"] as const;
let savedEnv: Record<string, string | undefined>;

describe("GET /admin/export vault path configuration", () => {
  beforeEach(() => {
    mocks.runVaultExport.mockReset();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // With RUNIR_TEST_NS set and no ns query param, isTestNs is false, so the
    // non-test branch (VAULT_EXPORT_PATH) applies.
    process.env.RUNIR_TEST_NS = "export-test-ns";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("returns the 503 configuration error in a prod-shaped env (RUNIR_TEST_NS unset, no ns param)", async () => {
    delete process.env.RUNIR_TEST_NS;

    const app = makeApp();
    const response = await app.request("/admin/export");
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json).toEqual({ ok: false, error: "VAULT_EXPORT_PATH not configured" });
    expect(mocks.runVaultExport).not.toHaveBeenCalled();
  });

  it("returns a 503 configuration error when VAULT_EXPORT_PATH is unset", async () => {
    const app = makeApp();
    const response = await app.request("/admin/export");
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json).toEqual({ ok: false, error: "VAULT_EXPORT_PATH not configured" });
    expect(mocks.runVaultExport).not.toHaveBeenCalled();
  });

  it("runs the export against VAULT_EXPORT_PATH scoped to the configured default tenant", async () => {
    process.env.VAULT_EXPORT_PATH = "/tmp/vault-export-test";
    mocks.runVaultExport.mockResolvedValue({ ok: true, exported: 3 });

    const app = makeApp();
    const response = await app.request("/admin/export");
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, exported: 3 });
    expect(mocks.runVaultExport).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/vault-export-test",
      { userId: "cfg-default-user" },
    );
  });

  it("scopes the export to an explicit ?userId= query param when provided", async () => {
    process.env.VAULT_EXPORT_PATH = "/tmp/vault-export-test";
    mocks.runVaultExport.mockResolvedValue({ ok: true, exported: 1 });

    const app = makeApp();
    const response = await app.request("/admin/export?userId=brooks");

    expect(response.status).toBe(200);
    expect(mocks.runVaultExport).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/vault-export-test",
      { userId: "brooks" },
    );
  });

  it("keeps the RUNIR_TEST_NS branch: ns=test-ns exports to the test default even without VAULT_EXPORT_PATH", async () => {
    mocks.runVaultExport.mockResolvedValue({ ok: true, exported: 0 });

    const app = makeApp();
    const response = await app.request("/admin/export?ns=export-test-ns");

    expect(response.status).toBe(200);
    expect(mocks.runVaultExport).toHaveBeenCalledWith(
      expect.anything(),
      "/var/lib/runir/vault-test",
      { userId: "cfg-default-user" },
    );
  });

  it("export failures stay 500 with the failure message (distinguishable from the 503 config error)", async () => {
    process.env.VAULT_EXPORT_PATH = "/tmp/vault-export-test";
    mocks.runVaultExport.mockRejectedValue(new Error("disk full"));

    const app = makeApp();
    const response = await app.request("/admin/export");
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json).toEqual({ ok: false, error: "disk full" });
  });
});
