import type { Hono } from "hono";
import { getBootstrapReadinessReport, probeDatabaseReady } from "../readiness.js";
import { cfg, db, supersessionJudge } from "../runtime.js";

export function registerHealthRoutes(app: Hono) {
  // Rúnir-pn1l.13.7 D7: supersessionJudge counters are ADDITIVE on /health regardless
  // of judge flags (disclosed in D1 compatibility claim).
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      userId: cfg.userId,
      reranker: cfg.reranker.provider,
      topK: cfg.topK,
      supersessionJudge: supersessionJudge.getCounters(),
    }),
  );

  app.get("/ready", async (c) => {
    const bootstrap = getBootstrapReadinessReport();
    let dbReady = false;
    let dbError: string | undefined;
    try {
      await probeDatabaseReady(db);
      dbReady = true;
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }

    const ready = bootstrap.ready && dbReady;
    return c.json({
      status: ready ? "ready" : "not_ready",
      userId: cfg.userId,
      reranker: cfg.reranker.provider,
      topK: cfg.topK,
      bootstrap,
      db: {
        ok: dbReady,
        ...(dbError ? { error: dbError } : {}),
      },
    }, ready ? 200 : 503);
  });
}
