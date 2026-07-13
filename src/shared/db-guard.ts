/**
 * Fail-closed guards that stop eval / harness / smoke / one-off-script entrypoints
 * from writing into the PRODUCTION SurrealDB (ns/db = main/main) or through the
 * PRODUCTION HTTP service (the launchd com.runir.local app on :7700).
 *
 * Why this exists: 58% of `semiote` and the `entities` table were contaminated by
 * eval/test tenants (g004-locomo-*, crossrun-*) that leaked into main/main through
 * two writer classes — see docs/analysis/2026-06-19-adopt-now-build-plan.md (#2):
 *   1. DIRECT-DB:        a SurrealClient opened with ns/db defaulting to main/main.
 *   2. SERVICE-MEDIATED: a POST to RUNIR_BASE_URL (defaulting to :7700) that writes
 *                        prod through /hooks/capture.
 *
 * The prod app (src/app/runtime.ts) is the primary legitimate main/main consumer. It
 * must NOT call these guards (or, if a genuine prod maintenance/migration must, it sets
 * the explicit escape hatch RUNIR_ALLOW_PROD_DB=1).
 *
 * scripts/run-vault-export.ts (Rúnir-78sy.6) is a second, explicit owner-ops exception:
 * it intentionally reads the real tenant's data out of main/main to produce a personal
 * Obsidian vault (the same operation GET /admin/export performs, which also calls no
 * guard). It likewise must NOT call these guards — doing so would force
 * RUNIR_ALLOW_PROD_DB=1 on every normal export run, an awkward footgun-prone
 * requirement for what should be the NORMAL invocation.
 *
 * Real-vs-eval is made a deterministic config fact via RUNIR_REAL_TENANTS — never a
 * fragile naming convention. The cleanup/prune path uses requireRealTenants() so it
 * fails closed (refuses to treat every tenant as eval) when the allowlist is unset.
 */

export const PROD_NAMESPACE = "main";
export const PROD_DATABASE = "main";
/** The launchd com.runir.local production app listens here. */
export const PROD_SERVICE_PORT = "7700";

const PROD_ESCAPE_ENV = "RUNIR_ALLOW_PROD_DB";

export class ProdDbGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProdDbGuardError";
  }
}

export interface SurrealishConfig {
  namespace?: string;
  database?: string;
  url?: string;
}

/** True when the ns/db tuple is the production (main/main) tuple. */
export function isProdDbTuple(namespace: string | undefined, database: string | undefined): boolean {
  return namespace === PROD_NAMESPACE && database === PROD_DATABASE;
}

/** True when baseUrl points at the local production service on :7700. */
export function isProdServiceUrl(baseUrl: string): boolean {
  // All local-host spellings + bind-address aliases that route to the same :7700
  // listener. Hostnames are bracket-stripped before lookup, so the bracketed IPv6
  // forms (e.g. [::], [::ffff:127.0.0.1]) reduce to their bare form here.
  const localHosts = new Set([
    "127.0.0.1",
    "localhost",
    "::1",
    "::",
    "0.0.0.0",
    "::ffff:127.0.0.1", // dotted form (some runtimes)
    "::ffff:7f00:1", // Node normalizes the IPv4-mapped form to hex
  ]);
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return u.port === PROD_SERVICE_PORT && localHosts.has(host);
  } catch {
    // Not a full URL — match a host:port substring as a fallback.
    return new RegExp(
      `(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|\\[?::1\\]?|\\[?::\\]?):${PROD_SERVICE_PORT}\\b`,
    ).test(baseUrl);
  }
}

/** The operator-set escape hatch that permits a deliberate prod write. */
export function prodWriteAllowed(): boolean {
  return process.env[PROD_ESCAPE_ENV] === "1";
}

/**
 * Fail closed if `cfg` targets the production database (main/main) without the
 * explicit RUNIR_ALLOW_PROD_DB=1 escape. Call this right after building a
 * SurrealClient in any eval / harness / script entrypoint.
 */
export function assertNotProdDbForEval(cfg: SurrealishConfig, context = "this eval/harness/script"): void {
  if (isProdDbTuple(cfg.namespace, cfg.database) && !prodWriteAllowed()) {
    throw new ProdDbGuardError(
      `REFUSING to run ${context} against the PRODUCTION database (ns/db = ` +
        `${PROD_NAMESPACE}/${PROD_DATABASE}). Point SURREAL_NS/SURREAL_DB at an isolated ` +
        `eval target (e.g. SURREAL_DB=eval) or launch an isolated service. If you truly ` +
        `mean to touch prod, set ${PROD_ESCAPE_ENV}=1.`,
    );
  }
}

/**
 * Service-mediated variant: fail closed if `baseUrl` points at the production
 * :7700 app (which would write prod main/main via /hooks/capture) without the escape.
 */
export function assertNotProdServiceUrl(baseUrl: string, context = "this eval/harness/script"): void {
  if (isProdServiceUrl(baseUrl) && !prodWriteAllowed()) {
    throw new ProdDbGuardError(
      `REFUSING to run ${context} against the PRODUCTION service at ${baseUrl} ` +
        `(writes prod ${PROD_NAMESPACE}/${PROD_DATABASE} via /hooks/capture). Point ` +
        `RUNIR_BASE_URL at an isolated eval service. If you truly mean prod, set ${PROD_ESCAPE_ENV}=1.`,
    );
  }
}

/**
 * Convenience for scripts that resolve ns/db straight from env (the common
 * `process.env.SURREAL_NS ?? "main"` pattern). Equivalent to assertNotProdDbForEval
 * over the env-resolved tuple.
 */
export function assertEnvNotProdDbForEval(context = "this script"): void {
  assertNotProdDbForEval(
    {
      namespace: process.env.SURREAL_NS ?? PROD_NAMESPACE,
      database: process.env.SURREAL_DB ?? PROD_DATABASE,
    },
    context,
  );
}

/**
 * The explicit set of REAL (non-eval) tenants, from RUNIR_REAL_TENANTS
 * (comma-separated). Empty when unset — callers that delete/prune by tenant MUST
 * use requireRealTenants() so an unset allowlist fails closed instead of treating
 * every tenant as disposable.
 */
export function realTenants(): Set<string> {
  const raw = process.env.RUNIR_REAL_TENANTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Like realTenants() but throws if the allowlist is unset/empty (fail-closed for cleanup). */
export function requireRealTenants(): Set<string> {
  const tenants = realTenants();
  if (tenants.size === 0) {
    throw new ProdDbGuardError(
      `RUNIR_REAL_TENANTS must be set (comma-separated real tenant ids, e.g. "brooks") ` +
        `before any tenant-scoped cleanup/prune. Refusing to treat all tenants as eval.`,
    );
  }
  return tenants;
}

/** True when userId is in the explicit real-tenant allowlist. */
export function isRealTenant(userId: string): boolean {
  return realTenants().has(userId);
}
