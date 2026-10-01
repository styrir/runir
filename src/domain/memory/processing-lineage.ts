/**
 * Structural provenance for content admitted from Minni.
 *
 * This module deliberately contains no authority objects.  A value that
 * passes the parser describes persisted provenance; it does not grant the
 * caller permission to create, read, or process content.
 */

export const PROCESSING_LINEAGE_STATE = "minni_verified" as const;
export const PROCESSING_LINEAGE_ORIGIN = "minni" as const;
export const PROCESSING_POLICY_VERSION = "runir.minni.local/v1" as const;
export const PROCESSING_LINEAGE_VERSION = "runir.minni.delivery/v1" as const;

export const PROCESSING_LINEAGE_OPERATIONS = [
  "capture_ingest",
  "scheduled_maintenance",
  "forced_maintenance",
] as const;

export const PROCESSING_LINEAGE_RESTRICTIONS = [
  "audio_derived",
  "excluded_source",
  "producer_local_only",
] as const;

export type ProcessingLineageOperation =
  (typeof PROCESSING_LINEAGE_OPERATIONS)[number];
export type ProcessingLineageRestriction =
  (typeof PROCESSING_LINEAGE_RESTRICTIONS)[number];
export type ProcessingLineageDisposition = "ordinary" | "local_only";

export type ProcessingLineageDelivery = Readonly<{
  version: typeof PROCESSING_LINEAGE_VERSION;
  disposition: ProcessingLineageDisposition;
  restrictions: readonly ProcessingLineageRestriction[];
}>;

/**
 * The exact persisted snake_case v1 shape.  The type is intentionally
 * structural: authority is established by the application seam before this
 * value is constructed and is revalidated at every protected use.
 */
export type ProcessingLineageV1 = Readonly<{
  state: typeof PROCESSING_LINEAGE_STATE;
  origin: typeof PROCESSING_LINEAGE_ORIGIN;
  producer_principal_ref: string;
  producer_registration_ref: string;
  processing_policy_version: typeof PROCESSING_POLICY_VERSION;
  admitted_operation: ProcessingLineageOperation;
  target_user_id: string;
  delivery: ProcessingLineageDelivery;
}>;

export type ProcessingLineageInvalidReason =
  | "null_value"
  | "root_shape"
  | "unknown_root_field"
  | "state"
  | "origin"
  | "principal_ref"
  | "registration_ref"
  | "policy_version"
  | "operation"
  | "target_user_id"
  | "delivery_shape"
  | "delivery_version"
  | "disposition"
  | "restrictions"
  | "unknown_restriction"
  | "ordinary_restrictions"
  | "local_only_restrictions";

export type ClassifiedProcessingLineage =
  | Readonly<{ state: "minni_verified"; lineage: ProcessingLineageV1 }>
  | Readonly<{ state: "legacy_unknown" }>
  | Readonly<{ state: "invalid"; reason: ProcessingLineageInvalidReason }>;

export type ProcessingLineageJoinFailure =
  | "legacy_unknown"
  | "invalid"
  | "origin_mismatch"
  | "policy_version_mismatch"
  | "principal_mismatch"
  | "registration_mismatch"
  | "operation_mismatch"
  | "target_user_mismatch";

export type ProcessingLineageJoinResult =
  | Readonly<{ ok: true; lineage: ProcessingLineageV1 }>
  | Readonly<{
      ok: false;
      reason: ProcessingLineageJoinFailure;
      contentFree: true;
    }>;

const ROOT_KEYS = [
  "admitted_operation",
  "delivery",
  "origin",
  "processing_policy_version",
  "producer_principal_ref",
  "producer_registration_ref",
  "state",
  "target_user_id",
] as const;

const DELIVERY_KEYS = ["disposition", "restrictions", "version"] as const;
const MAX_REFERENCE_LENGTH = 256;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactStringKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    return false;
  }
  const actual = ownKeys as string[];
  return (
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}

function boundedNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REFERENCE_LENGTH &&
    value.trim() === value
  );
}

function invalid(reason: ProcessingLineageInvalidReason): ClassifiedProcessingLineage {
  return Object.freeze({ state: "invalid" as const, reason });
}

function freezeLineage(
  root: Record<string, unknown>,
  delivery: Record<string, unknown>,
  restrictions: readonly ProcessingLineageRestriction[],
): ProcessingLineageV1 {
  const frozenDelivery: ProcessingLineageDelivery = Object.freeze({
    version: delivery.version as typeof PROCESSING_LINEAGE_VERSION,
    disposition: delivery.disposition as ProcessingLineageDisposition,
    restrictions: Object.freeze([...restrictions]),
  });
  return Object.freeze({
    state: root.state as typeof PROCESSING_LINEAGE_STATE,
    origin: root.origin as typeof PROCESSING_LINEAGE_ORIGIN,
    producer_principal_ref: root.producer_principal_ref as string,
    producer_registration_ref: root.producer_registration_ref as string,
    processing_policy_version:
      root.processing_policy_version as typeof PROCESSING_POLICY_VERSION,
    admitted_operation: root.admitted_operation as ProcessingLineageOperation,
    target_user_id: root.target_user_id as string,
    delivery: frozenDelivery,
  });
}

function classifyRestrictions(
  value: unknown,
):
  | Readonly<{
      ok: true;
      restrictions: readonly ProcessingLineageRestriction[];
    }>
  | Readonly<{ ok: false; reason: ProcessingLineageInvalidReason }> {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "restrictions" };
  }

  const seen = new Set<ProcessingLineageRestriction>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length > 64 ||
      !PROCESSING_LINEAGE_RESTRICTIONS.includes(
        item as ProcessingLineageRestriction,
      )
    ) {
      return { ok: false, reason: "unknown_restriction" };
    }
    seen.add(item as ProcessingLineageRestriction);
  }
  const restrictions = PROCESSING_LINEAGE_RESTRICTIONS.filter((item) => seen.has(item));
  return { ok: true, restrictions: Object.freeze(restrictions) };
}

/**
 * Parse and classify untrusted persisted data.  `undefined` is retained as a
 * legacy-unknown state so callers can preserve old rows without inventing
 * origin or joining them to verified Minni data.
 */
export function classifyProcessingLineage(
  value: unknown,
): ClassifiedProcessingLineage {
  if (value === undefined) {
    return Object.freeze({ state: "legacy_unknown" as const });
  }
  if (value === null) {
    return invalid("null_value");
  }
  if (!isPlainRecord(value)) {
    return invalid("root_shape");
  }
  if (!exactStringKeys(value, ROOT_KEYS)) {
    return invalid("unknown_root_field");
  }
  if (value.state !== PROCESSING_LINEAGE_STATE) {
    return invalid("state");
  }
  if (value.origin !== PROCESSING_LINEAGE_ORIGIN) {
    return invalid("origin");
  }
  if (!boundedNonEmptyString(value.producer_principal_ref)) {
    return invalid("principal_ref");
  }
  if (!boundedNonEmptyString(value.producer_registration_ref)) {
    return invalid("registration_ref");
  }
  if (value.processing_policy_version !== PROCESSING_POLICY_VERSION) {
    return invalid("policy_version");
  }
  if (
    typeof value.admitted_operation !== "string" ||
    !PROCESSING_LINEAGE_OPERATIONS.includes(
      value.admitted_operation as ProcessingLineageOperation,
    )
  ) {
    return invalid("operation");
  }
  if (!boundedNonEmptyString(value.target_user_id)) {
    return invalid("target_user_id");
  }
  if (!isPlainRecord(value.delivery)) {
    return invalid("delivery_shape");
  }
  if (!exactStringKeys(value.delivery, DELIVERY_KEYS)) {
    return invalid("delivery_shape");
  }
  if (value.delivery.version !== PROCESSING_LINEAGE_VERSION) {
    return invalid("delivery_version");
  }
  if (
    value.delivery.disposition !== "ordinary" &&
    value.delivery.disposition !== "local_only"
  ) {
    return invalid("disposition");
  }
  const parsedRestrictions = classifyRestrictions(value.delivery.restrictions);
  if (!parsedRestrictions.ok) {
    return invalid(parsedRestrictions.reason);
  }
  if (
    value.delivery.disposition === "ordinary" &&
    parsedRestrictions.restrictions.length !== 0
  ) {
    return invalid("ordinary_restrictions");
  }
  if (
    value.delivery.disposition === "local_only" &&
    parsedRestrictions.restrictions.length === 0
  ) {
    return invalid("local_only_restrictions");
  }

  return Object.freeze({
    state: "minni_verified" as const,
    lineage: freezeLineage(value, value.delivery, parsedRestrictions.restrictions),
  });
}

/**
 * Serialize a verified structural value using the exact persisted shape.
 * Invalid or legacy values fail before a storage call can be made.
 */
export function serializeProcessingLineage(
  value: ProcessingLineageV1,
): ProcessingLineageV1 {
  const parsed = classifyProcessingLineage(value);
  if (parsed.state !== "minni_verified") {
    throw new TypeError("processing lineage is not a verified v1 value");
  }
  return parsed.lineage;
}

/**
 * Join two verified provenance values without deriving trust.  The operation
 * and target must agree; restrictions are unioned in the published order.
 */
export function conservativeJoinProcessingLineage(
  left: ClassifiedProcessingLineage,
  right: ClassifiedProcessingLineage,
): ProcessingLineageJoinResult {
  if (left.state === "legacy_unknown" || right.state === "legacy_unknown") {
    return Object.freeze({ ok: false, reason: "legacy_unknown" as const, contentFree: true });
  }
  if (left.state === "invalid" || right.state === "invalid") {
    return Object.freeze({ ok: false, reason: "invalid" as const, contentFree: true });
  }

  const leftLineage = left.lineage;
  const rightLineage = right.lineage;
  const equalPairs: readonly [
    keyof ProcessingLineageV1,
    ProcessingLineageJoinFailure,
  ][] = [
    ["origin", "origin_mismatch"],
    ["processing_policy_version", "policy_version_mismatch"],
    ["producer_principal_ref", "principal_mismatch"],
    ["producer_registration_ref", "registration_mismatch"],
    ["admitted_operation", "operation_mismatch"],
    ["target_user_id", "target_user_mismatch"],
  ];
  for (const [key, reason] of equalPairs) {
    if (leftLineage[key] !== rightLineage[key]) {
      return Object.freeze({ ok: false, reason, contentFree: true });
    }
  }

  const restrictions = PROCESSING_LINEAGE_RESTRICTIONS.filter(
    (restriction) =>
      leftLineage.delivery.restrictions.includes(restriction) ||
      rightLineage.delivery.restrictions.includes(restriction),
  );
  const delivery = {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: restrictions.length > 0 ? "local_only" : "ordinary",
    restrictions,
  } as const;
  return Object.freeze({
    ok: true as const,
    lineage: serializeProcessingLineage({
      ...leftLineage,
      delivery,
    }),
  });
}
