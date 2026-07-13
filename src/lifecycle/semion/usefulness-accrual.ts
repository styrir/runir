/**
 * Auto-accrual of usefulness feedback on the capture path (Rúnir-mmg2.2).
 *
 * Today the per-memory usefulness loop (applyUsefulnessFeedback) only runs when a
 * client explicitly POSTs /hooks/feedback after the model answers — and no client
 * does, so the signal is starved (3 of 6,624 owner semiotes carried any usefulness
 * state at design time). This module wires the SAME evaluation onto the capture
 * path automatically: when a capture batch's last turn is the assistant's answer,
 * we evaluate the most recent retrieval trace for that session against that answer
 * (pure lexical — no LLM call) and persist the resulting usefulness state, plus
 * the intent-conditioned status-noise counters when the trace was a status recall.
 *
 * Contract (orchestrator rulings R1/R3/R5):
 *  - FIRE-AND-FORGET: the caller never awaits this on the response path and never
 *    lets it fail or delay capture (matches the aftermath-stage access-tracking
 *    idiom). All errors are warn-logged here.
 *  - EXACTLY ONE evaluation per capture request: the caller invokes this once,
 *    against the LAST assistant turn only.
 *  - INTENT-CONDITIONED counters: status_retrieved_count / status_used_count are
 *    incremented ONLY when the trace's intent is a status-class intent
 *    (isStatusClassIntent) — the SAME predicate the demotion site uses.
 *  - SURGICAL writes: only the usefulness fields + the two status counters are
 *    patched; no access counters, no other ranking-feeding field (R5). The patch
 *    deliberately carries no hexis* fields so this path never rewrites them.
 */

import type { IntentSignal, QueryIntent } from "../../recall/intent/intent-analyzer.js";
import { isStatusClassIntent } from "../../recall/intent/intent-analyzer.js";
import {
  applyUsefulnessFeedback,
  type UsefulnessState,
} from "./usefulness-feedback.js";

/** A capture message as normalized by normalizeCaptureMessages. */
export interface AccrualCaptureMessage {
  role: string;
  content: string;
}

/**
 * True when the LAST normalized capture turn is an assistant turn with non-empty
 * content. This is the single-evaluation trigger: one assistant answer per capture
 * batch drives at most one accrual evaluation (R1). A batch whose last turn is the
 * user's prompt (or that has no assistant text) produces no answer to evaluate.
 */
export function findLastAssistantAnswer(
  messages: readonly AccrualCaptureMessage[],
): string | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return undefined;
  const text = (last.content ?? "").trim();
  return text.length > 0 ? text : undefined;
}

/** The prior usefulness + status-counter state of a single semiote row. */
export interface PriorSemioteUsefulness {
  id: string;
  /** The memory text used for lexical-overlap evidence (l2/data). */
  memoryText: string;
  previous: Partial<UsefulnessState>;
  statusRetrievedCount: number;
  statusUsedCount: number;
}

/** The computed patch for one semiote (a superset of UsefulnessState). */
export interface AccrualPatch extends UsefulnessState {
  id: string;
  /** Present ONLY when the trace was a status-class intent (R3). */
  statusRetrievedCount?: number;
  statusUsedCount?: number;
}

/**
 * Pure core: given the answer text, the trace's intent, and the prior state of
 * each retrieved semiote, compute the usefulness patch for each one.
 *
 * The status counters are derived from the SAME evidence the Beta posterior uses:
 * every evaluated row's status_retrieved_count increments (it was shown under a
 * status recall), and status_used_count increments only when the row was lexically
 * "used" (evidence >= 0.35, the applyUsefulnessFeedback `used` threshold) — so a
 * memory that crosses the retrieved threshold with status_used_count == 0 is one
 * that was repeatedly surfaced in status recalls yet never matched any answer.
 *
 * Counters are attached ONLY when `intentLabel` is a status-class intent (R3).
 * Outside status recalls the patch carries no status counters → patchSemioteUsefulness
 * leaves the existing counters untouched.
 *
 * Pure + deterministic (clock injected) → unit-testable with no DB.
 */
export function buildUsefulnessAccrual(params: {
  answer: string;
  intentLabel: QueryIntent;
  rows: readonly PriorSemioteUsefulness[];
  /**
   * Auto-accrual derives no explicit resolution label — evidence comes from
   * lexical overlap with the answer (applyUsefulnessFeedback defaults the
   * resolution weight to 0.7 when absent). Left injectable for tests.
   */
  responseResolution?: Parameters<typeof applyUsefulnessFeedback>[0]["responseResolution"];
  corrected?: boolean;
  crossSession?: boolean;
  traceCreatedAt?: string;
  now?: string;
}): AccrualPatch[] {
  const isStatus = isStatusClassIntent(params.intentLabel);
  return params.rows.map((row) => {
    const next = applyUsefulnessFeedback({
      memoryText: row.memoryText,
      answer: params.answer,
      responseResolution: params.responseResolution,
      corrected: params.corrected ?? false,
      crossSession: params.crossSession ?? false,
      previous: row.previous,
      traceCreatedAt: params.traceCreatedAt,
      now: params.now,
    });
    const patch: AccrualPatch = { ...next, id: row.id };
    if (isStatus) {
      // "used" mirrors applyUsefulnessFeedback's own threshold: usedCount went up
      // iff this evaluation counted as a use. Compare against the prior usedCount
      // to detect that without recomputing the evidence here.
      const wasUsed = next.usedCount > (row.previous.usedCount ?? 0);
      patch.statusRetrievedCount = row.statusRetrievedCount + 1;
      patch.statusUsedCount = row.statusUsedCount + (wasUsed ? 1 : 0);
    }
    return patch;
  });
}

/** A retrieval trace, projected to what accrual needs. */
export interface AccrualTrace {
  id: string;
  sessionId?: string;
  intentLabel: string;
  createdAt: string;
  items: Array<{ id: string }>;
}

/** DB seam for the orchestration helper — injected so the helper is testable. */
export interface UsefulnessAccrualDeps {
  /** Most-recent-first traces for the user (e.g. listRetrievalTraces). */
  listTraces: (userId: string, limit: number) => Promise<AccrualTrace[]>;
  /** Loads prior usefulness + status-counter state for the given semiote ids. */
  loadPriorState: (ids: string[]) => Promise<PriorSemioteUsefulness[]>;
  /** Persists one computed patch (e.g. patchSemioteUsefulness). */
  persistPatch: (patch: AccrualPatch) => Promise<void>;
}

export interface UsefulnessAccrualParams {
  userId: string;
  sessionId?: string;
  messages: readonly AccrualCaptureMessage[];
  /** How many recent traces to scan for the session match. */
  traceLookback?: number;
  now?: string;
}

export interface UsefulnessAccrualResult {
  /** Why nothing was evaluated, or "ok" when an evaluation ran. */
  status: "ok" | "no_assistant_turn" | "no_trace" | "no_rows" | "error";
  traceId?: string;
  evaluated: number;
  statusConditioned: boolean;
}

/**
 * Orchestrates ONE auto-accrual evaluation for a capture request. Resilient by
 * construction: any thrown error is caught and returned as `status:"error"` (the
 * caller fire-and-forgets, so it never touches the capture response). Performs at
 * most one trace lookup + one state load + N small patches.
 *
 * Picks the most recent trace whose sessionId matches the capture's sessionId
 * (when a sessionId is supplied); otherwise the single most recent trace. This is
 * idempotent on re-POST of the same (trace, answer): applyUsefulnessFeedback is
 * deterministic, but each call still advances the Beta posterior + counters by one
 * observation — the caller's single-evaluation-per-request guard (one assistant
 * turn ⇒ one call) is what bounds accrual to one observation per captured answer.
 */
export async function accrueUsefulnessFromCapture(
  deps: UsefulnessAccrualDeps,
  params: UsefulnessAccrualParams,
): Promise<UsefulnessAccrualResult> {
  try {
    const answer = findLastAssistantAnswer(params.messages);
    if (!answer) {
      return { status: "no_assistant_turn", evaluated: 0, statusConditioned: false };
    }

    const lookback = params.traceLookback ?? 10;
    const traces = await deps.listTraces(params.userId, lookback);
    const trace = pickTraceForSession(traces, params.sessionId);
    if (!trace) {
      return { status: "no_trace", evaluated: 0, statusConditioned: false };
    }

    const itemIds = trace.items.map((item) => item.id).filter(Boolean);
    if (itemIds.length === 0) {
      return { status: "no_rows", traceId: trace.id, evaluated: 0, statusConditioned: false };
    }

    const rows = await deps.loadPriorState(itemIds);
    if (rows.length === 0) {
      return { status: "no_rows", traceId: trace.id, evaluated: 0, statusConditioned: false };
    }

    const patches = buildUsefulnessAccrual({
      answer,
      intentLabel: trace.intentLabel as QueryIntent,
      rows,
      traceCreatedAt: trace.createdAt,
      now: params.now,
    });

    for (const patch of patches) {
      await deps.persistPatch(patch);
    }

    return {
      status: "ok",
      traceId: trace.id,
      evaluated: patches.length,
      statusConditioned: isStatusClassIntent(trace.intentLabel as QueryIntent),
    };
  } catch (err) {
    console.warn("runir-capture: usefulness auto-accrual failed (non-fatal):", err);
    return { status: "error", evaluated: 0, statusConditioned: false };
  }
}

/**
 * Selects the trace to evaluate: the most recent trace matching `sessionId`, or —
 * when no sessionId is supplied — the single most recent trace. `traces` is
 * assumed newest-first (listRetrievalTraces' ORDER BY created_at DESC).
 */
export function pickTraceForSession(
  traces: readonly AccrualTrace[],
  sessionId: string | undefined,
): AccrualTrace | undefined {
  if (!sessionId) return traces[0];
  return traces.find((t) => t.sessionId === sessionId);
}

/** Re-export for callers wiring the predicate at the capture site. */
export { isStatusClassIntent };
export type { IntentSignal };
