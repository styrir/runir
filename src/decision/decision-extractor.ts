/**
 * Decision extractor (Rúnir-yod0.6.5 / WS-5.dec.1).
 *
 * Scans a session transcript for project-decision moments and emits two
 * domain event types — `project_decision` (the decision summary) and
 * `decision_rationale` (the supporting rationale text, ≥50 chars). The
 * domain events are paired by `decision_id`.
 *
 * Trace integration: `appendDecisionEventsToTrace` maps each
 * `project_decision` (with its paired rationale) to a frozen
 * `TraceLifecycleEventRecallDecision` per ADR 0008. ADR 0008 §Schema
 * versioning permits this additive consumer wiring without a
 * `traceSchemaVersion` bump because no existing variant is mutated.
 *
 * The extractor is heuristic. The marker corpus targets the surface forms
 * the cross-adapter scenarios use (matrix runs at
 * `harness/reports/p2-matrix-final-1777213051/`) and the gRPC scenario
 * transcript fixture at `tests/fixtures/scenarios/grpc/transcript.jsonl`.
 */
import type {
  RetrievalTrace,
  TraceLifecycleEventRecallDecision,
} from "../recall/selection/retrieval-trace.js";

export type DecisionEventProjectDecision = {
  readonly type: "project_decision";
  readonly decision_id: string;
  readonly decision: string;
  readonly at: string;
};

export type DecisionEventDecisionRationale = {
  readonly type: "decision_rationale";
  readonly decision_id: string;
  readonly text: string;
  readonly at: string;
};

export type DecisionEvent =
  | DecisionEventProjectDecision
  | DecisionEventDecisionRationale;

export type DecisionExtractorTurn = {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly ts?: string;
};

export type DecisionExtractorInput = {
  readonly sessionId: string;
  readonly turns: ReadonlyArray<DecisionExtractorTurn>;
};

export type DecisionExtractorOutput = {
  readonly events: readonly DecisionEvent[];
};

export const RATIONALE_MIN_CHARS = 50;

const DECISION_MARKERS = [
  "we decided to",
  "we'll go with",
  "going with",
  "let's go with",
  "decided to use",
  "decided on",
  "chose to",
  "we chose",
  "settled on",
  "final answer is",
  "i'll choose",
  "we'll use",
];

const RATIONALE_MARKERS = ["because", "since", "due to", "given that", "as"];

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function findFirstMarker(text: string, markers: readonly string[]): {
  index: number;
  marker: string;
} | null {
  const lower = text.toLowerCase();
  let best: { index: number; marker: string } | null = null;
  for (const m of markers) {
    const idx = lower.indexOf(m);
    if (idx >= 0 && (best === null || idx < best.index)) {
      best = { index: idx, marker: m };
    }
  }
  return best;
}

function sliceSentence(text: string, startIndex: number): string {
  const remainder = text.slice(startIndex);
  const periodIdx = remainder.search(/[.!?\n]/);
  return periodIdx === -1 ? remainder.trim() : remainder.slice(0, periodIdx).trim();
}

/**
 * The decision text runs from `startIndex` to the first sentence boundary
 * OR the first rationale marker — whichever comes first — so a single
 * sentence carrying both `decided/chose/...` and `because/since/...`
 * splits cleanly into decision + rationale halves.
 */
function sliceDecision(text: string, startIndex: number): { decision: string; nextIndex: number } {
  const remainder = text.slice(startIndex);
  const sentenceBreak = remainder.search(/[.!?\n]/);
  const rationaleHit = findFirstMarker(remainder, RATIONALE_MARKERS);
  const breakIdx = sentenceBreak === -1 ? remainder.length : sentenceBreak;
  const stopIdx = rationaleHit !== null && rationaleHit.index < breakIdx
    ? rationaleHit.index
    : breakIdx;
  return { decision: remainder.slice(0, stopIdx).trim(), nextIndex: startIndex + stopIdx };
}

function extractRationale(turnText: string, fromIndex: number): string | null {
  const tail = turnText.slice(fromIndex);
  const marker = findFirstMarker(tail, RATIONALE_MARKERS);
  if (marker !== null) {
    const rationale = sliceSentence(tail, marker.index);
    if (rationale.length >= RATIONALE_MIN_CHARS) {
      return rationale;
    }
  }
  const fullTail = tail.trim();
  if (fullTail.length >= RATIONALE_MIN_CHARS) {
    return fullTail.length > 240 ? fullTail.slice(0, 240) : fullTail;
  }
  return null;
}

export function extractDecisions(input: DecisionExtractorInput): DecisionExtractorOutput {
  const events: DecisionEvent[] = [];
  const turns = input.turns;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === "tool") continue;
    const marker = findFirstMarker(turn.text, DECISION_MARKERS);
    if (marker === null) continue;

    const decisionStart = marker.index;
    const { decision: decisionText, nextIndex } = sliceDecision(turn.text, decisionStart);
    if (decisionText.length === 0) continue;

    let rationale = extractRationale(turn.text, nextIndex);

    if (rationale === null) {
      for (let j = i + 1; j < Math.min(i + 3, turns.length); j++) {
        const followup = turns[j];
        if (followup.role === "tool") continue;
        if (followup.text.length >= RATIONALE_MIN_CHARS) {
          rationale = followup.text.trim().slice(0, 240);
          break;
        }
      }
    }

    if (rationale === null) continue;

    const at = turn.ts ?? new Date(0).toISOString();
    const decision_id = `dec-${input.sessionId}-${fnv1aHex(`${i}|${decisionText}|${at}`)}`;
    events.push({ type: "project_decision", decision_id, decision: decisionText, at });
    events.push({ type: "decision_rationale", decision_id, text: rationale, at });
  }

  return { events };
}

export function appendDecisionEventsToTrace(
  trace: RetrievalTrace,
  events: ReadonlyArray<DecisionEvent>,
): RetrievalTrace {
  const rationaleById = new Map<string, string>();
  for (const e of events) {
    if (e.type === "decision_rationale") rationaleById.set(e.decision_id, e.text);
  }
  const lifecycle: TraceLifecycleEventRecallDecision[] = [];
  for (const e of events) {
    if (e.type !== "project_decision") continue;
    const reason = rationaleById.get(e.decision_id);
    const event: TraceLifecycleEventRecallDecision = reason !== undefined
      ? { type: "recall_decision", decision: "accept", entryId: e.decision_id, reason }
      : { type: "recall_decision", decision: "accept", entryId: e.decision_id };
    lifecycle.push(event);
  }
  return {
    ...trace,
    lifecycleEvents: [...(trace.lifecycleEvents ?? []), ...lifecycle],
  };
}
