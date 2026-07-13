import type { ArbitrationOutcome } from "../../domain/memory/lifecycle.js";
import { normalizeText } from "./text-normalize.js";

// Overlay-supersession outcomes mirror ArbitrationOutcome at lifecycle.ts:48
// (skip|merge-update|supersede|create). The supersede path delegates to
// supersedeMemory at src/storage/surreal/surreal-store.ts:731 — this module
// makes the decision; the executor layer applies it. Lineage state is owned
// by supersedeMemory; this file does NOT mutate the inactivation or lineage
// fields directly.

export type OverlayLockKey = {
  factKey: string;
  continuitySubjectKey: string;
};

function normalizeKeyField(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Build the overlay lock key on (factKey, continuitySubjectKey). Returns null
 *  when either field is absent (null, undefined, or empty after trim per
 *  ADR 0006 §Optional-field treatment); the overlay disengages and the caller
 *  routes the row through the arbitrator path. */
export function buildOverlayKey(
  factKey: string | null | undefined,
  continuitySubjectKey: string | null | undefined,
): OverlayLockKey | null {
  const f = normalizeKeyField(factKey);
  const c = normalizeKeyField(continuitySubjectKey);
  if (f === null || c === null) return null;
  return { factKey: f, continuitySubjectKey: c };
}

/** Predicate — engage the overlay only when the (factKey, continuitySubjectKey)
 *  lock key is fully populated. Both-null and either-null rows bypass the
 *  overlay. */
export function shouldEngageOverlay(
  factKey: string | null | undefined,
  continuitySubjectKey: string | null | undefined,
): boolean {
  return buildOverlayKey(factKey, continuitySubjectKey) !== null;
}

export type OverlayDecisionInput = {
  factKey: string | null | undefined;
  continuitySubjectKey: string | null | undefined;
  existing?: { id: string; text: string };
  incomingText: string;
};

export type OverlayDecision =
  | { outcome: Extract<ArbitrationOutcome, "skip">; reason: string; matchedId: string }
  | { outcome: Extract<ArbitrationOutcome, "merge-update">; reason: string; mergeWithId: string }
  | { outcome: Extract<ArbitrationOutcome, "supersede">; reason: string; supersedesId: string }
  | { outcome: Extract<ArbitrationOutcome, "create">; reason: string };

/** Decide overlay outcome on the (factKey, continuitySubjectKey) lock key.
 *
 *  Outcomes mirror ArbitrationOutcome at lifecycle.ts:48 — exhaustive switch on
 *  the returned `outcome` field is type-safe at every consumer.
 *
 *    outcome: "create"        — no existing record on the lock key in this generation,
 *                               OR the lock key cannot be built (overlay disengaged)
 *    outcome: "skip"          — exact normalized text match on the locked key
 *    outcome: "merge-update"  — text containment on the locked key
 *    outcome: "supersede"     — conflicting text on the locked key (executor layer
 *                               delegates to supersedeMemory at surreal-store.ts:731)
 */
export function decideOverlayOutcome(input: OverlayDecisionInput): OverlayDecision {
  const lockKey = buildOverlayKey(input.factKey, input.continuitySubjectKey);
  if (lockKey === null) {
    return {
      outcome: "create",
      reason: "overlay disengaged: nullable lock key on (factKey, continuitySubjectKey)",
    };
  }
  if (!input.existing) {
    return {
      outcome: "create",
      reason: "new (factKey, continuitySubjectKey) lock key in this overlay generation",
    };
  }

  const existingNorm = normalizeText(input.existing.text);
  const incomingNorm = normalizeText(input.incomingText);

  if (existingNorm === incomingNorm) {
    return {
      outcome: "skip",
      reason: "exact text match on (factKey, continuitySubjectKey) lock key",
      matchedId: input.existing.id,
    };
  }

  if (existingNorm.includes(incomingNorm) || incomingNorm.includes(existingNorm)) {
    return {
      outcome: "merge-update",
      reason: "text containment on (factKey, continuitySubjectKey) lock key",
      mergeWithId: input.existing.id,
    };
  }

  return {
    outcome: "supersede",
    reason: "conflicting text on (factKey, continuitySubjectKey) lock key",
    supersedesId: input.existing.id,
  };
}
