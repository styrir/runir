/**
 * Scope predicate resolver for memory-hybrid.
 * ADR-52e.1 §2 — single point of truth for scope → WHERE clause mapping.
 */
import type { MemoryTier, SearchHit } from "../../domain/memory/types";

/** Resolved scope filter used by all query functions. */
export type ScopeFilter = {
  /** WHERE clause fragment (without leading AND; may be empty string for scope="all"). */
  whereClause: string;
  /** Bind variables for the WHERE clause. */
  vars: Record<string, unknown>;
};

/**
 * Resolves tool/hook scope inputs into a SurrealQL WHERE clause fragment.
 *
 * Scope mapping (per ADR-52e.1 §2):
 *   undefined / omitted → user + session (if sessionId available) + legacy (scope=NONE)
 *   "user"              → user + legacy (scope=NONE), no session memories
 *   "long-term"         → alias for "user" (deprecated name)
 *   "session"           → session-scoped only (strict, no widen)
 *   "all"               → no scope predicate (user_id filter still applies)
 *
 * Legacy records (scope = NONE) are treated as "user"-scoped in all default/user queries.
 *
 * @param scopeParam - The scope value from tool params (undefined = default retrieval)
 * @param sessionId  - Current session ID (undefined if unavailable)
 * @returns ScopeFilter with WHERE fragment and bind vars
 */
export function resolveScopeFilter(
  scopeParam: string | undefined,
  sessionId: string | undefined,
  teamId?: string | undefined,
): ScopeFilter {
  const normalized = scopeParam ? scopeParam.trim() || undefined : undefined;
  switch (normalized) {
    case "all":
      // Explicit bypass — return everything for the user; no scope predicate.
      return { whereClause: "", vars: {} };

    case "session":
      // Strict session scope — no widening to user memories.
      if (sessionId) {
        return {
          whereClause: "AND scope = $scopeVal AND session_id = $sessionId",
          vars: { scopeVal: "session", sessionId },
        };
      }
      // No session ID available — return empty set for session scope.
      return {
        whereClause: "AND scope = $scopeVal AND session_id = NONE AND false",
        vars: { scopeVal: "session" },
      };

    case "team":
      // Team scope (bead Rúnir-r9pn.3): visible to members of a specific team.
      // teamId is required — without it, return empty-set guard (better than
      // surfacing all teams' memories cross-team).
      if (teamId) {
        return {
          whereClause: "AND scope = $scopeVal AND team_id = $teamId",
          vars: { scopeVal: "team", teamId },
        };
      }
      return {
        whereClause: "AND scope = $scopeVal AND team_id = NONE AND false",
        vars: { scopeVal: "team" },
      };

    case "user":
    case "long-term":
      // User scope: include user-scoped records + legacy (scope=NONE). Exclude session memories.
      return {
        whereClause: "AND (scope = NONE OR scope = $scopeVal)",
        vars: { scopeVal: "user" },
      };

    default:
      // Default retrieval: user + legacy + current session (if available).
      if (sessionId) {
        return {
          whereClause:
            "AND (scope = NONE OR scope = $scopeVal OR (scope = $sessionScope AND session_id = $sessionId))",
          vars: { scopeVal: "user", sessionScope: "session", sessionId },
        };
      }
      return {
        whereClause: "AND (scope = NONE OR scope = $scopeVal)",
        vars: { scopeVal: "user" },
      };
  }
}

/**
 * Resolves write-path scope for memory_store tool and hooks.
 *
 * Priority: explicit `scope` param > `longTerm` mapping > default "user".
 * Logs deprecation warning when `longTerm` is used.
 *
 * @param scopeParam  - Explicit scope from tool params (undefined = not provided)
 * @param longTerm    - Deprecated boolean param from tool params (undefined = not provided)
 * @param sessionId   - Current session ID (used when scope="session")
 * @param logger      - Logger instance for deprecation warnings
 * @returns { scope, sessionId } to persist on the record
 */
/** Soft recall filters — applied post-query, after runHybridQuery returns SearchHit[]. */
export type RecallScopeFilter = {
  since?: string;        // ISO 8601 date cutoff
  tier?: MemoryTier;     // filter to specific tier
  tags?: string[];       // any-match on payload.tags
  confidence?: number;   // minimum confidence threshold
};

/**
 * Normalizes a body value to a trimmed non-empty string or undefined,
 * then falls back to the named env var. Treats null, undefined, missing,
 * and empty-string body values identically as "not provided".
 */
export function resolveAttrField(bodyVal: unknown, envKey: string): string | undefined {
  const v = bodyVal != null && typeof bodyVal === "string" && bodyVal.trim() !== "" ? bodyVal.trim() : undefined;
  return v ?? (process.env[envKey]?.trim() || undefined);
}

/**
 * Builds a ScopeFilter for attribution dimensions (path, client).
 * Returns empty filter when both are undefined — no WHERE clause added.
 * All values are bound params ($attrPath, $attrClient) — NEVER interpolated.
 */
export function resolveAttributionFilter(
  path: string | undefined,
  client: string | undefined,
): ScopeFilter {
  const clauses: string[] = [];
  const vars: Record<string, unknown> = {};
  if (path !== undefined) {
    clauses.push("AND payload.path = $attrPath");
    vars.attrPath = path;
  }
  if (client !== undefined) {
    clauses.push("AND payload.client = $attrClient");
    vars.attrClient = client;
  }
  return { whereClause: clauses.join(" "), vars };
}

/**
 * Builds a ScopeFilter for recall-specific path filtering (MIM-71).
 * Unlike resolveAttributionFilter (strict equality), this includes null-path records
 * so they can be included with a post-query penalty (two-pool strategy).
 *
 * With path: includes path-matched AND null-path records; excludes other-path records.
 * Without path: returns empty filter (no path predicate added).
 */
export function resolvePathRecallFilter(path: string | undefined): ScopeFilter {
  if (!path) return { whereClause: "", vars: {} };
  return {
    whereClause: "AND (payload.path = $recallPath OR payload.path = NONE)",
    vars: { recallPath: path },
  };
}

/**
 * Multiplicative penalty applied to null-path hits during path-scoped recall (MIM-71).
 * Configurable via RUNIR_NULL_PATH_PENALTY env var. Default: 0.70.
 * Based on Azure AI Search RRF multiplicative weighting pattern.
 */
export const PATH_NULL_PENALTY = parseFloat(process.env.RUNIR_NULL_PATH_PENALTY ?? "0.70");

/**
 * Applies a multiplicative score penalty to SearchHits that have no path set.
 * Only applied when requestedPath is provided.
 * Must be followed by a re-sort since scores are modified in place (spread).
 */
export function applyPathScorePenalty(
  hits: SearchHit[],
  requestedPath: string | undefined,
): SearchHit[] {
  if (!requestedPath) return hits;
  return hits.map((h) => {
    if (!h.path) return { ...h, score: h.score * PATH_NULL_PENALTY };
    return h;
  });
}

/**
 * Merges multiple ScopeFilter objects into one.
 * Concatenates whereClause strings (space-separated) and spreads all vars.
 * Caller is responsible for ensuring no var name collisions across filters.
 */
export function mergeFilters(...filters: ScopeFilter[]): ScopeFilter {
  const whereClause = filters
    .map((f) => f.whereClause)
    .filter((c) => c.length > 0)
    .join(" ");
  const vars: Record<string, unknown> = {};
  for (const f of filters) {
    Object.assign(vars, f.vars);
  }
  return { whereClause, vars };
}

/**
 * Post-query soft filters applied to SearchHit[] after runHybridQuery.
 * These do NOT affect the SurrealDB WHERE clause — they filter in application code
 * after scoring/ranking has occurred.
 */
export function applyRecallSoftFilters(
  hits: SearchHit[],
  filter: RecallScopeFilter,
): SearchHit[] {
  let results = hits;
  if (filter.since) {
    // Malformed since values (unparseable dates) produce NaN and are silently ignored —
    // the filter is skipped rather than discarding all results.
    const cutoff = new Date(filter.since).getTime();
    if (Number.isFinite(cutoff)) {
      results = results.filter(
        (h) => h.createdAt && new Date(h.createdAt).getTime() >= cutoff,
      );
    }
    // Invalid since values are silently ignored — caller should validate before sending.
  }
  if (filter.tier) {
    results = results.filter((h) => h.tier === filter.tier);
  }
  if (filter.confidence !== undefined) {
    results = results.filter(
      (h) => h.confidence !== undefined && h.confidence >= filter.confidence!,
    );
  }
  if (filter.tags && filter.tags.length > 0) {
    const tagSet = new Set(filter.tags);
    results = results.filter(
      (h) => h.tags?.some((t) => tagSet.has(t)),
    );
  }
  return results;
}

// MIM-20 T17: verified — resolveWriteScope() does not intercept or downgrade "global" scope.
// HTTP 403 in /memory/store endpoint is the single enforcement point for HTTP callers.
export function resolveWriteScope(
  scopeParam: string | undefined,
  longTerm: boolean | undefined,
  sessionId: string | undefined,
  logger: { warn: (msg: string) => void },
): { scope: "session" | "user" | "team" | "global"; sessionId: string | undefined } {
  const normalizedScope = scopeParam ? scopeParam.trim() || undefined : undefined;

  // If both scopeParam and longTerm are provided, scope wins; log warning.
  if (normalizedScope !== undefined && longTerm !== undefined) {
    logger.warn(
      "memory-hybrid: `longTerm` is deprecated and was ignored because `scope` was also provided. Use `scope` instead.",
    );
  }

  // Explicit scope param wins.
  if (normalizedScope !== undefined) {
    if (normalizedScope === "session") {
      return { scope: "session", sessionId };
    }
    if (normalizedScope === "global") {
      return { scope: "global", sessionId: undefined };
    }
    if (normalizedScope === "team") {
      // Team scope (bead Rúnir-r9pn.3). Caller is responsible for setting
      // team_id on the record body — this function only resolves the scope
      // discriminant. HTTP-path team_id wiring is intentionally not yet exposed
      // to clients (see MemoryScope JSDoc in src/domain/memory/boundary.ts).
      return { scope: "team", sessionId: undefined };
    }
    // "user" or any other value → user scope.
    return { scope: "user", sessionId: undefined };
  }

  // longTerm deprecation mapping.
  if (longTerm !== undefined) {
    logger.warn(
      "memory-hybrid: `longTerm` param is deprecated. Use `scope: \"user\"` or `scope: \"session\"` instead.",
    );
    if (longTerm === false) {
      return { scope: "session", sessionId };
    }
    // longTerm=true → user scope.
    return { scope: "user", sessionId: undefined };
  }

  // Default: user scope.
  return { scope: "user", sessionId: undefined };
}

