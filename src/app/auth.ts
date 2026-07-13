import type { MiddlewareHandler } from "hono";

// Paths exempt from the RUNIR_API_KEY bearer middleware. The /hooks/
// maintenance-class routes are NOT public in the security sense — each
// enforces its own MAINTENANCE_SECRET bearer inside the handler; they are
// exempt here because that secret is a DIFFERENT bearer than RUNIR_API_KEY
// and the middleware would otherwise reject it before the handler runs.
const PUBLIC_PATHS = new Set([
  "/health",
  "/ready",
  "/hooks/maintenance",
  "/hooks/entity-repair",
  "/hooks/entity-candidates",
  "/hooks/evidence",
]);

function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function isApiAuthConfigured(): boolean {
  return Boolean(process.env.RUNIR_API_KEY);
}

function shouldFailClosedWithoutApiKey(): boolean {
  return process.env.NODE_ENV === "production" || process.env.RUNIR_REQUIRE_API_KEY === "1";
}

/**
 * True when requests are served WITHOUT auth: no RUNIR_API_KEY configured and
 * nothing forces fail-closed (NODE_ENV=production or RUNIR_REQUIRE_API_KEY=1).
 * Mirrors the middleware's fail-open branch below; bootstrap uses it to emit a
 * loud startup warning (Rúnir-o75n.1).
 */
export function isAuthFailOpen(): boolean {
  return !isApiAuthConfigured() && !shouldFailClosedWithoutApiKey();
}

export function createApiAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const configuredKey = process.env.RUNIR_API_KEY;
    if (!configuredKey) {
      if (shouldFailClosedWithoutApiKey()) {
        return c.json({ error: "service auth is not configured" }, 503);
      }
      await next();
      return;
    }

    const presented = readBearerToken(c.req.header("Authorization"));
    if (!presented || presented !== configuredKey) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}
