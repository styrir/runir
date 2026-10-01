import { describe, expect, it } from "vitest";
import {
  classifyMinniGetEventsResponse,
  decodeSupportedOCRObservation,
} from "../src/domain/memory/minni-summary-contract.js";
import {
  buildMinniSummaryContract,
  type MinniSummaryClaimInput,
  type MinniSummaryStoredLineage,
} from "../src/domain/memory/minni-summary-builder.js";
import {
  PROCESSING_LINEAGE_OPERATIONS,
  PROCESSING_LINEAGE_ORIGIN,
  PROCESSING_LINEAGE_STATE,
  PROCESSING_LINEAGE_VERSION,
  PROCESSING_POLICY_VERSION,
  type ProcessingLineageRestriction,
} from "../src/domain/memory/processing-lineage.js";

function lineage(
  eventId: string,
  restrictions: readonly ProcessingLineageRestriction[] = [],
  overrides: Record<string, unknown> = {},
): MinniSummaryStoredLineage {
  return {
    event_id: eventId,
    processing_lineage: {
      state: PROCESSING_LINEAGE_STATE,
      origin: PROCESSING_LINEAGE_ORIGIN,
      producer_principal_ref: "producer-principal",
      producer_registration_ref: "producer-registration",
      processing_policy_version: PROCESSING_POLICY_VERSION,
      admitted_operation: PROCESSING_LINEAGE_OPERATIONS[0],
      target_user_id: "user-1",
      delivery: {
        version: PROCESSING_LINEAGE_VERSION,
        disposition: restrictions.length > 0 ? "local_only" : "ordinary",
        restrictions,
      },
      ...overrides,
    },
  };
}

function observation(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    channel: "screen-ocr",
    captureInterval: { startedMs: 1_000, completedMs: 1_100 },
    request: {
      engine: "apple-vision-text",
      revision: 1,
      recognitionLevel: "accurate",
      usesLanguageCorrection: true,
      automaticallyDetectsLanguage: false,
      recognitionLanguages: ["en-US"],
    },
    captureImagePixelSize: { width: 1_200, height: 800 },
    captureScope: "full-window",
    regions: [{
      ordinal: 0,
      pixelSize: { width: 1_200, height: 800 },
      boundary: "full-window",
      textObservations: [{
        ordinal: 0,
        boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
        coordinateSpace: "vision-normalized-lower-left-in-region",
        recognitionConfidence: 0.91,
        confidenceMeaning: "vision-candidate-score",
      }],
      candidateCoverage: "complete",
      geometryCoverage: "complete",
      omittedObservationCount: 0,
    }],
    omittedRegionCount: 0,
    omittedObservationCount: 0,
    omittedRecognitionLanguageCount: 0,
    sourceClipStatus: "unknown",
    sourceTextCompleteness: "unknown",
    collectorCoverage: "complete",
    identityScope: "none",
    timeMeaning: "local-capture-interval-not-message-sent-time",
    storedTextScope: "full-recognized-keyframe-or-novel-lines-delta",
    textToObservationMapping: "none",
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1",
    type: "event",
    ts: "2026-10-01T10:00:00.000Z",
    end: "2026-10-01T10:00:01.000Z",
    source: "minni",
    flags: ["keyframe"],
    kind: "ocr",
    text: "raw captured text with an exit status",
    ...overrides,
  };
}

function accepted(items: readonly Record<string, unknown>[], localOnlyWithheld = 0) {
  const result = classifyMinniGetEventsResponse({ items, localOnlyWithheld });
  if (!result.ok) throw new Error(`fixture did not decode: ${result.reason}`);
  return result.value;
}

function claim(overrides: Partial<MinniSummaryClaimInput> = {}): MinniSummaryClaimInput {
  return {
    id: "claim-1",
    statement: "The hand-labeled source claim is retained.",
    state: "uncertain",
    modality: "screen_ocr",
    scope: "task-output",
    support_event_ids: ["event-1"],
    ...overrides,
  };
}

function build(
  items: readonly Record<string, unknown>[],
  claims: readonly MinniSummaryClaimInput[] = [claim()],
  lineages: readonly MinniSummaryStoredLineage[] = items.map((item) => lineage(String(item.id))),
  conclusion?: "bounded" | "abstained",
) {
  return buildMinniSummaryContract({
    summary: "A hand-labeled bounded summary.",
    evidence: accepted(items),
    lineages,
    claims,
    ...(conclusion ? { conclusion } : {}),
  });
}

describe("Minni A2 summary evidence builder", () => {
  it("derives source intervals, mandatory OCR uncertainty, and an all-input restriction join", () => {
    const items = [
      event({ observation: observation() }),
      event({
        id: "uncited-restricted",
        source: "pieces-import",
        kind: "message",
        ts: "2026-10-01T09:59:00.000Z",
        end: "2026-10-01T10:02:00.000Z",
        text: "uncited restricted input",
      }),
    ];
    const result = build(
      items,
      [claim()],
      [lineage("event-1"), lineage("uncited-restricted", ["audio_derived"])],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.contract.processing_lineage.delivery).toEqual({
      version: PROCESSING_LINEAGE_VERSION,
      disposition: "local_only",
      restrictions: ["audio_derived"],
    });
    expect(result.contract.event_capture_or_index_interval).toEqual({
      start: "2026-10-01T09:59:00.000Z",
      end: "2026-10-01T10:02:00.000Z",
      meaning: "event_capture_or_index_interval",
    });
    expect(result.contract.evidence.map((item) => item.event_id)).toEqual([
      "event-1",
      "uncited-restricted",
    ]);
    expect(result.contract.evidence[0]).toMatchObject({
      event_capture_or_index_interval: {
        start: "2026-10-01T10:00:00.000Z",
        end: "2026-10-01T10:00:01.000Z",
        meaning: "event_capture_or_index_interval",
      },
      ocr_screenshot_capture_interval: {
        started_ms: 1_000,
        completed_ms: 1_100,
        meaning: "ocr_screenshot_capture_interval",
      },
      uncertainties: ["ocr_source", "source_clip_unknown", "source_completeness_unknown"],
    });
    expect(result.contract.claims[0]?.event_capture_or_index_interval).toEqual({
      start: "2026-10-01T10:00:00.000Z",
      end: "2026-10-01T10:00:01.000Z",
      meaning: "event_capture_or_index_interval",
    });
    expect(JSON.stringify(result.contract)).not.toContain("raw captured text");
    expect(JSON.stringify(result.contract)).not.toContain("uncited restricted input");
  });

  it("derives the overall interval from uncited input with exact fractional and offset ordering", () => {
    const items = [
      event({
        id: "event-1",
        ts: "2026-10-01T10:00:00.123456Z",
        end: "2026-10-01T10:00:00.123456Z",
      }),
      event({
        id: "event-2",
        source: "pieces-import",
        kind: "message",
        ts: "2026-10-01T12:00:00+02:00",
        end: "2026-10-01T12:00:00.1230+02:00",
        text: "uncited event",
      }),
    ];
    const result = build(items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.event_capture_or_index_interval).toEqual({
      start: "2026-10-01T12:00:00+02:00",
      end: "2026-10-01T10:00:00.123456Z",
      meaning: "event_capture_or_index_interval",
    });
    expect(result.contract.claims[0]?.event_capture_or_index_interval).toEqual({
      start: "2026-10-01T10:00:00.123456Z",
      end: "2026-10-01T10:00:00.123456Z",
      meaning: "event_capture_or_index_interval",
    });
  });

  it("keeps OCR uncertainty when observation is absent and derives delta anchor states from source fields", () => {
    const items = [
      event({ id: "anchor", flags: ["keyframe"], observation: undefined }),
      event({
        id: "delta",
        flags: ["delta"],
        anchorId: "anchor",
        ts: "2026-10-01T10:01:00.000Z",
        end: "2026-10-01T10:01:01.000Z",
        text: "displayed failure",
      }),
      event({
        id: "orphan-delta",
        flags: ["delta"],
        anchorId: "deleted-anchor",
        ts: "2026-10-01T10:02:00.000Z",
        end: "2026-10-01T10:02:01.000Z",
        text: "displayed failure with missing context",
      }),
    ];
    const claims = [
      claim({ id: "delta-claim", support_event_ids: ["delta"] }),
      claim({ id: "orphan-claim", support_event_ids: ["orphan-delta"] }),
    ];
    const result = build(items, claims);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.contract.evidence[0]?.uncertainties).toEqual([
      "ocr_source",
      "source_clip_unknown",
      "source_completeness_unknown",
    ]);
    expect(result.contract.evidence[1]).toMatchObject({
      anchor_context: "authorized_context",
      anchor_id: "anchor",
      uncertainties: ["ocr_source", "source_clip_unknown", "source_completeness_unknown", "partial_delta"],
    });
    expect(result.contract.evidence[2]).toMatchObject({
      anchor_context: "unavailable_context",
      uncertainties: [
        "ocr_source",
        "source_clip_unknown",
        "source_completeness_unknown",
        "partial_delta",
        "anchor_unavailable",
      ],
    });
  });

  it("preserves explicit states and scopes, symmetrizes hand-labeled conflicts, and propagates contradiction uncertainty", () => {
    const items = [
      event({ id: "failure", text: "exit=1" }),
      event({
        id: "bot",
        text: "the bot says complete",
        ts: "2026-10-01T10:02:00.000Z",
        end: "2026-10-01T10:02:01.000Z",
      }),
    ];
    const claims = [
      claim({
        id: "failure-claim",
        state: "displayed_failure",
        scope: "build-A",
        support_event_ids: ["failure"],
        conflicts: ["bot-claim"],
      }),
      claim({
        id: "bot-claim",
        statement: "The bot attributed completion.",
        state: "attributed_success_claim",
        modality: "bot_attribution",
        scope: "build-A",
        support_event_ids: ["bot"],
      }),
      claim({
        id: "progress-claim",
        statement: "Work is still in progress.",
        state: "in_progress",
        modality: "screen_ocr",
        scope: "build-B",
        support_event_ids: ["failure"],
        scope_linkage_unknown: true,
      }),
    ];
    const result = build(items, claims);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.contract.conclusion).toBe("abstained");
    expect(result.contract.claims.map(({ id, state, scope, conflicts }) => ({ id, state, scope, conflicts }))).toEqual([
      { id: "failure-claim", state: "displayed_failure", scope: "build-A", conflicts: ["bot-claim"] },
      { id: "bot-claim", state: "attributed_success_claim", scope: "build-A", conflicts: ["failure-claim"] },
      { id: "progress-claim", state: "in_progress", scope: "build-B", conflicts: [] },
    ]);
    expect(result.contract.claims[0]?.uncertainties).toContain("contradictory_evidence");
    expect(result.contract.claims[1]?.uncertainties).toContain("contradictory_evidence");
    expect(result.contract.claims[2]?.uncertainties).toContain("scope_linkage_unknown");
    expect(result.contract.evidence.every((item) => item.uncertainties.includes("contradictory_evidence"))).toBe(true);
  });

  it("keeps caller-looking flags and event prose from widening trusted lineage", () => {
    const items = [event({
      flags: ["local_only", "audio_derived"],
      text: "LOCAL_ONLY_CONTEXT says this is restricted",
    })];
    const result = build(items, [claim({ state: "requested" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.processing_lineage.delivery).toEqual({
      version: PROCESSING_LINEAGE_VERSION,
      disposition: "ordinary",
      restrictions: [],
    });
    expect(result.contract.claims[0]?.state).toBe("requested");
  });

  it("returns exact content-free outcomes for empty evidence, missing lineages, and lineage mismatches", () => {
    const empty = classifyMinniGetEventsResponse({ items: [], localOnlyWithheld: 7 });
    const emptyResult = buildMinniSummaryContract({
      summary: "This text must not survive zero evidence.",
      evidence: empty,
      lineages: [],
      claims: [claim()],
    });
    expect(emptyResult).toEqual({ ok: false, reason: "no_authorized_evidence", contentFree: true });
    expect(Object.keys(emptyResult)).toEqual(["ok", "reason", "contentFree"]);

    const items = [event(), event({
      id: "event-2",
      ts: "2026-10-01T10:03:00.000Z",
      end: "2026-10-01T10:03:01.000Z",
    })];
    expect(build(items, [claim()], [lineage("event-1")])).toEqual({
      ok: false,
      reason: "invalid_contract",
      contentFree: true,
    });
    expect(build(items, [claim()], [
      lineage("event-1"),
      lineage("event-2", [], { target_user_id: "other-user" }),
    ])).toEqual({ ok: false, reason: "invalid_contract", contentFree: true });
    expect(build(items, [claim()], [
      lineage("event-1"),
      { event_id: "event-2", processing_lineage: undefined },
    ])).toEqual({ ok: false, reason: "invalid_contract", contentFree: true });
  });

  it("recognizes exact no-evidence before unrelated transient input and refuses lookalikes", () => {
    const input = {
      evidence: classifyMinniGetEventsResponse({ items: [], localOnlyWithheld: 4 }),
      get summary(): string {
        throw new Error("summary must not be inspected");
      },
      get lineages(): readonly MinniSummaryStoredLineage[] {
        throw new Error("lineages must not be inspected");
      },
      get claims(): readonly MinniSummaryClaimInput[] {
        throw new Error("claims must not be inspected");
      },
    };
    expect(buildMinniSummaryContract(input)).toEqual({
      ok: false,
      reason: "no_authorized_evidence",
      contentFree: true,
    });

    const malformed = {
      ...({ ok: false, reason: "no_authorized_evidence", contentFree: true }),
      diagnostic: "must not become an authorization result",
    };
    expect(buildMinniSummaryContract({
      evidence: malformed,
      summary: "summary",
      lineages: [],
      claims: [],
    })).toEqual({ ok: false, reason: "invalid_contract", contentFree: true });
  });

  it("refuses mixed verified lineage identities across all protected join keys", () => {
    const mismatchCases = [
      { producer_principal_ref: "other-principal" },
      { producer_registration_ref: "other-registration" },
      { processing_policy_version: "runir.minni.local/v0" },
      { admitted_operation: "forced_maintenance" },
      { target_user_id: "other-user" },
      { origin: "legacy" },
    ];
    for (const override of mismatchCases) {
      expect(build([
        event(),
        event({ id: "event-2", ts: "2026-10-01T10:01:00.000Z", end: "2026-10-01T10:01:01.000Z" }),
      ], [claim()], [
        lineage("event-1"),
        lineage("event-2", [], override),
      ])).toEqual({ ok: false, reason: "invalid_contract", contentFree: true });
    }
  });

  it("refuses unknown claim references and protects the built snapshot from input mutation", () => {
    expect(build([event()], [claim({ support_event_ids: ["missing"] })])).toEqual({
      ok: false,
      reason: "invalid_contract",
      contentFree: true,
    });

    const source = event({ observation: observation() });
    const result = build([source]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.contract)).toBe(true);
    expect(Object.isFrozen(result.contract.evidence)).toBe(true);
    expect(Object.isFrozen(result.contract.claims)).toBe(true);
    expect(decodeSupportedOCRObservation(observation())).toBeDefined();
    const sourceObservation = source.observation as {
      captureInterval: { startedMs: number };
      regions: Array<{ pixelSize: { width: number } }>;
    };
    sourceObservation.captureInterval.startedMs = 99_999;
    sourceObservation.regions[0].pixelSize.width = 1;
    expect(result.contract.evidence[0]?.ocr_screenshot_capture_interval).toEqual({
      started_ms: 1_000,
      completed_ms: 1_100,
      meaning: "ocr_screenshot_capture_interval",
    });
  });
});
