import type { EmbeddingProvider } from "../storage/embeddings/providers/embedding-provider.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  backfillHasPath,
  ensureAttributionFields,
  ensureBm25Index,
  ensureEmbeddingMetadataTable,
  ensureMemoryEnrichmentSchema,
  ensureProjectStateTable,
  ensureRejectionLogTable,
  ensureSessionWatermarksTable,
  ensureSupersedeShadowTable,
} from "../storage/surreal/surreal-store.js";
import { ensureAtomicShadowTables } from "../storage/surreal/atomic-shadow-store.js";
import { ensureSynthesisSchema } from "../storage/surreal/migrations/synthesis-schema.js";
import { runSchemaMigrations } from "../storage/surreal/migrations.js";
import { ensureEntityTables } from "../entities/entity-store.js";
import {
  ensureConsolidationLogTable,
  ensureConsolidationStateTable,
  ensureDedupStateTable,
} from "../lifecycle/semion/consolidation.js";
import { ensureConsolidationLockTable, ensureStalenessBacklogTable } from "../lifecycle/semion/lock.js";
import { ensureSalienceSchema } from "../capture/continuity/salience-schema.js";
import { ensurePhase2Schema } from "../storage/surreal/phase2-store.js";
import { ensureRunirSessionTable } from "../storage/surreal/runir-session-store.js";
import { ensureSessionTurnSchema } from "../storage/surreal/session-turn-store.js";
import {
  ensureContinuityBuildStateTable,
  ensureProjectContinuityStateTable,
  ensureProjectEnrollmentTable,
} from "../storage/surreal/continuity-state-store.js";
import {
  ensureContinuityGapBuildStateTable,
  ensureContinuityGapTable,
  ensureContinuityReportStateTable,
} from "../storage/surreal/continuity-gap-store.js";
import { ensureContinuityEvidenceTable } from "../storage/surreal/continuity-evidence-store.js";
import { ensureEntityRepairSchema } from "../lifecycle/entity-repair/nightly-entity-repair.js";
import { ensureSupersessionJudgeLedgerTable } from "../storage/surreal/supersession-judge-ledger.js";
import { isApiAuthConfigured } from "./auth.js";

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  details?: string;
}

export interface RuntimeReadinessReport {
  ready: boolean;
  checkedAt: string;
  checks: ReadinessCheck[];
}

const DEFAULT_REPORT: RuntimeReadinessReport = {
  ready: false,
  checkedAt: new Date(0).toISOString(),
  checks: [{ name: "bootstrap", ok: false, details: "not_run" }],
};

let bootstrapReadinessReport: RuntimeReadinessReport = DEFAULT_REPORT;

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCheck(
  checks: ReadinessCheck[],
  name: string,
  fn: () => Promise<void>,
  strict: boolean,
): Promise<void> {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, details: toDetail(error) });
    if (strict) throw error;
  }
}

export async function probeDatabaseReady(db: SurrealClient): Promise<void> {
  await db.query("RETURN 1;");
}

export async function runDeploymentPreflight(params: {
  db: SurrealClient;
  provider?: EmbeddingProvider;
  strict?: boolean;
}): Promise<RuntimeReadinessReport> {
  const { db, provider, strict = true } = params;
  const checks: ReadinessCheck[] = [];

  checks.push({
    name: "api-auth-config",
    ok: isApiAuthConfigured(),
    ...(isApiAuthConfigured() ? {} : { details: "RUNIR_API_KEY is not set" }),
  });
  if (strict && !isApiAuthConfigured()) {
    throw new Error("RUNIR_API_KEY is not set");
  }

  await runCheck(checks, "db-ping", () => probeDatabaseReady(db), strict);
  await runCheck(checks, "bm25-index", () => ensureBm25Index(db), strict);
  await runCheck(checks, "phase2-schema", () => ensurePhase2Schema(db, provider?.dimensions), strict);
  await runCheck(checks, "runir-session", () => ensureRunirSessionTable(db), strict);
  await runCheck(checks, "session-watermarks", () => ensureSessionWatermarksTable(db), strict);
  await runCheck(checks, "session-turns", () => ensureSessionTurnSchema(db), strict);
  await runCheck(checks, "entity-repair", () => ensureEntityRepairSchema(db), strict);
  await runCheck(checks, "consolidation-locks", () => ensureConsolidationLockTable(db), strict);
  await runCheck(checks, "consolidation-log", () => ensureConsolidationLogTable(db), strict);
  await runCheck(checks, "consolidation-state", () => ensureConsolidationStateTable(db), strict);
  await runCheck(checks, "dedup-state", () => ensureDedupStateTable(db), strict);
  await runCheck(checks, "staleness-backlog", () => ensureStalenessBacklogTable(db), strict);
  await runCheck(checks, "embedding-metadata", () => ensureEmbeddingMetadataTable(db), strict);
  await runCheck(checks, "entity-tables", () => ensureEntityTables(db), strict);
  await runCheck(checks, "memory-enrichment", () => ensureMemoryEnrichmentSchema(db), strict);
  await runCheck(checks, "rejection-log", () => ensureRejectionLogTable(db), strict);
  await runCheck(checks, "supersede-shadow", () => ensureSupersedeShadowTable(db), strict);
  // Rúnir-h435.1 F4: atomic-isolated frame tables once at readiness (not per row write).
  await runCheck(checks, "atomic-shadow", () => ensureAtomicShadowTables(db), strict);
  // Rúnir-pn1l.13.7 D3: empty supersession_judge_ledger schema at bootstrap (additive;
  // disclosed in D1 compatibility claim — write decisions unchanged when flags OFF).
  await runCheck(checks, "supersession-judge-ledger", () => ensureSupersessionJudgeLedgerTable(db), strict);
  await runCheck(checks, "synthesis-schema", () => ensureSynthesisSchema(db), strict);
  await runCheck(checks, "attribution-fields", () => ensureAttributionFields(db), strict);
  await runCheck(checks, "project-state", () => ensureProjectStateTable(db), strict);
  await runCheck(checks, "project-continuity-state", () => ensureProjectContinuityStateTable(db), strict);
  await runCheck(checks, "project-enrollment", () => ensureProjectEnrollmentTable(db), strict);
  await runCheck(checks, "continuity-build-state", () => ensureContinuityBuildStateTable(db), strict);
  await runCheck(checks, "continuity-gap", () => ensureContinuityGapTable(db), strict);
  await runCheck(checks, "continuity-gap-build-state", () => ensureContinuityGapBuildStateTable(db), strict);
  await runCheck(checks, "continuity-report-state", () => ensureContinuityReportStateTable(db), strict);
  await runCheck(checks, "continuity-evidence", () => ensureContinuityEvidenceTable(db), strict);
  await runCheck(checks, "salience-schema", () => ensureSalienceSchema(db), strict);
  await runCheck(checks, "schema-migrations", () => runSchemaMigrations(db).then(() => undefined), strict);
  await runCheck(checks, "backfill-has-path", async () => { await backfillHasPath(db); }, strict);

  if (provider) {
    await runCheck(
      checks,
      "embedder-probe",
      async () => { await provider.embedQuery("runir deploy preflight"); },
      strict,
    );
  }

  return {
    ready: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export function setBootstrapReadinessReport(report: RuntimeReadinessReport) {
  bootstrapReadinessReport = report;
}

export function getBootstrapReadinessReport(): RuntimeReadinessReport {
  return bootstrapReadinessReport;
}
