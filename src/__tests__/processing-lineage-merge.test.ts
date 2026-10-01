import { describe, expect, it, vi } from "vitest";
import {
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerResolvedTargetUser,
  createServerSelectedProducerOperation,
  createTrustedProducerRegistration,
  mintProcessingLineage,
  revokeProducerRegistration,
  syntheticProducerDeliveryResolver,
} from "../app/processing-policy/authority.js";
import {
  findSimilarMemories,
  mergeMemoryWithProcessingLineage,
  updateMemoryText,
} from "../storage/surreal/surreal-store.js";
import { PROCESSING_LINEAGE_VERSION, type ProcessingLineageV1 } from "../domain/memory/processing-lineage.js";

const EMBEDDING = [0.1, 0.2, 0.3];

function admitted(operation: "capture_ingest" | "scheduled_maintenance" | "forced_maintenance" = "capture_ingest") {
  const principal = createServerAuthenticatedProducerPrincipal("principal.merge-test");
  const targetUser = createServerResolvedTargetUser("user.merge-test");
  const authority = createProducerAuthority([
    createTrustedProducerRegistration({
      registrationRef: "registration.merge-test",
      principalRef: principal.principalRef,
      authorizedOperations: [operation],
      authorizedTargetUsers: [targetUser.userId],
    }),
  ]);
  const selected = createServerSelectedProducerOperation(operation);
  const admission = authority.resolve({ principal, operation: selected, targetUser });
  if (!admission.ok) throw new Error(`fixture admission failed: ${admission.reason}`);
  const evidence = syntheticProducerDeliveryResolver.resolve(authority, admission.context);
  if ("ok" in evidence && evidence.ok === false) throw new Error(`fixture evidence failed: ${evidence.reason}`);
  const minted = mintProcessingLineage(authority, admission.context, evidence);
  if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
  return { authority, targetUser, minted };
}

function storedLineage(
  lineage: ProcessingLineageV1,
  overrides: Partial<ProcessingLineageV1> = {},
): ProcessingLineageV1 {
  return {
    ...lineage,
    ...overrides,
    delivery: {
      ...lineage.delivery,
      ...overrides.delivery,
    },
  };
}

function mergeInput(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "known-protected",
    userId,
    newText: "merged protected text",
    embedding: EMBEDDING,
    writeSource: "session_summary" as const,
    atomicFactAction: "retain" as const,
    continuityMetadata: { memoryRole: "recent_work" as const, continuitySubjectKey: "subject.merge" },
    ...overrides,
  };
}

describe("Sourceb-B protected merge and generic containment", () => {
  it("preflights only identity and lineage, joins restrictions monotonically, then writes one CAS transaction", async () => {
    const fixture = admitted();
    const stored = storedLineage(fixture.minted.lineage, {
      delivery: {
        version: PROCESSING_LINEAGE_VERSION,
        disposition: "local_only",
        restrictions: ["producer_local_only", "audio_derived"],
      },
    });
    const db = {
      query: vi.fn().mockResolvedValue([[
        { id: "semiote:known-protected", user_id: fixture.targetUser.userId, processing_lineage: stored },
      ]]),
      queryTransaction: vi.fn().mockResolvedValue(undefined),
    } as any;

    await mergeMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, mergeInput(fixture.targetUser.userId));

    expect(db.query).toHaveBeenCalledTimes(1);
    const preflightSQL = db.query.mock.calls[0][0] as string;
    expect(preflightSQL).toContain("SELECT id, user_id, processing_lineage");
    expect(preflightSQL).not.toContain("payload");
    expect(preflightSQL).not.toContain("l2");
    expect(preflightSQL).not.toContain("embedding");
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    const [transactionSQL, transactionVars] = db.queryTransaction.mock.calls[0];
    expect(transactionSQL).toContain("processing_lineage = $mergedProcessingLineage");
    expect(transactionSQL).toContain("processing_lineage = $expectedProcessingLineage");
    expect(transactionSQL).toContain("RETURN VALUE id");
    expect(transactionSQL).toContain("array::len($mergeRows) != 1");
    expect(transactionVars.expectedProcessingLineage).toEqual(stored);
    expect(transactionVars.mergedProcessingLineage.delivery).toEqual({
      version: PROCESSING_LINEAGE_VERSION,
      disposition: "local_only",
      restrictions: ["audio_derived", "producer_local_only"],
    });
  });

  it("preserves ordinary and every stored restriction reason without downgrade", async () => {
    const cases = [
      [],
      ["audio_derived"],
      ["excluded_source"],
      ["producer_local_only"],
      ["audio_derived", "excluded_source", "producer_local_only"],
    ] as const;
    for (const restrictions of cases) {
      const fixture = admitted();
      const stored = storedLineage(fixture.minted.lineage, {
        delivery: {
          version: PROCESSING_LINEAGE_VERSION,
          disposition: restrictions.length > 0 ? "local_only" : "ordinary",
          restrictions,
        },
      });
      const db = {
        query: vi.fn().mockResolvedValue([[{
          id: "known-protected",
          user_id: fixture.targetUser.userId,
          processing_lineage: stored,
        }]]),
        queryTransaction: vi.fn().mockResolvedValue(undefined),
      } as any;
      await mergeMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, mergeInput(fixture.targetUser.userId));
      const [, transactionVars] = db.queryTransaction.mock.calls[0];
      expect(transactionVars.mergedProcessingLineage.delivery.restrictions).toEqual([...restrictions]);
    }
  });

  it("refuses missing, invalid, legacy, mixed, and wrong-user rows without a transaction", async () => {
    const cases: Array<{ label: string; row: unknown; expectedUser?: string }> = [
      { label: "missing", row: undefined },
      { label: "legacy", row: { id: "known-protected", user_id: "user.merge-test" } },
      { label: "invalid", row: { id: "known-protected", user_id: "user.merge-test", processing_lineage: { forged: true } } },
      { label: "wrong-user", row: { id: "known-protected", user_id: "other-user", processing_lineage: admitted().minted.lineage } },
    ];

    for (const testCase of cases) {
      const fixture = admitted();
      const db = {
        query: vi.fn().mockResolvedValue([testCase.row === undefined ? [] : [testCase.row]]),
        queryTransaction: vi.fn().mockResolvedValue(undefined),
      } as any;
      await expect(mergeMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, mergeInput(fixture.targetUser.userId)))
        .rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });
      expect(db.queryTransaction).not.toHaveBeenCalled();
    }
  });

  it("refuses every compatibility mismatch before SQL mutation", async () => {
    const variants: Array<{ label: string; mutate: (lineage: ProcessingLineageV1) => ProcessingLineageV1 }> = [
      { label: "principal", mutate: (lineage) => storedLineage(lineage, { producer_principal_ref: "principal.other" as never }) },
      { label: "registration", mutate: (lineage) => storedLineage(lineage, { producer_registration_ref: "registration.other" as never }) },
      { label: "operation", mutate: (lineage) => storedLineage(lineage, { admitted_operation: "forced_maintenance" }) },
      { label: "policy", mutate: (lineage) => storedLineage(lineage, { processing_policy_version: "runir.other/v1" as never }) },
    ];

    for (const variant of variants) {
      const fixture = admitted();
      const db = {
        query: vi.fn().mockResolvedValue([[
          { id: "known-protected", user_id: fixture.targetUser.userId, processing_lineage: variant.mutate(fixture.minted.lineage) },
        ]]),
        queryTransaction: vi.fn().mockResolvedValue(undefined),
      } as any;
      await expect(mergeMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, mergeInput(fixture.targetUser.userId)))
        .rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });
      expect(db.queryTransaction).not.toHaveBeenCalled();
    }
  });

  it("rejects forged mint input before preflight and rejects a revoked authority between preflight and transaction", async () => {
    const fixture = admitted();
    const copied = { ...fixture.minted };
    const db = {
      query: vi.fn().mockResolvedValue([[{
        id: "known-protected",
        user_id: fixture.targetUser.userId,
        processing_lineage: fixture.minted.lineage,
      }]]),
      queryTransaction: vi.fn().mockResolvedValue(undefined),
    } as any;

    await expect(mergeMemoryWithProcessingLineage(db, fixture.authority, copied, mergeInput(fixture.targetUser.userId)))
      .rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });
    expect(db.query).not.toHaveBeenCalled();

    db.query.mockImplementationOnce(async () => {
      revokeProducerRegistration(fixture.authority, "registration.merge-test");
      return [[{ id: "known-protected", user_id: fixture.targetUser.userId, processing_lineage: fixture.minted.lineage }]];
    });
    await expect(mergeMemoryWithProcessingLineage(db, fixture.authority, fixture.minted, mergeInput(fixture.targetUser.userId)))
      .rejects.toMatchObject({ reason: "registration_revoked", contentFree: true });
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("keeps generic candidate and update paths absent-lineage-only", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([[]]),
    } as any;
    await findSimilarMemories(db, "user.merge-test", EMBEDDING, 24, 10);
    const candidateSQL = db.query.mock.calls[0][0] as string;
    expect(candidateSQL).toContain("AND processing_lineage = NONE");
    await updateMemoryText(db, "legacy-id", "legacy update", EMBEDDING, "session_summary", "clear");
    const updateSQL = db.query.mock.calls[1][0] as string;
    expect(updateSQL).toContain("WHERE processing_lineage = NONE");
    expect(updateSQL).toContain("RETURN VALUE id");
    expect(updateSQL).toContain("payload.atomicFact = NONE");
  });
});
