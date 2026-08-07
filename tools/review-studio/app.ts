import { Hono } from "hono";
import type { Context } from "hono";
import {
  ReviewCompatibilityError,
} from "../../src/testing/review-studio/benchmark-adapter.js";
import type {
  ReviewCaseResult,
  ReviewComparison,
  ReviewRun,
} from "../../src/testing/review-studio/types.js";
import {
  ReviewCatalog,
  type ReviewArtifactRoot,
  type ReviewCatalogOptions,
  type ReviewCatalogRun,
  type ReviewCatalogSnapshot,
  isSafeCatalogId,
  isSafeComparisonKey,
} from "./catalog.js";
import {
  ReviewStudioSecurityBoundary,
  SecurityViolation,
  assertNoBrowserSuppliedUpstreamUrl,
  type LoopbackBinding,
  type ReviewStudioApiRequest,
} from "./security/index.js";
import {
  clampTraceLimit,
  ReviewStudioTraceProxy,
  TraceProxyError,
  type ReviewStudioTraceBackendOptions,
} from "./trace-proxy.js";
import { buildCandidateFunnel } from "./trace-view.js";
import { readReviewStudioAsset } from "./ui-assets.js";

export type ReviewStudioAppOptions = {
  readonly artifactRoots: readonly (string | ReviewArtifactRoot)[];
  readonly port?: number;
  readonly protocol?: LoopbackBinding["protocol"];
  readonly catalogLimits?: ReviewCatalogOptions["limits"];
  readonly now?: () => Date;
  /** Omit for the default credential-free file-only launch. */
  readonly traceBackend?: ReviewStudioTraceBackendOptions;
};

export type ReviewStudioApplication = {
  readonly app: Hono;
  readonly catalog: ReviewCatalog;
  readonly security: ReviewStudioSecurityBoundary;
  readonly traceProxy?: ReviewStudioTraceProxy;
};

function requestFor(c: Context): ReviewStudioApiRequest {
  return {
    method: c.req.method,
    url: c.req.raw.url,
    headers: c.req.raw.headers,
  };
}

function errorResponse(
  security: ReviewStudioSecurityBoundary,
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(security, { error: code, message }, status);
}

function jsonResponse(
  security: ReviewStudioSecurityBoundary,
  value: unknown,
  status = 200,
): Response {
  const body = JSON.stringify(security.sanitizeForExport(value));
  const headers = new Headers(security.responseHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  return new Response(body, { status, headers });
}

function traceJsonResponse(
  security: ReviewStudioSecurityBoundary,
  traceProxy: ReviewStudioTraceProxy,
  value: unknown,
  status = 200,
): Response {
  // Backend redaction runs before the common launch/CSRF export redaction. The
  // request object (and therefore Authorization) never reaches this seam.
  return jsonResponse(security, security.sanitizeForExport(traceProxy.sanitizeForLog(value)), status);
}

function textResponse(
  security: ReviewStudioSecurityBoundary,
  value: string,
  contentType: string,
  status = 200,
  bootstrap = false,
): Response {
  const headers = new Headers(
    bootstrap
      ? security.bootstrapResponseHeaders({ "Content-Type": contentType })
      : security.responseHeaders({ "Content-Type": contentType }),
  );
  return new Response(value, { status, headers });
}

function authorizeApi(c: Context, security: ReviewStudioSecurityBoundary): Response | undefined {
  const decision = security.authorizeApiRequest(requestFor(c));
  if (decision.allowed) return undefined;
  return errorResponse(security, decision.status, decision.code, "Review Studio request rejected by the local security boundary.");
}

function authorizeBootstrap(c: Context, security: ReviewStudioSecurityBoundary): Response | undefined {
  const decision = security.authorizeBootstrapRequest(requestFor(c));
  if (decision.allowed) return undefined;
  return errorResponse(security, decision.status, decision.code, "Review Studio bootstrap request rejected.");
}

function publicCase(result: ReviewCaseResult): Omit<ReviewCaseResult, "rawEvidence"> {
  const { rawEvidence: _rawEvidence, ...withoutRawEvidence } = result;
  return withoutRawEvidence;
}

function publicRun(run: ReviewRun): Omit<ReviewRun, "cases" | "rawManifest"> & {
  cases: Array<Omit<ReviewCaseResult, "rawEvidence">>;
} {
  const { cases, rawManifest: _rawManifest, ...withoutRawManifest } = run;
  return { ...withoutRawManifest, cases: cases.map(publicCase) };
}

type PublicComparison = Omit<ReviewComparison, "caseDeltas"> & {
  readonly caseDeltas: Array<Omit<ReviewComparison["caseDeltas"][number], "baseline" | "candidate"> & {
    readonly baseline: ReturnType<typeof publicCase> | null;
    readonly candidate: ReturnType<typeof publicCase> | null;
  }>;
};

function publicComparison(comparison: ReviewComparison): PublicComparison {
  return {
    ...comparison,
    caseDeltas: comparison.caseDeltas.map((delta) => ({
      ...delta,
      baseline: delta.baseline ? publicCase(delta.baseline) : null,
      candidate: delta.candidate ? publicCase(delta.candidate) : null,
    })),
  };
}

function runSummary(record: ReviewCatalogRun): Record<string, unknown> {
  const { run, artifact } = record;
  const durations = run.cases.map((item) => item.metrics.latencyMs).filter((value): value is number => value !== null);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  return {
    catalogId: record.catalogId,
    runId: run.runId,
    conditionId: run.conditionId,
    suiteId: run.suiteId,
    suiteVersion: run.suiteVersion,
    runKind: run.runKind,
    createdAt: run.createdAt,
    git: run.git,
    configHash: run.configHash,
    candidates: run.candidates,
    aggregates: run.aggregates,
    provenance: run.provenance,
    diagnostics: run.diagnostics,
    artifact: {
      rootLabel: artifact.rootLabel,
      relativeManifest: artifact.relativeManifest,
      relativeRows: artifact.relativeRows,
      manifestBytes: artifact.manifestBytes,
      rowsBytes: artifact.rowsBytes,
      loadedRows: artifact.loadedRows,
    },
    caseCount: run.cases.length,
    durationMs: totalDuration,
  };
}

function findRecordOrError(
  catalog: ReviewCatalog,
  security: ReviewStudioSecurityBoundary,
  catalogId: string | undefined,
): ReviewCatalogRun | Response {
  if (!catalogId || !isSafeCatalogId(catalogId)) {
    return errorResponse(security, 400, "invalid_catalog_id", "Catalog ID is not valid.");
  }
  const record = catalog.findRun(catalogId);
  return record ?? errorResponse(security, 404, "run_not_found", "The requested run is not in the rebuildable catalog.");
}

function queryBoolean(c: Context, name: string): boolean {
  return c.req.query(name) === "true";
}

function traceModeDisabled(security: ReviewStudioSecurityBoundary): Response {
  return errorResponse(
    security,
    404,
    "trace_mode_disabled",
    "Trace review is disabled. Relaunch Review Studio with explicit trace backend configuration.",
  );
}

function rejectBrowserUpstreamQuery(
  c: Context,
  security: ReviewStudioSecurityBoundary,
): Response | undefined {
  for (const key of ["url", "upstreamUrl", "baseUrl"]) {
    const value = c.req.query(key);
    if (value === undefined) continue;
    try {
      assertNoBrowserSuppliedUpstreamUrl(value);
    } catch {
      return errorResponse(security, 400, "browser_upstream_url", "The browser cannot select a Rúnir upstream URL.");
    }
  }
  return undefined;
}

function traceFailureResponse(
  security: ReviewStudioSecurityBoundary,
  error: unknown,
): Response {
  if (error instanceof TraceProxyError) {
    return jsonResponse(
      security,
      {
        error: error.code,
        state: error.code === "trace_expired" ? "trace_expired_by_retention" : error.code,
        message: error.message,
      },
      error.status,
    );
  }
  if (error instanceof SecurityViolation) {
    return errorResponse(security, 400, "invalid_trace_reference", "The trace or memory reference is not valid.");
  }
  return errorResponse(security, 503, "upstream_unavailable", "Configured Rúnir is unavailable.");
}

export function createReviewStudioApp(options: ReviewStudioAppOptions): ReviewStudioApplication {
  const port = options.port ?? 7711;
  const security = new ReviewStudioSecurityBoundary({
    binding: { host: "127.0.0.1", port, protocol: options.protocol ?? "http" },
  });
  const traceProxy = options.traceBackend ? new ReviewStudioTraceProxy(options.traceBackend) : undefined;
  const catalog = new ReviewCatalog({
    roots: options.artifactRoots,
    limits: options.catalogLimits,
    now: options.now,
  });
  const app = new Hono();

  app.get("/", (c) => {
    const denied = authorizeBootstrap(c, security);
    if (denied) return denied;
    return textResponse(
      security,
      security.renderBootstrapDocument({
        title: "Rúnir / Evidence Light Table",
        scriptPath: "/assets/review-studio.js",
        stylesheetPath: "/assets/review-studio.css",
      }),
      "text/html; charset=utf-8",
      200,
      true,
    );
  });

  app.get("/assets/review-studio.css", (c) => {
    const denied = authorizeBootstrap(c, security);
    if (denied) return denied;
    return textResponse(security, readReviewStudioAsset("review-studio.css"), "text/css; charset=utf-8");
  });

  app.get("/assets/review-studio.js", (c) => {
    const denied = authorizeBootstrap(c, security);
    if (denied) return denied;
    return textResponse(security, readReviewStudioAsset("review-studio.js"), "text/javascript; charset=utf-8");
  });

  app.get("/api/runs", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    if (queryBoolean(c, "refresh")) catalog.refresh();
    const snapshot: ReviewCatalogSnapshot = catalog.snapshot;
    return jsonResponse(security, {
      generatedAt: snapshot.generatedAt,
      runs: snapshot.runs.map(runSummary),
      duplicateRunIds: snapshot.duplicateRunIds,
      diagnostics: snapshot.diagnostics,
    });
  });

  app.get("/api/capabilities", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    return jsonResponse(security, {
      schemaVersion: "runir-review-studio-capabilities/v1",
      traceMode: traceProxy ? "enabled" : "file-only",
      trace: traceProxy
        ? { enabled: true, maxLatestWindow: 200, detailOnDemand: true, ratingWrite: true, lineageRead: true }
        : { enabled: false },
    });
  });

  app.get("/api/runs/:catalogId", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    const record = findRecordOrError(catalog, security, c.req.param("catalogId"));
    if (record instanceof Response) return record;
    return jsonResponse(security, {
      ...runSummary(record),
      run: publicRun(record.run),
    });
  });

  app.get("/api/cases/:catalogId", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    const record = findRecordOrError(catalog, security, c.req.param("catalogId"));
    if (record instanceof Response) return record;
    const comparisonKey = c.req.query("key");
    if (!comparisonKey || !isSafeComparisonKey(comparisonKey)) {
      return errorResponse(security, 400, "invalid_comparison_key", "A stable comparison key is required.");
    }
    const result = record.run.cases.find((item) => item.comparisonKey === comparisonKey);
    if (!result) return errorResponse(security, 404, "case_not_found", "The requested case is not in the selected run.");
    return jsonResponse(security, {
      catalogId: record.catalogId,
      runId: record.run.runId,
      // Case detail is the explicit allowlisted raw-evidence seam. Compare
      // summaries remain redacted; opening a case is an intentional review
      // action and returns the adapter-sanitized row/manifest fields.
      case: result,
    });
  });

  app.get("/api/raw/:catalogId", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    const record = findRecordOrError(catalog, security, c.req.param("catalogId"));
    if (record instanceof Response) return record;
    const comparisonKey = c.req.query("key");
    if (!comparisonKey || !isSafeComparisonKey(comparisonKey)) {
      return errorResponse(security, 400, "invalid_comparison_key", "A stable comparison key is required.");
    }
    const rawEvidence = catalog.rawEvidence(record.catalogId, comparisonKey);
    if (!rawEvidence) return errorResponse(security, 404, "raw_evidence_not_found", "Allowlisted raw evidence was not found.");
    return jsonResponse(security, {
      catalogId: record.catalogId,
      runId: record.run.runId,
      comparisonKey,
      rawEvidence,
    });
  });

  app.get("/api/runs/:catalogId/export", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    const record = findRecordOrError(catalog, security, c.req.param("catalogId"));
    if (record instanceof Response) return record;
    return jsonResponse(security, {
      exportSchema: "runir-review-studio-export/v1",
      exportedAt: new Date().toISOString(),
      catalogId: record.catalogId,
      artifact: record.artifact,
      run: record.run,
    });
  });

  app.get("/api/compare", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    const baselineId = c.req.query("baseline");
    const candidateId = c.req.query("candidate");
    if (!baselineId || !candidateId || !isSafeCatalogId(baselineId) || !isSafeCatalogId(candidateId)) {
      return errorResponse(security, 400, "invalid_comparison_selection", "Baseline and candidate catalog IDs are required.");
    }
    try {
      const comparison = catalog.compare(baselineId, candidateId, {
        allowUnverifiedPairing: queryBoolean(c, "allowUnverified"),
        allowIncompatible: queryBoolean(c, "allowIncompatible"),
      });
      return jsonResponse(security, publicComparison(comparison));
    } catch (error) {
      if (error instanceof ReviewCompatibilityError) {
        return jsonResponse(
          security,
          { error: "incompatible", message: error.message, compatibility: error.compatibility },
          409,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(security, 400, "comparison_failed", message);
    }
  });

  app.get("/api/compare/export", (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    const baselineId = c.req.query("baseline");
    const candidateId = c.req.query("candidate");
    if (!baselineId || !candidateId || !isSafeCatalogId(baselineId) || !isSafeCatalogId(candidateId)) {
      return errorResponse(security, 400, "invalid_comparison_selection", "Baseline and candidate catalog IDs are required.");
    }
    try {
      const comparison = catalog.compare(baselineId, candidateId, {
        allowUnverifiedPairing: queryBoolean(c, "allowUnverified"),
        allowIncompatible: queryBoolean(c, "allowIncompatible"),
      });
      return jsonResponse(security, {
        exportSchema: "runir-review-studio-comparison-export/v1",
        exportedAt: new Date().toISOString(),
        comparison,
      });
    } catch (error) {
      if (error instanceof ReviewCompatibilityError) {
        return jsonResponse(
          security,
          { error: "incompatible", message: error.message, compatibility: error.compatibility },
          409,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(security, 400, "comparison_failed", message);
    }
  });

  app.get("/api/traces", async (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    if (!traceProxy) return traceModeDisabled(security);
    const browserUrl = rejectBrowserUpstreamQuery(c, security);
    if (browserUrl) return browserUrl;
    try {
      const payload = await traceProxy.list(clampTraceLimit(c.req.query("limit")));
      return traceJsonResponse(security, traceProxy, payload);
    } catch (error) {
      return traceFailureResponse(security, error);
    }
  });

  app.get("/api/traces/:traceId", async (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    if (!traceProxy) return traceModeDisabled(security);
    const browserUrl = rejectBrowserUpstreamQuery(c, security);
    if (browserUrl) return browserUrl;
    try {
      const payload = await traceProxy.detail(c.req.param("traceId"));
      const trace = payload.trace;
      return traceJsonResponse(security, traceProxy, {
        ...payload,
        review: { candidateFunnel: buildCandidateFunnel(trace) },
      });
    } catch (error) {
      return traceFailureResponse(security, error);
    }
  });

  // This is the only mutating Review Studio route. The configured backend owns
  // userId; any browser-supplied userId is deliberately ignored.
  app.post("/api/traces/:traceId/rate", async (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    if (!traceProxy) return traceModeDisabled(security);
    const browserUrl = rejectBrowserUpstreamQuery(c, security);
    if (browserUrl) return browserUrl;
    const body = await c.req.json().catch(() => null) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorResponse(security, 400, "invalid_rating_body", "Rating requires a JSON object.");
    }
    const input = body as Record<string, unknown>;
    try {
      const payload = await traceProxy.rate(c.req.param("traceId"), input.rating, input.note);
      return traceJsonResponse(security, traceProxy, payload);
    } catch (error) {
      return traceFailureResponse(security, error);
    }
  });

  app.get("/api/lineage/:memoryId", async (c) => {
    const denied = authorizeApi(c, security);
    if (denied) return denied;
    if (!traceProxy) return traceModeDisabled(security);
    const browserUrl = rejectBrowserUpstreamQuery(c, security);
    if (browserUrl) return browserUrl;
    try {
      const payload = await traceProxy.lineage(c.req.param("memoryId"));
      return traceJsonResponse(security, traceProxy, payload);
    } catch (error) {
      return traceFailureResponse(security, error);
    }
  });

  app.all("*", (c) => {
    const denied = authorizeBootstrap(c, security);
    if (denied) return denied;
    return errorResponse(security, 404, "not_found", "Review Studio route not found.");
  });

  return { app, catalog, security, ...(traceProxy ? { traceProxy } : {}) };
}
