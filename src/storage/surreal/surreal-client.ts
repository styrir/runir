import { Surreal } from "surrealdb";
import type { DriverOptions } from "surrealdb";
import { AbandonedQueryError, isCurrentWorkAbandoned } from "./query-abandonment.js";
import type {
  SearchHit,
} from "../../domain/memory/types";
import { attachSearchHitLineage } from "../../domain/memory/search-hit-lineage.js";
import {
  buildProjectStateRecordId,
} from "../../identity/canonical-context.js";

export const ACTIVE_MEMORY_FILTER = "AND (active = NONE OR active = true)";

export const DEFAULT_FINGERPRINT_TTL_MS = 60_000;

type FingerprintCacheEntry = { fingerprint: string | null; expiresAt: number };
/** @internal fingerprint cache — shared with embedding-fingerprint-store */
export const _fingerprintCache = new WeakMap<object, FingerprintCacheEntry>();

export function projectStateRecordId(
  userId: string,
  pathOrRef?: string | { projectKey?: string; path?: string },
): string {
  if (typeof pathOrRef === "object" && pathOrRef !== null) {
    return buildProjectStateRecordId(userId, pathOrRef.projectKey, pathOrRef.path);
  }
  return buildProjectStateRecordId(userId, undefined, pathOrRef);
}

export function mapMemoryRowToSearchHit(row: any): SearchHit {
  const payload = row?.payload ?? {};
  const hit: SearchHit = {
    id: extractId(row?.id),
    text: payload?.l2 ?? payload?.data ?? "",
    score: Number(row?.score ?? 0),
    createdAt: payload?.createdAt ?? row?.created_at,
    updatedAt: payload?.updatedAt ?? row?.updated_at,
    tags: payload?.tags,
    category: payload?.category,
    memoryRole: payload?.memoryRole,
    validAt: payload?.validAt ?? row?.valid_at,
    invalidAt: payload?.invalidAt ?? row?.invalid_at,
    scope: payload?.scope ?? row?.scope,
    sessionId: payload?.sessionId ?? row?.session_id,
    confidence: payload?.confidence,
    l0: payload?.l0,
    l1: payload?.l1,
    path: payload?.path,
    client: payload?.client,
    continuitySubjectKey: payload?.continuitySubjectKey,
    active: row?.active,
    inactiveReason: row?.inactive_reason,
    supersededById: row?.superseded_by ? extractId(row.superseded_by) : payload?.supersededById,
    lineageRootId: row?.lineage_root_id ? extractId(row.lineage_root_id) : payload?.lineageRootId,
    sourceKind: "semiote",
    noemaClaimKey: payload?.noemaClaimKey,
    noemaRevisionHash: payload?.noemaRevisionHash,
    noemaStatus: payload?.noemaStatus,
    noemaSupportSemioteIds: Array.isArray(payload?.noemaSupportSemioteIds) ? payload.noemaSupportSemioteIds.map(String) : undefined,
    raw_source_text: typeof payload?.raw_source_text === "string" ? payload.raw_source_text : undefined,
    rawSpan: payload?.rawSpan,
    rawSpans: Array.isArray(payload?.rawSpans) ? payload.rawSpans : undefined,
    atomicFact: payload?.atomicFact,
    event: payload?.event,
    atomicClaims: Array.isArray(payload?.atomicClaims) ? payload.atomicClaims : undefined,
  };
  return attachSearchHitLineage(hit);
}


type SurrealConnectionConfig = {
  url: string;
  username: string;
  password: string;
  namespace: string;
  database: string;
};

const SDK_CONNECTION_EVENTS = ["connected", "reconnecting", "disconnected", "error"] as const;

/** How long connect + signin + use may take before the attempt is abandoned. */
export const DEFAULT_SURREAL_CONNECT_TIMEOUT_MS = 5_000;

export type SurrealClientOptions = {
  /** For tests and diagnostics, e.g. an instrumented `websocketImpl`. */
  driverOptions?: DriverOptions;
  connectTimeoutMs?: number;
};

export class SurrealConnectError extends Error {
  override name = "SurrealConnectError";
}

const CONNECTION_LOSS_ERRORS = new Set([
  "CallTerminatedError",
  "ConnectionUnavailableError",
  "UnexpectedConnectionError",
  "ReconnectExhaustionError",
]);

/** The connection is gone: the query may not have reached the server, or its answer was lost. */
function isConnectionLoss(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return CONNECTION_LOSS_ERRORS.has(err.name) || err.message.includes("ConnectionUnavailable");
}

/** The connection is up but its session lost authentication. */
function isStaleSession(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Anonymous access") || msg.includes("Not enough permissions");
}

function describeError(detail: unknown): string {
  if (detail instanceof Error) {
    const cause = detail.cause instanceof Error ? ` (cause: ${detail.cause.message})` : "";
    return `${detail.name}: ${detail.message}${cause}`;
  }
  return detail === undefined ? "" : String(detail);
}

/** Best available text from a WebSocket error event (undici ErrorEvent, ws, or the SDK's CustomEvent). */
function describeSocketError(event: Event): string {
  const e = event as Event & { message?: unknown; error?: unknown; detail?: unknown };
  if (typeof e.message === "string" && e.message) return e.message;
  if (e.error !== undefined) return describeError(e.error);
  if (e.detail !== undefined) return describeError(e.detail);
  return "socket error";
}

export class SurrealClient {
  private surreal: Surreal;
  private ready: Promise<void>;
  private config: SurrealConnectionConfig;
  private readonly driverOptions?: DriverOptions;
  private readonly connectTimeoutMs: number;
  private reconnecting: Promise<void> | null = null;
  private connectionSeq = 0;

  constructor(config: SurrealConnectionConfig, options: SurrealClientOptions = {}) {
    this.config = config;
    this.driverOptions = options.driverOptions;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_SURREAL_CONNECT_TIMEOUT_MS;
    this.surreal = this.createSurreal();
    this.ready = this.init(this.surreal);
    // A failed first connect is retried by the next query; never an unhandled rejection.
    this.ready.catch(() => undefined);
  }

  /**
   * The SDK's own reconnect is disabled (vk-2993). On every reconnect it
   * re-sends every query still waiting for an answer. When the socket kept
   * dropping while a slow query ran, that query was re-sent indefinitely: one
   * recall produced 55 runs of the same query, and each run kept executing on
   * the server after its socket closed. Reconnection is done here instead, on
   * demand, with at most one re-send per query.
   */
  private createSurreal(): Surreal {
    const seq = ++this.connectionSeq;
    const log = (event: string, reason: string) => this.logConnection(seq, event, reason);
    // SDK 2.0.3 does not pass socket errors or close codes to its subscribers, so
    // they are read from the socket itself and reported with the SDK's events.
    let lastSocketEnd = "";
    const base = this.driverOptions?.websocketImpl ?? globalThis.WebSocket;
    const websocketImpl = base && class TracedWebSocket extends base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("error", (event) => {
          lastSocketEnd = describeSocketError(event);
          log("error", lastSocketEnd);
        });
        this.addEventListener("close", (event) => {
          const closed = `close code=${event.code}${event.reason ? ` reason=${event.reason}` : ""} clean=${event.wasClean}`;
          lastSocketEnd = lastSocketEnd ? `${lastSocketEnd}; ${closed}` : closed;
        });
        this.addEventListener("open", () => { lastSocketEnd = ""; });
      }
    };
    const surreal = new Surreal({ ...this.driverOptions, websocketImpl });
    for (const event of SDK_CONNECTION_EVENTS) {
      // Optional call: module mocks of "surrealdb" in older tests omit subscribe().
      surreal.subscribe?.(event, (detail?: unknown) => {
        const reason = event === "disconnected" ? lastSocketEnd || "closed by runir" : describeError(detail);
        log(event, reason);
      });
    }
    return surreal;
  }

  /** Connection #N numbers each SDK instance, so lines from a replaced instance stay attributable. */
  private logConnection(seq: number, event: string, reason: string): void {
    // stderr only: CLI tools built on this client print JSON on stdout.
    console.warn(`[runir] surreal connection #${seq} ${event}${reason ? `: ${reason}` : ""}`);
  }

  /**
   * Opens and authenticates `surreal`, failing within connectTimeoutMs. SDK
   * 2.0.3's connect() never settles when the socket is refused before it opens:
   * it waits for "connected" or "error" but only "disconnected" is published.
   * Without this bound a refused reconnect stranded every later query.
   */
  private async init(surreal: Surreal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const failed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SurrealConnectError(
        `SurrealDB session not ready after ${this.connectTimeoutMs}ms`)), this.connectTimeoutMs);
      unsubscribe = surreal.subscribe?.("disconnected", () => reject(new SurrealConnectError(
        "SurrealDB connection closed before the session was ready")));
    });
    try {
      await Promise.race([this.openSession(surreal), failed]);
    } catch (err) {
      surreal.close().catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
  }

  private async openSession(surreal: Surreal): Promise<void> {
    const config = this.config;
    // Convert http(s) → ws(s) for WebSocket transport
    const wsUrl = config.url
      .replace(/^http(s?):\/\//, "ws$1://")
      .replace(/\/+$/, "");
    // `{ enabled: false }`, not `false`: SDK 2.0.3's ReconnectContext treats any
    // falsy option as "use the defaults", so `reconnect: false` leaves it on.
    await surreal.connect(wsUrl, { reconnect: { enabled: false } });
    // SurrealDB 3.x WebSocket auth requires signin before use (a bare
    // `use()` on an unauthenticated session surfaces as InvalidAuth on the
    // next query). signin → use is the correct order for root-level auth.
    await surreal.signin({
      username: config.username,
      password: config.password,
    });
    await surreal.use({
      namespace: config.namespace,
      database: config.database,
    });
  }

  /**
   * Restores a usable session: re-authenticates a live connection, or replaces
   * a dead one. Coalesces concurrent attempts into a single promise.
   */
  private async reconnect(why: string): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    this.logConnection(this.connectionSeq, "reconnecting (runir)", why);
    this.reconnecting = (async () => {
      if (this.surreal.status === "connected") {
        try {
          // The connection may still be alive with only its auth expired.
          await this.surreal.signin({
            username: this.config.username,
            password: this.config.password,
          });
          await this.surreal.use({
            namespace: this.config.namespace,
            database: this.config.database,
          });
          return;
        } catch { /* fall through to a full reconnect */ }
      }
      const previous = this.surreal;
      this.surreal = this.createSurreal();
      try { await previous.close(); } catch { /* ignore */ }
      await this.init(this.surreal);
      this.ready = Promise.resolve();
    })().catch((err: unknown) => {
      this.logConnection(this.connectionSeq, "reconnect failed (runir)", describeError(err));
      throw err;
    }).finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }

  /**
   * Waits for a usable connection before a FIRST send; never re-sends anything.
   * A failed connection attempt fails this call; the next call tries again.
   */
  private async ensureConnected(): Promise<void> {
    if (this.reconnecting) await this.reconnecting;
    try {
      await this.ready;
    } catch (err) {
      await this.reconnect(`earlier connect failed: ${describeError(err)}`);
    }
    if (this.surreal.status === "disconnected") await this.reconnect("connection is closed");
  }

  /**
   * Executes SurrealQL with native parameter binding (no LET prepending).
   * Returns an array of result arrays, one per SQL statement.
   *
   * When the connection drops or the session goes stale, reconnects and
   * re-sends the query at most once; a second failure propagates. Work whose
   * caller already gave up (see runAbandonable) is never sent or re-sent.
   *
   * A query lost with its socket may already have run, so the one re-send can
   * run a write twice. Writes that must not repeat need idempotent SQL (fixed
   * record ids, UPSERT) or their own transaction via queryTransaction.
   */
  async query<T = unknown>(
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<T[][]> {
    if (isCurrentWorkAbandoned()) throw new AbandonedQueryError();
    await this.ensureConnected();
    if (isCurrentWorkAbandoned()) throw new AbandonedQueryError();
    try {
      const raw: unknown[] = await this.surreal.query(sql, vars);
      return this.normalizeResults<T>(raw);
    } catch (err: unknown) {
      if (!isConnectionLoss(err) && !isStaleSession(err)) throw err;
      // Nobody is waiting for this result: re-sending only loads the server.
      if (isCurrentWorkAbandoned()) throw err;
      await this.reconnect(describeError(err));
      if (isCurrentWorkAbandoned()) throw err;
      const raw: unknown[] = await this.surreal.query(sql, vars);
      return this.normalizeResults<T>(raw);
    }
  }

  /**
   * Runs a multi-statement BEGIN/COMMIT transaction atomically.
   *
   * Unlike {@link query}, this DELIBERATELY bypasses the reconnect-retry-once
   * path: a non-idempotent transaction must never be blindly re-applied after
   * an ambiguous connection loss (a silent retry could double-commit). The
   * caller supplies a statement `body` plus bound `vars`; the body is wrapped
   * in `BEGIN TRANSACTION; … COMMIT TRANSACTION;` and sent as one request.
   *
   * Failure detection uses the SDK's per-statement `responses()` envelopes.
   * `collect()` throws the first error, which can be a generic aborted-statement
   * error that hides the actual failing statement. Never interpret a user row's
   * `status` property as a transaction result.
   *
   * The COMMIT result is never parsed for control flow, and the method returns
   * `void` so callers cannot read partial transaction output. A thrown error
   * means the transaction did NOT durably commit, OR is in-doubt (the
   * connection dropped after COMMIT was sent) — callers must treat it as "not
   * done" and reconcile on the next pass, never assume a guaranteed rollback.
   */
  async queryTransaction(
    body: string,
    vars?: Record<string, unknown>,
  ): Promise<void> {
    if (isCurrentWorkAbandoned()) throw new AbandonedQueryError();
    await this.ensureConnected();
    if (isCurrentWorkAbandoned()) throw new AbandonedQueryError();
    const tx = `BEGIN TRANSACTION;\n${body}\nCOMMIT TRANSACTION;`;
    try {
      // responses() retains every statement failure. collect()/await throws on
      // the first response, which can be a generic aborted-transaction error
      // preceding the statement that actually caused the rollback.
      const responses = await this.surreal.query(tx, vars).responses();
      const failures = responses.flatMap((response, index) => response?.success === false
        ? [{ index, error: response.error }] : []);
      if (failures.length) {
        const root = failures.find(({ error }) => !/not executed due to a failed transaction/i.test(error.message)) ?? failures[0];
        const failure = new Error(
          `transaction failed (rolled back, or in-doubt if the connection dropped after COMMIT); statement index ${root.index}`,
          { cause: root.error },
        );
        Object.assign(failure, { statementIndex: root.index });
        throw failure;
      }
    } catch (err: unknown) {
      if (err instanceof Error && "statementIndex" in err) throw err;
      throw new Error(
        "transaction failed (rolled back, or in-doubt if the connection dropped after COMMIT)",
        { cause: err },
      );
    }
  }

  /** Normalizes raw query results to array-of-arrays. */
  private normalizeResults<T>(raw: unknown[]): T[][] {
    // Normalize each statement result to an array:
    // - SELECT / LET $x = SELECT → already an array of rows
    // - null / undefined (DDL, standalone LET) → empty array
    // - scalar → wrap in single-element array
    return raw.map((r) =>
      Array.isArray(r) ? r : r == null ? [] : [r],
    ) as T[][];
  }

  /** Cleanly close the WebSocket connection. */
  async close(): Promise<void> {
    await this.surreal.close();
  }
}

/** Extracts record id text from SurrealDB response variants. */

export function extractId(rawId: unknown): string {
  if (typeof rawId === "object" && rawId !== null && "id" in rawId) {
    return String((rawId as any).id);
  }
  return String(rawId).replace(/^[^:]+:/, "");
}
