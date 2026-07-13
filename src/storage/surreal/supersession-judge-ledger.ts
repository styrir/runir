/**
 * Rúnir-pn1l.13.7 D3 — append-only supersession_judge_ledger.
 *
 * ONE row per live applied-path F2 escalation resolution, written while
 * RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM is ON (NOT gated by RUNIR_SUPERSEDE_SHADOW).
 * Shadow-lane and replay resolutions NEVER write this ledger.
 *
 * decisionId is both the record id (create-once / conflict-as-success) and
 * stamped into applied-record supersessionProvenance for cross-reference.
 * candidateSha256 hashes the candidate's l2 at decision time (ids are not
 * immutable evidence — merge-update mutates records in place).
 *
 * Ledger-append failures never fail the write: callers swallow, log, and count
 * ledger_write_failures (same containment posture as logSupersedeShadow).
 *
 * Create-once semantics (code-review P0#2): a second append with the same
 * decisionId must NOT mutate the stored row. The caller mints `ts` ONCE (stable
 * across retries); duplicate-key is success.
 */

import type { SurrealClient } from "./surreal-store.js";
import type {
  F2JudgeCheckResult,
  GuardOverride,
  SupersessionJudgeIdentity,
} from "../writes/supersession-judge.js";

export type JudgeLedgerIdentityStatus = "resolved" | "no_handle";

export type SupersessionJudgeLedgerRow = {
  decisionId: string;
  /** ISO-8601 decision timestamp, minted ONCE by the caller (stable across retries). */
  ts: string;
  userId: string;
  scope: string;
  candidateId: string;
  candidateSha256: string;
  incomingSha256: string;
  signal: string;
  band: string | null;
  cosine: number;
  result: F2JudgeCheckResult;
  confidence?: number;
  guardOverride?: GuardOverride;
  judgeIdentity: SupersessionJudgeIdentity | null;
  identityStatus: JudgeLedgerIdentityStatus;
  appliedOutcome: "create" | "supersede" | "skip";
};

/**
 * Module-owned ledger-failure accounting (code-review P1#3 / arch-r2 P1#1).
 * Independent of any judge handle so no-handle escalations still log + count.
 * Handle counters (when present) also read this number so /health stays a single
 * surface.
 *
 * Default logger is console.warn with the same message format the factory uses
 * when it injects via setLedgerFailureLogger. Injection REPLACES the default;
 * passing undefined restores it. Every failure both logs and counts whether or
 * not a judge handle was ever constructed.
 */
const DEFAULT_LEDGER_FAILURE_LOGGER = (msg: string): void => {
  console.warn(msg);
};

let moduleLedgerWriteFailures = 0;
let moduleLedgerFailureLogger: (msg: string) => void = DEFAULT_LEDGER_FAILURE_LOGGER;

/** Replace the module logger (or restore the console.warn default when undefined). */
export function setLedgerFailureLogger(fn: ((msg: string) => void) | undefined): void {
  moduleLedgerFailureLogger = fn ?? DEFAULT_LEDGER_FAILURE_LOGGER;
}

/** Increment + log a ledger-append failure. Never throws. Always logs (default or injected). */
export function noteLedgerWriteFailure(detail?: string): void {
  moduleLedgerWriteFailures += 1;
  try {
    moduleLedgerFailureLogger(
      `supersession-judge-ledger: append failed: ${detail ?? "unknown"}`,
    );
  } catch {
    // Logger must never fail the write path.
  }
}

export function getLedgerWriteFailures(): number {
  return moduleLedgerWriteFailures;
}

/** Test-only reset (counter only — logger stays at current default/injected). */
export function resetLedgerWriteFailuresForTests(): void {
  moduleLedgerWriteFailures = 0;
}

export async function ensureSupersessionJudgeLedgerTable(db: SurrealClient): Promise<void> {
  await db.query("DEFINE TABLE IF NOT EXISTS supersession_judge_ledger SCHEMAFULL;");
  await db.query("DEFINE FIELD IF NOT EXISTS ts ON TABLE supersession_judge_ledger TYPE datetime;");
  await db.query("DEFINE FIELD IF NOT EXISTS user_id ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS scope ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS decision_id ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS candidate_id ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS candidate_sha256 ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS incoming_sha256 ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS signal ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS band ON TABLE supersession_judge_ledger TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS cosine ON TABLE supersession_judge_ledger TYPE float;");
  await db.query("DEFINE FIELD IF NOT EXISTS result ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS confidence ON TABLE supersession_judge_ledger TYPE option<float>;");
  // guard_override / judge_identity stored as JSON strings (TYPE string) to avoid
  // SCHEMAFULL nested-field issues (mirrors supersede_shadow.live_flags).
  await db.query("DEFINE FIELD IF NOT EXISTS guard_override ON TABLE supersession_judge_ledger TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS judge_identity ON TABLE supersession_judge_ledger TYPE option<string>;");
  await db.query("DEFINE FIELD IF NOT EXISTS identity_status ON TABLE supersession_judge_ledger TYPE string;");
  await db.query("DEFINE FIELD IF NOT EXISTS applied_outcome ON TABLE supersession_judge_ledger TYPE string;");
  await db.query(
    "DEFINE INDEX IF NOT EXISTS idx_supersession_judge_ledger_user_ts ON TABLE supersession_judge_ledger COLUMNS user_id, ts;",
  );
}

/**
 * Create-once append by decisionId (record id). A duplicate-key outcome is
 * success (idempotent retry) and does NOT mutate the first row. Parameterized —
 * never string-interpolate user text into SurrealQL. Callers must swallow
 * non-conflict failures (r3-#2 / P0#2).
 */
export async function logSupersessionJudgeLedger(
  db: SurrealClient,
  row: SupersessionJudgeLedgerRow,
): Promise<void> {
  // option<T> fields require NONE (not null) when absent — same gotcha as logSupersedeShadow.
  const sets: string[] = [
    // Caller-minted stable ts — never time::now() at write time (P0#2).
    `ts=<datetime>$ts`,
    `user_id=$user_id`,
    `scope=$scope`,
    `decision_id=$decision_id`,
    `candidate_id=$candidate_id`,
    `candidate_sha256=$candidate_sha256`,
    `incoming_sha256=$incoming_sha256`,
    `signal=$signal`,
    `cosine=$cosine`,
    `result=$result`,
    `identity_status=$identity_status`,
    `applied_outcome=$applied_outcome`,
    row.band != null ? `band=$band` : `band=NONE`,
    row.confidence !== undefined ? `confidence=$confidence` : `confidence=NONE`,
    row.guardOverride != null ? `guard_override=$guard_override` : `guard_override=NONE`,
    row.judgeIdentity != null ? `judge_identity=$judge_identity` : `judge_identity=NONE`,
  ];

  const vars: Record<string, unknown> = {
    id: row.decisionId,
    ts: row.ts,
    user_id: row.userId,
    scope: row.scope,
    decision_id: row.decisionId,
    candidate_id: row.candidateId,
    candidate_sha256: row.candidateSha256,
    incoming_sha256: row.incomingSha256,
    signal: row.signal,
    cosine: row.cosine,
    result: row.result,
    identity_status: row.identityStatus,
    applied_outcome: row.appliedOutcome,
  };
  if (row.band != null) vars.band = row.band;
  if (row.confidence !== undefined) vars.confidence = row.confidence;
  if (row.guardOverride != null) vars.guard_override = JSON.stringify(row.guardOverride);
  if (row.judgeIdentity != null) vars.judge_identity = JSON.stringify(row.judgeIdentity);

  try {
    // CREATE (not UPSERT): second append with the same id is a conflict, not a rewrite.
    await db.query(
      `CREATE type::record('supersession_judge_ledger', $id) SET ${sets.join(", ")};`,
      vars,
    );
  } catch (err) {
    const msg = String(err);
    // Surreal duplicate-record / already-exists outcomes count as success (create-once).
    if (
      msg.includes("already contains") ||
      msg.includes("already exists") ||
      /record.*already/i.test(msg)
    ) {
      return;
    }
    throw err;
  }
}
