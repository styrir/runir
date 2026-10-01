import { describe, expect, it, vi } from "vitest";
import {
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerResolvedTargetUser,
  createServerSelectedProducerOperation,
  createTrustedProducerRegistration,
  mintProcessingLineage,
  replaceProducerRegistration,
  runWithMintedProcessingLineage,
  syntheticProducerDeliveryResolver,
} from "../app/processing-policy/authority.js";
import {
  composeUpsertMemory,
  createMemoryWithProcessingLineage,
} from "../storage/surreal/surreal-store.js";

const EMBEDDING = [0.1, 0.2, 0.3];

function admitted() {
  const principal = createServerAuthenticatedProducerPrincipal("principal.create-test");
  const targetUser = createServerResolvedTargetUser("user.create-test");
  const authority = createProducerAuthority([
    createTrustedProducerRegistration({
      registrationRef: "registration.create-test",
      principalRef: principal.principalRef,
      authorizedOperations: ["capture_ingest"],
      authorizedTargetUsers: [targetUser.userId],
    }),
  ]);
  const operation = createServerSelectedProducerOperation("capture_ingest");
  const admission = authority.resolve({ principal, operation, targetUser });
  if (!admission.ok) throw new Error(`fixture admission failed: ${admission.reason}`);
  const evidence = syntheticProducerDeliveryResolver.resolve(authority, admission.context);
  if ("ok" in evidence && evidence.ok === false) throw new Error(`fixture evidence failed: ${evidence.reason}`);
  const minted = mintProcessingLineage(authority, admission.context, evidence);
  if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
  return { authority, principal, targetUser, minted };
}

describe("Sourceb-A exact minted binding", () => {
  it("runs the protected callback only for the exact mint object", async () => {
    const fixture = admitted();
    const calls: unknown[] = [];

    const accepted = await runWithMintedProcessingLineage(
      fixture.authority,
      fixture.minted,
      (lineage, context) => {
        calls.push({ lineage, context });
        return "accepted";
      },
      { targetUserId: fixture.targetUser.userId },
    );
    expect(accepted).toMatchObject({ ok: true, value: "accepted" });
    expect(calls).toHaveLength(1);

    for (const copied of [
      { ...fixture.minted },
      JSON.parse(JSON.stringify(fixture.minted)),
      fixture.minted.lineage,
      JSON.parse(JSON.stringify(fixture.minted.lineage)),
    ]) {
      const refused = await runWithMintedProcessingLineage(
        fixture.authority,
        copied,
        () => {
          calls.push("forged");
          return "must-not-run";
        },
      );
      expect(refused).toMatchObject({ ok: false, contentFree: true });
    }
    expect(calls).toHaveLength(1);
  });

  it("rechecks current registration grants at the write seam", async () => {
    const fixture = admitted();
    replaceProducerRegistration(fixture.authority, createTrustedProducerRegistration({
      registrationRef: "registration.create-test",
      principalRef: fixture.principal.principalRef,
      authorizedOperations: ["scheduled_maintenance"],
      authorizedTargetUsers: [fixture.targetUser.userId],
    }));

    const callback = vi.fn();
    const refused = await runWithMintedProcessingLineage(fixture.authority, fixture.minted, callback);
    expect(refused).toMatchObject({ ok: false, reason: "operation_not_authorized", contentFree: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps metadata lineage out of generic payloads and protects canonical writer facts", async () => {
    const fixture = admitted();
    const generic = composeUpsertMemory(
      "legacy-id",
      "legacy text",
      "user.create-test",
      EMBEDDING,
      { processing_lineage: { forged: true }, tags: ["synthetic"] },
      "user",
      undefined,
      { active: true },
      "semiote",
    );
    expect(generic.statement).toContain("UPSERT type::record('semiote', $recordId) CONTENT");
    expect(generic.statement).toContain("WHERE processing_lineage = NONE");
    expect(generic.vars.payload).not.toHaveProperty("processing_lineage");

    const db = { queryTransaction: vi.fn().mockResolvedValue(undefined) } as any;
    await createMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, {
      id: "protected-id",
      text: "protected text",
      userId: fixture.targetUser.userId,
      embedding: EMBEDDING,
      scope: "user",
      sessionId: "session.authoritative",
      lifecycle: { active: true, inactiveReason: undefined, supersededById: undefined, supersedesId: undefined, lineageRootId: "root.authoritative" },
      metadata: {
        processing_lineage: { forged: true },
        l2: "forged text",
        userId: "forged-user",
        scope: "global",
        sessionId: "forged-session",
        active: false,
        inactiveReason: "forged",
        supersededById: "forged-successor",
        supersedesId: "forged-predecessor",
        lineageRootId: "forged-root",
        tags: ["synthetic"],
      },
    });
    const [protectedSQL, protectedVars] = db.queryTransaction.mock.calls[0];
    expect(protectedSQL).toContain("CREATE ONLY type::record('semiote', $recordId) CONTENT");
    expect(protectedSQL).toContain("processing_lineage: $processingLineage");
    expect(protectedVars.processingLineage).toEqual(fixture.minted.lineage);
    expect(protectedVars.payload).toMatchObject({
      l2: "protected text",
      userId: fixture.targetUser.userId,
      scope: "user",
      sessionId: "session.authoritative",
      active: true,
      lineageRootId: "root.authoritative",
      tags: ["synthetic"],
    });
    expect(protectedVars.payload).not.toHaveProperty("processing_lineage");
  });

  it("refuses forged storage inputs before queryTransaction and accepts the exact mint", async () => {
    const fixture = admitted();
    const db = { queryTransaction: vi.fn().mockResolvedValue(undefined) } as any;
    await expect(createMemoryWithProcessingLineage(db, fixture.authority, { ...fixture.minted }, {
      id: "protected-id",
      text: "protected text",
      userId: fixture.targetUser.userId,
      embedding: EMBEDDING,
    })).rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });
    expect(db.queryTransaction).not.toHaveBeenCalled();

    await expect(createMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, {
      id: "protected-id",
      text: "protected text",
      userId: fixture.targetUser.userId,
      embedding: EMBEDDING,
    })).resolves.toBe("protected-id");
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    expect(db.queryTransaction.mock.calls[0][0]).toContain("CREATE ONLY");
  });
});
