import {
  classifyProcessingLineage,
  type ProcessingLineageV1,
} from "./processing-lineage.js";

export const MINNI_SUMMARY_CONTRACT_VERSION = "runir.minni.summary/v1" as const;
export const MINNI_GET_EVENTS_MAX_ITEMS = 500;
export const MINNI_OCR_MAX_REGIONS = 32;
export const MINNI_OCR_MAX_TEXT_OBSERVATIONS = 256;
export const MINNI_OCR_MAX_RECOGNITION_LANGUAGES = 16;
export const MINNI_OCR_MAX_LANGUAGE_UTF8_BYTES = 64;
export const MINNI_OCR_MAX_JSON_UTF8_BYTES = 65_536;

const MAX_REFERENCE_UTF8_BYTES = 256;

export const SUMMARY_CLAIM_STATES = [
  "requested",
  "planned",
  "in_progress",
  "displayed_success",
  "displayed_failure",
  "attributed_success_claim",
  "attributed_failure_claim",
  "uncertain",
] as const;

export const SUMMARY_UNCERTAINTIES = [
  "ocr_source",
  "source_clip_unknown",
  "source_completeness_unknown",
  "partial_delta",
  "anchor_unavailable",
  "contradictory_evidence",
  "scope_linkage_unknown",
] as const;

const REQUIRED_OCR_UNCERTAINTIES = [
  "ocr_source",
  "source_clip_unknown",
  "source_completeness_unknown",
] as const;

export const SUMMARY_ANCHOR_CONTEXTS = [
  "not_applicable",
  "authorized_context",
  "unavailable_context",
] as const;

export const SUMMARY_CONCLUSIONS = ["bounded", "abstained"] as const;
export const OCR_OBSERVATION_COVERAGE = [
  "complete",
  "partial-cardinality-cap",
  "partial-invalid-value",
] as const;
export const OCR_COLLECTOR_COVERAGE = [
  "complete",
  "partial-cardinality-cap",
  "partial-json-byte-cap",
  "partial-invalid-value",
] as const;
export const OCR_CAPTURE_SCOPES = ["full-window", "checked-web-area-regions"] as const;
export const OCR_BOUNDARIES = ["full-window", "checked-region-inset"] as const;

export type SummaryClaimState = (typeof SUMMARY_CLAIM_STATES)[number];
export type SummaryUncertainty = (typeof SUMMARY_UNCERTAINTIES)[number];
export type SummaryAnchorContext = (typeof SUMMARY_ANCHOR_CONTEXTS)[number];
export type SummaryConclusion = (typeof SUMMARY_CONCLUSIONS)[number];
export type OCRObservationCoverage = (typeof OCR_OBSERVATION_COVERAGE)[number];
export type OCRCollectorCoverage = (typeof OCR_COLLECTOR_COVERAGE)[number];
export type OCRCaptureScope = (typeof OCR_CAPTURE_SCOPES)[number];
export type OCRBoundary = (typeof OCR_BOUNDARIES)[number];

/** Summary-local labels are bounded labels, not sender, chat, or message identity. */
export type SummaryScopeLabel = string;
/** Modality is a hand-labeled contract value; it is not inferred from prose. */
export type SummaryModality = string;

export type NoAuthorizedEvidence = Readonly<{
  ok: false;
  reason: "no_authorized_evidence";
  contentFree: true;
}>;

export type SummaryCodecRefusalReason =
  | "invalid_producer_response"
  | "duplicate_returned_event_id"
  | "invalid_contract"
  | "unsupported_contract_version";

export type SummaryCodecRefusal = Readonly<{
  ok: false;
  reason: SummaryCodecRefusalReason;
  contentFree: true;
}>;

export type SummaryCodecResult<T> =
  | Readonly<{ ok: true; value: T }>
  | NoAuthorizedEvidence
  | SummaryCodecRefusal;

export type MinniEvent = Readonly<{
  id: string;
  type: "event";
  ts: string;
  source: string;
  flags: readonly string[];
  end?: string;
  app?: string;
  bundleId?: string;
  window?: string;
  url?: string;
  name?: string;
  kind?: string;
  anchorId?: string;
  conversationId?: string;
  text: string;
  observation?: SupportedOCRObservation;
}>;

export type MinniGetEventsResponse = Readonly<{
  items: readonly MinniEvent[];
  localOnlyWithheld: number;
}>;

export type AcceptedMinniEvidence = Readonly<{
  items: readonly MinniEvent[];
  returned_count: number;
  local_only_withheld_count: number;
}>;

export type OCRObservationRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type OCRObservationPixelSize = Readonly<{
  width: number;
  height: number;
}>;

export type SupportedOCRObservation = Readonly<{
  schemaVersion: 1;
  channel: "screen-ocr";
  captureInterval: Readonly<{ startedMs: number; completedMs: number }>;
  request: Readonly<{
    engine: "apple-vision-text";
    revision: number;
    recognitionLevel: "accurate" | "fast";
    usesLanguageCorrection: boolean;
    automaticallyDetectsLanguage: boolean;
    recognitionLanguages: readonly string[];
  }>;
  captureImagePixelSize: OCRObservationPixelSize;
  captureScope: OCRCaptureScope;
  regions: readonly Readonly<{
    ordinal: number;
    pixelSize: OCRObservationPixelSize;
    sourceRectInCapturePixels?: OCRObservationRect;
    boundary: OCRBoundary;
    textObservations: readonly Readonly<{
      ordinal: number;
      boundingBox: OCRObservationRect;
      coordinateSpace: "vision-normalized-lower-left-in-region";
      recognitionConfidence: number;
      confidenceMeaning: "vision-candidate-score";
    }>[];
    candidateCoverage: OCRObservationCoverage;
    geometryCoverage: OCRObservationCoverage;
    omittedObservationCount: number;
  }>[];
  omittedRegionCount: number;
  omittedObservationCount: number;
  omittedRecognitionLanguageCount: number;
  sourceClipStatus: "unknown";
  sourceTextCompleteness: "unknown";
  collectorCoverage: OCRCollectorCoverage;
  identityScope: "none";
  timeMeaning: "local-capture-interval-not-message-sent-time";
  storedTextScope: "full-recognized-keyframe-or-novel-lines-delta";
  textToObservationMapping: "none";
}>;

export type SummaryEventInterval = Readonly<{
  start: string;
  end: string;
  meaning: "event_capture_or_index_interval";
}>;

export type SummaryOCRScreenshotInterval = Readonly<{
  started_ms: number;
  completed_ms: number;
  meaning: "ocr_screenshot_capture_interval";
}>;

export type SummaryOCRCollector = Readonly<{
  collector_coverage: OCRCollectorCoverage;
  omitted_region_count: number;
  omitted_observation_count: number;
  omitted_recognition_language_count: number;
}>;

export type SummaryEvidenceReference = Readonly<{
  event_id: string;
  modality: SummaryModality;
  event_capture_or_index_interval: SummaryEventInterval;
  ocr_screenshot_capture_interval?: SummaryOCRScreenshotInterval;
  uncertainties: readonly SummaryUncertainty[];
  anchor_context: SummaryAnchorContext;
  anchor_id?: string;
  ocr_collector?: SummaryOCRCollector;
}>;

export type SummaryClaim = Readonly<{
  id: string;
  statement: string;
  state: SummaryClaimState;
  modality: SummaryModality;
  scope: SummaryScopeLabel;
  support_event_ids: readonly string[];
  event_capture_or_index_interval: SummaryEventInterval;
  uncertainties: readonly SummaryUncertainty[];
  conflicts: readonly string[];
}>;

export type MinniSummaryContract = Readonly<{
  version: typeof MINNI_SUMMARY_CONTRACT_VERSION;
  summary: string;
  event_capture_or_index_interval: SummaryEventInterval;
  evidence_counts: Readonly<{
    returned_count: number;
    local_only_withheld_count: number;
  }>;
  processing_lineage: ProcessingLineageV1;
  evidence: readonly SummaryEvidenceReference[];
  claims: readonly SummaryClaim[];
  conclusion: SummaryConclusion;
}>;

type ParsedMinniTimestamp = Readonly<{
  epochSeconds: bigint;
  fraction: string;
}>;

const MINNI_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysFromCivil(year: number, month: number, day: number): bigint {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365
    + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100)
    + dayOfYear;
  return BigInt(era * 146097 + dayOfEra - 719468);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parse a source-compatible ISO timestamp without converting it to Date/ms. */
export function parseMinniTimestamp(value: string): ParsedMinniTimestamp | undefined {
  if (!boundedString(value, MAX_REFERENCE_UTF8_BYTES, true)) return undefined;
  const match = MINNI_TIMESTAMP_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return undefined;

  const zone = match[8];
  let offsetSeconds = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return undefined;
    const sign = zone[0] === "-" ? -1 : 1;
    offsetSeconds = sign * (offsetHours * 60 + offsetMinutes) * 60;
  }
  const epochSeconds = daysFromCivil(year, month, day) * 86_400n
    + BigInt(hour * 3_600 + minute * 60 + second - offsetSeconds);
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  return Object.freeze({ epochSeconds, fraction });
}

/** Compare exact source instants; returns undefined when either input is invalid. */
export function compareMinniTimestamps(left: string, right: string): number | undefined {
  const parsedLeft = parseMinniTimestamp(left);
  const parsedRight = parseMinniTimestamp(right);
  if (!parsedLeft || !parsedRight) return undefined;
  if (parsedLeft.epochSeconds !== parsedRight.epochSeconds) {
    return parsedLeft.epochSeconds < parsedRight.epochSeconds ? -1 : 1;
  }
  const scale = Math.max(parsedLeft.fraction.length, parsedRight.fraction.length);
  const leftFraction = BigInt(parsedLeft.fraction.padEnd(scale, "0") || "0");
  const rightFraction = BigInt(parsedRight.fraction.padEnd(scale, "0") || "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

export type SummaryBuildResult =
  | Readonly<{ ok: true; contract: MinniSummaryContract }>
  | NoAuthorizedEvidence
  | SummaryCodecRefusal;

function noAuthorizedEvidence(): NoAuthorizedEvidence {
  return Object.freeze({
    ok: false as const,
    reason: "no_authorized_evidence" as const,
    contentFree: true as const,
  });
}

function refusal(reason: SummaryCodecRefusalReason): SummaryCodecRefusal {
  return Object.freeze({ ok: false as const, reason, contentFree: true as const });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.has(key))
    && required.every((key) => hasOwn(value, key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedString(value: unknown, maxBytes: number, trim = false): value is string {
  return typeof value === "string"
    && utf8Length(value) <= maxBytes
    && (!trim || value.length > 0 && value.trim() === value);
}

function nonEmptyReference(value: unknown): value is string {
  return boundedString(value, MAX_REFERENCE_UTF8_BYTES, true);
}

function nonEmptyTransientString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function transientString(value: unknown): value is string {
  return typeof value === "string";
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return safeCount(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseMinniTimestamp(value) !== undefined;
}

function intervalIsOrdered(start: string, end: string): boolean {
  const comparison = compareMinniTimestamps(start, end);
  return comparison !== undefined && comparison <= 0;
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function uniqueStrings(values: readonly string[]): readonly string[] | undefined {
  if (values.some((value) => !nonEmptyReference(value))) return undefined;
  const unique = [...new Set(values)];
  return unique.length === values.length ? Object.freeze(unique) : undefined;
}

function canonicalUncertainties(value: unknown): readonly SummaryUncertainty[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter((item): item is SummaryUncertainty => isEnum(item, SUMMARY_UNCERTAINTIES));
  if (parsed.length !== value.length) return undefined;
  const unique = new Set(parsed);
  return Object.freeze(SUMMARY_UNCERTAINTIES.filter((item) => unique.has(item)));
}

function hasRequiredOCRUncertainties(value: readonly SummaryUncertainty[]): boolean {
  return REQUIRED_OCR_UNCERTAINTIES.every((item) => value.includes(item));
}

function validRect(value: unknown, allowZero = true): value is OCRObservationRect {
  if (!isRecord(value) || !exactKeys(value, ["x", "y", "width", "height"])) return false;
  return finiteNumber(value.x) && finiteNumber(value.y)
    && finiteNumber(value.width) && finiteNumber(value.height)
    && (allowZero ? value.width >= 0 && value.height >= 0 : value.width > 0 && value.height > 0);
}

function validPixelSize(value: unknown): value is OCRObservationPixelSize {
  if (!isRecord(value) || !exactKeys(value, ["width", "height"])) return false;
  return positiveInteger(value.width) && positiveInteger(value.height);
}

function validCaptureInterval(value: unknown): value is { startedMs: number; completedMs: number } {
  if (!isRecord(value) || !exactKeys(value, ["startedMs", "completedMs"])) return false;
  return safeCount(value.startedMs) && safeCount(value.completedMs) && value.startedMs <= value.completedMs;
}

function validObservationProjection(value: unknown): value is SupportedOCRObservation {
  if (!isRecord(value)) return false;
  const keys = [
    "schemaVersion", "channel", "captureInterval", "request", "captureImagePixelSize",
    "captureScope", "regions", "omittedRegionCount", "omittedObservationCount",
    "omittedRecognitionLanguageCount", "sourceClipStatus", "sourceTextCompleteness",
    "collectorCoverage", "identityScope", "timeMeaning", "storedTextScope",
    "textToObservationMapping",
  ] as const;
  if (!exactKeys(value, keys)) return false;
  if (value.schemaVersion !== 1 || value.channel !== "screen-ocr") return false;
  if (!validCaptureInterval(value.captureInterval) || !validPixelSize(value.captureImagePixelSize)) return false;
  if (!isEnum(value.captureScope, OCR_CAPTURE_SCOPES)) return false;
  if (!safeCount(value.omittedRegionCount)
    || !safeCount(value.omittedObservationCount)
    || !safeCount(value.omittedRecognitionLanguageCount)) return false;
  if (value.sourceClipStatus !== "unknown"
    || value.sourceTextCompleteness !== "unknown"
    || value.identityScope !== "none"
    || value.timeMeaning !== "local-capture-interval-not-message-sent-time"
    || value.storedTextScope !== "full-recognized-keyframe-or-novel-lines-delta"
    || value.textToObservationMapping !== "none") return false;
  if (!isRecord(value.request)
    || !exactKeys(value.request, [
      "engine", "revision", "recognitionLevel", "usesLanguageCorrection",
      "automaticallyDetectsLanguage", "recognitionLanguages",
    ])
    || value.request.engine !== "apple-vision-text"
    || !positiveInteger(value.request.revision)
    || (value.request.recognitionLevel !== "accurate" && value.request.recognitionLevel !== "fast")
    || typeof value.request.usesLanguageCorrection !== "boolean"
    || typeof value.request.automaticallyDetectsLanguage !== "boolean"
    || !Array.isArray(value.request.recognitionLanguages)
    || value.request.recognitionLanguages.length > MINNI_OCR_MAX_RECOGNITION_LANGUAGES
    || value.request.recognitionLanguages.some(
      (language) => !nonEmptyReference(language) || utf8Length(language) > MINNI_OCR_MAX_LANGUAGE_UTF8_BYTES,
    )) return false;
  if (!Array.isArray(value.regions)
    || value.regions.length === 0
    || value.regions.length > MINNI_OCR_MAX_REGIONS) return false;

  let observationCount = 0;
  let allRegionsComplete = true;
  for (const [regionIndex, rawRegion] of value.regions.entries()) {
    if (!isRecord(rawRegion)
      || !exactKeys(rawRegion, [
        "ordinal", "pixelSize", "boundary", "textObservations", "candidateCoverage",
        "geometryCoverage", "omittedObservationCount",
      ], ["sourceRectInCapturePixels"])
      || rawRegion.ordinal !== regionIndex
      || !validPixelSize(rawRegion.pixelSize)
      || !isEnum(rawRegion.boundary, OCR_BOUNDARIES)
      || !Array.isArray(rawRegion.textObservations)
      || !isEnum(rawRegion.candidateCoverage, OCR_OBSERVATION_COVERAGE)
      || !isEnum(rawRegion.geometryCoverage, OCR_OBSERVATION_COVERAGE)
      || !safeCount(rawRegion.omittedObservationCount)) return false;
    if (hasOwn(rawRegion, "sourceRectInCapturePixels")
      && !validRect(rawRegion.sourceRectInCapturePixels, false)) return false;
    if (value.captureScope === "full-window") {
      if (value.regions.length !== 1
        || rawRegion.boundary !== "full-window"
        || hasOwn(rawRegion, "sourceRectInCapturePixels")
        || rawRegion.pixelSize.width !== value.captureImagePixelSize.width
        || rawRegion.pixelSize.height !== value.captureImagePixelSize.height) return false;
    } else {
      const rect = rawRegion.sourceRectInCapturePixels as OCRObservationRect | undefined;
      if (rawRegion.boundary !== "checked-region-inset"
        || !rect
        || Math.abs(rect.width - rawRegion.pixelSize.width) > 0.000001
        || Math.abs(rect.height - rawRegion.pixelSize.height) > 0.000001
        || rect.x < 0 || rect.y < 0
        || rect.x + rect.width > value.captureImagePixelSize.width
        || rect.y + rect.height > value.captureImagePixelSize.height) return false;
    }
    let previousOrdinal: number | undefined;
    for (const rawObservation of rawRegion.textObservations) {
      if (!isRecord(rawObservation)
        || !exactKeys(rawObservation, [
          "ordinal", "boundingBox", "coordinateSpace", "recognitionConfidence", "confidenceMeaning",
        ])
        || !safeCount(rawObservation.ordinal)
        || (previousOrdinal !== undefined && rawObservation.ordinal <= previousOrdinal)
        || !validRect(rawObservation.boundingBox)
        || rawObservation.boundingBox.x < 0
        || rawObservation.boundingBox.y < 0
        || rawObservation.boundingBox.x + rawObservation.boundingBox.width > 1
        || rawObservation.boundingBox.y + rawObservation.boundingBox.height > 1
        || rawObservation.coordinateSpace !== "vision-normalized-lower-left-in-region"
        || !finiteNumber(rawObservation.recognitionConfidence)
        || rawObservation.recognitionConfidence < 0
        || rawObservation.recognitionConfidence > 1
        || rawObservation.confidenceMeaning !== "vision-candidate-score") return false;
      previousOrdinal = rawObservation.ordinal;
      observationCount += 1;
    }
    if (rawRegion.textObservations.length > MINNI_OCR_MAX_TEXT_OBSERVATIONS) return false;
    if (rawRegion.omittedObservationCount === 0) {
      if (rawRegion.candidateCoverage !== "complete" || rawRegion.geometryCoverage !== "complete") return false;
    } else {
      if (rawRegion.candidateCoverage === "complete" || rawRegion.geometryCoverage === "complete") return false;
      allRegionsComplete = false;
    }
  }
  if (observationCount > MINNI_OCR_MAX_TEXT_OBSERVATIONS) return false;
  const localOmissions = value.regions.reduce(
    (total, region) => total + region.omittedObservationCount,
    0,
  );
  if (value.omittedRegionCount === 0) {
    if (value.omittedObservationCount !== localOmissions) return false;
  } else if (value.omittedObservationCount < localOmissions) {
    return false;
  }
  if (!isEnum(value.collectorCoverage, OCR_COLLECTOR_COVERAGE)) return false;
  if (value.collectorCoverage === "complete"
    && (value.omittedRegionCount !== 0
      || value.omittedObservationCount !== 0
      || value.omittedRecognitionLanguageCount !== 0
      || !allRegionsComplete)) return false;
  if (value.collectorCoverage !== "complete"
    && value.omittedRegionCount === 0
    && value.omittedObservationCount === 0
    && value.omittedRecognitionLanguageCount === 0
    && allRegionsComplete) return false;
  return true;
}

/** Decode a supported observation. Unsupported optional metadata is omitted, never diagnosed. */
export function decodeSupportedOCRObservation(value: unknown): SupportedOCRObservation | undefined {
  if (!isRecord(value)) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (utf8Length(encoded) > MINNI_OCR_MAX_JSON_UTF8_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!validObservationProjection(parsed)) return undefined;
  return deepFreeze(parsed) as SupportedOCRObservation;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

const EVENT_KEYS = ["id", "type", "ts", "source", "flags", "text"] as const;
const EVENT_OPTIONAL_KEYS = [
  "end", "app", "bundleId", "window", "url", "name", "kind", "anchorId", "conversationId", "observation",
] as const;

function decodeEvent(value: unknown): MinniEvent | undefined {
  if (!isRecord(value) || !exactKeys(value, EVENT_KEYS, EVENT_OPTIONAL_KEYS)) return undefined;
  if (!nonEmptyString(value.id)
    || value.type !== "event"
    || !isTimestamp(value.ts)
    || !nonEmptyTransientString(value.source)
    || !Array.isArray(value.flags)
    || value.flags.some((flag) => !transientString(flag))
    || typeof value.text !== "string"
    ) return undefined;
  if (hasOwn(value, "end")
    && (!isTimestamp(value.end) || !intervalIsOrdered(value.ts, value.end))) return undefined;
  for (const key of EVENT_OPTIONAL_KEYS) {
    if (key === "observation") continue;
    if (hasOwn(value, key) && !transientString(value[key])) return undefined;
  }
  const decoded: Record<string, unknown> = {
    id: value.id,
    type: "event",
    ts: value.ts,
    source: value.source,
    flags: Object.freeze([...value.flags]),
    text: value.text,
  };
  for (const key of EVENT_OPTIONAL_KEYS) {
    if (key === "observation" || !hasOwn(value, key)) continue;
    decoded[key] = value[key];
  }
  if (value.source === "minni" && value.kind === "ocr" && hasOwn(value, "observation")) {
    const observation = decodeSupportedOCRObservation(value.observation);
    if (observation) decoded.observation = observation;
  }
  return Object.freeze(decoded) as MinniEvent;
}

/** Decode the authenticated Minni `get_events` response without retaining request or denied IDs. */
export function decodeMinniGetEventsResponse(value: unknown): SummaryCodecResult<AcceptedMinniEvidence> {
  if (!isRecord(value) || !exactKeys(value, ["items", "localOnlyWithheld"])
    || !Array.isArray(value.items)
    || value.items.length > MINNI_GET_EVENTS_MAX_ITEMS
    || !safeCount(value.localOnlyWithheld)) return refusal("invalid_producer_response");
  if (value.items.length === 0) return noAuthorizedEvidence();
  const items: MinniEvent[] = [];
  const ids = new Set<string>();
  for (const rawItem of value.items) {
    const event = decodeEvent(rawItem);
    if (!event) return refusal("invalid_producer_response");
    if (ids.has(event.id)) return refusal("duplicate_returned_event_id");
    ids.add(event.id);
    items.push(event);
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      items: Object.freeze(items),
      returned_count: items.length,
      local_only_withheld_count: value.localOnlyWithheld,
    }),
  });
}

export const classifyMinniGetEventsResponse = decodeMinniGetEventsResponse;

function validSummaryInterval(value: unknown): value is SummaryEventInterval {
  return isRecord(value)
    && exactKeys(value, ["start", "end", "meaning"])
    && isTimestamp(value.start)
    && isTimestamp(value.end)
    && intervalIsOrdered(value.start, value.end)
    && value.meaning === "event_capture_or_index_interval";
}

function derivedEvidenceInterval(
  evidence: readonly SummaryEvidenceReference[],
): SummaryEventInterval | undefined {
  if (evidence.length === 0) return undefined;
  let start = evidence[0].event_capture_or_index_interval.start;
  let end = evidence[0].event_capture_or_index_interval.end;
  for (const item of evidence.slice(1)) {
    const itemInterval = item.event_capture_or_index_interval;
    const startComparison = compareMinniTimestamps(itemInterval.start, start);
    const endComparison = compareMinniTimestamps(itemInterval.end, end);
    if (startComparison === undefined || endComparison === undefined) return undefined;
    if (startComparison < 0) start = itemInterval.start;
    if (endComparison > 0) end = itemInterval.end;
  }
  return Object.freeze({
    start,
    end,
    meaning: "event_capture_or_index_interval" as const,
  });
}

function validOCRScreenshotInterval(value: unknown): value is SummaryOCRScreenshotInterval {
  return isRecord(value)
    && exactKeys(value, ["started_ms", "completed_ms", "meaning"])
    && safeCount(value.started_ms)
    && safeCount(value.completed_ms)
    && value.started_ms <= value.completed_ms
    && value.meaning === "ocr_screenshot_capture_interval";
}

function validCollector(value: unknown): value is SummaryOCRCollector {
  return isRecord(value)
    && exactKeys(value, [
      "collector_coverage", "omitted_region_count", "omitted_observation_count",
      "omitted_recognition_language_count",
    ])
    && isEnum(value.collector_coverage, OCR_COLLECTOR_COVERAGE)
    && safeCount(value.omitted_region_count)
    && safeCount(value.omitted_observation_count)
    && safeCount(value.omitted_recognition_language_count);
}

function validateEvidenceReference(
  value: unknown,
): SummaryEvidenceReference | undefined {
  if (!isRecord(value)
    || !exactKeys(value, [
      "event_id", "modality", "event_capture_or_index_interval", "uncertainties", "anchor_context",
    ], ["ocr_screenshot_capture_interval", "anchor_id", "ocr_collector"])
    || !nonEmptyReference(value.event_id)
    || !boundedString(value.modality, MAX_REFERENCE_UTF8_BYTES, true)
    || !validSummaryInterval(value.event_capture_or_index_interval)
    || !isEnum(value.anchor_context, SUMMARY_ANCHOR_CONTEXTS)) return undefined;
  const uncertainties = canonicalUncertainties(value.uncertainties);
  if (!uncertainties) return undefined;
  // This is a structural check on a later hand-labeled OCR-shaped entry. A2
  // must derive the label and uncertainties from the decoded source event.
  if ((value.modality === "screen_ocr"
    || hasOwn(value, "ocr_screenshot_capture_interval")
    || hasOwn(value, "ocr_collector"))
    && !hasRequiredOCRUncertainties(uncertainties)) return undefined;
  if (hasOwn(value, "ocr_screenshot_capture_interval")
    && !validOCRScreenshotInterval(value.ocr_screenshot_capture_interval)) return undefined;
  if (hasOwn(value, "ocr_collector") && !validCollector(value.ocr_collector)) return undefined;
  if (value.anchor_context === "authorized_context") {
    if (!hasOwn(value, "anchor_id") || !nonEmptyReference(value.anchor_id)) return undefined;
  } else if (hasOwn(value, "anchor_id")) {
    return undefined;
  }
  const screenshotInterval = hasOwn(value, "ocr_screenshot_capture_interval")
    ? value.ocr_screenshot_capture_interval as SummaryOCRScreenshotInterval
    : undefined;
  const collector = hasOwn(value, "ocr_collector")
    ? value.ocr_collector as SummaryOCRCollector
    : undefined;
  const anchorId = hasOwn(value, "anchor_id") ? value.anchor_id as string : undefined;
  return Object.freeze({
    event_id: value.event_id,
    modality: value.modality,
    event_capture_or_index_interval: Object.freeze({ ...value.event_capture_or_index_interval }),
    ...(screenshotInterval
      ? { ocr_screenshot_capture_interval: Object.freeze({ ...screenshotInterval }) }
      : {}),
    uncertainties,
    anchor_context: value.anchor_context,
    ...(anchorId ? { anchor_id: anchorId } : {}),
    ...(collector ? { ocr_collector: Object.freeze({ ...collector }) } : {}),
  });
}

function validateClaim(value: unknown): SummaryClaim | undefined {
  if (!isRecord(value)
    || !exactKeys(value, [
      "id", "statement", "state", "modality", "scope", "support_event_ids",
      "event_capture_or_index_interval", "uncertainties", "conflicts",
    ])
    || !nonEmptyReference(value.id)
    || !nonEmptyString(value.statement)
    || !isEnum(value.state, SUMMARY_CLAIM_STATES)
    || !boundedString(value.modality, MAX_REFERENCE_UTF8_BYTES, true)
    || !boundedString(value.scope, MAX_REFERENCE_UTF8_BYTES, true)
    || !validSummaryInterval(value.event_capture_or_index_interval)
    || !Array.isArray(value.support_event_ids)
    || value.support_event_ids.length === 0
    || !Array.isArray(value.conflicts)) return undefined;
  const supportEventIds = uniqueStrings(value.support_event_ids);
  const conflicts = uniqueStrings(value.conflicts);
  const uncertainties = canonicalUncertainties(value.uncertainties);
  if (!supportEventIds || !conflicts || !uncertainties || conflicts.includes(value.id)) return undefined;
  if (value.modality === "screen_ocr" && !hasRequiredOCRUncertainties(uncertainties)) return undefined;
  return Object.freeze({
    id: value.id,
    statement: value.statement,
    state: value.state,
    modality: value.modality,
    scope: value.scope,
    support_event_ids: supportEventIds,
    event_capture_or_index_interval: Object.freeze({ ...value.event_capture_or_index_interval }),
    uncertainties,
    conflicts,
  });
}

function validateLineage(value: unknown): ProcessingLineageV1 | undefined {
  const classified = classifyProcessingLineage(value);
  return classified.state === "minni_verified" ? classified.lineage : undefined;
}

function validateContract(value: unknown): MinniSummaryContract | SummaryCodecRefusal | NoAuthorizedEvidence {
  if (!isRecord(value)) return refusal("invalid_contract");
  if (value.version !== MINNI_SUMMARY_CONTRACT_VERSION) return refusal("unsupported_contract_version");
  if (!exactKeys(value, [
    "version", "summary", "event_capture_or_index_interval", "evidence_counts",
    "processing_lineage", "evidence", "claims", "conclusion",
  ])) return refusal("invalid_contract");
  if (!nonEmptyString(value.summary)
    || !validSummaryInterval(value.event_capture_or_index_interval)
    || !isEnum(value.conclusion, SUMMARY_CONCLUSIONS)
    || !isRecord(value.evidence_counts)
    || !exactKeys(value.evidence_counts, ["returned_count", "local_only_withheld_count"])
    || !safeCount(value.evidence_counts.returned_count)
    || !safeCount(value.evidence_counts.local_only_withheld_count)
    || !Array.isArray(value.evidence)
    || !Array.isArray(value.claims)) return refusal("invalid_contract");
  if (value.evidence.length === 0) return noAuthorizedEvidence();
  if (value.evidence.length > MINNI_GET_EVENTS_MAX_ITEMS || value.claims.length === 0) {
    return refusal("invalid_contract");
  }
  if (value.evidence_counts.returned_count !== value.evidence.length) return refusal("invalid_contract");
  const lineage = validateLineage(value.processing_lineage);
  if (!lineage) return refusal("invalid_contract");
  const evidence: SummaryEvidenceReference[] = [];
  const evidenceIds = new Set<string>();
  for (const rawEvidence of value.evidence) {
    const parsed = validateEvidenceReference(rawEvidence);
    if (!parsed || evidenceIds.has(parsed.event_id)) return refusal("invalid_contract");
    evidenceIds.add(parsed.event_id);
    evidence.push(parsed);
  }
  const overallInterval = derivedEvidenceInterval(evidence);
  const suppliedOverallInterval = value.event_capture_or_index_interval as SummaryEventInterval;
  if (!overallInterval
    || suppliedOverallInterval.start !== overallInterval.start
    || suppliedOverallInterval.end !== overallInterval.end) return refusal("invalid_contract");
  for (const item of evidence) {
    if (item.anchor_context === "authorized_context"
      && (!item.anchor_id
        || item.anchor_id === item.event_id
        || !evidenceIds.has(item.anchor_id))) return refusal("invalid_contract");
  }
  const claims: SummaryClaim[] = [];
  const claimIds = new Set<string>();
  for (const rawClaim of value.claims) {
    const parsed = validateClaim(rawClaim);
    if (!parsed || claimIds.has(parsed.id)
      || parsed.support_event_ids.some((id) => !evidenceIds.has(id))) return refusal("invalid_contract");
    const supportEvidence = parsed.support_event_ids.map((id) =>
      evidence.find((item) => item.event_id === id)!);
    const supportInterval = derivedEvidenceInterval(supportEvidence);
    if (!supportInterval
      || parsed.event_capture_or_index_interval.start !== supportInterval.start
      || parsed.event_capture_or_index_interval.end !== supportInterval.end) {
      return refusal("invalid_contract");
    }
    claimIds.add(parsed.id);
    claims.push(parsed);
  }
  for (const claim of claims) {
    if (claim.conflicts.some((id) => !claimIds.has(id))) return refusal("invalid_contract");
    for (const conflictId of claim.conflicts) {
      const other = claims.find((candidate) => candidate.id === conflictId);
      if (!other || !other.conflicts.includes(claim.id)) return refusal("invalid_contract");
    }
  }
  const conflictEvidenceIds = new Set<string>();
  for (const claim of claims) {
    if (claim.conflicts.length === 0) continue;
    if (!claim.uncertainties.includes("contradictory_evidence")) return refusal("invalid_contract");
    for (const eventId of claim.support_event_ids) conflictEvidenceIds.add(eventId);
  }
  for (const item of evidence) {
    if (conflictEvidenceIds.has(item.event_id)
      && !item.uncertainties.includes("contradictory_evidence")) return refusal("invalid_contract");
  }
  return Object.freeze({
    version: MINNI_SUMMARY_CONTRACT_VERSION,
    summary: value.summary,
    event_capture_or_index_interval: Object.freeze({ ...value.event_capture_or_index_interval }),
    evidence_counts: Object.freeze({
      returned_count: value.evidence_counts.returned_count,
      local_only_withheld_count: value.evidence_counts.local_only_withheld_count,
    }),
    processing_lineage: lineage,
    evidence: Object.freeze(evidence),
    claims: Object.freeze(claims),
    conclusion: value.conclusion,
  });
}

/** Classify an untrusted serialized contract without granting processing or persistence authority. */
export function classifyMinniSummaryContract(value: unknown): SummaryBuildResult {
  if (value === undefined || value === null) return noAuthorizedEvidence();
  const result = validateContract(value);
  if (result === undefined) return refusal("invalid_contract");
  if ("version" in result) return Object.freeze({ ok: true as const, contract: result });
  return result;
}

export const decodeMinniSummaryContract = classifyMinniSummaryContract;

/** Serialize only a validated durable contract; raw events, pixels, hashes, and auth fields cannot enter it. */
export function serializeMinniSummaryContract(value: unknown): MinniSummaryContract {
  const result = classifyMinniSummaryContract(value);
  if (!result.ok) {
    throw new TypeError(result.reason);
  }
  return result.contract;
}

/** A content-free result for empty, missing, or wholly withheld authorized evidence. */
export function noAuthorizedMinniEvidence(): NoAuthorizedEvidence {
  return noAuthorizedEvidence();
}
