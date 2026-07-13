// Idle-session janitor (Rúnir-78sy.13, F3).
//
// Step in runConsolidationForScope (scope==='user' pass, BEFORE the
// continuity-gap Step 4.6 — see consolidation.ts) that closes this user's
// active-but-idle runir_session rows. This is the universal fallback closer:
// /hooks/session-end (F2) only fires when a client both registers a
// SessionEnd hook AND successfully POSTs it; this step catches everything
// else (crash/kill, clients with no session-end path at all — codex, hermes,
// pi per the 78sy.13 root-cause brief).
//
// Consolidation-scoped, NOT a universal table cleanup (Codex MINOR #6): this
// only runs for users who reach the consolidation "user" scope pass, which
// itself is gated by consolidation eligibility (measurement tenants never
// auto-eligible, watermark-count gating — consolidation.ts's
// getEligibleUsers/runForUser). A user never eligible for consolidation
// keeps zombie rows and also never gets gap detection — consistent, not a
// regression.
//
// Bulk UPDATE bypasses resolveRunirSession, so it must independently stamp
// last_closed_at with the SAME monotone-guard shape (F1 race rule) — two
// interleaved closers (this step and a session-end POST landing at the same
// moment) must never regress each other's last_closed_at.

import type { SurrealClient } from "../../storage/surreal/surreal-store.js";

/**
 * RUNIR_SESSION_IDLE_CLOSE_H: hours of inactivity (last_seen_at) before an
 * active row is considered idle and closed. Default 12. `0` (or any
 * non-positive value) explicitly DISABLES the step — distinct from an
 * unset/invalid value, which falls back to the default (continuity-gaps.ts
 * resolver shape does not need this distinction; this knob does, per brief).
 * Must be well under the detector's lookback window (168h default,
 * RUNIR_CONTINUITY_GAP_SESSION_LOOKBACK_H) to be useful — a row closed
 * further in the past than the lookback never becomes a missing_handoff
 * candidate at all.
 */
export function resolveSessionIdleCloseH(): number | 0 {
  const raw = process.env.RUNIR_SESSION_IDLE_CLOSE_H;
  if (raw === undefined) return 12;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 12;
  if (n <= 0) return 0; // explicit disable (0 or negative)
  return n;
}

/**
 * Detector lookback default (continuity-gaps.ts resolveGapSessionLookbackH),
 * duplicated here ONLY for the preflight "within gap lookback" log metric —
 * NOT imported, to avoid a session-janitor -> continuity-gaps dependency for
 * a single constant (the janitor must be independently disableable/testable
 * without pulling in the gap detector's module graph). If the detector's
 * default ever changes, this preflight metric may drift from the live
 * default when RUNIR_CONTINUITY_GAP_SESSION_LOOKBACK_H is unset; it reads
 * the SAME env var so an explicit override still tracks correctly.
 */
function resolveGapLookbackHForPreflight(): number {
  const n = Number(process.env.RUNIR_CONTINUITY_GAP_SESSION_LOOKBACK_H);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 168;
}

export interface SessionIdleJanitorResult {
  closed: number;
  disabled: boolean;
}

/**
 * Closes active-but-idle runir_session rows for one user. Own try/catch is
 * the CALLER's responsibility (consolidation.ts wraps every Step like this
 * one) — this function itself does not swallow errors, matching
 * runGapDetectionStep/runContinuityBuildStep's contract (the caller decides
 * how "degrade, never fail the run" applies).
 */
export async function runSessionIdleJanitorStep(
  db: SurrealClient,
  userId: string,
  logger?: (msg: string) => void,
): Promise<SessionIdleJanitorResult> {
  const idleH = resolveSessionIdleCloseH();
  if (idleH === 0) return { closed: 0, disabled: true };

  const cutoffIso = new Date(Date.now() - idleH * 3_600_000).toISOString();
  const gapLookbackCutoffIso = new Date(Date.now() - resolveGapLookbackHForPreflight() * 3_600_000).toISOString();

  // Preflight (Codex MAJOR #3): count matching rows AND how many of those
  // fall within the detector's lookback window (i.e. potentially
  // gap-eligible once closed) BEFORE running the UPDATE, so the first run
  // against the 2738-zombie backlog is auditable from the log alone.
  const preflightResults = await db.query<{ total: number; withinLookback: number }>(
    `SELECT count() AS total,
            count(last_seen_at > <datetime>$gapLookbackCutoff) AS withinLookback
       FROM runir_session
       WHERE user_id = $userId AND status = 'active' AND last_seen_at < <datetime>$cutoff
       GROUP ALL;`,
    { userId, cutoff: cutoffIso, gapLookbackCutoff: gapLookbackCutoffIso },
  );
  const preflight = preflightResults[0]?.[0];
  const total = preflight?.total ?? 0;
  if (total === 0) return { closed: 0, disabled: false };

  const withinLookback = preflight?.withinLookback ?? 0;
  logger?.(`janitor: closing ${total} idle sessions for ${userId} (${withinLookback} within gap lookback)`);

  // closed_at = last_seen_at (NOT now): true end-of-activity semantics AND
  // flood safety — the historical zombie backlog gets closed_at values far
  // older than the detector's lookback by construction, so the first run
  // cannot flood continuity_gap with a wave of "just closed" candidates.
  // last_closed_at uses the SAME monotone-guard shape as resolveRunirSession
  // (F1 race rule): this bulk UPDATE bypasses resolveRunirSession entirely,
  // so it must independently guard against regressing a newer close that
  // landed via a concurrent session-end POST between this preflight read and
  // this write.
  await db.query(
    `UPDATE runir_session SET
       status = 'closed',
       closed_at = last_seen_at,
       close_reason = 'idle_timeout',
       last_closed_at = IF last_closed_at == NONE OR last_seen_at > last_closed_at
         THEN last_seen_at ELSE last_closed_at END
     WHERE user_id = $userId AND status = 'active' AND last_seen_at < <datetime>$cutoff;`,
    { userId, cutoff: cutoffIso },
  );

  return { closed: total, disabled: false };
}
