import {
  classifyProcessingLineage,
  type ClassifiedProcessingLineage,
} from "./processing-lineage.js";

/**
 * Read-only classification carried beside a retrieved value.
 *
 * The carrier is deliberately a module-private symbol.  It is enumerable so
 * ordinary object spread/rest cloning keeps the classification, while its
 * symbol key is omitted by JSON serialization and cannot become a public
 * string-keyed field.
 */
export type SearchHitLineageClassification =
  | ClassifiedProcessingLineage
  | Readonly<{ state: "unavailable" }>;

type SearchHitLineageCarrier = Readonly<{
  [searchHitLineage]: SearchHitLineageClassification;
}>;

const searchHitLineage: unique symbol = Symbol("runir.searchHitLineage");
const UNAVAILABLE = Object.freeze({ state: "unavailable" as const });

function attachClassification<T extends object>(
  value: T,
  classification: SearchHitLineageClassification,
): T & SearchHitLineageCarrier {
  const copy = { ...value } as Record<PropertyKey, unknown>;
  // The persisted snake_case field is source input, never part of a returned
  // row or SearchHit.  Keep only the non-wire symbol carrier.
  delete copy.processing_lineage;
  copy[searchHitLineage] = classification;
  return copy as T & SearchHitLineageCarrier;
}

/**
 * Attach the shared mapper's compatibility state.  The mapper's one-argument
 * contract does not establish that its row selected the top-level field, so
 * absence remains unavailable even when a row body happens to omit it.
 */
export function attachSearchHitLineage<T extends object>(
  value: T,
): T & SearchHitLineageCarrier {
  return attachClassification(value, UNAVAILABLE);
}

/**
 * Attach processing-lineage evidence only after an owned storage projection
 * explicitly selected the top-level field.  This is the sole path that may
 * classify an observed absence as legacy_unknown; keep it separate from the
 * one-argument mapper so callback arguments and foreign query rows cannot
 * establish selection by accident.
 */
export function attachSelectedSearchHitLineage<T extends object>(
  value: T,
  selectedProcessingLineage: unknown,
): T & SearchHitLineageCarrier {
  return attachClassification(value, classifyProcessingLineage(selectedProcessingLineage));
}

/**
 * Read the internal classification.  Inherited, non-enumerable, malformed,
 * or manually constructed values are unavailable rather than legacy rows.
 */
export function getSearchHitLineage(value: unknown): SearchHitLineageClassification {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return UNAVAILABLE;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, searchHitLineage);
  if (!descriptor?.enumerable) return UNAVAILABLE;
  const classification = descriptor.value as SearchHitLineageClassification | undefined;
  if (!classification || typeof classification !== "object") return UNAVAILABLE;
  if (
    classification.state === "unavailable" ||
    classification.state === "legacy_unknown" ||
    classification.state === "invalid" ||
    classification.state === "minni_verified"
  ) {
    return classification;
  }
  return UNAVAILABLE;
}
