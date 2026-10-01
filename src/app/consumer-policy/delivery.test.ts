import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConsumerAuthority,
  createReviewedConsumerRegistration,
  createServerAuthenticatedConsumerPrincipal,
  createServerResolvedConsumerTargetUser,
  createServerSelectedConsumerOperation,
  createServerSelectedConsumerTier,
  replaceConsumerRegistration,
  revokeConsumerRegistration,
  type ConsumerLocality,
  type ConsumerTier,
} from "./authority.js";
import {
  decideConsumerDelivery,
  runWithConsumerDelivery,
} from "./delivery.js";
import {
  PROCESSING_LINEAGE_RESTRICTIONS,
  PROCESSING_LINEAGE_VERSION,
  PROCESSING_POLICY_VERSION,
  type ProcessingLineageRestriction,
} from "../../domain/memory/processing-lineage.js";

let fixtureNumber = 0;

afterEach(() => {
  vi.useRealTimers();
});

function buildFixture(options: {
  locality?: ConsumerLocality;
  allowOrdinary?: boolean;
  allowedLocalOnlyRestrictions?: readonly ProcessingLineageRestriction[];
  tier?: ConsumerTier;
  targetUserId?: string;
} = {}) {
  fixtureNumber += 1;
  const targetUserId = options.targetUserId ?? "owner";
  const principal = createServerAuthenticatedConsumerPrincipal(`consumer-${fixtureNumber}`);
  const targetUser = createServerResolvedConsumerTargetUser(targetUserId);
  const operation = createServerSelectedConsumerOperation("recall");
  const tier = createServerSelectedConsumerTier(options.tier ?? "ordinary");
  const registration = createReviewedConsumerRegistration({
    registrationRef: `consumer-registration-${fixtureNumber}`,
    principalRef: principal.principalRef,
    provider: "openai",
    client: "codex",
    locality: options.locality ?? "same_device",
    authorizedOperations: ["recall"],
    authorizedTargetUsers: [targetUser.userId],
    authorizedTiers: [tier.name],
    allowOrdinary: options.allowOrdinary ?? true,
    allowedLocalOnlyRestrictions: options.allowedLocalOnlyRestrictions ?? [],
  });
  const authority = createConsumerAuthority([registration]);
  const admission = authority.resolve({ principal, operation, tier, targetUser });
  if (!admission.ok) throw new Error(`fixture admission failed: ${admission.reason}`);
  return { authority, context: admission.context, targetUser, registration };
}

function ordinaryLineage(targetUserId = "owner") {
  return {
    state: "minni_verified",
    origin: "minni",
    producer_principal_ref: "producer-principal",
    producer_registration_ref: "producer-registration",
    processing_policy_version: PROCESSING_POLICY_VERSION,
    admitted_operation: "capture_ingest",
    target_user_id: targetUserId,
    delivery: {
      version: PROCESSING_LINEAGE_VERSION,
      disposition: "ordinary",
      restrictions: [],
    },
  };
}

function localOnlyLineage(
  restrictions: readonly ProcessingLineageRestriction[],
  targetUserId = "owner",
) {
  return {
    ...ordinaryLineage(targetUserId),
    delivery: {
      version: PROCESSING_LINEAGE_VERSION,
      disposition: "local_only",
      restrictions: [...restrictions],
    },
  };
}

describe("pure consumer delivery policy", () => {
  it("allows ordinary Minni delivery for an authorized cloud consumer", () => {
    const fixture = buildFixture({ locality: "cloud" });
    const decision = decideConsumerDelivery(fixture.authority, fixture.context, ordinaryLineage());

    expect(decision).toEqual({
      kind: "allow",
      lineage: "minni_verified",
      disposition: "ordinary",
      registrationRef: "consumer-registration-1",
      provider: "openai",
      client: "codex",
      locality: "cloud",
    });
    expect(Object.keys(decision)).not.toEqual(expect.arrayContaining([
      "processing",
      "model",
      "endpoint",
      "credential",
    ]));
  });

  it("allows ordinary local delivery and every canonical local-only reason when granted", () => {
    const ordinary = buildFixture({ locality: "same_device" });
    expect(decideConsumerDelivery(ordinary.authority, ordinary.context, ordinaryLineage())).toMatchObject({
      kind: "allow",
      locality: "same_device",
    });

    for (const restriction of PROCESSING_LINEAGE_RESTRICTIONS) {
      const single = buildFixture({
        locality: "same_device",
        allowedLocalOnlyRestrictions: [restriction],
      });
      expect(decideConsumerDelivery(
        single.authority,
        single.context,
        localOnlyLineage([restriction]),
      )).toMatchObject({
        kind: "allow",
        disposition: "local_only",
      });
    }

    const all = buildFixture({
      locality: "same_device",
      allowedLocalOnlyRestrictions: PROCESSING_LINEAGE_RESTRICTIONS,
    });
    expect(decideConsumerDelivery(
      all.authority,
      all.context,
      localOnlyLineage(PROCESSING_LINEAGE_RESTRICTIONS),
    )).toMatchObject({
      kind: "allow",
      disposition: "local_only",
    });
  });

  it("withholds restricted lineage for cloud, partial grants, and an ordinary-denied registration", () => {
    const cloud = buildFixture({
      locality: "cloud",
      tier: "restricted",
      allowedLocalOnlyRestrictions: PROCESSING_LINEAGE_RESTRICTIONS,
    });
    expect(decideConsumerDelivery(
      cloud.authority,
      cloud.context,
      localOnlyLineage(["audio_derived"]),
    )).toMatchObject({
      kind: "withhold",
      reason: "local_only_requires_same_device",
      contentFree: true,
    });

    const partial = buildFixture({
      locality: "same_device",
      allowedLocalOnlyRestrictions: ["audio_derived"],
    });
    expect(decideConsumerDelivery(
      partial.authority,
      partial.context,
      localOnlyLineage(["audio_derived", "excluded_source"]),
    )).toMatchObject({
      kind: "withhold",
      reason: "restriction_not_granted",
      contentFree: true,
    });

    const ordinaryDenied = buildFixture({ allowOrdinary: false });
    expect(decideConsumerDelivery(
      ordinaryDenied.authority,
      ordinaryDenied.context,
      ordinaryLineage(),
    )).toMatchObject({
      kind: "withhold",
      reason: "ordinary_not_granted",
      contentFree: true,
    });
  });

  it("requires the consumer target to match the persisted lineage target", () => {
    const fixture = buildFixture({ targetUserId: "owner" });
    const decision = decideConsumerDelivery(
      fixture.authority,
      fixture.context,
      ordinaryLineage("other-user"),
    );

    expect(decision).toEqual({
      kind: "withhold",
      lineage: "minni_verified",
      reason: "target_user_mismatch",
      contentFree: true,
    });
  });

  it("withholds valid Minni lineage for missing, copied, JSON, and producer-shaped contexts", () => {
    const fixture = buildFixture();
    const copied = { ...fixture.context };
    const json = JSON.parse(JSON.stringify(fixture.context));
    const producerLike = {
      principalRef: fixture.context.principalRef,
      registrationRef: fixture.context.registrationRef,
      origin: "minni",
      policyVersion: PROCESSING_POLICY_VERSION,
      operation: "capture_ingest",
      targetUserId: "owner",
    };

    for (const context of [undefined, null, copied, json, producerLike]) {
      const decision = decideConsumerDelivery(fixture.authority, context, ordinaryLineage());
      expect(decision).toMatchObject({
        kind: "withhold",
        lineage: "minni_verified",
        reason: "consumer_context_invalid",
        contentFree: true,
      });
    }
  });

  it("treats invalid present lineage as withhold and never downgrades it to legacy", () => {
    const fixture = buildFixture();
    const invalidRoot = {
      ...ordinaryLineage(),
      source_client: "codex",
    };
    const invalidRestriction = {
      ...ordinaryLineage(),
      delivery: {
        ...ordinaryLineage().delivery,
        restrictions: ["unknown_reason"],
      },
    };
    const unsupportedVersion = {
      ...ordinaryLineage(),
      processing_policy_version: "runir.minni.local/v0",
    };

    expect(decideConsumerDelivery(fixture.authority, fixture.context, invalidRoot)).toEqual({
      kind: "withhold",
      lineage: "invalid",
      reason: "lineage_invalid",
      contentFree: true,
      lineageReason: "unknown_root_field",
    });
    expect(decideConsumerDelivery(fixture.authority, fixture.context, invalidRestriction)).toMatchObject({
      kind: "withhold",
      lineage: "invalid",
      reason: "lineage_invalid",
      lineageReason: "unknown_restriction",
      contentFree: true,
    });
    expect(decideConsumerDelivery(fixture.authority, fixture.context, unsupportedVersion)).toMatchObject({
      kind: "withhold",
      lineage: "invalid",
      reason: "lineage_invalid",
      lineageReason: "policy_version",
      contentFree: true,
    });
  });

  it("keeps absent lineage on a distinct generic continuation path", () => {
    const decision = decideConsumerDelivery(createConsumerAuthority(), undefined, undefined);

    expect(decision).toEqual({
      kind: "legacy_generic",
      lineage: "legacy_unknown",
      genericContinuation: true,
      contentFree: true,
    });
    expect(decision.kind).not.toBe("allow");
  });

  it("suppresses callbacks for legacy and denied rows and invokes one only for an allowed row", async () => {
    const fixture = buildFixture({ locality: "same_device" });
    let protectedCalls = 0;
    const callback = () => {
      protectedCalls += 1;
      return "provider-and-service-free";
    };

    const legacy = await runWithConsumerDelivery(
      fixture.authority,
      fixture.context,
      undefined,
      callback,
    );
    expect(legacy).toMatchObject({ kind: "legacy_generic", genericContinuation: true });
    expect(protectedCalls).toBe(0);

    const denied = await runWithConsumerDelivery(
      fixture.authority,
      fixture.context,
      localOnlyLineage(["excluded_source"]),
      callback,
    );
    expect(denied).toMatchObject({ kind: "withhold", reason: "restriction_not_granted" });
    expect(protectedCalls).toBe(0);

    const allowed = await runWithConsumerDelivery(
      fixture.authority,
      fixture.context,
      ordinaryLineage(),
      callback,
    );
    expect(allowed).toMatchObject({
      decision: { kind: "allow", disposition: "ordinary" },
      value: "provider-and-service-free",
    });
    expect(protectedCalls).toBe(1);
  });

  it("revalidates after an async callback before releasing an allow result", async () => {
    const revoked = buildFixture();
    let releaseRevoked!: () => void;
    const revokedGate = new Promise<void>((resolve) => {
      releaseRevoked = resolve;
    });
    const revokedRun = runWithConsumerDelivery(
      revoked.authority,
      revoked.context,
      ordinaryLineage(),
      async () => {
        await revokedGate;
        return "stale-revoked-value";
      },
    );
    await Promise.resolve();
    revokeConsumerRegistration(revoked.authority, revoked.registration.registrationRef);
    releaseRevoked();
    expect(await revokedRun).toMatchObject({
      kind: "withhold",
      reason: "consumer_context_invalid",
      authorityReason: "registration_revoked",
      contentFree: true,
    });

    const changedGrant = buildFixture();
    let releaseGrant!: () => void;
    const grantGate = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    const changedGrantRun = runWithConsumerDelivery(
      changedGrant.authority,
      changedGrant.context,
      ordinaryLineage(),
      async () => {
        await grantGate;
        return "stale-grant-value";
      },
    );
    await Promise.resolve();
    replaceConsumerRegistration(changedGrant.authority, createReviewedConsumerRegistration({
      ...changedGrant.registration,
      allowOrdinary: false,
    }));
    releaseGrant();
    expect(await changedGrantRun).toMatchObject({
      kind: "withhold",
      reason: "ordinary_not_granted",
      contentFree: true,
    });

    vi.useFakeTimers();
    const expiring = buildFixture();
    let releaseExpiry!: () => void;
    const expiryGate = new Promise<void>((resolve) => {
      releaseExpiry = resolve;
    });
    const expiry = new Date(Date.now() + 1000).toISOString();
    replaceConsumerRegistration(expiring.authority, createReviewedConsumerRegistration({
      ...expiring.registration,
      expiresAt: expiry,
    }));
    const expiryRun = runWithConsumerDelivery(
      expiring.authority,
      expiring.context,
      ordinaryLineage(),
      async () => {
        await expiryGate;
        return "stale-expiry-value";
      },
    );
    await Promise.resolve();
    vi.setSystemTime(new Date(Date.parse(expiry) + 1));
    releaseExpiry();
    expect(await expiryRun).toMatchObject({
      kind: "withhold",
      reason: "consumer_context_invalid",
      authorityReason: "registration_expired",
      contentFree: true,
    });
  });
});
