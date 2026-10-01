import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTrustedConsumerDeliveryContext,
  createConsumerAuthority,
  createReviewedConsumerRegistration,
  createServerAuthenticatedConsumerPrincipal,
  createServerResolvedConsumerTargetUser,
  createServerSelectedConsumerOperation,
  createServerSelectedConsumerTier,
  getCurrentConsumerDeliveryGrant,
  productionConsumerAuthority,
  removeConsumerRegistration,
  replaceConsumerRegistration,
  revokeConsumerRegistration,
  runWithConsumerAdmission,
  type ConsumerAdmissionInput,
} from "./authority.js";

afterEach(() => {
  vi.useRealTimers();
});

function buildFixture(overrides: Partial<Parameters<typeof createReviewedConsumerRegistration>[0]> = {}) {
  const principal = createServerAuthenticatedConsumerPrincipal("synthetic-consumer");
  const targetUser = createServerResolvedConsumerTargetUser("owner");
  const operation = createServerSelectedConsumerOperation("recall");
  const tier = createServerSelectedConsumerTier("ordinary");
  const registration = createReviewedConsumerRegistration({
    registrationRef: "synthetic-consumer-registration",
    principalRef: principal.principalRef,
    provider: "openai",
    client: "codex",
    locality: "cloud",
    authorizedOperations: ["recall"],
    authorizedTargetUsers: [targetUser.userId],
    authorizedTiers: ["ordinary"],
    allowOrdinary: true,
    allowedLocalOnlyRestrictions: [],
    ...overrides,
  });
  const authority = createConsumerAuthority([registration]);
  return { principal, targetUser, operation, tier, registration, authority };
}

function admit(fixture: ReturnType<typeof buildFixture>) {
  const result = fixture.authority.resolve({
    principal: fixture.principal,
    operation: fixture.operation,
    tier: fixture.tier,
    targetUser: fixture.targetUser,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("fixture admission failed");
  return result.context;
}

async function runPendingAdmission(
  fixture: ReturnType<typeof buildFixture>,
  mutateWhilePending: () => void,
) {
  let release!: () => void;
  let callbackCalls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runWithConsumerAdmission(
    fixture.authority,
    {
      principal: fixture.principal,
      operation: fixture.operation,
      tier: fixture.tier,
      targetUser: fixture.targetUser,
    },
    async () => {
      callbackCalls += 1;
      await gate;
      return "protected-value";
    },
  );
  await Promise.resolve();
  mutateWhilePending();
  release();
  const result = await pending;
  expect(callbackCalls).toBe(1);
  expect(result).not.toHaveProperty("value");
  return result;
}

describe("internal consumer authority", () => {
  it("keeps the production registry empty and suppresses the protected callback", async () => {
    const principal = createServerAuthenticatedConsumerPrincipal("unregistered-consumer");
    const targetUser = createServerResolvedConsumerTargetUser("owner");
    let callbackCalls = 0;

    const result = await runWithConsumerAdmission(
      productionConsumerAuthority,
      {
        principal,
        operation: createServerSelectedConsumerOperation("recall"),
        tier: createServerSelectedConsumerTier("ordinary"),
        targetUser,
      },
      () => {
        callbackCalls += 1;
        return "must-not-run";
      },
    );

    expect(result).toEqual({
      ok: false,
      code: "consumer_policy_refused",
      reason: "registration_missing",
      contentFree: true,
    });
    expect(callbackCalls).toBe(0);
  });

  it("binds the current consumer registration and exposes only its reviewed delivery grant", () => {
    const fixture = buildFixture();
    const context = admit(fixture);
    const grant = getCurrentConsumerDeliveryGrant(fixture.authority, context);

    expect(grant).toMatchObject({
      context,
      registrationRef: fixture.registration.registrationRef,
      provider: "openai",
      client: "codex",
      locality: "cloud",
      allowOrdinary: true,
      allowedLocalOnlyRestrictions: [],
    });
    expect(Object.keys(grant)).toEqual([
      "context",
      "registrationRef",
      "provider",
      "client",
      "locality",
      "allowOrdinary",
      "allowedLocalOnlyRestrictions",
      "status",
    ]);
  });

  it("does not let a request user label widen the server target", () => {
    const fixture = buildFixture();
    const result = fixture.authority.resolve({
      principal: fixture.principal,
      operation: fixture.operation,
      tier: fixture.tier,
      targetUser: fixture.targetUser,
      requestedUserId: "other-user",
    });

    expect(result).toEqual({
      ok: false,
      code: "consumer_policy_refused",
      reason: "requested_user_mismatch",
      contentFree: true,
    });
  });

  it("rejects body-shaped, inherited, spread, descriptor-forged, and JSON identities", () => {
    const fixture = buildFixture();
    const bodyPrincipal = {
      principalRef: fixture.principal.principalRef,
      authenticatedBy: "server",
    };
    const bodyTarget = { userId: fixture.targetUser.userId };
    const bodyOperation = { name: fixture.operation.name };
    const bodyTier = { name: fixture.tier.name };
    const cases: ConsumerAdmissionInput[] = [
      {
        principal: bodyPrincipal as ConsumerAdmissionInput["principal"],
        operation: fixture.operation,
        tier: fixture.tier,
        targetUser: fixture.targetUser,
      },
      {
        principal: Object.create(fixture.principal) as ConsumerAdmissionInput["principal"],
        operation: fixture.operation,
        tier: fixture.tier,
        targetUser: fixture.targetUser,
      },
      {
        principal: JSON.parse(JSON.stringify(fixture.principal)) as ConsumerAdmissionInput["principal"],
        operation: fixture.operation,
        tier: fixture.tier,
        targetUser: fixture.targetUser,
      },
      {
        principal: fixture.principal,
        operation: bodyOperation as ConsumerAdmissionInput["operation"],
        tier: fixture.tier,
        targetUser: fixture.targetUser,
      },
      {
        principal: fixture.principal,
        operation: fixture.operation,
        tier: bodyTier as ConsumerAdmissionInput["tier"],
        targetUser: fixture.targetUser,
      },
      {
        principal: fixture.principal,
        operation: fixture.operation,
        tier: fixture.tier,
        targetUser: bodyTarget as ConsumerAdmissionInput["targetUser"],
      },
    ];

    expect(fixture.authority.resolve(cases[0])).toMatchObject({
      ok: false,
      reason: "principal_untrusted",
      contentFree: true,
    });
    expect(fixture.authority.resolve(cases[1])).toMatchObject({
      ok: false,
      reason: "principal_untrusted",
      contentFree: true,
    });
    expect(fixture.authority.resolve(cases[2])).toMatchObject({
      ok: false,
      reason: "principal_untrusted",
      contentFree: true,
    });
    expect(fixture.authority.resolve(cases[3])).toMatchObject({
      ok: false,
      reason: "operation_untrusted",
      contentFree: true,
    });
    expect(fixture.authority.resolve(cases[4])).toMatchObject({
      ok: false,
      reason: "tier_untrusted",
      contentFree: true,
    });
    expect(fixture.authority.resolve(cases[5])).toMatchObject({
      ok: false,
      reason: "target_user_untrusted",
      contentFree: true,
    });
  });

  it("rejects producer-shaped and caller-label contexts", () => {
    const fixture = buildFixture();
    const producerLike = {
      principalRef: fixture.principal.principalRef,
      registrationRef: fixture.registration.registrationRef,
      origin: "minni",
      policyVersion: "runir.minni.local/v1",
      operation: "capture_ingest",
      targetUserId: "owner",
    };
    const result = fixture.authority.resolve({
      principal: producerLike as ConsumerAdmissionInput["principal"],
      operation: "recall" as ConsumerAdmissionInput["operation"],
      tier: "ordinary" as ConsumerAdmissionInput["tier"],
      targetUser: { userId: "owner" } as ConsumerAdmissionInput["targetUser"],
      client: "codex",
      provider: "openai",
      locality: "cloud",
      origin: "minni",
    } as unknown as ConsumerAdmissionInput);

    expect(result).toMatchObject({
      ok: false,
      reason: "principal_untrusted",
      contentFree: true,
    });
  });

  it("keeps copied or JSON registration values outside the trusted setup boundary", () => {
    const fixture = buildFixture();
    expect(() => createConsumerAuthority([
      { ...fixture.registration },
    ])).toThrowError("consumer registration must come from reviewed server construction");
    expect(() => createConsumerAuthority([
      JSON.parse(JSON.stringify(fixture.registration)),
    ])).toThrowError("consumer registration must come from reviewed server construction");
    expect(() => replaceConsumerRegistration(
      fixture.authority,
      { ...fixture.registration },
    )).toThrowError("consumer registration must come from reviewed server construction");
  });

  it("revalidates revoke, removal, expiry, replacement, grant, and principal mapping at use", () => {
    const revoked = buildFixture();
    const revokedContext = admit(revoked);
    revokeConsumerRegistration(revoked.authority, revoked.registration.registrationRef);
    expect(getCurrentConsumerDeliveryGrant(revoked.authority, revokedContext)).toMatchObject({
      ok: false,
      reason: "registration_revoked",
      contentFree: true,
    });

    const removed = buildFixture();
    const removedContext = admit(removed);
    removeConsumerRegistration(removed.authority, removed.registration.registrationRef);
    expect(getCurrentConsumerDeliveryGrant(removed.authority, removedContext)).toMatchObject({
      ok: false,
      reason: "registration_missing",
      contentFree: true,
    });

    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const expiring = buildFixture({ expiresAt });
    const expiringContext = admit(expiring);
    vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
    expect(getCurrentConsumerDeliveryGrant(expiring.authority, expiringContext)).toMatchObject({
      ok: false,
      reason: "registration_expired",
      contentFree: true,
    });
    vi.useRealTimers();

    const changedGrant = buildFixture();
    const changedGrantContext = admit(changedGrant);
    replaceConsumerRegistration(changedGrant.authority, createReviewedConsumerRegistration({
      ...changedGrant.registration,
      allowOrdinary: false,
    }));
    expect(getCurrentConsumerDeliveryGrant(changedGrant.authority, changedGrantContext)).toMatchObject({
      context: changedGrantContext,
      allowOrdinary: false,
    });

    const changedProvider = buildFixture();
    const changedProviderContext = admit(changedProvider);
    replaceConsumerRegistration(changedProvider.authority, createReviewedConsumerRegistration({
      ...changedProvider.registration,
      provider: "anthropic",
      client: "claude",
    }));
    expect(getCurrentConsumerDeliveryGrant(changedProvider.authority, changedProviderContext)).toMatchObject({
      ok: false,
      reason: "registration_mismatch",
      contentFree: true,
    });

    const changedOperation = buildFixture();
    const changedOperationContext = admit(changedOperation);
    replaceConsumerRegistration(changedOperation.authority, createReviewedConsumerRegistration({
      ...changedOperation.registration,
      authorizedOperations: ["summary_delivery"],
    }));
    expect(getCurrentConsumerDeliveryGrant(changedOperation.authority, changedOperationContext)).toMatchObject({
      ok: false,
      reason: "operation_not_authorized",
      contentFree: true,
    });

    const changedStatus = buildFixture();
    const changedStatusContext = admit(changedStatus);
    replaceConsumerRegistration(changedStatus.authority, createReviewedConsumerRegistration({
      ...changedStatus.registration,
      status: "revoked",
    }));
    expect(getCurrentConsumerDeliveryGrant(changedStatus.authority, changedStatusContext)).toMatchObject({
      ok: false,
      reason: "registration_revoked",
      contentFree: true,
    });

    const changedPrincipal = buildFixture();
    const changedPrincipalContext = admit(changedPrincipal);
    replaceConsumerRegistration(changedPrincipal.authority, createReviewedConsumerRegistration({
      ...changedPrincipal.registration,
      principalRef: "different-consumer",
    }));
    expect(getCurrentConsumerDeliveryGrant(changedPrincipal.authority, changedPrincipalContext)).toMatchObject({
      ok: false,
      reason: "registration_mismatch",
      contentFree: true,
    });

    const crossAuthority = buildFixture();
    const crossAuthorityContext = admit(crossAuthority);
    expect(getCurrentConsumerDeliveryGrant(createConsumerAuthority(), crossAuthorityContext)).toMatchObject({
      ok: false,
      reason: "authority_mismatch",
      contentFree: true,
    });
    const descriptorForged = Object.create(crossAuthorityContext) as Record<string, unknown>;
    Object.defineProperty(descriptorForged, "provider", {
      configurable: true,
      value: "anthropic",
    });
    expect(() => assertTrustedConsumerDeliveryContext(crossAuthority.authority, {
      ...descriptorForged,
    })).toThrowError(expect.objectContaining({
      code: "consumer_policy_refused",
      reason: "context_invalid",
      contentFree: true,
    }));
  });

  it("refuses expired and unauthorized registrations before admission", () => {
    const principal = createServerAuthenticatedConsumerPrincipal("consumer-gates");
    const targetUser = createServerResolvedConsumerTargetUser("owner");
    const expired = createReviewedConsumerRegistration({
      registrationRef: "expired-consumer",
      principalRef: principal.principalRef,
      provider: "anthropic",
      client: "claude",
      locality: "same_device",
      authorizedOperations: ["summary_delivery"],
      authorizedTargetUsers: [targetUser.userId],
      authorizedTiers: ["restricted"],
      allowOrdinary: false,
      allowedLocalOnlyRestrictions: ["excluded_source"],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const authority = createConsumerAuthority([expired]);
    expect(authority.resolve({
      principal,
      operation: createServerSelectedConsumerOperation("summary_delivery"),
      tier: createServerSelectedConsumerTier("restricted"),
      targetUser,
    })).toMatchObject({
      ok: false,
      reason: "registration_expired",
      contentFree: true,
    });
  });

  it("suppresses a pending callback value after current authority or grant changes", async () => {
    const cases = [
      {
        reason: "registration_revoked",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => revokeConsumerRegistration(
          fixture.authority,
          fixture.registration.registrationRef,
        ),
      },
      {
        reason: "registration_missing",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => removeConsumerRegistration(
          fixture.authority,
          fixture.registration.registrationRef,
        ),
      },
      {
        reason: "registration_mismatch",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, provider: "anthropic" }),
        ),
      },
      {
        reason: "registration_mismatch",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, client: "claude" }),
        ),
      },
      {
        reason: "registration_mismatch",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, locality: "same_device" }),
        ),
      },
      {
        reason: "operation_not_authorized",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, authorizedOperations: ["summary_delivery"] }),
        ),
      },
      {
        reason: "target_user_not_authorized",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, authorizedTargetUsers: ["other-user"] }),
        ),
      },
      {
        reason: "tier_not_authorized",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, authorizedTiers: ["restricted"] }),
        ),
      },
      {
        reason: "context_invalid",
        fixture: buildFixture(),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, allowOrdinary: false }),
        ),
      },
      {
        reason: "context_invalid",
        fixture: buildFixture({ allowedLocalOnlyRestrictions: ["audio_derived"] }),
        mutate: (fixture: ReturnType<typeof buildFixture>) => replaceConsumerRegistration(
          fixture.authority,
          createReviewedConsumerRegistration({ ...fixture.registration, allowedLocalOnlyRestrictions: [] }),
        ),
      },
    ] as const;

    for (const testCase of cases) {
      const result = await runPendingAdmission(testCase.fixture, () => testCase.mutate(testCase.fixture));
      expect(result).toMatchObject({
        ok: false,
        code: "consumer_policy_refused",
        reason: testCase.reason,
        contentFree: true,
      });
    }
  });

  it("suppresses a pending callback value after expiry", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const fixture = buildFixture({ expiresAt });
    const result = await runPendingAdmission(fixture, () => {
      vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
    });

    expect(result).toMatchObject({
      ok: false,
      code: "consumer_policy_refused",
      reason: "registration_expired",
      contentFree: true,
    });
  });

  it("returns an unchanged authorized value after async admission", async () => {
    const fixture = buildFixture();
    const result = await runWithConsumerAdmission(
      fixture.authority,
      {
        principal: fixture.principal,
        operation: fixture.operation,
        tier: fixture.tier,
        targetUser: fixture.targetUser,
      },
      async () => {
        await Promise.resolve();
        return "authorized-value";
      },
    );

    expect(result).toMatchObject({
      ok: true,
      context: expect.objectContaining({ registrationRef: fixture.registration.registrationRef }),
      value: "authorized-value",
    });
  });
});
