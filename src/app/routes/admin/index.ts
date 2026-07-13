import type { Hono } from "hono";
import { fetchUnenrichedMemories, runEnrichment } from "../../../capture/enrichment/memory-enricher.js";
import { runClustering } from "../../../lifecycle/compaction/memory-clusterer.js";
import { runSynthesis } from "../../../lifecycle/synthesis/synthesis-generator.js";
import { runVaultExport } from "../../../lifecycle/archive/vault-exporter.js";
import { loadSeed, resetSeed } from "../../../testing/test-seed.js";
import { runtime, resolveUserId } from "../../runtime.js";
import { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import { assertNotProdDbForEval } from "../../../shared/db-guard.js";

function getAdminDb(c: any): { adminDb: SurrealClient; isOverride: boolean } {
  const nsParam = c.req.query("ns");
  const dbParam = c.req.query("db");
  if (nsParam || dbParam) {
    assertNotProdDbForEval(
      {
        namespace: nsParam ?? runtime.cfg.surrealdb.namespace,
        database: dbParam ?? runtime.cfg.surrealdb.database,
      },
      "admin ns/db override",
    );
    const overrideDb = new SurrealClient({
      ...runtime.cfg.surrealdb,
      namespace: nsParam ?? runtime.cfg.surrealdb.namespace,
      database: dbParam ?? runtime.cfg.surrealdb.database,
    });
    return { adminDb: overrideDb, isOverride: true };
  }
  return { adminDb: runtime.db, isOverride: false };
}

export function registerAdminRoutes(app: Hono) {
  app.get("/admin/rejection-stats", async (c) => {
    try {
      const totalResult = await runtime.db.query<any>("SELECT count() AS total FROM rejection_log GROUP ALL;");
      const total = (totalResult[0] ?? [])[0]?.total ?? 0;

      const last24hResult = await runtime.db.query<any>(
        "SELECT count() AS cnt FROM rejection_log WHERE rejected_at > time::now() - 24h GROUP ALL;",
      );
      const last24h = (last24hResult[0] ?? [])[0]?.cnt ?? 0;

      const byReasonResult = await runtime.db.query<any>(
        "SELECT reason, count() AS cnt FROM rejection_log GROUP BY reason;",
      );
      const byReason: Record<string, number> = {};
      for (const row of (byReasonResult[0] ?? [])) {
        byReason[row.reason] = Number(row.cnt ?? 0);
      }

      return c.json({ total: Number(total), last24h: Number(last24h), byReason });
    } catch (err) {
      return c.json({ error: `Rejection stats query failed: ${String(err)}` }, 500);
    }
  });

  app.get("/admin/retrieval-stats", (c) => c.json(runtime.retrievalStats.getStats()));

  app.post("/admin/enrich", async (c) => {
    const apiKey = process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey) {
      return c.json({ ok: false, error: "OPENROUTER_API_KEY not set" }, 500);
    }

    const limitParam = c.req.query("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;

    const { adminDb, isOverride } = getAdminDb(c);
    try {
      // Rúnir-ekos B5: this route family (/admin/enrich, /admin/backfill) is a
      // legacy-table backfill surface, intentional — every tableName arg
      // below is explicit "memories" rather than relying on the callee's own
      // default, so a future default-flip elsewhere can't silently redirect
      // this surface.
      const enrichResult = await runEnrichment(adminDb, apiKey, limit, undefined, "memories");
      const clusterResult = await runClustering(adminDb);
      const synthesisResult = await runSynthesis(adminDb, apiKey);

      return c.json({
        ok: true,
        enrichment: enrichResult,
        clustering: clusterResult,
        synthesis: synthesisResult,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    } finally {
      if (isOverride) await adminDb.close().catch(() => {});
    }
  });

  app.post("/admin/backfill", async (c) => {
    const apiKey = process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey) {
      return c.json({ ok: false, error: "OPENROUTER_API_KEY not set" }, 500);
    }

    const batchSizeParam = c.req.query("batch_size");
    const batchSize = batchSizeParam ? parseInt(batchSizeParam, 10) : 100;
    const dryRun = c.req.query("dry_run") === "true";
    const maxBatches = 100;

    const { adminDb, isOverride } = getAdminDb(c);
    const startMs = Date.now();

    try {
      // Rúnir-ekos B5: see the rationale on /admin/enrich above.
      const unenrichedRows = await fetchUnenrichedMemories(adminDb, 999999, "memories");
      const totalUnenriched = unenrichedRows.length;

      if (dryRun) {
        return c.json({
          ok: true,
          dryRun: true,
          totalUnenriched,
          durationMs: Date.now() - startMs,
        });
      }

      let totalEnriched = 0;
      let totalFailed = 0;
      let batches = 0;

      while (batches < maxBatches) {
        const batchStart = Date.now();
        // Rúnir-ekos B5: see the rationale on /admin/enrich above.
        const enrichResult = await runEnrichment(adminDb, apiKey, batchSize, undefined, "memories");
        batches++;

        totalEnriched += enrichResult.enriched;
        totalFailed += enrichResult.failed;

        const elapsed = Date.now() - startMs;
        console.log(
          `[backfill] batch ${batches}: enriched=${enrichResult.enriched} failed=${enrichResult.failed} ` +
          `batchMs=${Date.now() - batchStart} totalElapsedMs=${elapsed}`,
        );

        if (enrichResult.enriched === 0) {
          break;
        }
      }

      const clusterResult = await runClustering(adminDb);
      console.log(
        `[backfill] clustering done: upserted=${clusterResult.upserted} elapsedMs=${Date.now() - startMs}`,
      );

      const synthesisResult = await runSynthesis(adminDb, apiKey);
      console.log(
        `[backfill] synthesis done: created=${synthesisResult.created} updated=${synthesisResult.updated} elapsedMs=${Date.now() - startMs}`,
      );

      return c.json({
        ok: true,
        totalEnriched,
        totalFailed,
        clustersCreated: clusterResult.upserted,
        synthesesCreated: synthesisResult.created,
        durationMs: Date.now() - startMs,
        batches,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    } finally {
      if (isOverride) await adminDb.close().catch(() => {});
    }
  });

  app.get("/admin/export", async (c) => {
    const { adminDb, isOverride } = getAdminDb(c);
    // Truthy RUNIR_TEST_NS required: with it unset AND no ?ns param, the bare
    // comparison was undefined === undefined → the test branch applied in a
    // prod-shaped env and the VAULT_EXPORT_PATH guard below never fired.
    const isTestNs = Boolean(process.env.RUNIR_TEST_NS) && c.req.query("ns") === process.env.RUNIR_TEST_NS;
    const vaultPath = isTestNs
      ? (process.env.VAULT_TEST_EXPORT_PATH ?? "/var/lib/runir/vault-test")
      : process.env.VAULT_EXPORT_PATH;
    try {
      if (!vaultPath) {
        // Configuration error (503), deliberately distinguishable from an export failure (500).
        return c.json({ ok: false, error: "VAULT_EXPORT_PATH not configured" }, 503);
      }
      // Tenant scoping (Rúnir-78sy.2): export exactly one tenant — the
      // ?userId= query param, else the configured default tenant — so
      // harness-tenant rows never leak into the personal vault.
      const userId = resolveUserId(c.req.query("userId"), runtime.cfg);
      const result = await runVaultExport(adminDb, vaultPath, { userId });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    } finally {
      if (isOverride) await adminDb.close().catch(() => {});
    }
  });

  app.post("/admin/test/seed", async (c) => {
    if (!process.env.RUNIR_TEST_NS) return c.json({ error: "not found" }, 404);
    const testDb = new SurrealClient({
      ...runtime.cfg.surrealdb,
      namespace: process.env.RUNIR_TEST_NS ?? "test",
      database: process.env.RUNIR_TEST_DB ?? "test",
    });
    try {
      const { memories, entities } = await loadSeed(testDb);
      return c.json({ ok: true, memoriesLoaded: memories, entitiesLoaded: entities });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    } finally {
      await testDb.close().catch(() => {});
    }
  });

  app.post("/admin/test/reset", async (c) => {
    if (!process.env.RUNIR_TEST_NS) return c.json({ error: "not found" }, 404);
    const testDb = new SurrealClient({
      ...runtime.cfg.surrealdb,
      namespace: process.env.RUNIR_TEST_NS ?? "test",
      database: process.env.RUNIR_TEST_DB ?? "test",
    });
    try {
      const { memories, entities } = await resetSeed(testDb);
      return c.json({ ok: true, memoriesLoaded: memories, entitiesLoaded: entities });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    } finally {
      await testDb.close().catch(() => {});
    }
  });
}
