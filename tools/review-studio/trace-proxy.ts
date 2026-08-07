import {
  ConfiguredRunirBackend,
  SecurityViolation,
  type ConfiguredRunirBackendOptions,
} from "./security/index.js";

export const DEFAULT_TRACE_LIMIT = 20;
export const MAX_TRACE_LIMIT = 200;
export const TRACE_RATINGS = ["helped", "hurt", "unused", "missing", "stale"] as const;
export type TraceRating = (typeof TRACE_RATINGS)[number];

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_NOTE_LENGTH = 4_000;
const MAX_JSON_BYTES = 32_000_000;

export type ReviewStudioFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ReviewStudioTraceBackendOptions = ConfiguredRunirBackendOptions & {
  /** Injectable for deterministic tests and the local in-memory stub. */
  readonly fetch?: ReviewStudioFetch;
};

export type TraceCoverage = {
  readonly requestedLimit: number;
  readonly returnedCount: number;
  readonly maxHistoricalWindow: typeof MAX_TRACE_LIMIT;
  readonly label: string;
  readonly emptyState: "never_selected_or_empty" | "window_has_receipts";
};

export class TraceProxyError extends Error {
  readonly code: "invalid_request" | "upstream_unavailable" | "trace_expired" | "lineage_unavailable";
  readonly status: 400 | 404 | 410 | 503;

  constructor(
    code: TraceProxyError["code"],
    status: TraceProxyError["status"],
    message: string,
  ) {
    super(message);
    this.name = "TraceProxyError";
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isTraceRating(value: unknown): value is TraceRating {
  return typeof value === "string" && (TRACE_RATINGS as readonly string[]).includes(value);
}

export function clampTraceLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TRACE_LIMIT;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(numeric)) return DEFAULT_TRACE_LIMIT;
  return Math.min(Math.max(numeric, 1), MAX_TRACE_LIMIT);
}

/** Existing Rúnir route IDs are bare IDs; an optional table prefix is accepted for CLI parity. */
export function normalizeTraceId(raw: unknown): string {
  if (typeof raw !== "string") throw new SecurityViolation("invalid-upstream-path");
  const id = raw.replace(/^retrieval_trace:/u, "");
  if (!SAFE_ID.test(id)) throw new SecurityViolation("invalid-upstream-path");
  return id;
}

/** Existing memory lineage callers may use either the bare ID or its table prefix. */
export function normalizeMemoryId(raw: unknown): string {
  if (typeof raw !== "string") throw new SecurityViolation("invalid-upstream-path");
  const id = raw.replace(/^(?:memories|semiote):/u, "");
  if (!SAFE_ID.test(id)) throw new SecurityViolation("invalid-upstream-path");
  return id;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TraceProxyError("upstream_unavailable", 503, "Configured Rúnir returned an invalid JSON envelope.");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TraceProxyError("upstream_unavailable", 503, `Configured Rúnir returned an invalid ${field} envelope.`);
  }
  return value;
}

function safeNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_NOTE_LENGTH) {
    throw new TraceProxyError("invalid_request", 400, "Rating note is invalid.");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A deliberately narrow, server-side-only adapter for the four existing
 * Rúnir endpoints. It returns upstream JSON data, never the request object;
 * credentials and backend headers remain inside ConfiguredRunirBackend.
 */
export class ReviewStudioTraceProxy {
  readonly #backend: ConfiguredRunirBackend;
  readonly #fetch: ReviewStudioFetch;

  constructor(options: ReviewStudioTraceBackendOptions) {
    this.#backend = new ConfiguredRunirBackend(options);
    const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (fetcher === undefined) {
      throw new TraceProxyError("upstream_unavailable", 503, "No fetch implementation is available for trace mode.");
    }
    this.#fetch = fetcher;
  }

  /** Backend-owned redaction seam for response/export/log callers. */
  sanitizeForLog(value: unknown): unknown {
    return this.#backend.sanitizeForLog(value);
  }

  /** The browser never receives this object; it is only used by the app route. */
  get backend(): ConfiguredRunirBackend {
    return this.#backend;
  }

  async list(limit: number): Promise<Record<string, unknown>> {
    const boundedLimit = clampTraceLimit(limit);
    const request = this.#backend.buildRequest("/hooks/traces", {
      query: { limit: boundedLimit },
      userIdPlacement: "query",
    });
    const payload = await this.#readJson(request, "list");
    const traces = asArray(payload.traces, "trace list");
    const coverage: TraceCoverage = {
      requestedLimit: boundedLimit,
      returnedCount: traces.length,
      maxHistoricalWindow: MAX_TRACE_LIMIT,
      label: `latest ${boundedLimit} of at most ${MAX_TRACE_LIMIT}`,
      emptyState: traces.length === 0 ? "never_selected_or_empty" : "window_has_receipts",
    };
    return {
      ...payload,
      traces,
      coverage,
    };
  }

  async detail(rawId: string): Promise<Record<string, unknown>> {
    const id = normalizeTraceId(rawId);
    const request = this.#backend.buildRequest(`/hooks/traces/${encodeURIComponent(id)}`, {
      userIdPlacement: "query",
    });
    return this.#readJson(request, "detail", "trace");
  }

  async rate(rawId: string, rating: unknown, note: unknown): Promise<Record<string, unknown>> {
    const id = normalizeTraceId(rawId);
    if (!isTraceRating(rating)) {
      throw new TraceProxyError("invalid_request", 400, "Rating must be one of: helped, hurt, unused, missing, stale.");
    }
    const normalizedNote = safeNote(note);
    const body = JSON.stringify({
      userId: this.#backend.userId,
      rating,
      ...(normalizedNote === undefined ? {} : { note: normalizedNote }),
    });
    const request = this.#backend.buildRequest(`/hooks/traces/${encodeURIComponent(id)}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      userIdPlacement: "body",
    });
    return this.#readJson(request, "rating");
  }

  async lineage(rawId: string): Promise<Record<string, unknown>> {
    const id = normalizeMemoryId(rawId);
    const request = this.#backend.buildRequest(`/memory/lineage/${encodeURIComponent(id)}`, {
      userIdPlacement: "query",
    });
    return this.#readJson(request, "lineage", "lineage");
  }

  async #readJson(
    request: { readonly url: string; readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
    kind: "list" | "detail" | "rating" | "lineage",
    requiredField?: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch {
      throw new TraceProxyError("upstream_unavailable", 503, "Configured Rúnir is unavailable.");
    }

    if (!response.ok) {
      if (response.status === 404 && (kind === "detail" || kind === "rating")) {
        throw new TraceProxyError("trace_expired", 410, "The selected trace expired by retention or is no longer available.");
      }
      if (response.status === 404 && kind === "lineage") {
        throw new TraceProxyError("lineage_unavailable", 404, "Memory lineage evidence is unavailable for the selected memory.");
      }
      throw new TraceProxyError("upstream_unavailable", 503, "Configured Rúnir is unavailable.");
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new TraceProxyError("upstream_unavailable", 503, "Configured Rúnir returned an unreadable response.");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
      throw new TraceProxyError("upstream_unavailable", 503, "Configured Rúnir returned an oversized response.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new TraceProxyError("upstream_unavailable", 503, "Configured Rúnir returned invalid JSON.");
    }
    const payload = asRecord(parsed);
    if (requiredField !== undefined) {
      if (!(requiredField in payload)) {
        throw new TraceProxyError("upstream_unavailable", 503, `Configured Rúnir returned no ${requiredField} field.`);
      }
    }
    return payload;
  }
}
