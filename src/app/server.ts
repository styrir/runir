import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { createApiAuthMiddleware, isAuthFailOpen } from "./auth.js";
import { attachServerErrorHandler } from "./server-error-handler.js";
import { ensureSalienceSchema } from "../capture/continuity/salience-schema.js";
import { deriveCentroids, upsertSeedPrototypes } from "../capture/continuity/salience-prototypes.js";
import { setSalienceVectorReady } from "../capture/continuity/session-salience.js";
import { ensureEntityTables } from "../entities/entity-store.js";
import {
  startConsolidationScheduler,
} from "../lifecycle/semion/consolidation.js";
import {
  SurrealClient,
} from "../storage/surreal/surreal-store.js";
import { ensureSynthesisSchema } from "../storage/surreal/migrations/synthesis-schema.js";
import { registerAdminRoutes } from "./routes/admin/index.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHookRoutes } from "./routes/hooks/index.js";
import { registerMemoryRoutes } from "./routes/memory/index.js";
import { bm25StatsCache, cfg, db, HOST, noiseBank, PORT, provider } from "./runtime.js";
import { resolveUserId } from "./resolve-user-id.js";
import { resolveCaptureApiKey } from "../shared/config.js";
import { loadRankingProfiles } from "../recall/policy/ranking-profile.js";
import { runDeploymentPreflight, setBootstrapReadinessReport } from "./readiness.js";
import { performGracefulShutdown } from "./shutdown.js";

let stopConsolidation: (() => void) | undefined;
let server: ReturnType<typeof serve> | undefined;

export function createApp() {
  const app = new Hono();
  app.use("*", logger());
  app.use("*", createApiAuthMiddleware());

  registerHealthRoutes(app);
  registerMemoryRoutes(app);
  registerHookRoutes(app);
  registerDebugRoutes(app);
  registerAdminRoutes(app);

  return app;
}

export async function bootstrap() {
  const app = createApp();

  // Load per-tenant ranking profiles once at startup (Rúnir-mmg2). With
  // RUNIR_RANKING_PROFILES unset the cache is empty → every tenant runs clean.
  // When the var IS set, a missing/unreadable/schema-invalid file THROWS here so
  // bootstrap refuses to start (fail loud — the operator declared intent by
  // setting the var; silently dropping a tenant's ranking behavior is worse than
  // crashing).
  const rankingProfilesPath = process.env.RUNIR_RANKING_PROFILES;
  const rankingProfiles = loadRankingProfiles(rankingProfilesPath);
  if (rankingProfilesPath) {
    console.log(`runir-service: loaded ${rankingProfiles.size} ranking profile(s) from ${rankingProfilesPath}`);
  }

  const bootstrapReadiness = await runDeploymentPreflight({
    db,
    provider,
    strict: false,
  });
  setBootstrapReadinessReport(bootstrapReadiness);
  for (const check of bootstrapReadiness.checks.filter((check) => !check.ok)) {
    console.warn(`runir-service: bootstrap check failed (${check.name}): ${check.details ?? "unknown error"}`);
  }

  if (process.env.RUNIR_TEST_NS) {
    const testNsDb = new SurrealClient({
      ...cfg.surrealdb,
      namespace: process.env.RUNIR_TEST_NS,
      database: process.env.RUNIR_TEST_DB ?? "test",
    });
    await ensureSynthesisSchema(testNsDb).catch(() => {});
    await ensureEntityTables(testNsDb).catch(() => {});
  }

  await ensureSalienceSchema(db);
  await upsertSeedPrototypes(db, provider);
  try {
    await deriveCentroids(db);
    setSalienceVectorReady(true);
  } catch (err) {
    console.warn("runir-service: centroid bootstrap failed, degrading to lexical-only:", err);
  }

  await noiseBank.init(provider).catch((err) => console.warn("runir-service: noise bank init failed:", err));
  if (isAuthFailOpen()) {
    console.warn(
      "runir-service: WARNING — auth is FAIL-OPEN: RUNIR_API_KEY is not set, so every endpoint " +
      "accepts unauthenticated requests. Set RUNIR_API_KEY (and RUNIR_REQUIRE_API_KEY=1 to fail " +
      "closed) before exposing the service beyond loopback.",
    );
  }
  console.log(`runir-service starting on ${HOST}:${PORT}`);
  console.log(`  userId=${cfg.userId}  reranker=${cfg.reranker.provider}  topK=${cfg.topK}`);
  server = serve({ fetch: app.fetch, hostname: HOST, port: PORT });
  attachServerErrorHandler(server as unknown as NodeJS.EventEmitter, PORT);

  // Scheduler starts AFTER the port binds — startConsolidationScheduler runs a
  // STARTUP CATCH-UP (backlog replay + runForUser for every eligible tenant)
  // and awaiting it before serve() held the port closed for the entire run.
  // Live incident 2026-06-11: the first boot after a tenant crossed the
  // ≥5-new-watermarks eligibility threshold ran that tenant's FULL first-ever
  // consolidation (O(n²) dedup sweep) before listen — the service answered
  // nothing the whole time. Availability must never gate on background
  // maintenance; recall-degradation-during-maintenance stays tracked as x46j.
  const maintenanceApiKey = resolveCaptureApiKey(cfg);
  if (maintenanceApiKey) {
    void startConsolidationScheduler(
      db,
      (text: string) => provider.embedDocument(text),
      bm25StatsCache,
      Number(process.env.CONSOLIDATION_INTERVAL_MS ?? 60 * 60 * 1000),
      maintenanceApiKey,
      console.warn,
    ).then((stop) => {
      stopConsolidation = stop;
    }).catch((err) => {
      console.warn("runir-service: consolidation scheduler bootstrap failed:", err);
      stopConsolidation = undefined;
    });
  } else {
    console.warn("runir-service: consolidation scheduler skipped — no capture API key");
    stopConsolidation = undefined;
  }
}

export function registerShutdownHandlers() {
  let shuttingDown = false;
  const handle = (signal: string) => () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void performGracefulShutdown(signal, {
      server,
      stopConsolidation,
      closeDb: () => db.close(),
      exit: (code) => process.exit(code),
      log: (msg) => console.log(msg),
    });
  };
  process.on("SIGTERM", handle("SIGTERM"));
  process.on("SIGINT", handle("SIGINT"));
}

export { resolveUserId };
