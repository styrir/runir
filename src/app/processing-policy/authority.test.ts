import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTrustedProcessingPolicyContext,
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerSelectedProducerOperation,
  createServerResolvedTargetUser,
  createTrustedProducerRegistration,
  productionProducerAuthority,
  removeProducerRegistration,
  replaceProducerRegistration,
  revokeProducerRegistration,
  runWithProducerAdmission,
  type ProducerAdmissionInput,
} from "./authority.js";

afterEach(() => {
  vi.useRealTimers();
});

function buildFixture() {
  const principal = createServerAuthenticatedProducerPrincipal("synthetic-minni-producer");
  const targetUser = createServerResolvedTargetUser("owner");
  const registration = createTrustedProducerRegistration({
    registrationRef: "synthetic-registration",
    principalRef: principal.principalRef,
    authorizedOperations: ["capture_ingest"],
    authorizedTargetUsers: [targetUser.userId],
  });
  return {
    principal,
    targetUser,
    registration,
    authority: createProducerAuthority([registration]),
  };
}

describe("internal Minni producer authority", () => {
  it("refuses with a content-free result before the protected callback when production registry is empty", async () => {
    const principal = createServerAuthenticatedProducerPrincipal("unregistered-producer");
    const targetUser = createServerResolvedTargetUser("owner");
    let callbackCalls = 0;

    const result = await runWithProducerAdmission(
      productionProducerAuthority,
      { principal, operation: createServerSelectedProducerOperation("capture_ingest"), targetUser },
      () => {
        callbackCalls += 1;
        return "must-not-run";
      },
    );

    expect(result).toEqual({
      ok: false,
      code: "producer_policy_refused",
      reason: "registration_missing",
      contentFree: true,
    });
    expect(callbackCalls).toBe(0);
  });

  it("binds the context to the authenticated principal, server operation, and target user", async () => {
    const fixture = buildFixture();
    const result = await runWithProducerAdmission(
      fixture.authority,
      {
        principal: fixture.principal,
        operation: createServerSelectedProducerOperation("capture_ingest"),
        targetUser: fixture.targetUser,
        requestedUserId: "owner",
      },
      (context) => context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      principalRef: fixture.principal.principalRef,
      registrationRef: fixture.registration.registrationRef,
      origin: "minni",
      policyVersion: "runir.minni.local/v1",
      operation: "capture_ingest",
      targetUserId: "owner",
      mode: "local-only",
      lineageState: "minni_verified",
    });
    expect(result.context).toBe(result.value);
  });

  it("does not let a requested body user widen the server target binding", () => {
    const fixture = buildFixture();
    const result = fixture.authority.resolve({
      principal: fixture.principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: fixture.targetUser,
      requestedUserId: "other-user",
    });

    expect(result).toEqual({
      ok: false,
      code: "producer_policy_refused",
      reason: "requested_user_mismatch",
      contentFree: true,
    });
  });

  it("rejects unmarked caller-shaped principal and target values", () => {
    const fixture = buildFixture();
    const unmarkedPrincipal = { principalRef: fixture.principal.principalRef, authenticatedBy: "server" };
    const unmarkedTarget = { userId: fixture.targetUser.userId };

    expect(fixture.authority.resolve({
      principal: unmarkedPrincipal as unknown as ProducerAdmissionInput["principal"],
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: fixture.targetUser,
    })).toMatchObject({ ok: false, reason: "principal_untrusted", contentFree: true });
    expect(fixture.authority.resolve({
      principal: fixture.principal,
      operation: "capture_ingest",
      targetUser: unmarkedTarget as unknown as ProducerAdmissionInput["targetUser"],
    })).toMatchObject({ ok: false, reason: "target_user_untrusted", contentFree: true });
  });

  it("refuses revoked, expired, cross-user, and unauthorized-operation registrations", () => {
    const principal = createServerAuthenticatedProducerPrincipal("producer-under-test");
    const targetUser = createServerResolvedTargetUser("owner");
    const cases = [
      {
        reason: "registration_revoked",
        registration: createTrustedProducerRegistration({
          registrationRef: "revoked",
          principalRef: principal.principalRef,
          authorizedOperations: ["capture_ingest"],
          authorizedTargetUsers: [targetUser.userId],
          status: "revoked",
        }),
        operation: createServerSelectedProducerOperation("capture_ingest"),
        targetUser,
      },
      {
        reason: "registration_expired",
        registration: createTrustedProducerRegistration({
          registrationRef: "expired",
          principalRef: principal.principalRef,
          authorizedOperations: ["capture_ingest"],
          authorizedTargetUsers: [targetUser.userId],
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
        operation: createServerSelectedProducerOperation("capture_ingest"),
        targetUser,
      },
      {
        reason: "target_user_not_authorized",
        registration: createTrustedProducerRegistration({
          registrationRef: "cross-user",
          principalRef: principal.principalRef,
          authorizedOperations: ["capture_ingest"],
          authorizedTargetUsers: ["another-user"],
        }),
        operation: createServerSelectedProducerOperation("capture_ingest"),
        targetUser,
      },
      {
        reason: "operation_not_authorized",
        registration: createTrustedProducerRegistration({
          registrationRef: "operation",
          principalRef: principal.principalRef,
          authorizedOperations: ["capture_ingest"],
          authorizedTargetUsers: [targetUser.userId],
        }),
        operation: createServerSelectedProducerOperation("forced_maintenance"),
        targetUser,
      },
    ] as const;

    for (const testCase of cases) {
      const result = createProducerAuthority([testCase.registration]).resolve({
        principal,
        operation: testCase.operation,
        targetUser: testCase.targetUser,
      });
      expect(result).toMatchObject({ ok: false, reason: testCase.reason, contentFree: true });
    }
  });

  it("keeps caller labels out of the context and refuses an untrusted operation", () => {
    const fixture = buildFixture();
    const result = fixture.authority.resolve({
      principal: fixture.principal,
      operation: "untrusted-operation",
      targetUser: fixture.targetUser,
      requestedUserId: "owner",
      // Deliberately caller-shaped metadata. The authority has no input slots
      // for client/origin/policy/locality/tier and cannot use these labels.
      client: "minni",
      origin: "minni",
      policy: "local-only",
      locality: "local",
      tier: "trusted",
    } as unknown as ProducerAdmissionInput);

    expect(result).toEqual({
      ok: false,
      code: "producer_policy_refused",
      reason: "operation_untrusted",
      contentFree: true,
    });
  });

  it("rejects inherited, descriptor-forged, spread, and JSON-built processing contexts", () => {
    const fixture = buildFixture();
    const admission = fixture.authority.resolve({
      principal: fixture.principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: fixture.targetUser,
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    const inherited = Object.create(admission.context) as Record<string, unknown>;
    const descriptorForged = Object.create(admission.context) as Record<string, unknown>;
    Object.defineProperty(descriptorForged, "targetUserId", { configurable: true, value: "other-user" });
    const forgeries: unknown[] = [
      inherited,
      descriptorForged,
      { ...admission.context },
      JSON.parse(JSON.stringify(admission.context)),
    ];

    for (const forgery of forgeries) {
      expect(() => assertTrustedProcessingPolicyContext(forgery))
        .toThrowError(expect.objectContaining({
          code: "producer_policy_refused",
          reason: "context_invalid",
          contentFree: true,
        }));
    }
    expect(() => assertTrustedProcessingPolicyContext(admission.context)).not.toThrow();
  });

  it("revalidates the current registration after minting", () => {
    const revokedFixture = buildFixture();
    const revokedAdmission = revokedFixture.authority.resolve({
      principal: revokedFixture.principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: revokedFixture.targetUser,
    });
    expect(revokedAdmission.ok).toBe(true);
    if (!revokedAdmission.ok) return;
    revokeProducerRegistration(revokedFixture.authority, revokedFixture.registration.registrationRef);
    expect(() => assertTrustedProcessingPolicyContext(revokedAdmission.context))
      .toThrowError(expect.objectContaining({ reason: "registration_revoked", contentFree: true }));

    const staleFixture = buildFixture();
    const staleAdmission = staleFixture.authority.resolve({
      principal: staleFixture.principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: staleFixture.targetUser,
    });
    expect(staleAdmission.ok).toBe(true);
    if (!staleAdmission.ok) return;
    removeProducerRegistration(staleFixture.authority, staleFixture.registration.registrationRef);
    expect(() => assertTrustedProcessingPolicyContext(staleAdmission.context))
      .toThrowError(expect.objectContaining({ reason: "registration_missing", contentFree: true }));

    const operationFixture = buildFixture();
    const operationAdmission = operationFixture.authority.resolve({
      principal: operationFixture.principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: operationFixture.targetUser,
    });
    expect(operationAdmission.ok).toBe(true);
    if (!operationAdmission.ok) return;
    replaceProducerRegistration(operationFixture.authority, createTrustedProducerRegistration({
      registrationRef: operationFixture.registration.registrationRef,
      principalRef: operationFixture.principal.principalRef,
      authorizedOperations: ["scheduled_maintenance"],
      authorizedTargetUsers: [operationFixture.targetUser.userId],
    }));
    expect(() => assertTrustedProcessingPolicyContext(operationAdmission.context))
      .toThrowError(expect.objectContaining({ reason: "operation_not_authorized", contentFree: true }));

    const userFixture = buildFixture();
    const userAdmission = userFixture.authority.resolve({
      principal: userFixture.principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser: userFixture.targetUser,
    });
    expect(userAdmission.ok).toBe(true);
    if (!userAdmission.ok) return;
    replaceProducerRegistration(userFixture.authority, createTrustedProducerRegistration({
      registrationRef: userFixture.registration.registrationRef,
      principalRef: userFixture.principal.principalRef,
      authorizedOperations: ["capture_ingest"],
      authorizedTargetUsers: ["other-user"],
    }));
    expect(() => assertTrustedProcessingPolicyContext(userAdmission.context))
      .toThrowError(expect.objectContaining({ reason: "target_user_not_authorized", contentFree: true }));
  });

  it("revalidates expiry after a context has been minted", () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const principal = createServerAuthenticatedProducerPrincipal("expiring-producer");
    const targetUser = createServerResolvedTargetUser("owner");
    const registration = createTrustedProducerRegistration({
      registrationRef: "expiring-registration",
      principalRef: principal.principalRef,
      authorizedOperations: ["capture_ingest"],
      authorizedTargetUsers: [targetUser.userId],
      expiresAt,
    });
    const authority = createProducerAuthority([registration]);
    const admission = authority.resolve({
      principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser,
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
    expect(() => assertTrustedProcessingPolicyContext(admission.context))
      .toThrowError(expect.objectContaining({ reason: "registration_expired", contentFree: true }));
  });
});
