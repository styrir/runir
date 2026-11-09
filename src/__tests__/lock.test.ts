import { describe, it, expect, vi } from "vitest";
import {
  acquireLock,
  extendLock,
  releaseLock,
  writeStalenessBacklog,
  ensureConsolidationLockTable,
  ensureStalenessBacklogTable,
  StalenessBacklogFactsSchemaError,
} from "../lifecycle/semion/lock.js";
import { processingLineageSchemaStatements } from "../storage/surreal/processing-lineage-schema.js";

type MockDb = { query: ReturnType<typeof vi.fn>; fields?: Record<string, string> };

function completeLineageFields(): Record<string, string> {
  return Object.fromEntries(processingLineageSchemaStatements("staleness_backlog").map((statement) => {
    const field = statement.match(/^DEFINE FIELD IF NOT EXISTS ([^ ]+)/)?.[1] ?? "";
    return [field, statement.replace("IF NOT EXISTS ", "")];
  }));
}

function completeFactsFields(): Record<string, string> {
  return {
    facts: "DEFINE FIELD facts ON TABLE staleness_backlog TYPE array;",
    "facts.*.text": "DEFINE FIELD facts.*.text ON TABLE staleness_backlog TYPE string;",
    "facts.*.confidence": "DEFINE FIELD facts.*.confidence ON TABLE staleness_backlog TYPE float;",
    "facts.*.replacementMemoryId": "DEFINE FIELD facts.*.replacementMemoryId ON TABLE staleness_backlog TYPE string;",
  };
}

function schemaAwareBacklogDb(initialFields: Record<string, string>): MockDb & { fields: Record<string, string> } {
  const state = { fields: { ...initialFields } };
  const db: MockDb & { fields: Record<string, string> } = {
    fields: state.fields,
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INFO FOR TABLE staleness_backlog")) return [[{ fields: state.fields }]];
      if (sql.includes("DEFINE FIELD IF NOT EXISTS processing_lineage")) {
        Object.assign(state.fields, completeLineageFields());
        db.fields = state.fields;
        return [[]];
      }
      if (sql.includes("DEFINE FIELD IF NOT EXISTS facts")) {
        Object.assign(state.fields, completeFactsFields());
        db.fields = state.fields;
        return [[]];
      }
      return [[]];
    }),
  };
  return db;
}

function makeDb(transactionResults: unknown[]): MockDb {
  return { query: vi.fn().mockResolvedValue(transactionResults) };
}

describe("acquireLock", () => {
  it("returns a holder ID when acquired", async () => {
    const db = makeDb([[], [{ id: "consolidation_locks:new-record" }]]);
    const holder = await acquireLock(db as any, "user1::user", 60);
    expect(holder).not.toBeNull();
  });

  it("returns null when the unique index rejects the CREATE", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("idx_cl_key already contains")) };
    await expect(acquireLock(db as any, "user1::user", 60)).resolves.toBeNull();
  });

  it("rethrows non-contention failures", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("ConnectionUnavailable")) };
    await expect(acquireLock(db as any, "user1::user", 60)).rejects.toThrow("ConnectionUnavailable");
  });
});

describe("extendLock and releaseLock", () => {
  it("extends only the matching holder", async () => {
    const db = makeDb([[{ id: "consolidation_locks:row" }]]);
    await expect(extendLock(db as any, "user1::user", "holder", 300)).resolves.toBe(true);
    expect(db.query.mock.calls[0][0]).toContain("lock_key = $key AND holder = $holder");
  });

  it("returns false when the lease row is gone and deletes matching locks", async () => {
    const db = makeDb([[]]);
    await expect(extendLock(db as any, "user1::user", "holder", 300)).resolves.toBe(false);
    await releaseLock(db as any, "user1::user", "holder");
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

describe("writeStalenessBacklog", () => {
  it("preserves the legacy input and null session behavior", async () => {
    const db = makeDb([[]]);
    await writeStalenessBacklog(db as any, "user1", "user", undefined, []);
    expect(db.query.mock.calls[0][1].sessionId).toBeNull();
    expect(db.query.mock.calls[0][0]).toContain("CREATE staleness_backlog");
  });
});

describe("ensureConsolidationLockTable", () => {
  it("defines the lock table, fields, and index", async () => {
    const db = makeDb([[]]);
    await ensureConsolidationLockTable(db as any);
    expect(db.query).toHaveBeenCalledTimes(6);
    expect(db.query.mock.calls.map((call: any[]) => call[0]).join("\n")).toContain("idx_cl_key");
  });
});

describe("ensureStalenessBacklogTable facts hierarchy", () => {
  it("initializes the optional lineage and closed facts hierarchy, then later fields", async () => {
    const db = schemaAwareBacklogDb({});
    await ensureStalenessBacklogTable(db as any);
    expect(db.fields).toEqual({ ...completeLineageFields(), ...completeFactsFields() });
    const calls = db.query.mock.calls.map((call: any[]) => call[0] as string);
    expect(calls.some((sql: string) => sql.includes("INFO FOR TABLE staleness_backlog"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("facts.*.text"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("DEFINE FIELD IF NOT EXISTS user_id"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("idx_sb_status"))).toBe(true);
  });

  it("is idempotent for complete lineage and facts definitions", async () => {
    const db = schemaAwareBacklogDb({ ...completeLineageFields(), ...completeFactsFields() });
    await ensureStalenessBacklogTable(db as any);
    const first = db.query.mock.calls.length;
    await ensureStalenessBacklogTable(db as any);
    const second = db.query.mock.calls.slice(first).map((call: any[]) => call[0] as string);
    expect(second.some((sql: string) => sql.includes("DEFINE FIELD IF NOT EXISTS processing_lineage"))).toBe(false);
    expect(second.some((sql: string) => sql.includes("facts.*.text"))).toBe(false);
  });

  it.each([
    ["partial", { facts: completeFactsFields().facts, "facts.*.text": completeFactsFields()["facts.*.text"] }],
    ["incompatible", { ...completeFactsFields(), "facts.*.confidence": "DEFINE FIELD facts.*.confidence ON TABLE staleness_backlog TYPE string;" }],
    ["extra", { ...completeFactsFields(), "facts.*.unknown": "DEFINE FIELD facts.*.unknown ON TABLE staleness_backlog TYPE string;" }],
  ] as const)("refuses %s facts hierarchy before later fields", async (_label, facts) => {
    const db = schemaAwareBacklogDb({ ...completeLineageFields(), ...facts });
    await expect(ensureStalenessBacklogTable(db as any)).rejects.toBeInstanceOf(StalenessBacklogFactsSchemaError);
    const calls = db.query.mock.calls.map((call: any[]) => call[0] as string);
    expect(calls.some((sql: string) => sql.includes("DEFINE FIELD IF NOT EXISTS user_id"))).toBe(false);
  });

  it("refuses a post-DDL hierarchy race before later fields", async () => {
    const fields = { ...completeLineageFields() };
    let infoCalls = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INFO FOR TABLE staleness_backlog")) {
          infoCalls += 1;
          if (infoCalls === 1) return [[{ fields }]];
          if (infoCalls === 2) return [[{ fields }]];
          return [[{ fields: { ...fields, ...completeFactsFields(), "facts.*.race": "DEFINE FIELD facts.*.race ON TABLE staleness_backlog TYPE string;" } }]];
        }
        if (sql.includes("processing_lineage")) Object.assign(fields, completeLineageFields());
        if (sql.includes("facts.*.text")) Object.assign(fields, completeFactsFields());
        return [[]];
      }),
    };
    await expect(ensureStalenessBacklogTable(db as any)).rejects.toBeInstanceOf(StalenessBacklogFactsSchemaError);
    expect(db.query.mock.calls.map((call: any[]) => call[0] as string).some((sql: string) => sql.includes("DEFINE FIELD IF NOT EXISTS user_id"))).toBe(false);
  });
});
