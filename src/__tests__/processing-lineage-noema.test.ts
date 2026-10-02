import { describe, expect, it, vi } from "vitest";
import { DateTime } from "surrealdb";
import { promoteSemioteToNoema } from "../storage/surreal/phase2-store.js";

type Row = Record<string, unknown>;

function sourceRow(overrides: Row = {}): Row {
  return {
    id: "semiote:atomic-source",
    user_id: "atomic-user",
    active: true,
    scope: "user",
    path: "/synthetic/atomic",
    memory_role: "current_status",
    updated_at: "source-version-1",
    payload: {
      l2: "The atomic source is eligible for a synthetic Noema promotion.",
      l0: "Atomic source eligible",
      category: "cases",
      factKey: "cases:atomic-promotion",
      continuitySubjectKey: "atomic-source",
      claimPredicate: "is",
      confidence: 0.95,
    },
    usefulness_score: 0.84,
    successful_use_count: 3,
    cross_session_use_count: 2,
    contradiction_count: 0,
    ...overrides,
  };
}

function sourceMetadata(row: Row, overrides: Row = {}): Row {
  const payload = row.payload as Row;
  return {
    id: row.id,
    user_id: row.user_id,
    processing_lineage: undefined,
    active: row.active,
    supersedes: row.supersedes,
    superseded_by: row.superseded_by,
    lineage_root_id: row.lineage_root_id,
    inactive_at: row.inactive_at,
    inactive_reason: row.inactive_reason,
    supersede_provenance: row.supersede_provenance,
    updated_at: row.updated_at,
    payload_user_id: payload.userId,
    payload_active: payload.active,
    payload_inactive_at: payload.inactiveAt,
    payload_inactive_reason: payload.inactiveReason,
    payload_superseded_by_id: payload.supersededById,
    payload_supersedes_id: payload.supersedesId,
    payload_lineage_root_id: payload.lineageRootId,
    payload_supersede_provenance: payload.supersede_provenance,
    payload_updated_at: payload.updatedAt,
    payload_write_source: payload.writeSource,
    payload_arbitration_outcome: payload.arbitrationOutcome,
    payload_is_stale: payload.isStale,
    payload_stale_since: payload.staleSince,
    payload_contradicted_by: payload.contradictedBy,
    ...overrides,
  };
}

type PromotionDbOptions = {
  target?: Row;
  transaction?: (sql: string, variables: Row) => Promise<void>;
  readbackTarget?: Row;
  readbackSource?: Row;
};

function promotionDb(row: Row, options: PromotionDbOptions = {}) {
  const metadata = sourceMetadata(row);
  const target = options.target;
  let transactionStarted = false;
  const query = vi.fn().mockImplementation((sql: string, variables: Row = {}) => {
    if (sql.includes("FROM type::record('noema'")) {
      return Promise.resolve(options.readbackTarget !== undefined
        ? (options.readbackTarget ? [[options.readbackTarget]] : [[]])
        : (target ? [[target]] : [[]]));
    }
    if (sql.includes("AS promoted_to_noema_id")) {
      return Promise.resolve(options.readbackSource ? [[options.readbackSource]] : [[]]);
    }
    if (sql.includes("SELECT id, user_id") && sql.includes("FROM type::record('semiote'")) {
      const requestedId = typeof variables.id === "string" ? variables.id : undefined;
      const metadataId = typeof metadata.id === "string" ? metadata.id.replace(/^semiote:/, "") : undefined;
      return Promise.resolve([[requestedId && requestedId !== metadataId ? { ...metadata, id: `semiote:${requestedId}` } : metadata]]);
    }
    if (sql.includes("SELECT * FROM type::record('semiote'")) return Promise.resolve([[row]]);
    if (sql.includes("FROM type::record('semiote'")) return Promise.resolve([[metadata]]);
    return Promise.resolve([[]]);
  });
  const queryTransaction = vi.fn().mockImplementation(async (sql: string, variables: Row) => {
    transactionStarted = true;
    if (options.transaction) return options.transaction(sql, variables);
  });
  return {
    query,
    queryTransaction,
    transactionStarted: () => transactionStarted,
  } as any;
}

function dateTimePlusNanosecond(value: unknown): DateTime {
  const timestamp = value instanceof DateTime ? value : new DateTime(String(value));
  return DateTime.fromEpochNanoseconds(timestamp.nanoseconds + 1n);
}

function noEffectReadbackDb(
  row: Row,
  targetBefore: Row,
  churn: "source" | "target" | "both",
) {
  const metadata = sourceMetadata(row);
  let transactionFailed = false;
  let targetAfter: Row | undefined;
  let sourceAfter: Row | undefined;
  const query = vi.fn().mockImplementation((sql: string, _variables: Row = {}) => {
    if (sql.includes("FROM type::record('noema'")) {
      return Promise.resolve([[transactionFailed ? targetAfter : targetBefore]]);
    }
    if (sql.includes("AS promoted_to_noema_id")) {
      return Promise.resolve([[sourceAfter]]);
    }
    if (sql.includes("SELECT id, user_id") && sql.includes("FROM type::record('semiote'")) {
      return Promise.resolve([[metadata]]);
    }
    if (sql.includes("SELECT * FROM type::record('semiote'")) return Promise.resolve([[row]]);
    if (sql.includes("FROM type::record('semiote'")) return Promise.resolve([[metadata]]);
    return Promise.resolve([[]]);
  });
  const queryTransaction = vi.fn().mockImplementation(async (_sql: string, variables: Row) => {
    transactionFailed = true;
    const expected = variables.now;
    const unrelated = dateTimePlusNanosecond(expected);
    targetAfter = {
      ...targetBefore,
      updated_at: churn === "target" || churn === "both" ? unrelated : expected,
    };
    sourceAfter = {
      id: row.id,
      user_id: row.user_id,
      processing_lineage: undefined,
      updated_at: churn === "source" || churn === "both" ? unrelated : expected,
      promoted_to_noema_id: variables.noemaRecordId,
      noema_support_semiote_ids: variables.supportSemioteIds,
      noema_claim_key: variables.claimKey,
      noema_revision_hash: variables.revisionHash,
      noema_status: variables.status,
      noema_stable_claim: variables.stableClaim,
    };
    throw new Error("synthetic no-effect transaction error");
  });
  return { query, queryTransaction } as any;
}

describe("Sourcec-N2 atomic Noema promotion", () => {
  it("uses one transaction for a collision-safe create and source marker CAS", async () => {
    const row = sourceRow();
    const db = promotionDb(row);
    const result = await promoteSemioteToNoema(db, "atomic-source");

    expect(result.promoted).toBe(true);
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    const [sql, variables] = db.queryTransaction.mock.calls[0] as [string, Row];
    expect(sql).toContain("CREATE ONLY type::record('noema', $noemaId)");
    expect(sql).toContain("UPDATE type::record('semiote', $sourceId)");
    expect(sql).toContain("RETURN VALUE [id]");
    expect(sql).toContain("semiote promotion marker compare-and-set failed");
    expect(sql).toContain("noema create affected unexpected rows");
    expect(variables).toMatchObject({
      sourceId: "atomic-source",
      expectedSourceRawText: "The atomic source is eligible for a synthetic Noema promotion.",
      expectedSourceScope: "user",
      expectedSourcePath: "/synthetic/atomic",
      expectedSourceMemoryRole: "current_status",
      expectedSourceFactKey: "cases:atomic-promotion",
      expectedSourceClaimPredicate: "is",
      expectedSourceUsefulnessScore: 0.84,
    });
    expect(db.query.mock.calls.slice(3).some(([statement]: [string]) =>
      /\b(CREATE|UPDATE)\b/.test(statement))).toBe(false);
  });

  it("reinforces an existing unlineaged target inside the same transaction", async () => {
    const row = sourceRow();
    const target = {
      id: "noema:existing-target",
      user_id: "atomic-user",
      processing_lineage: undefined,
      status: "superseded",
      claim_key: "legacy-claim",
      revision_hash: "legacy-revision",
      support_semiote_ids: ["legacy-source"],
      active: false,
      updated_at: "noema-version-1",
    };
    const db = promotionDb(row, { target });
    await promoteSemioteToNoema(db, "atomic-source");

    const [sql, variables] = db.queryTransaction.mock.calls[0] as [string, Row];
    expect(sql).toContain("UPDATE type::record('noema', $noemaId)");
    expect(sql).not.toContain("CREATE ONLY type::record('noema'");
    expect(sql).toContain("expectedTargetUpdatedAt");
    expect(variables.supportSemioteIds).toEqual(["legacy-source", "atomic-source"]);
    expect(variables.status).toBe("superseded");
  });

  it("guards legacy payload.data when payload.l2 is absent", async () => {
    const row = sourceRow({
      payload: {
        ...(sourceRow().payload as Row),
        l2: undefined,
        data: "legacy data-backed source",
      },
    });
    const db = promotionDb(row);

    const result = await promoteSemioteToNoema(db, "atomic-source");

    expect(result.promoted).toBe(true);
    const [sql, variables] = db.queryTransaction.mock.calls[0] as [string, Row];
    expect(sql).toContain("payload.data = $expectedSourceRawText");
    expect(variables.expectedSourceRawText).toBe("legacy data-backed source");
  });

  it("refuses a protected target before provider execution or transaction", async () => {
    const row = sourceRow();
    const db = promotionDb(row, {
      target: {
        id: "noema:protected-target",
        user_id: "atomic-user",
        processing_lineage: { state: "minni_verified" },
        status: "active",
        claim_key: "protected-claim",
        revision_hash: "protected-revision",
        support_semiote_ids: ["atomic-source"],
        active: true,
        updated_at: "noema-version-1",
      },
    });
    const embedText = vi.fn().mockResolvedValue([1, 2, 3]);

    expect(await promoteSemioteToNoema(db, "atomic-source", embedText)).toEqual({
      promoted: false,
      id: null,
      embeddingWritten: false,
    });
    expect(embedText).not.toHaveBeenCalled();
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("refuses malformed target metadata before transaction", async () => {
    const row = sourceRow();
    const db = promotionDb(row, {
      target: {
        id: "noema:malformed-target",
        user_id: "atomic-user",
        processing_lineage: undefined,
        status: "unknown-status",
        claim_key: 42,
        revision_hash: "revision",
        support_semiote_ids: ["atomic-source"],
        active: true,
        updated_at: "noema-version-1",
      },
    });

    expect(await promoteSemioteToNoema(db, "atomic-source")).toEqual({
      promoted: false,
      id: null,
      embeddingWritten: false,
    });
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("reports a transaction error as rolled back only after metadata readback", async () => {
    const row = sourceRow();
    const db = promotionDb(row, {
      transaction: async () => {
        throw new Error("synthetic connection lost after commit boundary");
      },
      readbackSource: {
        id: row.id,
        user_id: row.user_id,
        processing_lineage: undefined,
        updated_at: row.updated_at,
        promoted_to_noema_id: undefined,
        noema_support_semiote_ids: undefined,
        noema_claim_key: undefined,
        noema_revision_hash: undefined,
        noema_status: undefined,
        noema_stable_claim: undefined,
      },
    });

    await expect(promoteSemioteToNoema(db, "atomic-source")).rejects.toMatchObject({
      noemaPromotionOutcome: "rolled_back",
      noemaPromotionReadback: expect.objectContaining({ sourceId: "atomic-source" }),
    });
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes("SELECT *"))).toBe(true);
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports unresolved readback when target and source disagree", async () => {
    const row = sourceRow();
    const db = promotionDb(row, {
      transaction: async (_sql, variables) => {
        throw new Error(`synthetic unresolved ${String(variables.noemaId)}`);
      },
      readbackTarget: {
        id: "noema:partial",
        user_id: "atomic-user",
        processing_lineage: undefined,
        status: "active",
        claim_key: "partial-claim",
        revision_hash: "partial-revision",
        support_semiote_ids: ["atomic-source"],
        active: true,
        updated_at: "noema-version-2",
      },
      readbackSource: {
        id: row.id,
        user_id: row.user_id,
        processing_lineage: undefined,
        updated_at: "source-version-2",
        promoted_to_noema_id: "noema:partial",
        noema_support_semiote_ids: ["atomic-source"],
        noema_claim_key: "partial-claim",
        noema_revision_hash: "partial-revision",
        noema_status: "active",
        noema_stable_claim: { unexpected: true },
      },
    });

    await expect(promoteSemioteToNoema(db, "atomic-source")).rejects.toMatchObject({
      noemaPromotionOutcome: "inconsistent_or_unresolved",
    });
    expect(db.query.mock.calls.at(-2)?.[0]).toContain("support_semiote_ids");
    expect(db.query.mock.calls.at(-1)?.[0]).toContain("promoted_to_noema_id");
  });

  it.each(["source", "target", "both"] as const)(
    "refuses a no-effect transaction with %s-only full-precision timestamp churn",
    async (churn) => {
      const initialRow = sourceRow();
      const initialDb = promotionDb(initialRow);
      const initial = await promoteSemioteToNoema(initialDb, "atomic-source");
      expect(initial.promoted).toBe(true);
      const [, initialVariables] = initialDb.queryTransaction.mock.calls[0] as [string, Row];
      const prestateTimestamp = new DateTime("2026-10-01T00:00:00.123456000Z");
      const targetBefore = {
        id: `noema:${initialVariables.noemaId}`,
        user_id: initialVariables.userId,
        processing_lineage: undefined,
        status: initialVariables.status,
        claim_key: initialVariables.claimKey,
        revision_hash: initialVariables.revisionHash,
        support_semiote_ids: initialVariables.supportSemioteIds,
        active: true,
        updated_at: prestateTimestamp,
      };
      const retryRow = sourceRow({
        updated_at: prestateTimestamp,
        payload: {
          ...(initialRow.payload as Row),
          promotedToNoemaId: initialVariables.noemaRecordId,
          noemaSupportSemioteIds: initialVariables.supportSemioteIds,
          noemaClaimKey: initialVariables.claimKey,
          noemaRevisionHash: initialVariables.revisionHash,
          noemaStatus: initialVariables.status,
          noemaStableClaim: initialVariables.stableClaim,
        },
      });
      const db = noEffectReadbackDb(retryRow, targetBefore, churn);

      await expect(promoteSemioteToNoema(db, "atomic-source")).rejects.toMatchObject({
        noemaPromotionOutcome: "inconsistent_or_unresolved",
      });
      expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    },
  );
});
