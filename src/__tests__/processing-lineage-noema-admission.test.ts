import { describe, expect, it, vi } from "vitest";
import { DateTime } from "surrealdb";
import { promoteSemioteToNoema } from "../storage/surreal/phase2-store.js";

type StoredRow = Record<string, unknown>;

function storedRow(overrides: StoredRow = {}): StoredRow {
  return {
    id: "semiote:source-1",
    user_id: "user-1",
    active: true,
    scope: "user",
    path: "/repo",
    memory_role: "current_status",
    updated_at: "version-1",
    supersede_provenance: undefined,
    payload: {
      l2: "stored source content",
      l0: "stored source",
      category: "cases",
      factKey: "cases:stored-source",
      continuitySubjectKey: "stored-source",
      claimPredicate: "contains",
      confidence: 0.95,
      supersede_provenance: undefined,
    },
    usefulness_score: 0.83,
    successful_use_count: 3,
    cross_session_use_count: 2,
    contradiction_count: 0,
    ...overrides,
  };
}

function promotionMetadata(row: StoredRow, overrides: StoredRow = {}): StoredRow {
  return {
    id: row.id,
    user_id: row.user_id,
    processing_lineage: undefined,
    active: row.active,
    scope: row.scope,
    path: row.path,
    memory_role: row.memory_role,
    supersedes: row.supersedes,
    superseded_by: row.superseded_by,
    lineage_root_id: row.lineage_root_id,
    inactive_at: row.inactive_at,
    inactive_reason: row.inactive_reason,
    supersede_provenance: row.supersede_provenance,
    updated_at: row.updated_at,
    payload_supersede_provenance: (row.payload as StoredRow).supersede_provenance,
    ...overrides,
  };
}

function promotionDb(
  metadata: StoredRow,
  content: StoredRow = storedRow(),
) {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes("SELECT id, user_id") && sql.includes("processing_lineage")) return Promise.resolve([[metadata]]);
    if (sql.includes("SELECT * FROM type::record('semiote'")) return Promise.resolve([[content]]);
    if (sql.includes("SELECT status FROM type::record('noema'")) return Promise.resolve([[]]);
    return Promise.resolve([[]]);
  });
  return { query } as any;
}

describe("Sourcec-N1 stable-id Noema admission", () => {
  it("observes only the compatibility carrier id before the metadata read", async () => {
    const row = storedRow();
    const db = promotionDb(promotionMetadata(row), row);
    const caller = {
      id: "semiote:source-1",
      get payload(): never {
        throw new Error("caller payload must not be read");
      },
      get user_id(): never {
        throw new Error("caller user must not be read");
      },
      get usefulness_score(): never {
        throw new Error("caller usefulness must not be read");
      },
      get embedding(): never {
        throw new Error("caller embedding must not be read");
      },
    };

    const result = await promoteSemioteToNoema(db, caller);

    expect(result.promoted).toBe(true);
    expect(db.query.mock.calls[0][0]).toContain("SELECT id, user_id");
    expect(db.query.mock.calls[0][0]).toContain("processing_lineage");
    expect(db.query.mock.calls[0][0]).not.toContain("payload.l2");
    expect(db.query.mock.calls[0][0]).not.toContain("embedding");
    expect(db.query.mock.calls[1][0]).toContain("processing_lineage = NONE");
    expect(db.query.mock.calls[3][1]).toMatchObject({ canonicalText: "stored source content" });
  });

  it("refuses valid and invalid present lineage before guarded content or writes", async () => {
    for (const processingLineage of [
      { state: "minni_verified", origin: "minni" },
      null,
    ]) {
      const row = storedRow();
      const db = promotionDb(promotionMetadata(row, { processing_lineage: processingLineage }), row);
      const embedText = vi.fn().mockResolvedValue([1, 2, 3]);

      const result = await promoteSemioteToNoema(db, "source-1", embedText);

      expect(result).toEqual({ promoted: false, id: null, embeddingWritten: false });
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls[0][0]).not.toContain("SELECT *");
      expect(embedText).not.toHaveBeenCalled();
    }
  });

  it("ignores caller content and refuses a metadata-to-content branch race", async () => {
    const row = storedRow();
    const caller = {
      id: "source-1",
      payload: {
        l2: "caller content must not win",
        userId: "attacker",
        usefulnessScore: 1,
      },
    };
    const db = promotionDb(promotionMetadata(row), row);
    const result = await promoteSemioteToNoema(db, caller);

    expect(result.promoted).toBe(true);
    expect(db.query.mock.calls[3][1]).toMatchObject({ canonicalText: "stored source content" });
    expect(db.query.mock.calls[3][1]).not.toMatchObject({ canonicalText: "caller content must not win" });

    const raced = storedRow({ updated_at: "version-2" });
    const racedDb = promotionDb(promotionMetadata(row), raced);
    const racedResult = await promoteSemioteToNoema(racedDb, "source-1");
    expect(racedResult).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(racedDb.query).toHaveBeenCalledTimes(2);
    expect(racedDb.query.mock.calls.some(([sql]: [string]) => sql.includes("UPSERT type::record('noema'"))).toBe(false);
  });

  it("accepts equal SDK timestamps and structured provenance but refuses a one-nanosecond change", async () => {
    const timestamp = "2026-10-01T00:00:00.123456000Z";
    const provenance = {
      reason: "sourcec-n1-test",
      restrictions: ["same-user", "absent-lineage"],
      source: { kind: "semiote", version: 1 },
    };
    const row = storedRow({
      updated_at: new DateTime(timestamp),
      supersede_provenance: provenance,
      payload: {
        ...storedRow().payload as StoredRow,
        supersede_provenance: provenance,
      },
    });
    const metadata = promotionMetadata(row, {
      updated_at: new DateTime(timestamp),
      supersede_provenance: { ...provenance, restrictions: [...provenance.restrictions] },
      payload_supersede_provenance: {
        ...provenance,
        restrictions: [...provenance.restrictions],
        source: { ...provenance.source },
      },
    });
    const acceptedDb = promotionDb(metadata, row);
    const accepted = await promoteSemioteToNoema(acceptedDb, "source-1");
    expect(accepted.promoted).toBe(true);

    const changedRow = storedRow({
      ...row,
      updated_at: new DateTime("2026-10-01T00:00:00.123456001Z"),
    });
    const changedDb = promotionDb(metadata, changedRow);
    const changed = await promoteSemioteToNoema(changedDb, "source-1");
    expect(changed).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(changedDb.query).toHaveBeenCalledTimes(2);
    expect(changedDb.query.mock.calls.some(([sql]: [string]) => sql.includes("UPSERT type::record('noema'"))).toBe(false);
  });

  it("refuses circular or unsupported metadata instead of stringifying it into equality", async () => {
    const expectedCircular: Record<string, unknown> = { kind: "circular" };
    expectedCircular.self = expectedCircular;
    const actualCircular: Record<string, unknown> = { kind: "circular" };
    actualCircular.self = actualCircular;
    class UnsupportedMetadata {}

    const row = storedRow({ supersede_provenance: actualCircular });
    const metadata = promotionMetadata(row, { supersede_provenance: expectedCircular });
    const circularDb = promotionDb(metadata, row);
    const circularResult = await promoteSemioteToNoema(circularDb, "source-1");
    expect(circularResult).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(circularDb.query).toHaveBeenCalledTimes(2);

    const unsupportedRow = storedRow({ supersede_provenance: new UnsupportedMetadata() });
    const unsupportedMetadata = promotionMetadata(unsupportedRow, { supersede_provenance: new UnsupportedMetadata() });
    const unsupportedDb = promotionDb(unsupportedMetadata, unsupportedRow);
    const unsupportedResult = await promoteSemioteToNoema(unsupportedDb, "source-1");
    expect(unsupportedResult).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(unsupportedDb.query).toHaveBeenCalledTimes(2);

    const sharedCircular: Record<string, unknown> = { kind: "shared-circular" };
    sharedCircular.self = sharedCircular;
    const sharedCircularRow = storedRow({ supersede_provenance: sharedCircular });
    const sharedCircularDb = promotionDb(
      promotionMetadata(sharedCircularRow, { supersede_provenance: sharedCircular }),
      sharedCircularRow,
    );
    const sharedCircularResult = await promoteSemioteToNoema(sharedCircularDb, "source-1");
    expect(sharedCircularResult).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(sharedCircularDb.query).toHaveBeenCalledTimes(2);

    const sharedUnsupported = new UnsupportedMetadata();
    const sharedUnsupportedRow = storedRow({ supersede_provenance: sharedUnsupported });
    const sharedUnsupportedDb = promotionDb(
      promotionMetadata(sharedUnsupportedRow, { supersede_provenance: sharedUnsupported }),
      sharedUnsupportedRow,
    );
    const sharedUnsupportedResult = await promoteSemioteToNoema(sharedUnsupportedDb, "source-1");
    expect(sharedUnsupportedResult).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(sharedUnsupportedDb.query).toHaveBeenCalledTimes(2);
  });

  it("refuses invalid or throwing stable ids before any database access", async () => {
    const db = { query: vi.fn() } as any;
    expect(await promoteSemioteToNoema(db, "")).toEqual({ promoted: false, id: null, embeddingWritten: false });
    const throwingId = {
      get id(): never {
        throw new Error("id read failed");
      },
    };
    expect(await promoteSemioteToNoema(db, throwingId)).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(db.query).not.toHaveBeenCalled();
  });
});
