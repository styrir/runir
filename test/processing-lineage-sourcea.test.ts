import { describe, expect, it } from "vitest";
import {
  classifyProcessingLineage,
  conservativeJoinProcessingLineage,
  PROCESSING_LINEAGE_VERSION,
  serializeProcessingLineage,
} from "../src/domain/memory/processing-lineage.js";
import {
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerResolvedTargetUser,
  createServerSelectedProducerOperation,
  createTrustedProducerRegistration,
  mintProcessingLineage,
  productionProducerAuthority,
  replaceProducerRegistration,
  revokeProducerRegistration,
  syntheticProducerDeliveryResolver,
  type ProducerOperation,
} from "../src/app/processing-policy/authority.js";
import {
  assessProcessingLineageSchema,
  processingLineageSchemaStatements,
} from "../src/storage/surreal/processing-lineage-schema.js";

function lineage(overrides: Record<string, unknown> = {}) {
  return {
    state: "minni_verified",
    origin: "minni",
    producer_principal_ref: "principal.synthetic",
    producer_registration_ref: "registration.synthetic",
    processing_policy_version: "runir.minni.local/v1",
    admitted_operation: "capture_ingest",
    target_user_id: "user.synthetic",
    delivery: {
      version: PROCESSING_LINEAGE_VERSION,
      disposition: "ordinary",
      restrictions: [],
    },
    ...overrides,
  };
}

function admittedAuthority(operationName: ProducerOperation = "capture_ingest", targetUserId = "user.synthetic") {
  const principal = createServerAuthenticatedProducerPrincipal("principal.synthetic");
  const operation = createServerSelectedProducerOperation(operationName);
  const targetUser = createServerResolvedTargetUser(targetUserId);
  const authority = createProducerAuthority([
    createTrustedProducerRegistration({
      registrationRef: "registration.synthetic",
      principalRef: "principal.synthetic",
      authorizedOperations: [operationName],
      authorizedTargetUsers: [targetUserId],
    }),
  ]);
  const admission = authority.resolve({ principal, operation, targetUser });
  if (!admission.ok) throw new Error(`synthetic admission failed: ${admission.reason}`);
  return { authority, principal, operation, targetUser, context: admission.context };
}

describe("Sourcea processing lineage contract", () => {
  it("classifies exact values, retains legacy absence, and rejects semantic drift", () => {
    expect(classifyProcessingLineage(undefined)).toEqual({ state: "legacy_unknown" });
    const parsed = classifyProcessingLineage(lineage());
    expect(parsed.state).toBe("minni_verified");
    if (parsed.state === "minni_verified") {
      expect(Object.isFrozen(parsed.lineage)).toBe(true);
      expect(Object.isFrozen(parsed.lineage.delivery.restrictions)).toBe(true);
      expect(serializeProcessingLineage(parsed.lineage)).toEqual(parsed.lineage);
    }
    expect(classifyProcessingLineage({ ...lineage(), unexpected: true })).toEqual({ state: "invalid", reason: "unknown_root_field" });
    expect(classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "ordinary", restrictions: ["audio_derived"] } }))).toEqual({ state: "invalid", reason: "ordinary_restrictions" });
    expect(classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: [] } }))).toEqual({ state: "invalid", reason: "local_only_restrictions" });
    const nonCanonical = classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: ["producer_local_only", "audio_derived", "audio_derived"] } }));
    expect(nonCanonical).toMatchObject({ state: "minni_verified" });
    if (nonCanonical.state === "minni_verified") {
      expect(nonCanonical.lineage.delivery.restrictions).toEqual(["audio_derived", "producer_local_only"]);
    }
    for (const permutation of [
      ["audio_derived", "excluded_source", "producer_local_only"],
      ["producer_local_only", "excluded_source", "audio_derived"],
      ["excluded_source", "audio_derived", "producer_local_only"],
      ["audio_derived", "producer_local_only", "excluded_source"],
      ["excluded_source", "producer_local_only", "audio_derived"],
      ["producer_local_only", "audio_derived", "excluded_source"],
    ]) {
      const permutationResult = classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: permutation } }));
      expect(permutationResult.state).toBe("minni_verified");
      if (permutationResult.state === "minni_verified") expect(permutationResult.lineage.delivery.restrictions).toEqual(["audio_derived", "excluded_source", "producer_local_only"]);
    }
    expect(classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: ["audio_derived", "unknown"] } }))).toEqual({ state: "invalid", reason: "unknown_restriction" });
    expect(classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: ["audio_derived", 7] } }))).toEqual({ state: "invalid", reason: "unknown_restriction" });
    expect(classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: ["x".repeat(65)] } }))).toEqual({ state: "invalid", reason: "unknown_restriction" });
  });

  it("joins only same-authority provenance and unions restrictions conservatively", () => {
    const restricted = lineage({
      delivery: {
        version: PROCESSING_LINEAGE_VERSION,
        disposition: "local_only",
        restrictions: ["audio_derived"],
      },
    });
    const left = classifyProcessingLineage(lineage());
    const right = classifyProcessingLineage(restricted);
    const joined = conservativeJoinProcessingLineage(left, right);
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(joined.lineage.delivery.restrictions).toEqual(["audio_derived"]);
    const all = classifyProcessingLineage(lineage({ delivery: { version: PROCESSING_LINEAGE_VERSION, disposition: "local_only", restrictions: ["producer_local_only", "audio_derived", "excluded_source"] } }));
    const allJoined = conservativeJoinProcessingLineage(right, all);
    expect(allJoined.ok).toBe(true);
    if (allJoined.ok) expect(allJoined.lineage.delivery.restrictions).toEqual(["audio_derived", "excluded_source", "producer_local_only"]);
    expect(conservativeJoinProcessingLineage(left, classifyProcessingLineage(undefined))).toMatchObject({ ok: false, reason: "legacy_unknown", contentFree: true });
    expect(conservativeJoinProcessingLineage(left, classifyProcessingLineage({ ...lineage(), admitted_operation: "forced_maintenance" }))).toMatchObject({ ok: false, reason: "operation_mismatch", contentFree: true });
  });

  it("mints through the opaque current authority and rejects replay or forged context", () => {
    const admitted = admittedAuthority();
    const trustedEvidence = syntheticProducerDeliveryResolver.resolve(admitted.authority, admitted.context);
    expect(trustedEvidence).not.toHaveProperty("ok", false);
    expect(mintProcessingLineage(admitted.authority, admitted.context, trustedEvidence)).toMatchObject({ ok: true, lineage: { admitted_operation: "capture_ingest", delivery: { disposition: "ordinary", restrictions: [] } } });

    const restricted = admittedAuthority("scheduled_maintenance");
    const restrictedEvidence = syntheticProducerDeliveryResolver.resolve(restricted.authority, restricted.context);
    expect(mintProcessingLineage(restricted.authority, restricted.context, restrictedEvidence)).toMatchObject({ ok: true, lineage: { admitted_operation: "scheduled_maintenance", delivery: { disposition: "local_only", restrictions: ["audio_derived"] } } });
    const wrongOperation = admittedAuthority("forced_maintenance");
    const wrongOperationEvidence = syntheticProducerDeliveryResolver.resolve(wrongOperation.authority, wrongOperation.context);
    expect(mintProcessingLineage(admitted.authority, admitted.context, wrongOperationEvidence)).toMatchObject({ ok: false, reason: "authority_mismatch", contentFree: true });
    const wrongUser = admittedAuthority("capture_ingest", "other-user");
    const wrongUserEvidence = syntheticProducerDeliveryResolver.resolve(wrongUser.authority, wrongUser.context);
    expect(mintProcessingLineage(admitted.authority, admitted.context, wrongUserEvidence)).toMatchObject({ ok: false, reason: "authority_mismatch", contentFree: true });

    expect(mintProcessingLineage(productionProducerAuthority, admitted.context, trustedEvidence)).toMatchObject({ ok: false, reason: "authority_mismatch", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, { ...admitted.context }, syntheticProducerDeliveryResolver)).toMatchObject({ ok: false, reason: "authority_mismatch", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, JSON.parse(JSON.stringify(admitted.context)), syntheticProducerDeliveryResolver)).toMatchObject({ ok: false, reason: "authority_mismatch", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context)).toMatchObject({ ok: false, reason: "delivery_resolver_unconfigured", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, {} as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, { audioDerived: false } as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, { audioDerived: false, excludedSource: false, producerLocalOnly: false } as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, JSON.parse(JSON.stringify(syntheticProducerDeliveryResolver)) as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, { client: "minni", tags: ["producer_local_only"] } as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, { ...trustedEvidence } as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });
    expect(mintProcessingLineage(admitted.authority, admitted.context, JSON.parse(JSON.stringify(trustedEvidence)) as unknown as never)).toMatchObject({ ok: false, reason: "delivery_resolver_untrusted", contentFree: true });

    revokeProducerRegistration(admitted.authority, "registration.synthetic");
    expect(mintProcessingLineage(admitted.authority, admitted.context, trustedEvidence)).toMatchObject({ ok: false, reason: "registration_revoked", contentFree: true });
  });

  it("rechecks replacement identity and does not let old operation context grant current permission", () => {
    const admitted = admittedAuthority();
    replaceProducerRegistration(admitted.authority, createTrustedProducerRegistration({
      registrationRef: "registration.synthetic",
      principalRef: "principal.rebound",
      authorizedOperations: ["capture_ingest"],
      authorizedTargetUsers: ["user.synthetic"],
    }));
    const trustedEvidence = syntheticProducerDeliveryResolver.resolve(admitted.authority, admitted.context);
    expect(mintProcessingLineage(admitted.authority, admitted.context, trustedEvidence)).toMatchObject({ ok: false, reason: "registration_mismatch", contentFree: true });

    const expiry = admittedAuthority();
    replaceProducerRegistration(expiry.authority, createTrustedProducerRegistration({
      registrationRef: "registration.synthetic",
      principalRef: "principal.synthetic",
      authorizedOperations: ["capture_ingest"],
      authorizedTargetUsers: ["user.synthetic"],
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }));
    const expiryEvidence = syntheticProducerDeliveryResolver.resolve(expiry.authority, expiry.context);
    expect(mintProcessingLineage(expiry.authority, expiry.context, expiryEvidence)).toMatchObject({ ok: false, reason: "registration_expired", contentFree: true });

    const operation = admittedAuthority();
    replaceProducerRegistration(operation.authority, createTrustedProducerRegistration({
      registrationRef: "registration.synthetic",
      principalRef: "principal.synthetic",
      authorizedOperations: ["scheduled_maintenance"],
      authorizedTargetUsers: ["user.synthetic"],
    }));
    const operationEvidence = syntheticProducerDeliveryResolver.resolve(operation.authority, operation.context);
    expect(mintProcessingLineage(operation.authority, operation.context, operationEvidence)).toMatchObject({ ok: false, reason: "operation_not_authorized", contentFree: true });
  });

  it("requires every lineage definition and refuses extra or incompatible hierarchy", () => {
    const definitions = Object.fromEntries(processingLineageSchemaStatements("semiote").map((statement) => {
      const field = statement.match(/^DEFINE FIELD IF NOT EXISTS ([^ ]+)/)?.[1] ?? "";
      const type = statement.match(/ TYPE ([^;]+);$/)?.[1] ?? "";
      return [field, `DEFINE FIELD ${field} ON semiote TYPE ${type}`];
    }));
    expect(assessProcessingLineageSchema({ fields: definitions })).toEqual({ kind: "compatible" });
    const partial = { fields: { processing_lineage: "DEFINE FIELD processing_lineage ON semiote TYPE none | object" } };
    expect(assessProcessingLineageSchema(partial)).toMatchObject({ kind: "partial" });
    expect(assessProcessingLineageSchema({ fields: { ...definitions, "processing_lineage.unexpected": "DEFINE FIELD processing_lineage.unexpected ON semiote TYPE string" } })).toMatchObject({ kind: "extra" });
    expect(assessProcessingLineageSchema({ fields: { ...definitions, "processing_lineage.state": "DEFINE FIELD processing_lineage.state ON semiote TYPE number" } })).toMatchObject({ kind: "incompatible" });
  });
});
