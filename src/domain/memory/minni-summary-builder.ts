import {
  SUMMARY_CLAIM_STATES,
  SUMMARY_CONCLUSIONS,
  SUMMARY_UNCERTAINTIES,
  classifyMinniGetEventsResponse,
  compareMinniTimestamps,
  noAuthorizedMinniEvidence,
  serializeMinniSummaryContract,
  type AcceptedMinniEvidence,
  type MinniEvent,
  type MinniSummaryContract,
  type NoAuthorizedEvidence,
  type SummaryAnchorContext,
  type SummaryBuildResult,
  type SummaryClaim,
  type SummaryClaimState,
  type SummaryCodecRefusal,
  type SummaryCodecResult,
  type SummaryConclusion,
  type SummaryEvidenceReference,
  type SummaryEventInterval,
  type SummaryModality,
  type SummaryScopeLabel,
  type SummaryUncertainty,
} from "./minni-summary-contract.js";
import {
  conservativeJoinProcessingLineage,
  classifyProcessingLineage,
  type ClassifiedProcessingLineage,
  type ProcessingLineageV1,
} from "./processing-lineage.js";

const MAX_REFERENCE_UTF8_BYTES = 256;
const NO_AUTHORIZED_EVIDENCE_REASON = "no_authorized_evidence" as const;

/**
 * A stored lineage is evidence attached to one accepted event.  It is never
 * an authority object and this builder never constructs one.
 */
export type MinniSummaryStoredLineage = Readonly<{
  event_id: string;
  processing_lineage: unknown;
}>;

/**
 * Hand-labeled claim input.  Nothing in this shape is inferred from event
 * prose; the builder only validates references and derives source facts.
 */
export type MinniSummaryClaimInput = Readonly<{
  id: string;
  statement: string;
  state: SummaryClaimState;
  modality: SummaryModality;
  scope: SummaryScopeLabel;
  support_event_ids: readonly string[];
  conflicts?: readonly string[];
  scope_linkage_unknown?: boolean;
}>;

/**
 * Pure input to the A2 builder. `evidence` may be the A1 accepted value or
 * the A1 classifier result so an A1 content-free refusal can pass through.
 */
export type MinniSummaryBuilderInput = Readonly<{
  summary: string;
  evidence: AcceptedMinniEvidence | SummaryCodecResult<AcceptedMinniEvidence>;
  lineages: readonly MinniSummaryStoredLineage[];
  claims: readonly MinniSummaryClaimInput[];
  conclusion?: SummaryConclusion;
}>;

type AcceptedEvidenceResult =
  | Readonly<{ ok: true; evidence: AcceptedMinniEvidence }>
  | NoAuthorizedEvidence
  | SummaryCodecRefusal
  | undefined;

type MutableEvidence = Readonly<{
  event: MinniEvent;
  reference: SummaryEvidenceReference;
  uncertainties: Set<SummaryUncertainty>;
}>;

type ValidatedClaimInput = Readonly<{
  id: string;
  statement: string;
  state: SummaryClaimState;
  modality: SummaryModality;
  scope: SummaryScopeLabel;
  support_event_ids: readonly string[];
  conflicts: readonly string[];
  scope_linkage_unknown: boolean;
}>;

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

function nonEmptyReference(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && utf8Length(value) <= MAX_REFERENCE_UTF8_BYTES;
}

function nonEmptyStatement(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function refusal(): SummaryBuildResult {
  return Object.freeze({
    ok: false as const,
    reason: "invalid_contract" as const,
    contentFree: true as const,
  });
}

function isNoAuthorizedEvidence(value: unknown): value is NoAuthorizedEvidence {
  return isRecord(value)
    && value.ok === false
    && value.reason === NO_AUTHORIZED_EVIDENCE_REASON
    && value.contentFree === true
    && exactKeys(value, ["ok", "reason", "contentFree"]);
}

function isSummaryCodecRefusal(value: unknown): value is SummaryCodecRefusal {
  return isRecord(value)
    && value.ok === false
    && value.contentFree === true
    && typeof value.reason === "string"
    && [
      "invalid_producer_response",
      "duplicate_returned_event_id",
      "invalid_contract",
      "unsupported_contract_version",
    ].includes(value.reason)
    && exactKeys(value, ["ok", "reason", "contentFree"]);
}

function decodeAcceptedEvidence(value: unknown): AcceptedEvidenceResult {
  if (!isRecord(value)
    || !exactKeys(value, ["items", "returned_count", "local_only_withheld_count"])
    || !Array.isArray(value.items)
    || !safeCount(value.returned_count)
    || !safeCount(value.local_only_withheld_count)
    || value.returned_count !== value.items.length) return undefined;
  const decoded = classifyMinniGetEventsResponse({
    items: value.items,
    localOnlyWithheld: value.local_only_withheld_count,
  });
  if (decoded.ok) return Object.freeze({ ok: true as const, evidence: decoded.value });
  return decoded;
}

function unwrapEvidence(value: unknown): AcceptedEvidenceResult {
  if (isNoAuthorizedEvidence(value)) return noAuthorizedMinniEvidence();
  if (isSummaryCodecRefusal(value)) return Object.freeze({
    ok: false as const,
    reason: value.reason,
    contentFree: true as const,
  });
  if (isRecord(value) && hasOwn(value, "ok")) {
    if (value.ok !== true || !hasOwn(value, "value")) return undefined;
    return decodeAcceptedEvidence(value.value);
  }
  return decodeAcceptedEvidence(value);
}

/** Read only the evidence seam before inspecting any unrelated builder input. */
function readEvidenceBeforeTransientInput(value: unknown): AcceptedEvidenceResult {
  if (!isRecord(value) || !hasOwn(value, "evidence")) return undefined;
  try {
    return unwrapEvidence(value.evidence);
  } catch {
    return undefined;
  }
}

function canonicalUncertainties(values: Iterable<SummaryUncertainty>): readonly SummaryUncertainty[] {
  const present = new Set(values);
  return Object.freeze(SUMMARY_UNCERTAINTIES.filter((item) => present.has(item)));
}

function isSummaryClaimState(value: unknown): value is SummaryClaimState {
  return typeof value === "string" && SUMMARY_CLAIM_STATES.includes(value as SummaryClaimState);
}

function isSummaryConclusion(value: unknown): value is SummaryConclusion {
  return typeof value === "string" && SUMMARY_CONCLUSIONS.includes(value as SummaryConclusion);
}

function validateClaimInputs(value: unknown): readonly ValidatedClaimInput[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return undefined;
  const ids = new Set<string>();
  const claims: ValidatedClaimInput[] = [];
  for (const rawClaim of value) {
    if (!isRecord(rawClaim)
      || !exactKeys(rawClaim, [
        "id", "statement", "state", "modality", "scope", "support_event_ids",
      ], ["conflicts", "scope_linkage_unknown"])
      || !nonEmptyReference(rawClaim.id)
      || ids.has(rawClaim.id)
      || !nonEmptyStatement(rawClaim.statement)
      || !isSummaryClaimState(rawClaim.state)
      || !nonEmptyReference(rawClaim.modality)
      || !nonEmptyReference(rawClaim.scope)
      || !Array.isArray(rawClaim.support_event_ids)
      || rawClaim.support_event_ids.length === 0
      || rawClaim.support_event_ids.some((id) => !nonEmptyReference(id))) return undefined;
    const supportEventIds = [...rawClaim.support_event_ids];
    if (new Set(supportEventIds).size !== supportEventIds.length) return undefined;
    const conflicts = hasOwn(rawClaim, "conflicts") ? rawClaim.conflicts : [];
    if (!Array.isArray(conflicts) || conflicts.some((id) => !nonEmptyReference(id))) return undefined;
    const uniqueConflicts = [...conflicts];
    if (new Set(uniqueConflicts).size !== uniqueConflicts.length
      || uniqueConflicts.includes(rawClaim.id)) return undefined;
    const scopeLinkageUnknown = hasOwn(rawClaim, "scope_linkage_unknown")
      ? rawClaim.scope_linkage_unknown
      : false;
    if (typeof scopeLinkageUnknown !== "boolean") return undefined;
    ids.add(rawClaim.id);
    claims.push(Object.freeze({
      id: rawClaim.id,
      statement: rawClaim.statement,
      state: rawClaim.state,
      modality: rawClaim.modality,
      scope: rawClaim.scope,
      support_event_ids: Object.freeze(supportEventIds),
      conflicts: Object.freeze(uniqueConflicts),
      scope_linkage_unknown: scopeLinkageUnknown,
    }));
  }
  for (const claim of claims) {
    if (claim.conflicts.some((id) => !ids.has(id))) return undefined;
  }
  return Object.freeze(claims);
}

function validateLineageInputs(
  rawLineages: unknown,
  eventIds: readonly string[],
): Readonly<{ lineage: ProcessingLineageV1; byEventId: ReadonlyMap<string, ClassifiedProcessingLineage> }> | undefined {
  if (!Array.isArray(rawLineages) || rawLineages.length !== eventIds.length) return undefined;
  const eventIdSet = new Set(eventIds);
  const byEventId = new Map<string, ClassifiedProcessingLineage>();
  for (const rawLineage of rawLineages) {
    if (!isRecord(rawLineage)
      || !exactKeys(rawLineage, ["event_id", "processing_lineage"])
      || !nonEmptyReference(rawLineage.event_id)
      || !eventIdSet.has(rawLineage.event_id)
      || byEventId.has(rawLineage.event_id)
      || rawLineage.processing_lineage === undefined) return undefined;
    const classified = classifyProcessingLineage(rawLineage.processing_lineage);
    byEventId.set(rawLineage.event_id, classified);
  }
  if (byEventId.size !== eventIds.length) return undefined;
  let joined: ClassifiedProcessingLineage | undefined;
  for (const eventId of eventIds) {
    const current = byEventId.get(eventId);
    if (!current) return undefined;
    if (!joined) {
      joined = current;
      continue;
    }
    const result = conservativeJoinProcessingLineage(joined, current);
    if (!result.ok) return undefined;
    joined = { state: "minni_verified", lineage: result.lineage };
  }
  if (!joined || joined.state !== "minni_verified") return undefined;
  return Object.freeze({ lineage: joined.lineage, byEventId });
}

function eventInterval(event: MinniEvent): Readonly<{
  start: string;
  end: string;
  meaning: "event_capture_or_index_interval";
}> {
  return Object.freeze({
    start: event.ts,
    end: event.end ?? event.ts,
    meaning: "event_capture_or_index_interval" as const,
  });
}

function derivedInterval(events: readonly MinniEvent[]): SummaryEventInterval | undefined {
  if (events.length === 0) return undefined;
  let start = events[0].ts;
  let end = events[0].end ?? events[0].ts;
  for (const event of events.slice(1)) {
    const eventEnd = event.end ?? event.ts;
    const startComparison = compareMinniTimestamps(event.ts, start);
    const endComparison = compareMinniTimestamps(eventEnd, end);
    if (startComparison === undefined || endComparison === undefined) return undefined;
    if (startComparison < 0) start = event.ts;
    if (endComparison > 0) end = eventEnd;
  }
  return Object.freeze({
    start,
    end,
    meaning: "event_capture_or_index_interval" as const,
  });
}

function isOCR(event: MinniEvent): boolean {
  return event.source === "minni" && event.kind === "ocr";
}

function isDelta(event: MinniEvent): boolean {
  return event.flags.includes("delta");
}

function eventUncertainties(event: MinniEvent): Set<SummaryUncertainty> {
  const uncertainties = new Set<SummaryUncertainty>();
  if (isOCR(event)) {
    uncertainties.add("ocr_source");
    uncertainties.add("source_clip_unknown");
    uncertainties.add("source_completeness_unknown");
  }
  if (isDelta(event)) uncertainties.add("partial_delta");
  return uncertainties;
}

function anchorForEvent(
  event: MinniEvent,
  eventIds: ReadonlySet<string>,
  uncertainties: Set<SummaryUncertainty>,
): Readonly<{ anchor_context: SummaryAnchorContext; anchor_id?: string }> {
  if (event.anchorId === undefined && !isDelta(event)) {
    return { anchor_context: "not_applicable" };
  }
  if (event.anchorId !== undefined
    && event.anchorId !== event.id
    && eventIds.has(event.anchorId)) {
    return { anchor_context: "authorized_context", anchor_id: event.anchorId };
  }
  uncertainties.add("anchor_unavailable");
  return { anchor_context: "unavailable_context" };
}

function buildEvidenceReference(
  event: MinniEvent,
  eventIds: ReadonlySet<string>,
): MutableEvidence {
  const uncertainties = eventUncertainties(event);
  const anchor = anchorForEvent(event, eventIds, uncertainties);
  const observation = isOCR(event) && event.observation ? event.observation : undefined;
  const reference: SummaryEvidenceReference = {
    event_id: event.id,
    modality: isOCR(event) ? "screen_ocr" : "event",
    event_capture_or_index_interval: eventInterval(event),
    ...(observation ? {
      ocr_screenshot_capture_interval: Object.freeze({
        started_ms: observation.captureInterval.startedMs,
        completed_ms: observation.captureInterval.completedMs,
        meaning: "ocr_screenshot_capture_interval" as const,
      }),
    } : {}),
    uncertainties: canonicalUncertainties(uncertainties),
    anchor_context: anchor.anchor_context,
    ...(anchor.anchor_id ? { anchor_id: anchor.anchor_id } : {}),
    ...(observation ? {
      ocr_collector: Object.freeze({
        collector_coverage: observation.collectorCoverage,
        omitted_region_count: observation.omittedRegionCount,
        omitted_observation_count: observation.omittedObservationCount,
        omitted_recognition_language_count: observation.omittedRecognitionLanguageCount,
      }),
    } : {}),
  };
  return Object.freeze({ event, reference, uncertainties });
}

function addUncertainty(
  values: Set<SummaryUncertainty>,
  uncertainty: SummaryUncertainty,
): void {
  values.add(uncertainty);
}

function conflictSets(
  claims: readonly ValidatedClaimInput[],
): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  const ids = new Set(claims.map((claim) => claim.id));
  const sets = new Map<string, Set<string>>(
    claims.map((claim) => [claim.id, new Set<string>()]),
  );
  for (const claim of claims) {
    const own = sets.get(claim.id);
    if (!own) return undefined;
    for (const conflictId of claim.conflicts) {
      if (!ids.has(conflictId)) return undefined;
      own.add(conflictId);
      const other = sets.get(conflictId);
      if (!other) return undefined;
      other.add(claim.id);
    }
  }
  return new Map([...sets].map(([id, conflicts]) => [id, conflicts] as const));
}

function claimConflictsInCanonicalOrder(
  claimId: string,
  conflicts: ReadonlySet<string>,
  claims: readonly ValidatedClaimInput[],
): readonly string[] {
  return Object.freeze(claims
    .filter((claim) => claim.id !== claimId && conflicts.has(claim.id))
    .map((claim) => claim.id));
}

function buildClaim(
  input: ValidatedClaimInput,
  conflictIds: ReadonlySet<string>,
  claims: readonly ValidatedClaimInput[],
  evidenceById: ReadonlyMap<string, MutableEvidence>,
): SummaryClaim | undefined {
  const supportEvents: MinniEvent[] = [];
  const uncertainties = new Set<SummaryUncertainty>();
  for (const eventId of input.support_event_ids) {
    const evidence = evidenceById.get(eventId);
    if (!evidence) return undefined;
    supportEvents.push(evidence.event);
    for (const uncertainty of evidence.uncertainties) uncertainties.add(uncertainty);
  }
  if (input.scope_linkage_unknown) addUncertainty(uncertainties, "scope_linkage_unknown");
  if (conflictIds.size > 0) addUncertainty(uncertainties, "contradictory_evidence");
  const interval = derivedInterval(supportEvents);
  if (!interval) return undefined;
  return Object.freeze({
    id: input.id,
    statement: input.statement,
    state: input.state,
    modality: input.modality,
    scope: input.scope,
    support_event_ids: Object.freeze([...input.support_event_ids]),
    event_capture_or_index_interval: interval,
    uncertainties: canonicalUncertainties(uncertainties),
    conflicts: claimConflictsInCanonicalOrder(input.id, conflictIds, claims),
  });
}

function normalizeBuilderInput(value: unknown): MinniSummaryBuilderInput | undefined {
  if (!isRecord(value)
    || !exactKeys(value, ["summary", "evidence", "lineages", "claims"], ["conclusion"])
    || !nonEmptyStatement(value.summary)
    || !Array.isArray(value.lineages)
    || !Array.isArray(value.claims)
    || (hasOwn(value, "conclusion") && !isSummaryConclusion(value.conclusion))) return undefined;
  return value as unknown as MinniSummaryBuilderInput;
}

/**
 * Build the internal v1 contract from A1 evidence and explicit structured
 * claims. The operation is pure and makes no authority, provider, model,
 * persistence, route, or delivery decision.
 */
export function buildMinniSummaryContract(value: unknown): SummaryBuildResult {
  const evidenceResult = readEvidenceBeforeTransientInput(value);
  if (!evidenceResult) return refusal();
  if (!evidenceResult.ok) return evidenceResult;

  const input = normalizeBuilderInput(value);
  if (!input) return refusal();
  const evidence = evidenceResult.evidence;
  const overallInterval = derivedInterval(evidence.items);
  if (!overallInterval) return refusal();
  const eventIds = evidence.items.map((event) => event.id);
  const lineageResult = validateLineageInputs(input.lineages, eventIds);
  if (!lineageResult) return refusal();
  const claimInputs = validateClaimInputs(input.claims);
  if (!claimInputs) return refusal();
  const conflictMap = conflictSets(claimInputs);
  if (!conflictMap) return refusal();

  const eventIdSet = new Set(eventIds);
  const evidenceById = new Map<string, MutableEvidence>();
  const builtEvidence = evidence.items.map((event) => {
    const built = buildEvidenceReference(event, eventIdSet);
    evidenceById.set(event.id, built);
    return built;
  });
  if (evidenceById.size !== evidence.items.length) return refusal();

  const builtClaims = claimInputs.map((claim) => {
    const conflictIds = conflictMap.get(claim.id);
    return conflictIds ? buildClaim(claim, conflictIds, claimInputs, evidenceById) : undefined;
  });
  if (builtClaims.some((claim) => claim === undefined)) return refusal();
  const claims = builtClaims.filter((claim): claim is SummaryClaim => claim !== undefined);

  const conflictEvidenceIds = new Set<string>();
  for (const claim of claims) {
    if (claim.conflicts.length === 0) continue;
    for (const eventId of claim.support_event_ids) conflictEvidenceIds.add(eventId);
  }
  const serializedEvidence = builtEvidence.map((built) => {
    if (!conflictEvidenceIds.has(built.event.id)) return built.reference;
    const uncertainties = new Set(built.uncertainties);
    addUncertainty(uncertainties, "contradictory_evidence");
    return Object.freeze({
      ...built.reference,
      uncertainties: canonicalUncertainties(uncertainties),
    });
  });
  const hasConflict = claims.some((claim) => claim.conflicts.length > 0);
  const conclusion = input.conclusion ?? (hasConflict ? "abstained" : "bounded");

  try {
    const contract: MinniSummaryContract = serializeMinniSummaryContract({
      version: "runir.minni.summary/v1",
      summary: input.summary,
      event_capture_or_index_interval: overallInterval,
      evidence_counts: {
        returned_count: evidence.returned_count,
        local_only_withheld_count: evidence.local_only_withheld_count,
      },
      processing_lineage: lineageResult.lineage,
      evidence: serializedEvidence,
      claims,
      conclusion,
    });
    return Object.freeze({ ok: true as const, contract });
  } catch {
    return refusal();
  }
}

/** Alias using the shorter source-level name used by callers. */
export const buildMinniSummary = buildMinniSummaryContract;
