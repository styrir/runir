import { Surreal } from "surrealdb";
import type {
  SearchHit,
} from "../../domain/memory/types";
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
  return {
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
}


export class SurrealClient {
  private surreal: Surreal;
  private ready: Promise<void>;
  private config: {
    url: string;
    username: string;
    password: string;
    namespace: string;
    database: string;
  };
  private reconnecting: Promise<void> | null = null;

  constructor(config: {
    url: string;
    username: string;
    password: string;
    namespace: string;
    database: string;
  }) {
    this.config = config;
    this.surreal = new Surreal();
    this.ready = this.init(config);
  }

  private async init(config: {
    url: string;
    username: string;
    password: string;
    namespace: string;
    database: string;
  }): Promise<void> {
    // Convert http(s) → ws(s) for WebSocket transport
    const wsUrl = config.url
      .replace(/^http(s?):\/\//, "ws$1://")
      .replace(/\/+$/, "");
    await this.surreal.connect(wsUrl);
    // SurrealDB 3.x WebSocket auth requires signin before use (a bare
    // `use()` on an unauthenticated session surfaces as InvalidAuth on the
    // next query). signin → use is the correct order for root-level auth.
    await this.surreal.signin({
      username: config.username,
      password: config.password,
    });
    await this.surreal.use({
      namespace: config.namespace,
      database: config.database,
    });
  }

  /**
   * Re-authenticates (and reconnects if needed) after a stale WebSocket session.
   * Coalesces concurrent reconnect attempts into a single promise.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      try {
        // Try re-signin first (connection may still be alive but auth expired)
        await this.surreal.signin({
          username: this.config.username,
          password: this.config.password,
        });
        await this.surreal.use({
          namespace: this.config.namespace,
          database: this.config.database,
        });
      } catch {
        // Full reconnect — connection is dead
        try { await this.surreal.close(); } catch { /* ignore */ }
        this.surreal = new Surreal();
        await this.init(this.config);
      }
    })().finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }

  /**
   * Executes SurrealQL with native parameter binding (no LET prepending).
   * Returns an array of result arrays, one per SQL statement.
   *
   * On "Anonymous access" or connection errors, automatically reconnects
   * and retries once before propagating the failure.
   */
  async query<T = unknown>(
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<T[][]> {
    await this.ready;
    try {
      const raw: unknown[] = await this.surreal.query(sql, vars);
      return this.normalizeResults<T>(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Anonymous access") || msg.includes("Not enough permissions") || msg.includes("ConnectionUnavailable")) {
        // Stale session — reconnect and retry once
        await this.reconnect();
        const raw: unknown[] = await this.surreal.query(sql, vars);
        return this.normalizeResults<T>(raw);
      }
      throw err;
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
    await this.ready;
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
