import { describe, expect, it, vi } from "vitest";
import {
  writeCurrentSnapshotStalenessBacklog,
  writeSyntheticForcedStalenessBacklog,
  writeSyntheticScheduledStalenessBacklog,
} from "../lifecycle/semion/lock.js";
import {
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerResolvedTargetUser,
  createServerSelectedProducerOperation,
  createTrustedProducerRegistration,
  mintProcessingLineage,
  replaceProducerRegistration,
  revokeProducerRegistration,
  syntheticProducerDeliveryResolver,
} from "../app/processing-policy/authority.js";
import type { ProcessingLineageRestriction, ProcessingLineageV1 } from "../domain/memory/processing-lineage.js";

type StoredRow = Record<string, unknown>;

function sourceRow(id: string, overrides: StoredRow = {}): StoredRow {
  return {
    id,
    user_id: "user-1",
    payload_user_id: "user-1",
    scope: "user",
    payload_scope: "user",
    session_id: undefined,
    payload_session_id: undefined,
    active: true,
    inactive_at: undefined,
    inactive_reason: undefined,
    superseded_by: undefined,
    lineage_root_id: undefined,
    valid_at: undefined,
    invalid_at: undefined,
    created_at: "2026-10-02T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
    status: undefined,
    payload_active: true,
    payload_inactive_at: undefined,
    payload_inactive_reason: undefined,
    payload_superseded_by_id: undefined,
    payload_lineage_root_id: undefined,
    payload_valid_at: undefined,
    payload_invalid_at: undefined,
    payload_created_at: "2026-10-02T00:00:00.000Z",
    payload_updated_at: "2026-10-02T00:00:00.000Z",
    payload_write_source: "capture",
    payload_arbitration_outcome: undefined,
    payload_is_stale: false,
    payload_stale_since: undefined,
    payload_contradicted_by: undefined,
    payload_noema_status: undefined,
    support_semiote_ids: undefined,
    processing_lineage: undefined,
    payload_l2: "stored fact",
    payload_data: undefined,
    payload_confidence: 0.8,
    confidence: undefined,
    ...overrides,
  };
}

function captureLineage(userId = "user-1", restrictions: readonly ProcessingLineageRestriction[] = []): ProcessingLineageV1 {
  return {
    state: "minni_verified",
    origin: "minni",
    producer_principal_ref: "capture-principal",
    producer_registration_ref: "capture-registration",
    processing_policy_version: "runir.minni.local/v1",
    admitted_operation: "capture_ingest",
    target_user_id: userId,
    delivery: {
      version: "runir.minni.delivery/v1",
      disposition: restrictions.length > 0 ? "local_only" : "ordinary",
      restrictions,
    },
  };
}

function protectedSourceRow(
  id: string,
  userId = "user-1",
  supportIds: readonly string[] = [],
  restrictions: readonly ProcessingLineageRestriction[] = [],
  overrides: StoredRow = {},
): StoredRow {
  return sourceRow(id, {
    user_id: userId,
    payload_user_id: userId,
    support_semiote_ids: [...supportIds],
    processing_lineage: captureLineage(userId, restrictions),
    ...overrides,
  });
}

function protectedAuthority(operation: "scheduled_maintenance" | "forced_maintenance", userId = "user-1") {
  const principalRef = `principal.backlog.${operation}`;
  const registrationRef = `registration.backlog.${operation}`;
  const principal = createServerAuthenticatedProducerPrincipal(principalRef);
  const authority = createProducerAuthority([createTrustedProducerRegistration({
    registrationRef,
    principalRef,
    authorizedOperations: [operation],
    authorizedTargetUsers: [userId],
  })]);
  const admission = authority.resolve({
    principal,
    operation: createServerSelectedProducerOperation(operation),
    targetUser: createServerResolvedTargetUser(userId),
  });
  if (!admission.ok) throw new Error(`protected authority fixture failed: ${admission.reason}`);
  const minted = mintProcessingLineage(authority, admission.context, syntheticProducerDeliveryResolver);
  if (!minted.ok) throw new Error(`protected mint fixture failed: ${minted.reason}`);
  return { authority, minted, registrationRef };
}

function makeDb(rows: StoredRow[], options: {
  failTransaction?: boolean;
  beforeTransaction?: () => void;
} = {}) {
  const rowMap = new Map(rows.map((row) => [String(row.id), row]));
  const sameId = (left: unknown, right: unknown) => String(left).replace(/^[^:]+:/, "") === String(right).replace(/^[^:]+:/, "");
  let backlog: StoredRow | undefined;
  const query = vi.fn(async (sql: string, vars?: Record<string, unknown>) => {
    if ((sql.match(/SELECT VALUE id/g) ?? []).length > 1) {
      return sql.split(/;\s*/).filter((statement) => statement.includes("SELECT VALUE id")).map((statement) => {
        if (statement.includes("FROM type::record('semiote'")) {
          const entry = Object.entries(vars ?? {}).find(([key]) => /(?:Source|Support)\d+Id$/.test(key));
          const row = entry ? rowMap.get(String(entry[1])) : undefined;
          const expectedText = entry ? vars?.[entry[0].replace(/Id$/, "FactPayloadL2")] : undefined;
          const expectedUpdatedAt = entry ? vars?.[entry[0].replace(/Id$/, "UpdatedAt")] : undefined;
          return row
            && (expectedText === undefined || row.payload_l2 === expectedText)
            && (expectedUpdatedAt === undefined || row.updated_at === expectedUpdatedAt)
            ? [row.id]
            : [];
        }
        const id = vars?.backlogId ?? vars?.id;
        if (!backlog || !sameId(backlog.id, id)) return [];
        if (statement.includes("facts = $facts")) return [backlog.id];
        return [backlog.id];
      });
    }
    if (sql.includes("FROM type::record('semiote'")) {
      if (sql.includes("SELECT VALUE id")) {
        const ids = Object.entries(vars ?? {}).filter(([key]) => /(?:Source|Support)\d+Id$/.test(key));
        return ids.map(([key, value]) => {
          const row = rowMap.get(String(value));
          const factKey = key.replace(/Id$/, "FactPayloadL2");
          const expectedText = vars?.[factKey];
          const factMismatch = expectedText !== undefined && row?.payload_l2 !== expectedText;
          const expectedUpdatedAt = vars?.[key.replace(/Id$/, "UpdatedAt")];
          const updatedMismatch = expectedUpdatedAt !== undefined && row?.updated_at !== expectedUpdatedAt;
          return row && !factMismatch && !updatedMismatch ? [row.id] : [];
        });
      }
      const row = rowMap.get(String(vars?.id));
      return row ? [[{ ...row }]] : [[]];
    }
    if (sql.includes("FROM type::record('staleness_backlog'")) {
      if (sql.includes("SELECT VALUE id")) {
        const id = vars?.backlogId ?? vars?.id;
        return backlog && sameId(backlog.id, id) ? [[backlog.id]] : [[]];
      }
      const id = vars?.id;
      return backlog && sameId(backlog.id, id) ? [[{ ...backlog }]] : [[]];
    }
    return [[]];
  });
  const queryTransaction = vi.fn(async (_sql: string, vars: Record<string, unknown>) => {
    options.beforeTransaction?.();
    if (options.failTransaction) throw new Error("synthetic statement failure");
    backlog = {
      id: `staleness_backlog:${String(vars.backlogId)}`,
      user_id: vars.userId,
      scope: vars.scope,
      session_id: vars.sessionId,
      status: "pending",
      processing_lineage: undefined,
      triggered_at: vars.now,
    };
  });
  return { query, queryTransaction, rowMap } as any;
}

describe("generic current-snapshot staleness backlog", () => {
  it("reads only the replacement id data property and commits stored facts once", async () => {
    const db = makeDb([sourceRow("replacement-1")]);
    const carrier = { replacementMemoryId: "replacement-1", text: "caller text", confidence: 0.01 };
    const result = await writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [carrier]);
    expect(result).toMatchObject({ status: "committed" });
    expect(db.queryTransaction).toHaveBeenCalledOnce();
    const [sql, variables] = db.queryTransaction.mock.calls[0] as [string, Record<string, unknown>];
    expect(sql).toContain("payload.l2 = $source0FactPayloadL2");
    expect(sql).toContain("processing_lineage = NONE");
    expect(variables.facts).toEqual([{ text: "stored fact", confidence: 0.8, replacementMemoryId: "replacement-1" }]);
  });

  it("refuses accessor carriers without invoking their getter", async () => {
    const db = makeDb([sourceRow("replacement-1")]);
    const carrier = {} as { replacementMemoryId: string };
    Object.defineProperty(carrier, "replacementMemoryId", { get: () => { throw new Error("getter touched"); } });
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [carrier]))
      .resolves.toMatchObject({ status: "refused", reason: "invalid_input", contentFree: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects nonprimitive carrier ids without invoking nested id or toString getters", async () => {
    let getterCalls = 0;
    const nestedId = {} as Record<string, unknown>;
    Object.defineProperty(nestedId, "id", { get: () => { getterCalls += 1; return "replacement-1"; } });
    const nestedToString = {} as Record<string, unknown>;
    Object.defineProperty(nestedToString, "toString", { get: () => { getterCalls += 1; return () => "replacement-1"; } });
    for (const value of [nestedId, nestedToString, { tb: "semiote", id: "replacement-1" }, () => "replacement-1"]) {
      const db = makeDb([sourceRow("replacement-1")]);
      await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: value as never }]))
        .resolves.toMatchObject({ status: "refused", reason: "invalid_input", contentFree: true });
      expect(db.query).not.toHaveBeenCalled();
      expect(db.queryTransaction).not.toHaveBeenCalled();
    }
    expect(getterCalls).toBe(0);
  });

  it("refuses duplicate, missing, and malformed ids before any content read", async () => {
    const db = makeDb([sourceRow("replacement-1")]);
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [
      { replacementMemoryId: "replacement-1" },
      { replacementMemoryId: "replacement-1" },
    ])).resolves.toMatchObject({ status: "refused", reason: "duplicate_replacement", contentFree: true });
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: "missing" }]))
      .resolves.toMatchObject({ status: "refused", reason: "source_missing", contentFree: true });
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: "bad id" }]))
      .resolves.toMatchObject({ status: "refused", reason: "invalid_input", contentFree: true });
  });

  it("refuses any valid or invalid source lineage before content", async () => {
    const valid = sourceRow("valid", { processing_lineage: {
      state: "minni_verified",
      origin: "minni",
      producer_principal_ref: "principal",
      producer_registration_ref: "registration",
      processing_policy_version: "runir.minni.local/v1",
      admitted_operation: "capture_ingest",
      target_user_id: "user-1",
      delivery: { version: "runir.minni.delivery/v1", disposition: "ordinary", restrictions: [] },
    } });
    const invalid = sourceRow("invalid", { processing_lineage: null });
    const db = makeDb([valid, invalid]);
    for (const [id, reason] of [["valid", "source_lineage_present"], ["invalid", "source_lineage_invalid"]] as const) {
      const result = await writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: id }]);
      expect(result).toMatchObject({ status: "refused", reason, contentFree: true });
    }
    expect(db.query.mock.calls.filter(([sql]: [string]) => sql.includes("payload.l2 AS payload_l2"))).toHaveLength(0);
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("checks all source and support metadata before any fact read", async () => {
    const first = sourceRow("first", { support_semiote_ids: ["support-good"] });
    const second = sourceRow("second", { support_semiote_ids: ["support-bad"] });
    const good = sourceRow("support-good");
    const bad = sourceRow("support-bad", { processing_lineage: { unexpected: true } });
    const db = makeDb([first, second, good, bad]);
    const result = await writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [
      { replacementMemoryId: "first" },
      { replacementMemoryId: "second" },
    ]);
    expect(result).toMatchObject({ status: "refused", reason: "support_lineage_invalid", contentFree: true });
    expect(db.query.mock.calls.filter(([sql]: [string]) => sql.includes("payload.l2 AS payload_l2"))).toHaveLength(0);
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing top-level user", { user_id: undefined }, "source_user_mismatch"],
    ["missing payload user", { payload_user_id: undefined }, "source_user_mismatch"],
    ["missing top-level scope", { scope: undefined }, "source_scope_mismatch"],
    ["missing payload scope", { payload_scope: undefined }, "source_scope_mismatch"],
    ["mismatched dual user", { payload_user_id: "user-2" }, "source_user_mismatch"],
    ["mismatched dual scope", { payload_scope: "session" }, "source_scope_mismatch"],
  ] as const)("requires both current metadata bindings before facts (%s)", async (_label, overrides, reason) => {
    const db = makeDb([sourceRow("replacement-1", overrides)]);
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "refused", reason, contentFree: true });
    expect(db.query.mock.calls.filter(([sql]: [string]) => sql.includes("payload.l2 AS payload_l2"))).toHaveLength(0);
  });

  it.each([
    ["wrong user", { user_id: "user-2", payload_user_id: "user-2" }, "source_user_mismatch"],
    ["wrong scope", { scope: "session", payload_scope: "session" }, "source_scope_mismatch"],
    ["wrong session", { session_id: "other", payload_session_id: "other" }, "source_session_mismatch"],
    ["inactive branch", { active: false, payload_active: false }, "source_status_mismatch"],
    ["superseded branch", { superseded_by: "other" }, "source_branch_mismatch"],
  ] as const)("refuses %s before fact access", async (_label, overrides, reason) => {
    const db = makeDb([sourceRow("replacement-1", overrides)]);
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "refused", reason, contentFree: true });
    expect(db.query.mock.calls.filter(([sql]: [string]) => sql.includes("payload.l2 AS payload_l2"))).toHaveLength(0);
  });

  it("classifies rollback and body races content-free without retry", async () => {
    const rollback = makeDb([sourceRow("replacement-1")], { failTransaction: true });
    await expect(writeCurrentSnapshotStalenessBacklog(rollback, "user-1", "user", undefined, [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "rolled_back", contentFree: true });
    const race = makeDb([sourceRow("replacement-1")], {
      failTransaction: true,
      beforeTransaction: () => { race.rowMap.get("replacement-1")!.payload_l2 = "body changed"; },
    });
    await expect(writeCurrentSnapshotStalenessBacklog(race, "user-1", "user", undefined, [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "indeterminate", contentFree: true });
  });

  it("reconciles a committed private row after the transaction wrapper rejects", async () => {
    const db = makeDb([sourceRow("replacement-1")]);
    const original = db.queryTransaction.bind(db);
    db.queryTransaction = vi.fn(async (sql: string, vars: Record<string, unknown>) => {
      await original(sql, vars);
      throw new Error("synthetic post-commit wrapper rejection");
    });
    await expect(writeCurrentSnapshotStalenessBacklog(db, "user-1", "user", undefined, [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "committed" });
  });
});

describe("source-owned protected synthetic staleness backlog", () => {
  it.each([
    ["scheduled_maintenance", writeSyntheticScheduledStalenessBacklog],
    ["forced_maintenance", writeSyntheticForcedStalenessBacklog],
  ] as const)("commits fixed %s facts through two opaque authority gates", async (operation, writer) => {
    const fixture = protectedAuthority(operation);
    const db = makeDb([protectedSourceRow("replacement-1")]);
    const result = await writer(db, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]);
    expect(result).toMatchObject({ status: "committed" });
    expect(db.queryTransaction).toHaveBeenCalledOnce();
    const [sql, variables] = db.queryTransaction.mock.calls[0] as [string, Record<string, unknown>];
    expect(sql).toContain("processing_lineage = $source0ProcessingLineage");
    expect(sql).toContain("CREATE ONLY type::record('staleness_backlog'");
    expect(variables.facts).toEqual([{
      text: operation === "scheduled_maintenance"
        ? "Synthetic scheduled maintenance proof content."
        : "Synthetic forced maintenance proof content.",
      confidence: 0.5,
      replacementMemoryId: "replacement-1",
    }]);
    expect(db.query.mock.calls.some(([query]: [string]) => query.includes("payload.l2 AS payload_l2"))).toBe(false);
  });

  it("refuses copied, serialized, wrong-authority, wrong-operation, and wrong-user mints before SQL", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const otherUser = protectedAuthority("scheduled_maintenance", "user-2");
    const db = makeDb([protectedSourceRow("replacement-1")]);
    const forged = [
      { ...fixture.minted },
      JSON.parse(JSON.stringify(fixture.minted)),
      fixture.minted.lineage,
      JSON.parse(JSON.stringify(fixture.minted.lineage)),
    ];
    for (const minted of forged) {
      await expect(writeSyntheticScheduledStalenessBacklog(db, fixture.authority, minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
        .resolves.toMatchObject({ status: "refused", reason: "producer_policy_refused", contentFree: true });
    }
    await expect(writeSyntheticForcedStalenessBacklog(db, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "refused", reason: "producer_policy_refused", contentFree: true });
    await expect(writeSyntheticScheduledStalenessBacklog(db, otherUser.authority, otherUser.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "refused", reason: "producer_policy_refused", contentFree: true });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["scheduled_maintenance", writeSyntheticScheduledStalenessBacklog],
    ["forced_maintenance", writeSyntheticForcedStalenessBacklog],
  ] as const)("rejects nonprimitive %s carrier ids before the first authority callback", async (operation, writer) => {
    const fixture = protectedAuthority(operation);
    let getterCalls = 0;
    const nested = {} as Record<string, unknown>;
    Object.defineProperty(nested, "id", { get: () => { getterCalls += 1; return "replacement-1"; } });
    const nestedToString = {} as Record<string, unknown>;
    Object.defineProperty(nestedToString, "toString", { get: () => { getterCalls += 1; return () => "replacement-1"; } });
    for (const value of [nested, nestedToString, { tb: "semiote", id: "replacement-1" }, () => "replacement-1"]) {
      const db = makeDb([protectedSourceRow("replacement-1")]);
      await expect(writer(db, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: value as never }]))
        .resolves.toMatchObject({ status: "refused", reason: "invalid_input", contentFree: true });
      expect(db.query).not.toHaveBeenCalled();
      expect(db.queryTransaction).not.toHaveBeenCalled();
    }
    expect(getterCalls).toBe(0);
  });

  it("refuses revoked and expired registrations before any metadata read", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const db = makeDb([protectedSourceRow("replacement-1")]);
    revokeProducerRegistration(fixture.authority, fixture.registrationRef);
    await expect(writeSyntheticScheduledStalenessBacklog(db, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "refused", reason: "producer_policy_refused", contentFree: true });

    const expiredPrincipal = createServerAuthenticatedProducerPrincipal("principal.backlog.expired");
    const expiredRegistration = createTrustedProducerRegistration({
      registrationRef: "registration.backlog.expired",
      principalRef: expiredPrincipal.principalRef,
      authorizedOperations: ["scheduled_maintenance"],
      authorizedTargetUsers: ["user-1"],
    });
    const expiredAuthority = createProducerAuthority([expiredRegistration]);
    const expiredAdmission = expiredAuthority.resolve({
      principal: expiredPrincipal,
      operation: createServerSelectedProducerOperation("scheduled_maintenance"),
      targetUser: createServerResolvedTargetUser("user-1"),
    });
    if (!expiredAdmission.ok) throw new Error(`expired fixture admission failed: ${expiredAdmission.reason}`);
    const expiredMint = mintProcessingLineage(expiredAuthority, expiredAdmission.context, syntheticProducerDeliveryResolver);
    if (!expiredMint.ok) throw new Error(`expired fixture mint failed: ${expiredMint.reason}`);
    replaceProducerRegistration(expiredAuthority, createTrustedProducerRegistration({
      registrationRef: expiredRegistration.registrationRef,
      principalRef: expiredPrincipal.principalRef,
      authorizedOperations: ["scheduled_maintenance"],
      authorizedTargetUsers: ["user-1"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    }));
    await expect(writeSyntheticScheduledStalenessBacklog(db, expiredAuthority, expiredMint, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "refused", reason: "producer_policy_refused", contentFree: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rechecks revocation after all metadata and collision reads before transaction", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const db = makeDb([protectedSourceRow("replacement-1")]);
    const originalQuery = db.query.bind(db);
    db.query = vi.fn(async (sql: string, vars?: Record<string, unknown>) => {
      const result = await originalQuery(sql, vars);
      if (sql.includes("FROM type::record('staleness_backlog'") && sql.includes("SELECT VALUE id")) {
        revokeProducerRegistration(fixture.authority, fixture.registrationRef);
      }
      return result;
    });
    const result = await writeSyntheticScheduledStalenessBacklog(db, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]);
    expect(result).toMatchObject({ status: "refused", reason: "producer_policy_refused", contentFree: true });
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("joins only current capture lineages and refuses invalid support metadata before facts", async () => {
    const fixture = protectedAuthority("forced_maintenance");
    const source = protectedSourceRow("source-1", "user-1", ["support-1"], ["audio_derived"]);
    const support = protectedSourceRow("support-1", "user-1", [], ["excluded_source"]);
    const db = makeDb([source, support]);
    const result = await writeSyntheticForcedStalenessBacklog(db, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "source-1" }]);
    expect(result.status).toBe("committed");
    expect(db.query.mock.calls.some(([query]: [string]) => query.includes("payload.l2 AS payload_l2"))).toBe(false);

    const invalid = makeDb([source, protectedSourceRow("support-1", "user-1", [], [], { processing_lineage: { forged: true } })]);
    await expect(writeSyntheticForcedStalenessBacklog(invalid, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "source-1" }]))
      .resolves.toMatchObject({ status: "refused", reason: "support_lineage_invalid", contentFree: true });
    expect(invalid.queryTransaction).not.toHaveBeenCalled();
  });

  it("uses truthful metadata-only outcomes for rollback, body races, and post-commit wrapper errors", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const rollback = makeDb([protectedSourceRow("replacement-1")], { failTransaction: true });
    await expect(writeSyntheticScheduledStalenessBacklog(rollback, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "rolled_back", contentFree: true });

    const raced = makeDb([protectedSourceRow("replacement-1")], {
      failTransaction: true,
      beforeTransaction: () => { raced.rowMap.get("replacement-1")!.updated_at = "2026-10-02T00:00:00.000000001Z"; },
    });
    await expect(writeSyntheticScheduledStalenessBacklog(raced, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "indeterminate", contentFree: true });

    const postCommit = makeDb([protectedSourceRow("replacement-1")]);
    const originalTransaction = postCommit.queryTransaction.bind(postCommit);
    postCommit.queryTransaction = vi.fn(async (sql: string, vars: Record<string, unknown>) => {
      await originalTransaction(sql, vars);
      throw new Error("synthetic post-commit wrapper rejection");
    });
    await expect(writeSyntheticScheduledStalenessBacklog(postCommit, fixture.authority, fixture.minted, "user-1", [{ replacementMemoryId: "replacement-1" }]))
      .resolves.toMatchObject({ status: "committed" });
  });
});
