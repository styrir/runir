import { spawn, type ChildProcess } from "node:child_process";
import { createServer, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerResolvedTargetUser,
  createServerSelectedProducerOperation,
  createTrustedProducerRegistration,
  mintProcessingLineage,
  syntheticProducerDeliveryResolver,
  type ProducerOperation,
} from "../src/app/processing-policy/authority.js";
import {
  createMemoryWithProcessingLineage,
  findSimilarMemories,
  mergeMemoryWithProcessingLineage,
  upsertMemory,
  updateMemoryText,
} from "../src/storage/surreal/surreal-store.js";
import { SurrealClient } from "../src/storage/surreal/surreal-client.js";
import { ensureProcessingLineageSchema } from "../src/storage/surreal/processing-lineage-schema.js";
import { PROCESSING_LINEAGE_VERSION, type ProcessingLineageRestriction, type ProcessingLineageV1 } from "../src/domain/memory/processing-lineage.js";

const runNative = process.env.RUNIR_LINEAGE_NATIVE_WRITES === "1";
const PASSWORD = "sourceb-a-native-synthetic";
const EMBEDDING = [0.1, 0.2, 0.3];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("native Sourceb-A fixture did not allocate a port");
  return port;
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500);
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
      socket.connect(port, "127.0.0.1");
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`native Sourceb-A fixture did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function fixture(operation: ProducerOperation = "capture_ingest") {
  const principal = createServerAuthenticatedProducerPrincipal(`principal.sourceb.native.${operation}`);
  const targetUser = createServerResolvedTargetUser("user.sourceb-a.native");
  const authority = createProducerAuthority([
    createTrustedProducerRegistration({
      registrationRef: `registration.sourceb.native.${operation}`,
      principalRef: principal.principalRef,
      authorizedOperations: [operation],
      authorizedTargetUsers: [targetUser.userId],
    }),
  ]);
  const selectedOperation = createServerSelectedProducerOperation(operation);
  const admission = authority.resolve({ principal, operation: selectedOperation, targetUser });
  if (!admission.ok) throw new Error(`native admission failed: ${admission.reason}`);
  const evidence = syntheticProducerDeliveryResolver.resolve(authority, admission.context);
  if ("ok" in evidence && evidence.ok === false) throw new Error(`native evidence failed: ${evidence.reason}`);
  const minted = mintProcessingLineage(authority, admission.context, evidence);
  if (!minted.ok) throw new Error(`native mint failed: ${minted.reason}`);
  return { authority, targetUser, minted };
}

function restrictedLineage(
  lineage: ProcessingLineageV1,
  restrictions: readonly ProcessingLineageRestriction[],
): ProcessingLineageV1 {
  return {
    ...lineage,
    delivery: {
      version: PROCESSING_LINEAGE_VERSION,
      disposition: restrictions.length > 0 ? "local_only" : "ordinary",
      restrictions: [...restrictions],
    },
  };
}

async function insertRawMemory(
  db: SurrealClient,
  input: {
    id: string;
    userId: string;
    text: string;
    embedding?: number[];
    lineage?: unknown;
    scope?: "user" | "session";
    sessionId?: string;
    tags?: string[];
    pinnedAt?: string;
    atomicFact?: unknown;
    tableName?: "semiote" | "memories";
  },
): Promise<void> {
  const now = new Date().toISOString();
  const tableName = input.tableName ?? "semiote";
  const lineageClause = input.lineage === undefined ? "" : ", processing_lineage: $lineage";
  await db.query(
    `CREATE type::record('${tableName}', $id) CONTENT {
       embedding: $embedding,
       payload: {
         l2: $text,
         userId: $userId,
         tags: $tags,
         pinnedAt: $pinnedAt,
         atomicFact: $atomicFact
       },
       user_id: $userId,
       scope: $scope,
       session_id: $sessionId,
       created_at: <datetime>$now,
       updated_at: <datetime>$now,
       active: true${lineageClause}
     };`,
    {
      id: input.id,
      userId: input.userId,
      text: input.text,
      embedding: input.embedding ?? [1, 0, 0],
      lineage: input.lineage,
      scope: input.scope ?? "user",
      sessionId: input.sessionId,
      tags: input.tags ?? [],
      pinnedAt: input.pinnedAt,
      atomicFact: input.atomicFact,
      now,
    },
  );
}

describe.skipIf(!runNative)("Sourceb-A native processing-lineage writes", () => {
  let db: SurrealClient;
  let server: ChildProcess;

  beforeAll(async () => {
    const port = await freePort();
    server = spawn(
      "/usr/local/bin/surreal",
      ["start", "memory", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", PASSWORD, "--log", "none", "--no-banner"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    await waitForServer(port);
    db = new SurrealClient({
      url: `http://127.0.0.1:${port}`,
      username: "root",
      password: PASSWORD,
      namespace: "main",
      database: "main",
    });
    await db.query("DEFINE TABLE semiote SCHEMALESS;");
    await ensureProcessingLineageSchema(db, "semiote");
  }, 30_000);

  beforeEach(async () => {
    await db.query("DELETE semiote;");
  });

  afterAll(async () => {
    await db?.close();
    if (server && server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    if (server) {
      await Promise.race([
        waitForExit(server),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    }
  });

  it("round-trips exact top-level lineage with content and lifecycle in one writer transaction", async () => {
    const source = fixture();
    await createMemoryWithProcessingLineage(db, source.authority, source.minted, {
      id: "native-roundtrip",
      text: "Synthetic Sourceb-A roundtrip",
      userId: source.targetUser.userId,
      embedding: EMBEDDING,
      scope: "user",
      sessionId: "session.native.authoritative",
      lifecycle: { active: true, lineageRootId: "root.native.authoritative" },
      metadata: {
        tags: ["native"],
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
      },
    });

    const rows = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-roundtrip" });
    const row = rows[0]?.[0];
    expect(row?.processing_lineage).toEqual(source.minted.lineage);
    expect(row?.payload?.processing_lineage).toBeUndefined();
    expect(row?.payload?.l2).toBe("Synthetic Sourceb-A roundtrip");
    expect(row?.payload?.userId).toBe(source.targetUser.userId);
    expect(row?.payload?.scope).toBe("user");
    expect(row?.payload?.sessionId).toBe("session.native.authoritative");
    expect(row?.payload?.active).toBe(true);
    expect(row?.payload?.lineageRootId).toBe("root.native.authoritative");
    expect(row?.payload?.inactiveReason).toBeUndefined();
    expect(row?.payload?.supersededById).toBeUndefined();
    expect(row?.payload?.supersedesId).toBeUndefined();
    expect(row?.user_id).toBe(source.targetUser.userId);
    expect(row?.scope).toBe("user");
    expect(row?.session_id).toBe("session.native.authoritative");
    expect(row?.lineage_root_id).toBe("root.native.authoritative");
  }, 30_000);

  it("refuses every protected collision without changing the existing row", async () => {
    const source = fixture();
    const invalidLineage = { ...source.minted.lineage, state: "forged" };
    const cases = [
      { id: "collision-absent", lineage: undefined, marker: "legacy", userId: source.targetUser.userId },
      { id: "collision-other-user", lineage: undefined, marker: "other-user", userId: "other-user" },
      { id: "collision-valid", lineage: source.minted.lineage, marker: "valid", userId: source.targetUser.userId },
      { id: "collision-invalid", lineage: invalidLineage, marker: "invalid-present", userId: source.targetUser.userId },
    ] as const;

    for (const item of cases) {
      await db.query(
        "CREATE type::record('semiote', $id) CONTENT { payload: { l2: $marker, userId: $userId }, user_id: $userId, processing_lineage: $lineage };",
        { id: item.id, marker: item.marker, userId: item.userId, lineage: item.lineage },
      );
      const before = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: item.id });
      await expect(createMemoryWithProcessingLineage(db, source.authority, source.minted, {
        id: item.id,
        text: "must not overwrite",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
      })).rejects.toThrow();
      const after = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: item.id });
      expect(after[0]?.[0]).toEqual(before[0]?.[0]);
      await db.query("DELETE type::record('semiote', $id);", { id: item.id });
    }
  }, 30_000);

  it("preserves generic absent-lineage compatibility and refuses valid or invalid-present rows", async () => {
    const source = fixture();
    await upsertMemory(db, "generic-legacy", "legacy before", source.targetUser.userId, EMBEDDING, {}, "user");
    await upsertMemory(db, "generic-legacy", "legacy after", source.targetUser.userId, EMBEDDING, {}, "user");
    const legacy = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "generic-legacy" });
    expect(legacy[0]?.[0]?.payload?.l2).toBe("legacy after");

    await db.query(
      "CREATE type::record('semiote', $id) CONTENT { payload: { l2: $marker, userId: $userId }, user_id: $userId, processing_lineage: $lineage };",
      { id: "generic-valid", marker: "valid", userId: source.targetUser.userId, lineage: source.minted.lineage },
    );
    const validBefore = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "generic-valid" });
    await expect(upsertMemory(db, "generic-valid", "must not overwrite valid", source.targetUser.userId, EMBEDDING, {}, "user"))
      .rejects.toMatchObject({ reason: "lineage_present", contentFree: true });
    const validAfter = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "generic-valid" });
    expect(validAfter[0]?.[0]).toEqual(validBefore[0]?.[0]);

    const invalidLineage = { ...source.minted.lineage, state: "forged" };
    await db.query(
      "CREATE type::record('semiote', $id) CONTENT { payload: { l2: $marker, userId: $userId }, user_id: $userId, processing_lineage: $lineage };",
      { id: "generic-invalid", marker: "invalid-present", userId: source.targetUser.userId, lineage: invalidLineage },
    );
    const invalidBefore = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "generic-invalid" });
    await expect(upsertMemory(db, "generic-invalid", "must not overwrite invalid", source.targetUser.userId, EMBEDDING, {}, "user"))
      .rejects.toMatchObject({ reason: "lineage_present", contentFree: true });
    const invalidAfter = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "generic-invalid" });
    expect(invalidAfter[0]?.[0]).toEqual(invalidBefore[0]?.[0]);
  }, 30_000);

  it("serializes concurrent same-id protected creates as one winner", async () => {
    const source = fixture();
    const attempts = await Promise.allSettled([
      createMemoryWithProcessingLineage(db, source.authority, source.minted, {
        id: "concurrent-create",
        text: "winner one",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
      }),
      createMemoryWithProcessingLineage(db, source.authority, source.minted, {
        id: "concurrent-create",
        text: "winner two",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const rows = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "concurrent-create" });
    expect(rows[0]).toHaveLength(1);
  }, 30_000);

  it("rolls back a writer transaction when the precommit statement fails", async () => {
    const source = fixture();
    await db.query("DEFINE FIELD payload.l2 ON TABLE semiote TYPE string ASSERT $value != 'rollback-probe';");
    await expect(createMemoryWithProcessingLineage(db, source.authority, source.minted, {
      id: "rollback-create",
      text: "rollback-probe",
      userId: source.targetUser.userId,
      embedding: EMBEDDING,
    })).rejects.toThrow();
    const rows = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "rollback-create" });
    expect(rows[0]).toHaveLength(0);
  }, 30_000);

  it("merges a known row with a monotonic restricted lineage and preserves rich payload fields", async () => {
    const source = fixture();
    const storedLineage = restrictedLineage(source.minted.lineage, ["audio_derived", "producer_local_only"]);
    const pinnedAt = "2026-01-01T00:00:00.000Z";
    const atomicFact = { subject: "synthetic", predicate: "merge", value: "before" };
    await insertRawMemory(db, {
      id: "native-merge-rich",
      userId: source.targetUser.userId,
      text: "before merge",
      lineage: storedLineage,
      scope: "session",
      sessionId: "native-merge-session",
      tags: ["keep", "synthetic"],
      pinnedAt,
      atomicFact,
    });
    const before = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-merge-rich" }))[0]?.[0];

    await mergeMemoryWithProcessingLineage(db, source.authority, source.minted, {
      id: "native-merge-rich",
      userId: source.targetUser.userId,
      newText: "after merge",
      embedding: [0.2, 0.3, 0.4],
      writeSource: "session_summary",
      atomicFactAction: "retain",
      continuityMetadata: { memoryRole: "recent_work", continuitySubjectKey: "subject.merge" },
    });

    const after = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-merge-rich" }))[0]?.[0];
    expect(after?.processing_lineage).toEqual(restrictedLineage(source.minted.lineage, ["audio_derived", "producer_local_only"]));
    expect(after?.payload?.l2).toBe("after merge");
    expect(after?.payload?.tags).toEqual(["keep", "synthetic"]);
    expect(after?.payload?.pinnedAt).toBe(pinnedAt);
    expect(after?.payload?.atomicFact).toEqual(atomicFact);
    expect(after?.payload?.userId).toBe(source.targetUser.userId);
    expect(after?.scope).toBe(before?.scope);
    expect(after?.session_id).toBe(before?.session_id);
    expect(after?.created_at).toEqual(before?.created_at);
    expect(new Date(String(after?.updated_at)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(before?.updated_at)).getTime(),
    );
  }, 30_000);

  it("refuses compare-and-set user, lineage, and deletion changes after preflight", async () => {
    const mutations = [
      {
        label: "user",
        apply: async (source: ReturnType<typeof fixture>) => {
          await db.query("UPDATE type::record('semiote', $id) SET user_id = $other;", { id: "native-merge-cas-user", other: "changed-user" });
          return source;
        },
        id: "native-merge-cas-user",
      },
      {
        label: "lineage",
        apply: async (source: ReturnType<typeof fixture>) => {
          await db.query("UPDATE type::record('semiote', $id) SET processing_lineage = $lineage;", {
            id: "native-merge-cas-lineage",
            lineage: restrictedLineage(source.minted.lineage, ["audio_derived"]),
          });
          return source;
        },
        id: "native-merge-cas-lineage",
      },
      {
        label: "deletion",
        apply: async (source: ReturnType<typeof fixture>) => {
          await db.query("DELETE type::record('semiote', $id);", { id: "native-merge-cas-delete" });
          return source;
        },
        id: "native-merge-cas-delete",
      },
    ] as const;

    for (const mutation of mutations) {
      const source = fixture();
      await insertRawMemory(db, {
        id: mutation.id,
        userId: source.targetUser.userId,
        text: `before ${mutation.label}`,
        lineage: source.minted.lineage,
      });
      const originalQuery = db.query.bind(db);
      let mutated = false;
      (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
        const result = await originalQuery(sql, vars);
        if (!mutated && sql.includes("SELECT id, user_id, processing_lineage")) {
          mutated = true;
          await mutation.apply(source);
        }
        return result;
      };
      try {
        await expect(mergeMemoryWithProcessingLineage(db, source.authority, source.minted, {
          id: mutation.id,
          userId: source.targetUser.userId,
          newText: "must not land",
          embedding: EMBEDDING,
          writeSource: "session_summary",
          atomicFactAction: "retain",
        })).rejects.toThrow(/transaction failed|compare-and-set/);
      } finally {
        (db as any).query = originalQuery;
      }
      expect(mutated).toBe(true);
      if (mutation.label !== "deletion") {
        const row = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: mutation.id }))[0]?.[0];
        expect(row?.payload?.l2).toContain("before");
      } else {
        const rows = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: mutation.id });
        expect(rows[0]).toHaveLength(0);
      }
    }
  }, 30_000);

  it("rolls back protected merge text and lineage on a known precommit failure", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-merge-rollback",
      userId: source.targetUser.userId,
      text: "rollback before",
      lineage: source.minted.lineage,
      tags: ["preserve"],
    });
    await db.query("DEFINE FIELD payload.writeSource ON TABLE semiote TYPE option<int> ASSERT $value = NONE OR $value = 0;");
    await expect(mergeMemoryWithProcessingLineage(db, source.authority, source.minted, {
      id: "native-merge-rollback",
      userId: source.targetUser.userId,
      newText: "merge-rollback",
      embedding: [0.4, 0.5, 0.6],
      writeSource: "session_summary",
      atomicFactAction: "retain",
    })).rejects.toThrow();
    const row = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-merge-rollback" }))[0]?.[0];
    expect(row?.payload?.l2).toBe("rollback before");
    expect(row?.payload?.tags).toEqual(["preserve"]);
    expect(row?.processing_lineage).toEqual(source.minted.lineage);
    await db.query("REMOVE FIELD payload.writeSource ON TABLE semiote;");
  }, 30_000);

  it("keeps protected rows out of generic similarity mapping and rejects generic updates", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-candidate-legacy",
      userId: source.targetUser.userId,
      text: "legacy candidate",
      embedding: [1, 0, 0],
    });
    await insertRawMemory(db, {
      id: "native-candidate-valid",
      userId: source.targetUser.userId,
      text: "valid protected candidate",
      embedding: [1, 0, 0],
      lineage: source.minted.lineage,
    });
    await insertRawMemory(db, {
      id: "native-candidate-invalid",
      userId: source.targetUser.userId,
      text: "invalid protected candidate",
      embedding: [1, 0, 0],
      lineage: { ...source.minted.lineage, state: "forged" },
    });

    const candidates = await findSimilarMemories(db, source.targetUser.userId, [1, 0, 0], 24, 10);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["native-candidate-legacy"]);

    await expect(updateMemoryText(db, "native-candidate-valid", "must not update", EMBEDDING, "session_summary", "retain"))
      .rejects.toMatchObject({ reason: "lineage_present", contentFree: true });
    await expect(updateMemoryText(db, "native-candidate-invalid", "must not update", EMBEDDING, "session_summary", "retain"))
      .rejects.toMatchObject({ reason: "lineage_present", contentFree: true });
    await updateMemoryText(db, "native-candidate-legacy", "legacy updated", EMBEDDING, "session_summary", "retain");
    const legacy = (await db.query<any>("SELECT payload.l2 FROM type::record('semiote', $id);", { id: "native-candidate-legacy" }))[0]?.[0];
    expect(legacy?.payload?.l2).toBe("legacy updated");
  }, 30_000);
});
