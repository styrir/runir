// Continuity-gap detectors (Rúnir-78sy.4, Archeion v2 Phase 3).
//
// Step 4.6 in runConsolidationForScope (scope==='user' pass, after Step 4.5).
// DETERMINISTIC — no LLM call. Each detector interprets the builder's
// already-synthesized §7 continuity lists (unfiled_intentions / open_loops /
// pending_verification / active_agent_runs) + runir_session/semiote metadata into
// continuity_gap records. The 4 collector-blocked kinds (§11.2) need Leit's S-2
// evidence and are NOT built here.
//
// Discipline (continuity-build.ts): iterate enrolled projects only, bounded by a
// per-run project cap + a wall-clock budget, degrade-never-throw per project.
// After detection the step RECONCILES (supersedes stale/emptied active gaps) and
// stamps continuity_gap_build_state.evaluated_through = state.updatedAt so the
// report can tell "gaps current with state" from "gaps pending evaluation".
//
// Confidence is honest (Codex brief review): no `strong` without Leit S-2
// (§11.3 needs a work-item cross-check we don't have); unfiled_intent +
// started_unfinished are `weak` (single evidence class = the synthesized state);
// only missing_handoff is `developing` (two independent SESSION-BOUND classes:
// the close event + the session's own capture activity). `score` is a
// deterministic SORT-ONLY count ordering, never threshold-tuned.

import { canonicalizeWorkspaceId, fingerprint } from "../../identity/canonical-context.js";
import { buildBindingConditions, deriveContinuityBindingKeys } from "./continuity-build.js";
import { buildHandoffCueSqlFragment } from "./handoff-cues.js";
import type {
  ContinuityGapConfidence,
  ContinuityGapWrite,
  EvidenceRef,
  ProjectContinuityStateRecord,
  ProjectEnrollmentRecord,
  ShipNowGapKind,
} from "../../domain/memory/continuity.js";
import {
  listActiveGapsForKind,
  setGapStatus,
  upsertContinuityGap,
  writeGapEvaluatedThrough,
} from "../../storage/surreal/continuity-gap-store.js";
import {
  getProjectContinuityState,
  listProjectEnrollments,
} from "../../storage/surreal/continuity-state-store.js";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";

// ── Env resolvers (colocated, posIntEnv shape — continuity-build.ts pattern) ──

function resolveGapMaxProjectsPerRun(): number {
  const n = Number(process.env.RUNIR_CONTINUITY_GAP_MAX_PROJECTS_PER_RUN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

function resolveGapBudgetMs(): number {
  const n = Number(process.env.CONSOLIDATION_GAP_BUDGET_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30_000;
}

function resolveGapMaxSessionsPerProject(): number {
  const n = Number(process.env.RUNIR_CONTINUITY_GAP_MAX_SESSIONS_PER_PROJECT);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

function resolveGapSessionLookbackH(): number {
  const n = Number(process.env.RUNIR_CONTINUITY_GAP_SESSION_LOOKBACK_H);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 168;
}

export interface GapDetectionDeps {
  db: SurrealClient;
  userId: string;
  logger?: (msg: string) => void;
}

export interface GapDetectionResult {
  detected: number;
  superseded: number;
  projectsConsidered: number;
  projectsSkipped: number;
}

const SHIP_NOW_KINDS: ShipNowGapKind[] = ["unfiled_intent", "started_unfinished", "missing_handoff"];

// ── Content fingerprint for rolling dedupe keys ──────────────────────────────
// A stable, order-insensitive fingerprint of a list's content so a genuinely
// changed list surfaces a NEW gap (new dedupeKey) rather than overwriting a
// dismissed one (§R.4). Trim/lowercase/sort/join, then fp24.

export function normalizedListFingerprint(items: string[]): string {
  const norm = items
    .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
    .filter((s) => s.length > 0)
    .sort();
  return fingerprint(norm.join("\n"));
}

/** Sort-only ordering hint (NOT confidence/quality). Bounded count function. */
function scoreForCount(n: number): number {
  return Math.min(0.99, 0.1 * n);
}

function semioteEvidenceRefs(state: ProjectContinuityStateRecord, cap = 10): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const raw of state.sourceEvidenceRefs.slice(0, cap)) {
    const id = typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : undefined;
    if (!id) continue;
    const at = typeof (raw as { at?: unknown }).at === "string" ? (raw as { at: string }).at : undefined;
    refs.push({
      sourceType: "semiote",
      sourceId: id,
      label: `semiote ${id.slice(0, 12)}`,
      timestamp: at,
      sensitivity: "normal",
    });
  }
  return refs;
}

// ── Rolling project-level detectors (unfiled_intent, started_unfinished) ─────
// Both draw from a single evidence class — the LLM-synthesized continuity state
// — so both are `weak` (§11.1 / Codex F7); the dedupe key folds a content
// fingerprint so a changed list surfaces a fresh gap. Shared shape, one builder.

function buildRollingGap(
  state: ProjectContinuityStateRecord,
  kind: "unfiled_intent" | "started_unfinished",
  items: string[],
  title: string,
  summary: string,
  recommendation: string,
): ContinuityGapWrite | null {
  if (items.length === 0) return null;
  return {
    userId: state.userId,
    workspaceId: state.workspaceId,
    projectKey: state.projectKey,
    targetProjectId: state.projectId,
    targetNamespaceId: state.defaultNamespaceId,
    kind,
    title,
    summary,
    recommendation,
    relatedWorkItems: [],
    evidence: semioteEvidenceRefs(state),
    score: scoreForCount(items.length),
    confidence: "weak",
    status: "new",
    dedupeKey: `${kind}:${normalizedListFingerprint(items)}`,
  };
}

function detectUnfiledIntent(state: ProjectContinuityStateRecord): ContinuityGapWrite | null {
  const items = state.unfiledIntentions;
  return buildRollingGap(
    state,
    "unfiled_intent",
    items,
    `Unfiled intentions in ${state.projectKey}`,
    `${items.length} intention(s) discussed but not filed as beads/tasks: ${items.join("; ")}`,
    "File these as beads/tasks, or dismiss if intentional.",
  );
}

function detectStartedUnfinished(state: ProjectContinuityStateRecord): ContinuityGapWrite | null {
  const items = [...state.openLoops, ...state.pendingVerification, ...state.activeAgentRuns];
  return buildRollingGap(
    state,
    "started_unfinished",
    items,
    `Started-but-unfinished work in ${state.projectKey}`,
    `${items.length} open loop(s)/pending verification(s)/active run(s) without completion evidence: ${items.join("; ")}`,
    "Close out, verify, or file follow-up work for these items.",
  );
}

// ── Detector 3: missing_handoff (per ended session, developing) ──────────────

export interface EndedSession {
  id: string;
  closedAt?: string;
  closeReason?: string;
}

// Exported for the live-DB F4 durable-field test only (Rúnir-78sy.13,
// matching the sessionHasHandoff precedent above) — GitNexus-confirmed the
// export itself is additive/zero-blast-radius (no existing caller's behavior
// changes). Not part of the detector's public surface otherwise.
export async function fetchRecentlyEndedSessions(
  db: SurrealClient,
  userId: string,
  enrollment: ProjectEnrollmentRecord,
  cutoffIso: string,
  cap: number,
): Promise<EndedSession[]> {
  const keys = deriveContinuityBindingKeys(enrollment);
  const binding = buildBindingConditions(keys, "workspace_fingerprint");
  if (!binding) return [];
  const { conditions, vars: bindingVars } = binding;
  const vars: Record<string, unknown> = { userId, cutoff: cutoffIso, cap, ...bindingVars };

  // F4 (Rúnir-78sy.13): keys on the DURABLE last_closed_at, not the live
  // status/closed_at pairing. A row that closed last night and reactivated
  // this morning (status back to 'active', closed_at cleared) still MATCHES —
  // that is the fix (C1 in the 78sy.13 root-cause brief: the live pairing was
  // erased by the very next opener/recall/capture call, starving this
  // detector almost entirely). last_closed_at is never cleared by
  // reactivation, so no status filter is needed or wanted here.
  const results = await db.query<{ id: unknown; last_closed_at?: unknown; close_reason?: string | null }>(
    `SELECT id, last_closed_at, close_reason FROM runir_session
       WHERE user_id = $userId AND last_closed_at > <datetime>$cutoff
       AND (${conditions.join(" OR ")})
       ORDER BY last_closed_at DESC
       LIMIT $cap;`,
    vars,
  );
  return (results[0] ?? []).map((r) => ({
    id: typeof r.id === "string" ? r.id : String((r.id as { id?: unknown } | null)?.id ?? r.id),
    // close_reason may be NONE for a reactivated row whose reason was
    // cleared on resume (closed_at/close_reason pairing is unaffected by
    // this fix — Addendum A) — degrades gracefully (already optional on
    // EndedSession/missingHandoffGap).
    closedAt: r.last_closed_at != null ? String(r.last_closed_at) : undefined,
    closeReason: r.close_reason ?? undefined,
  }));
}

async function sessionDidWork(db: SurrealClient, userId: string, sessionId: string): Promise<boolean> {
  const results = await db.query<{ count: number }>(
    `SELECT count() FROM semiote
       WHERE user_id = $userId AND runir_session_id = $sessionId AND (active = NONE OR active = true)
       GROUP ALL;`,
    { userId, sessionId },
  );
  const count = Number(results[0]?.[0]?.count ?? 0);
  return count > 0;
}

// Broadened stored-role fast path (kept — F1/F19) OR'd with a cue-phrase leg
// matched server-side against the top-level lowercased `text_norm` column
// (already indexed for this exact user_id+runir_session_id scope: F11-F13,
// live-timed 126ms worst case on the busiest real session, 1609 rows). A
// genuine handoff worded differently (resume-point phrasing, handoff-doc-
// creation references — F5/F6) now suppresses the gap without a capture or
// schema change. `text_norm` is `option<string>` (phase2-store.ts), so the
// cue leg is explicitly guarded with `text_norm != NONE AND (...)` — a NONE
// row never reaches `string::contains` and never matches via the cue leg
// (pinned live: continuity-gaps-handoff-cue-repro.test.ts).
const { fragment: HANDOFF_CUE_FRAGMENT, vars: HANDOFF_CUE_VARS } = buildHandoffCueSqlFragment("text_norm");

// Exported for the live-DB SQL≡JS fixture-matrix test only (Codex MAJOR-3) —
// GitNexus-confirmed LOW blast radius, single internal chain (F23). Not part
// of the detector's public surface otherwise.
export async function sessionHasHandoff(db: SurrealClient, userId: string, sessionId: string): Promise<boolean> {
  const results = await db.query<{ id: unknown }>(
    `SELECT id FROM semiote
       WHERE user_id = $userId AND runir_session_id = $sessionId
       AND (active = NONE OR active = true)
       AND (memory_role = 'session_handoff' OR (text_norm != NONE AND (${HANDOFF_CUE_FRAGMENT})))
       LIMIT 1;`,
    { userId, sessionId, ...HANDOFF_CUE_VARS },
  );
  return (results[0] ?? []).length > 0;
}

/** Builds the generation-suffixed missing_handoff dedupeKey (F7). Exported
 *  ONLY for the eligibility-prefix builder below — the two must derive from
 *  the exact same shape so the reconciliation membership test never drifts
 *  from what the detector actually writes. */
function missingHandoffDedupeKey(sessionId: string, closedAt: string): string {
  return `missing_handoff:${sessionId}:${closedAt}`;
}

function missingHandoffGap(state: ProjectContinuityStateRecord, session: EndedSession): ContinuityGapWrite {
  // Two independent SESSION-BOUND evidence classes, both auditable from the row
  // (Codex F7): the close event AND the session's own capture activity.
  const evidence: EvidenceRef[] = [
    {
      sourceType: "runir_session",
      sourceId: session.id,
      label: session.closeReason ? `session closed (${session.closeReason})` : "session closed",
      timestamp: session.closedAt,
      sensitivity: "normal",
    },
    {
      sourceType: "semiote",
      sourceId: session.id,
      label: "session produced captured work (no bound session_handoff)",
      sensitivity: "normal",
    },
  ];
  return {
    userId: state.userId,
    workspaceId: state.workspaceId,
    projectKey: state.projectKey,
    targetProjectId: state.projectId,
    targetNamespaceId: state.defaultNamespaceId,
    kind: "missing_handoff",
    title: `Session ended without a durable handoff in ${state.projectKey}`,
    summary:
      `A session that captured work closed without a session_handoff artifact. ` +
      `Heuristic: the handoff signal is derived from capture-time phrasing, so a differently-worded handoff may not register.`,
    recommendation: "Write a durable handoff for this session, or dismiss if none is needed.",
    relatedWorkItems: [],
    evidence,
    score: scoreForCount(1),
    // Two independent SESSION-BOUND classes (close event + capture activity).
    confidence: "developing" as ContinuityGapConfidence,
    status: "new",
    // F7 (Rúnir-78sy.13, Codex MAJOR #2): the key gains a CLOSE GENERATION —
    // the last_closed_at ISO of the close event that made this session
    // eligible (fetchRecentlyEndedSessions' WHERE already excludes sessions
    // with no last_closed_at, so `session.closedAt` — F4's mapped field — is
    // always defined here; the `?? "unknown"` fallback only guards a future
    // caller violating that invariant, it is never expected to fire).
    // Consequence: a dismissed gap only ever suppresses THAT close's gap —
    // a later close on the same row (new last_closed_at) is a NEW key, so it
    // gets its own fresh gap eligibility rather than staying suppressed
    // forever by an earlier dismiss (the bug this field fixes: before F7 a
    // shared per-scope row could produce only ONE missing-handoff gap for
    // its entire lifetime once dismissed).
    dedupeKey: missingHandoffDedupeKey(session.id, session.closedAt ?? "unknown"),
  };
}

interface MissingHandoffDetection {
  gaps: ContinuityGapWrite[];
  /** Every session this run actually evaluated (fetchRecentlyEndedSessions'
   *  result), regardless of whether it fired a gap. Threaded into
   *  reconcileKind as the window-eligibility set (§Part B, F15/F16): a gap
   *  whose session is NOT in this set merely aged past the LIMIT window and
   *  was never re-evaluated — reconciliation must not treat that as "resolved". */
  evaluatedSessionIds: Set<string>;
}

async function detectMissingHandoff(
  db: SurrealClient,
  state: ProjectContinuityStateRecord,
  enrollment: ProjectEnrollmentRecord,
): Promise<MissingHandoffDetection> {
  const cutoffMs = Date.now() - resolveGapSessionLookbackH() * 3_600_000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const sessions = await fetchRecentlyEndedSessions(db, state.userId, enrollment, cutoffIso, resolveGapMaxSessionsPerProject());
  const gaps: ContinuityGapWrite[] = [];
  const evaluatedSessionIds = new Set<string>();
  for (const session of sessions) {
    evaluatedSessionIds.add(session.id);
    const [didWork, hasHandoff] = await Promise.all([
      sessionDidWork(db, state.userId, session.id),
      sessionHasHandoff(db, state.userId, session.id),
    ]);
    if (didWork && !hasHandoff) gaps.push(missingHandoffGap(state, session));
  }
  return { gaps, evaluatedSessionIds };
}

// ── Reconciliation (§R.4) ─────────────────────────────────────────────────────
// Per kind: supersede every active/new gap whose dedupeKey is NOT in the set the
// detectors fired this run. A changed rolling list → old-content gap superseded;
// an emptied list → all active gaps of that kind superseded; a missing_handoff
// session that gained a handoff → its gap superseded, but a session that merely
// aged out of the evaluated window is NOT touched (window-aware eligibility
// below). Runs AFTER the fired gaps are upserted so a just-written gap is never
// superseded.
//
// `isWindowEligible` (Part B, F15-F17, adapted for F7's generation-suffixed
// keys): when provided, a gap ALSO needs this predicate to return true to be
// supersede-eligible. Undefined for the two rolling kinds (unfiled_intent/
// started_unfinished) → the `??` below makes the check a no-op, so their
// reconciliation is behavior-identical to before Part B/F7. For
// missing_handoff, the caller passes a predicate built from THIS run's
// evaluated session ids (see buildMissingHandoffEligibility below) — a gap
// whose predicate returns false merely aged past the LIMIT window (or belongs
// to a session never evaluated this run) and was never re-evaluated, so it
// must survive rather than be treated as resolved.

async function reconcileKind(
  db: SurrealClient,
  state: ProjectContinuityStateRecord,
  kind: ShipNowGapKind,
  firedKeys: Set<string>,
  isWindowEligible?: (dedupeKey: string) => boolean,
): Promise<number> {
  const active = await listActiveGapsForKind(db, state.userId, state.workspaceId, state.projectKey, kind);
  let superseded = 0;
  for (const gap of active) {
    const windowEligible = isWindowEligible?.(gap.dedupeKey) ?? true;
    if (!firedKeys.has(gap.dedupeKey) && windowEligible) {
      await setGapStatus(db, gap.id, "superseded");
      superseded++;
    }
  }
  return superseded;
}

/**
 * Builds the missing_handoff window-eligibility predicate (F7 adaptation of
 * Part B/F15-F17) from this run's evaluated session ids. A gap's dedupeKey is
 * eligible when it belongs to one of THESE sessions — either the legacy
 * un-suffixed shape `missing_handoff:${sessionId}` (rows written before this
 * generation-suffix landed; prod has ~zero such rows given the starvation
 * this bead fixes, but they must not crash reconciliation) or the current
 * generation-suffixed shape `missing_handoff:${sessionId}:${anyGeneration}`.
 *
 * Never splits the STORED dedupeKey on ':' (session ids are record-like and
 * may themselves contain colons, e.g. `runir_session:abc` — Codex MAJOR-2):
 * both the legacy exact-match and the generation prefix are constructed
 * FORWARD from the known sessionId, then compared against the whole stored
 * key — so an embedded colon in sessionId is just more literal prefix text,
 * never a delimiter this function tries to parse apart.
 */
function buildMissingHandoffEligibility(evaluatedSessionIds: Set<string>): (dedupeKey: string) => boolean {
  const legacyExact = new Set<string>();
  const generationPrefixes: string[] = [];
  for (const sessionId of evaluatedSessionIds) {
    legacyExact.add(`missing_handoff:${sessionId}`);
    generationPrefixes.push(`missing_handoff:${sessionId}:`);
  }
  return (dedupeKey: string): boolean =>
    legacyExact.has(dedupeKey) || generationPrefixes.some((prefix) => dedupeKey.startsWith(prefix));
}

// ── Per-project detection ─────────────────────────────────────────────────────

async function detectForProject(
  deps: GapDetectionDeps,
  enrollment: ProjectEnrollmentRecord,
): Promise<{ detected: number; superseded: number; evaluated: boolean }> {
  const { db, userId } = deps;
  const workspaceId = canonicalizeWorkspaceId(enrollment.workspaceId);
  const state = await getProjectContinuityState(db, userId, workspaceId, enrollment.projectKey);
  if (!state) return { detected: 0, superseded: 0, evaluated: false };

  const fired = new Map<ShipNowGapKind, Set<string>>(SHIP_NOW_KINDS.map((k) => [k, new Set<string>()]));

  const rollingGaps = [detectUnfiledIntent(state), detectStartedUnfinished(state)].filter(
    (g): g is ContinuityGapWrite => g !== null,
  );
  const { gaps: handoffGaps, evaluatedSessionIds } = await detectMissingHandoff(db, state, enrollment);
  // The window-eligibility predicate for missing_handoff reconciliation
  // (Part B, adapted by F7 for generation-suffixed keys): built here (not in
  // reconcileKind) from the sessions THIS run actually evaluated — see
  // buildMissingHandoffEligibility's own doc for the legacy/generation
  // matching rule.
  const missingHandoffEligible = buildMissingHandoffEligibility(evaluatedSessionIds);

  let detected = 0;
  for (const gap of [...rollingGaps, ...handoffGaps]) {
    // Reopen-on-refire (Codex MAJOR-1) is scoped to missing_handoff: that
    // signal is not monotonic (sessionHasHandoff reads ACTIVE semiote rows,
    // so a handoff can later be inactivated), so a superseded gap must be
    // able to become active again. Rolling kinds keep the default (sticky)
    // upsert behavior — unaffected.
    await upsertContinuityGap(db, gap, gap.kind === "missing_handoff" ? { reopenIfSuperseded: true } : undefined);
    fired.get(gap.kind as ShipNowGapKind)?.add(gap.dedupeKey);
    detected++;
  }

  // Reconcile all 3 kinds concurrently — each read + its supersede writes are
  // independent across kinds (runs after the fired gaps are upserted above).
  // Only missing_handoff gets the window-eligibility filter; the two rolling
  // kinds pass `undefined` so reconcileKind's `?? true` keeps them unchanged.
  const supersededByKind = await Promise.all(
    SHIP_NOW_KINDS.map((kind) =>
      reconcileKind(
        db,
        state,
        kind,
        fired.get(kind) ?? new Set(),
        kind === "missing_handoff" ? missingHandoffEligible : undefined,
      ),
    ),
  );
  const superseded = supersededByKind.reduce((a, b) => a + b, 0);

  // Stamp the gap-evaluation cursor: gaps are now current with this state row.
  await writeGapEvaluatedThrough(db, userId, workspaceId, enrollment.projectKey, state.updatedAt);
  return { detected, superseded, evaluated: true };
}

// ── Entrypoint (Step 4.6) ─────────────────────────────────────────────────────

/**
 * Iterates enrolled projects (capped at RUNIR_CONTINUITY_GAP_MAX_PROJECTS_PER_RUN,
 * step budget CONSOLIDATION_GAP_BUDGET_MS), detecting + reconciling gaps for each.
 * Degrade-never-throw: a per-project failure is logged and skipped; the step
 * never fails the consolidation run.
 */
export async function runGapDetectionStep(deps: GapDetectionDeps): Promise<GapDetectionResult> {
  const { db, userId, logger } = deps;
  const maxProjects = resolveGapMaxProjectsPerRun();
  const budgetMs = resolveGapBudgetMs();
  const startedAt = Date.now();

  const enrollments = await listProjectEnrollments(db, userId);
  let detected = 0;
  let superseded = 0;
  let considered = 0;
  let skipped = 0;

  for (const enrollment of enrollments) {
    if (considered >= maxProjects) {
      logger?.(`memory-hybrid: gap detection project cap reached for ${userId} after ${considered} project(s)`);
      break;
    }
    if (Date.now() - startedAt >= budgetMs) {
      logger?.(`memory-hybrid: gap detection budget exhausted for ${userId} after ${considered} project(s)`);
      break;
    }
    considered++;
    try {
      const outcome = await detectForProject(deps, enrollment);
      detected += outcome.detected;
      superseded += outcome.superseded;
      if (!outcome.evaluated) skipped++;
    } catch (err) {
      logger?.(`memory-hybrid: gap detection error for ${userId}::${enrollment.projectKey}: ${String(err)}`);
    }
  }

  return { detected, superseded, projectsConsidered: considered, projectsSkipped: skipped };
}
