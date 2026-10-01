import {
  getCurrentConsumerDeliveryGrant,
  type ConsumerAdmissionRefusal,
  type ConsumerAuthority,
} from "./authority.js";
import {
  classifyProcessingLineage,
  type ClassifiedProcessingLineage,
  type ProcessingLineageDisposition,
  type ProcessingLineageInvalidReason,
  type ProcessingLineageRestriction,
} from "../../domain/memory/processing-lineage.js";

/**
 * Delivery is a projection decision only. It never authorizes Rúnir model
 * processing, remote reranking, embedding, synthesis, maintenance, or any
 * other provider call.
 */
export type ConsumerDeliveryDecision =
  | Readonly<{
      kind: "allow";
      lineage: "minni_verified";
      disposition: ProcessingLineageDisposition;
      registrationRef: string;
      provider: string;
      client: string;
      locality: "same_device" | "cloud";
  }>
  | Readonly<{
      kind: "withhold";
      lineage: "minni_verified" | "invalid";
      reason: ConsumerDeliveryWithholdReason;
      contentFree: true;
      authorityReason?: ConsumerAdmissionRefusal["reason"];
      lineageReason?: ProcessingLineageInvalidReason;
  }>
  | Readonly<{
      kind: "legacy_generic";
      lineage: "legacy_unknown";
      genericContinuation: true;
      contentFree: true;
  }>;

export type ConsumerDeliveryWithholdReason =
  | "consumer_context_invalid"
  | "target_user_mismatch"
  | "ordinary_not_granted"
  | "local_only_requires_same_device"
  | "restriction_not_granted"
  | "lineage_invalid";

function withhold(
  reason: ConsumerDeliveryWithholdReason,
  extra: Readonly<{
    lineage: "minni_verified" | "invalid";
    authorityReason?: ConsumerAdmissionRefusal["reason"];
    lineageReason?: ProcessingLineageInvalidReason;
  }>,
): ConsumerDeliveryDecision {
  return Object.freeze({
    kind: "withhold" as const,
    reason,
    contentFree: true as const,
    ...extra,
  });
}

function contextRefusalDecision(
  refusal: ConsumerAdmissionRefusal,
): ConsumerDeliveryDecision {
  return withhold("consumer_context_invalid", {
    lineage: "minni_verified",
    authorityReason: refusal.reason,
  });
}

/**
 * Decide whether a classified Minni row may reach the current consumer. The
 * input is parsed through Sourcea's neutral classifier, so persisted evidence
 * remains evidence and never becomes a capability.
 */
export function decideConsumerDelivery(
  authority: ConsumerAuthority,
  context: unknown,
  persistedLineage: unknown,
): ConsumerDeliveryDecision {
  const classified: ClassifiedProcessingLineage = classifyProcessingLineage(persistedLineage);
  if (classified.state === "legacy_unknown") {
    return Object.freeze({
      kind: "legacy_generic" as const,
      lineage: "legacy_unknown" as const,
      genericContinuation: true as const,
      contentFree: true as const,
    });
  }
  if (classified.state === "invalid") {
    return withhold("lineage_invalid", {
      lineage: "invalid",
      lineageReason: classified.reason,
    });
  }

  const grant = getCurrentConsumerDeliveryGrant(authority, context);
  if (!("context" in grant)) return contextRefusalDecision(grant);
  if (grant.context.targetUserId !== classified.lineage.target_user_id) {
    return withhold("target_user_mismatch", { lineage: "minni_verified" });
  }

  const delivery = classified.lineage.delivery;
  if (delivery.disposition === "ordinary") {
    if (!grant.allowOrdinary) return withhold("ordinary_not_granted", { lineage: "minni_verified" });
  } else {
    if (grant.locality !== "same_device") {
      return withhold("local_only_requires_same_device", { lineage: "minni_verified" });
    }
    const allRestrictionsGranted = delivery.restrictions.every(
      (restriction: ProcessingLineageRestriction) => grant.allowedLocalOnlyRestrictions.includes(restriction),
    );
    if (!allRestrictionsGranted) return withhold("restriction_not_granted", { lineage: "minni_verified" });
  }

  return Object.freeze({
    kind: "allow" as const,
    lineage: "minni_verified" as const,
    disposition: delivery.disposition,
    registrationRef: grant.registrationRef,
    provider: grant.provider,
    client: grant.client,
    locality: grant.locality,
  });
}

/**
 * A small pre-projection fence for tests and later callers. Denied and legacy
 * generic outcomes do not invoke the protected callback. Processing policy is
 * intentionally absent from this helper and must be composed separately.
 */
export async function runWithConsumerDelivery<T>(
  authority: ConsumerAuthority,
  context: unknown,
  persistedLineage: unknown,
  callback: (decision: Extract<ConsumerDeliveryDecision, { kind: "allow" }>) => T | Promise<T>,
): Promise<ConsumerDeliveryDecision | Readonly<{
  decision: Extract<ConsumerDeliveryDecision, { kind: "allow" }>;
  value: T;
}>> {
  const decision = decideConsumerDelivery(authority, context, persistedLineage);
  if (decision.kind !== "allow") return decision;
  const value = await callback(decision);
  const finalDecision = decideConsumerDelivery(authority, context, persistedLineage);
  if (finalDecision.kind !== "allow") return finalDecision;
  return Object.freeze({ decision: finalDecision, value });
}
