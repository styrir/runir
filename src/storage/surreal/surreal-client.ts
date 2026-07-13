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
   * Failure detection: with surrealdb@2.0.3, awaiting `surreal.query()` runs the
   * driver's `collect()`, which THROWS on the first failed statement
   * (`if (chunk.error) throw chunk.error` — surrealdb.mjs:3257; an `ERR` status
   * becomes `chunk.error` at :6594). A failed transaction therefore surfaces as
   * a rejected promise, never as a resolved result carrying a `status:"ERR"`
   * envelope — so the rejected await is the COMPLETE failure signal. We
   * deliberately do NOT scan resolved statement results for a `status` field:
   * those are user result VALUES (rows/objects), not RPC envelopes, and a value
   * that happens to contain `status:"ERR"` must not be mistaken for a rollback.
   * Re-verify this await-throws contract if the SDK is bumped.
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
      // Raw driver call — bypasses query()'s reconnect-retry-once on purpose.
      await this.surreal.query(tx, vars);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `transaction failed (rolled back, or in-doubt if the connection dropped after COMMIT): ${msg}`,
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


