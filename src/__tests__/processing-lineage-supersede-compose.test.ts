import { describe, expect, it, vi } from "vitest";
import { DateTime, RecordId, Uuid, type Surreal as SurrealClient } from "surrealdb";
import {
  composePreparedSupersedeBatch,
  prepareSupersedeMemory,
  SurrealClient as ExportedSurrealClient,
  supersedeMemory,
  type PreparedGenericSupersede,
} from "../storage/surreal/surreal-store.js";
import type { SimilarCandidate } from "../domain/memory/types.js";

const TABLE = "semiote";
const USER = "h1-unit-user";
const VECTOR = [0.1, 0.2, 0.3];

type FakeDb = {
  query: ReturnType<typeof vi.fn>;
  queryTransaction: ReturnType<typeof vi.fn>;
};

function candidate(id: string, lineageRootId = id): SimilarCandidate {
  return {
    id,
    l2: `previous ${id}`,
    similarity: 0.9,
    createdAt: "2026-01-01T00:00:00.000Z",
    lineageRootId,
    scope: "user",
  };
}

function replacement(id: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    l2: `replacement ${id}`,
    userId: USER,
    embedding: [...VECTOR],
    metadata,
    scope: "user" as const,
    writeSource: "session_summary" as const,
  };
}

function mockDb(options: { replacementExists?: boolean } = {}): FakeDb {
  const replacementExists = options.replacementExists ?? false;
  return {
    query: vi.fn(async (statement: string) => {
      if (statement.includes("SELECT id FROM")) {
        return [replacementExists ? [{ id: "existing" }] : []];
      }
      return [[{ supersedes: null }]];
    }),
    queryTransaction: vi.fn(async () => []),
  };
}

function metadataRow(
  id: string,
  _links: {
    supersedes: RecordId;
    supersededBy?: RecordId;
    lineageRootId: RecordId;
  },
): Record<string, unknown> {
  // H1 receives only the source-owned plain witness. The typed row remains a
  // native-only concern and never enters the unit composer variables.
  void _links;
  return {
    id: `${TABLE}:${id}`,
    user_id: USER,
    payload_user_id: USER,
    lineage_absent: true,
    updated_at: "2026-01-01T00:00:00.000000001Z",
    row_digest: "a".repeat(64),
  };
}

function typedMetadataDb(rows: Record<string, Record<string, unknown>>): FakeDb {
  const db = Object.create(ExportedSurrealClient.prototype) as FakeDb;
  db.query = vi.fn(async (statement: string, vars?: Record<string, unknown>) => {
    if (statement.includes("payload.userId AS payload_user_id") || statement.includes("row_digest")) {
      const recordId = String(vars?.recordId ?? "");
      const row = rows[recordId];
      return row ? [[row]] : [[]];
    }
    if (statement.includes("SELECT supersedes FROM")) return [[{ supersedes: null }]];
    throw new Error(`unexpected controlled query: ${statement}`);
  });
  db.queryTransaction = vi.fn(async () => []);
  return db;
}

async function prepare(
  db: FakeDb,
  previousId: string,
  replacementId: string,
  metadata: Record<string, unknown> = {},
): Promise<PreparedGenericSupersede> {
  return prepareSupersedeMemory(
    db as unknown as SurrealClient,
    candidate(previousId),
    replacement(replacementId, metadata),
    "deterministic",
    undefined,
    "superseded",
    TABLE,
  );
}

describe("generic supersede preparation and composition", () => {
  it("prepares without mutation, preserves copied primitives, and namespaces a fresh plan", async () => {
    const db = mockDb();
    const input = replacement("fresh-replacement", { confidence: 0.81, nested: { keep: "yes" } });
    const previous = candidate("fresh-previous");
    const plan = await prepareSupersedeMemory(
      db as unknown as SurrealClient,
      previous,
      input,
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    );

    expect(db.queryTransaction).not.toHaveBeenCalled();
    input.id = "mutated-id";
    input.l2 = "mutated text";
    input.embedding[0] = 99;
    input.metadata!.confidence = 0.01;
    (input.metadata!.nested as { keep: string }).keep = "mutated";
    previous.lineageRootId = "mutated-root";

    const composed = composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [plan],
    );
    expect(composed.statement).toContain("$h1_0_sup_recordId");
    expect(composed.statement).toContain("CREATE ONLY");
    expect(composed.statement).toContain("$h1_0_previousRows");
    expect(composed.vars.h1_0_sup_recordId).toBe("fresh-replacement");
    expect(composed.vars.h1_0_sup_embedding).toEqual(VECTOR);
    expect((composed.vars.h1_0_sup_payload as { confidence: number }).confidence).toBe(0.81);
    expect((composed.vars.h1_0_sup_payload as { nested: { keep: string } }).nested.keep).toBe("yes");
    expect(composed.vars.h1_0_sup_payload).toMatchObject({
      l2: "replacement fresh-replacement",
      userId: USER,
    });
    expect(composed.vars.h1_0_now).toEqual(expect.any(String));
    expect(composed.statement).toContain("<datetime>$h1_0_now");
  });

  it("composes row-disjoint plans into one transaction body and rejects overlap before execution", async () => {
    const db = mockDb();
    const first = await prepare(db, "previous-a", "replacement-a");
    const second = await prepare(db, "previous-b", "replacement-b");
    const composed = composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [first, second],
    );

    expect(composed.statement).toContain("$h1_0_previousRows");
    expect(composed.statement).toContain("$h1_1_previousRows");
    expect(composed.vars.h1_0_sup_recordId).toBe("replacement-a");
    expect(composed.vars.h1_1_sup_recordId).toBe("replacement-b");
    expect(db.queryTransaction).not.toHaveBeenCalled();

    const overlapping = await prepare(db, "previous-a", "replacement-c");
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [first, overlapping],
    )).toThrow(/rows overlap/);
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("keeps the existing-survivor branch bookkeeping-only", async () => {
    const db = mockDb({ replacementExists: true });
    const plan = await prepare(db, "existing-previous", "existing");
    const composed = composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [plan],
    );

    expect(composed.statement).toContain("UPDATE type::record('semiote'");
    expect(composed.statement).not.toContain("CREATE ONLY");
    expect(composed.statement).toContain("payload.arbitrationOutcome = 'supersede'");
    expect(composed.vars.h1_0_writeSource).toBe("session_summary");
  });

  it("keeps the stored rich row behind a plain source-owned witness", async () => {
    const uuid = new Uuid("0189dcd5-5311-7d40-8db0-9496a2eef37b");
    const previousLinks = new RecordId(TABLE, {
      branch: "previous",
      uuid,
      nested: ["stable", { uuid }],
    });
    const previousRoot = new RecordId(TABLE, uuid);
    const previousSuccessor = new RecordId(TABLE, "unit-successor");
    const replacementLinks = new RecordId(TABLE, ["replacement", { uuid }]);
    const replacementRoot = new RecordId(TABLE, { root: "unit-root", uuid });
    const db = typedMetadataDb({
      "unit-previous": metadataRow("unit-previous", {
        supersedes: previousLinks,
        supersededBy: previousSuccessor,
        lineageRootId: previousRoot,
      }),
      "unit-replacement": metadataRow("unit-replacement", {
        supersedes: replacementLinks,
        lineageRootId: replacementRoot,
      }),
    });

    const plan = await prepareSupersedeMemory(
      db as unknown as SurrealClient,
      candidate("unit-previous"),
      replacement("unit-replacement"),
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    );
    const composed = composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [plan],
    );

    expect(composed.vars.h1_0_previousUserId).toBe(USER);
    expect(composed.vars.h1_0_previousPayloadUserId).toBe(USER);
    expect(composed.vars.h1_0_previousUpdatedAt).toBe("2026-01-01T00:00:00.000000001Z");
    expect(composed.vars.h1_0_previousRowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(composed.vars.h1_0_replacementRowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(composed.vars).some((value) => value instanceof RecordId || value instanceof Uuid || value instanceof DateTime)).toBe(false);
    expect(() => JSON.stringify(composed.vars)).not.toThrow();
    expect(db.queryTransaction).not.toHaveBeenCalled();
  });

  it("quarantines wrong-user or lineage-present rows before the body witness query", async () => {
    const db = Object.create(ExportedSurrealClient.prototype) as FakeDb;
    db.query = vi.fn(async (statement: string, vars?: Record<string, unknown>) => {
      if (statement.includes("payload.userId AS payload_user_id")) {
        const recordId = String(vars?.recordId ?? "");
        return [[{
          id: `semiote:${recordId}`,
          user_id: recordId === "quarantine-previous" ? "foreign-user" : USER,
          payload_user_id: recordId === "quarantine-previous" ? "foreign-user" : USER,
          lineage_absent: recordId !== "quarantine-lineage",
          updated_at: "2026-01-01T00:00:00.000000001Z",
        }]];
      }
      if (statement.includes("row_digest")) throw new Error("body witness must not run");
      if (statement.includes("SELECT supersedes FROM")) return [[{ supersedes: null }]];
      throw new Error(`unexpected controlled query: ${statement}`);
    });
    db.queryTransaction = vi.fn(async () => []);
    await expect(prepareSupersedeMemory(
      db as unknown as SurrealClient,
      candidate("quarantine-previous"),
      replacement("quarantine-replacement"),
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    )).rejects.toThrow(/previous generic snapshot mismatch/);
    expect(db.query.mock.calls.some(([statement]) => String(statement).includes("row_digest"))).toBe(false);

    const lineageDb = Object.create(ExportedSurrealClient.prototype) as FakeDb;
    lineageDb.query = vi.fn(async (statement: string, vars?: Record<string, unknown>) => {
      if (statement.includes("payload.userId AS payload_user_id")) {
        const recordId = String(vars?.recordId ?? "");
        return [[{
          id: `semiote:${recordId}`,
          user_id: USER,
          payload_user_id: USER,
          lineage_absent: recordId !== "quarantine-lineage",
          updated_at: "2026-01-01T00:00:00.000000001Z",
        }]];
      }
      if (statement.includes("row_digest")) throw new Error("body witness must not run");
      if (statement.includes("SELECT supersedes FROM")) return [[{ supersedes: null }]];
      throw new Error(`unexpected controlled query: ${statement}`);
    });
    lineageDb.queryTransaction = vi.fn(async () => []);
    await expect(prepareSupersedeMemory(
      lineageDb as unknown as SurrealClient,
      candidate("quarantine-lineage"),
      replacement("quarantine-lineage-replacement"),
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    )).rejects.toThrow();
    expect(lineageDb.query.mock.calls.some(([statement]) => String(statement).includes("row_digest"))).toBe(false);
  });

  it("rejects foreign SDK values as fresh caller data while stored values stay server-owned", async () => {
    // The historical direct-server-loader failure remains a preserved diagnostic.
    // H1 does not widen fresh caller inputs to foreign SDK brands; only the
    // native server projection may observe stored RecordId/Uuid/DateTime data.
    // @ts-expect-error The installed server entrypoint is the preserved historical probe input.
    const direct = await import("/Users/brooks/Code/runir/node_modules/surrealdb/dist/surrealdb.server.mjs");
    await expect(prepare(mockDb(), "direct-previous", "direct-replacement", {
      foreignRecordId: new direct.RecordId(TABLE, "foreign-id"),
    })).rejects.toThrow(/unsupported prepared object prototype/);
  });

  it("preserves safe data descriptors and rejects accessors, cycles, unknown prototypes, and spoofs", async () => {
    const shared = { value: "shared" };
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    const holes: unknown[] = [];
    holes.length = 2;
    holes[1] = shared;
    nullPrototype.shared = shared;
    nullPrototype.holes = holes;
    const db = mockDb();
    const plan = await prepare(db, "descriptor-previous", "descriptor-replacement", {
      first: shared,
      second: shared,
      nullPrototype,
    });
    const composed = composePreparedSupersedeBatch(db as unknown as SurrealClient, TABLE, USER, [plan]);
    const payload = composed.vars.h1_0_sup_payload as {
      first: unknown;
      second: unknown;
      nullPrototype: Record<string, unknown>;
    };
    expect(payload.first).toBe(payload.second);
    expect(Object.getPrototypeOf(payload.nullPrototype)).toBeNull();
    expect(payload.nullPrototype.shared).toBe(payload.first);
    expect((payload.nullPrototype.holes as unknown[]).length).toBe(2);
    expect(0 in (payload.nullPrototype.holes as unknown[])).toBe(false);
    expect((payload.nullPrototype.holes as unknown[])[1]).toBe(payload.first);

    let getterReads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        throw new Error("accessor invoked");
      },
    });
    await expect(prepare(mockDb(), "accessor-previous", "accessor-replacement", { accessor }))
      .rejects.toThrow(/accessor properties/);
    expect(getterReads).toBe(0);

    const iteratorTrap: unknown[] = [];
    Object.defineProperty(iteratorTrap, Symbol.iterator, {
      configurable: true,
      get: () => {
        getterReads += 1;
        throw new Error("iterator invoked");
      },
    });
    await expect(prepare(mockDb(), "iterator-previous", "iterator-replacement", { iteratorTrap }))
      .rejects.toThrow(/accessor properties/);
    expect(getterReads).toBe(0);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(prepare(mockDb(), "cycle-previous", "cycle-replacement", { cycle }))
      .rejects.toThrow(/circular/);

    const unknownPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    unknownPrototype.value = "unsupported";
    await expect(prepare(mockDb(), "prototype-previous", "prototype-replacement", { unknownPrototype }))
      .rejects.toThrow(/prototype/);

    const spoof = Object.create(RecordId.prototype) as Record<string, unknown>;
    await expect(prepare(mockDb(), "spoof-previous", "spoof-replacement", { spoof }))
      .rejects.toThrow(/unsupported prepared object prototype/);
  });

  it("rejects proxy values and proxy-bearing prototypes before reflection or storage queries", async () => {
    const trapCalls = {
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      has: 0,
    };
    const handler: ProxyHandler<object> = {
      getPrototypeOf() {
        trapCalls.getPrototypeOf += 1;
        throw new Error("proxy getPrototypeOf invoked");
      },
      ownKeys() {
        trapCalls.ownKeys += 1;
        throw new Error("proxy ownKeys invoked");
      },
      getOwnPropertyDescriptor() {
        trapCalls.getOwnPropertyDescriptor += 1;
        throw new Error("proxy descriptor invoked");
      },
      get() {
        trapCalls.get += 1;
        throw new Error("proxy get invoked");
      },
      has() {
        trapCalls.has += 1;
        throw new Error("proxy has invoked");
      },
    };
    const proxiedEmbedding = new Proxy([...VECTOR], handler) as unknown as number[];
    const revoked = Proxy.revocable({ revoked: true }, handler);
    revoked.revoke();
    const proxyPrototype = new Proxy({}, handler);
    const objectWithProxyPrototype = Object.create(proxyPrototype) as Record<string, unknown>;
    objectWithProxyPrototype.value = "unsupported";
    const arrayWithProxyPrototype: unknown[] = ["unsupported"];
    Object.setPrototypeOf(arrayWithProxyPrototype, proxyPrototype);
    const cases: Array<[string, () => Record<string, unknown>]> = [
      ["embedding proxy", () => {
        const input = replacement("proxy-embedding-replacement");
        input.embedding = proxiedEmbedding;
        return input;
      }],
      ["revoked proxy", () => replacement("revoked-proxy-replacement", { revoked: revoked.proxy })],
      ["nested metadata proxy", () => replacement("nested-proxy-replacement", { nested: { value: new Proxy({}, handler) } })],
      ["proxy object prototype", () => replacement("proxy-object-prototype-replacement", { objectWithProxyPrototype })],
      ["proxy array prototype", () => replacement("proxy-array-prototype-replacement", { arrayWithProxyPrototype })],
    ];
    for (const [label, makeInput] of cases) {
      const db = mockDb();
      await expect(prepareSupersedeMemory(
        db as unknown as SurrealClient,
        candidate(`${label}-previous`),
        makeInput(),
        "deterministic",
        undefined,
        "superseded",
        TABLE,
      )).rejects.toThrow(/Proxy/);
      expect(db.query).not.toHaveBeenCalled();
      expect(db.queryTransaction).not.toHaveBeenCalled();
    }
    expect(trapCalls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      has: 0,
    });
  });

  it("requires dense finite embedding data descriptors without coercion or queries", async () => {
    let accessorReads = 0;
    let coercions = 0;
    const sparse = [0.1, 0.2, 0.3];
    delete sparse[1];
    const accessor = [0.1, 0.2, 0.3];
    Object.defineProperty(accessor, "1", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("embedding accessor invoked");
      },
    });
    const coercible = [0.1, {
      valueOf: () => {
        coercions += 1;
        return 0.2;
      },
    }, 0.3] as unknown as number[];
    const cases: Array<[string, number[]]> = [
      ["sparse", sparse],
      ["accessor", accessor],
      ["nonfinite", [0.1, Number.NaN, 0.3]],
      ["coercible", coercible],
    ];
    for (const [label, embedding] of cases) {
      const db = mockDb();
      const input = replacement(`dense-${label}-replacement`);
      input.embedding = embedding;
      await expect(prepareSupersedeMemory(
        db as unknown as SurrealClient,
        candidate(`dense-${label}-previous`),
        input,
        "deterministic",
        undefined,
        "superseded",
        TABLE,
      )).rejects.toThrow(/embedding|accessor|executable/);
      expect(db.query).not.toHaveBeenCalled();
      expect(db.queryTransaction).not.toHaveBeenCalled();
    }
    expect(accessorReads).toBe(0);
    expect(coercions).toBe(0);
  });

  it("requires the private token identity and exact db/table/user context", async () => {
    const db = mockDb();
    const plan = await prepare(db, "identity-previous", "identity-replacement");
    const forged = { kind: plan.kind } as PreparedGenericSupersede;
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [forged],
    )).toThrow(/not owned/);
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      "memories",
      USER,
      [plan],
    )).toThrow(/table mismatch/);
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      "other-user",
      [plan],
    )).toThrow(/user mismatch/);
    const otherDb = mockDb();
    expect(() => composePreparedSupersedeBatch(
      otherDb as unknown as SurrealClient,
      TABLE,
      USER,
      [plan],
    )).toThrow(/database mismatch/);
  });

  it("copies plan collections and rejects caller traps before token lookup", async () => {
    const db = mockDb();
    const plan = await prepare(db, "collection-previous", "collection-replacement");
    let trapCalls = 0;
    const forgedMap = {
      get length() {
        trapCalls += 1;
        throw new Error("length invoked");
      },
      map() {
        trapCalls += 1;
        throw new Error("map invoked");
      },
    } as unknown as readonly PreparedGenericSupersede[];
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      forgedMap,
    )).toThrow(/must be an array/);
    expect(trapCalls).toBe(0);

    const accessorArray = [plan] as PreparedGenericSupersede[];
    Object.defineProperty(accessorArray, "map", {
      configurable: true,
      get: () => {
        trapCalls += 1;
        throw new Error("map getter invoked");
      },
    });
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      accessorArray,
    )).toThrow(/unsupported own property|accessor/);
    expect(trapCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxiedPlans = new Proxy([plan], {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("plan collection prototype trap invoked");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("plan collection ownKeys trap invoked");
      },
      get() {
        proxyTrapCalls += 1;
        throw new Error("plan collection get trap invoked");
      },
    });
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      proxiedPlans,
    )).toThrow(/Proxy/);
    expect(proxyTrapCalls).toBe(0);
  });

  it("rejects executable, symbolic, and coercible scalar inputs before any query", async () => {
    const db = mockDb();
    const before = db.query.mock.calls.length;
    await expect(prepare(db, "function-previous", "function-replacement", {
      callable: () => "must not run",
    })).rejects.toThrow(/executable/);
    await expect(prepare(db, "symbol-previous", "symbol-replacement", {
      symbolic: Symbol("unsupported"),
    })).rejects.toThrow(/symbol/);
    const coercible = {
      toString: () => {
        throw new Error("coercion invoked");
      },
    };
    await expect(prepareSupersedeMemory(
      db as unknown as SurrealClient,
      candidate("coercion-previous"),
      replacement("coercion-replacement"),
      // @ts-expect-error adversarial runtime scalar
      coercible,
      undefined,
      "superseded",
      TABLE,
    )).rejects.toThrow(/provenance/);
    expect(db.query.mock.calls.length).toBe(before);
    expect(() => composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      coercible as unknown as never,
      USER,
      [],
    )).toThrow(/unsupported table name/);
  });

  it("places every initial branch guard before the first mutation effect", async () => {
    const db = mockDb();
    const first = await prepare(db, "guard-previous-a", "guard-replacement-a");
    const second = await prepare(db, "guard-previous-b", "guard-replacement-b");
    const composed = composePreparedSupersedeBatch(
      db as unknown as SurrealClient,
      TABLE,
      USER,
      [first, second],
    );
    const firstEffect = Math.min(
      composed.statement.indexOf("CREATE ONLY"),
      composed.statement.indexOf("UPDATE type::record"),
    );
    expect(firstEffect).toBeGreaterThanOrEqual(0);
    expect(composed.statement.lastIndexOf("initialPreviousRows")).toBeLessThan(firstEffect);
    expect(composed.statement.lastIndexOf("initialReplacementRows")).toBeLessThan(firstEffect);
    expect(composed.statement.match(/initialPreviousRows/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the legacy single-call API to one prepared mutation and one transaction", async () => {
    const db = mockDb();
    await supersedeMemory(
      db as unknown as SurrealClient,
      candidate("legacy-previous"),
      replacement("legacy-replacement"),
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    );
    expect(db.queryTransaction).toHaveBeenCalledTimes(1);
    expect(db.queryTransaction.mock.calls[0]?.[0]).toContain("$previousRows");
    expect(db.queryTransaction.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      sup_recordId: "legacy-replacement",
    }));
  });
});
