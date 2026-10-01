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
  revokeProducerRegistration,
  syntheticProducerDeliveryResolver,
  type ProducerOperation,
} from "../src/app/processing-policy/authority.js";
import {
  createMemoryWithProcessingLineage,
  findSimilarMemories,
  mergeMemoryWithProcessingLineage,
  supersedeMemoryWithProcessingLineage,
  supersedeMemory,
  softArchiveInactiveOlderThan,
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
        if (!mutated && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage")) {
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

  it("supersedes a protected fresh replacement with the monotonic lineage union", async () => {
    const source = fixture();
    const storedLineage = restrictedLineage(source.minted.lineage, ["audio_derived"]);
    await insertRawMemory(db, {
      id: "native-supersede-prev",
      userId: source.targetUser.userId,
      text: "protected previous",
      lineage: storedLineage,
      tags: ["keep-previous"],
    });

    await supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
      previousId: "native-supersede-prev",
      replacement: {
        id: "native-supersede-fresh",
        text: "protected replacement",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
        scope: "user",
        writeSource: "session_summary",
      },
      supersedeProvenance: "deterministic",
    });

    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-prev" }))[0]?.[0];
    const replacement = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-fresh" }))[0]?.[0];
    expect(previous?.active).toBe(false);
    expect(replacement?.active).toBe(true);
    expect(replacement?.supersedes).toBeTruthy();
    expect(replacement?.processing_lineage).toEqual(storedLineage);
    expect(previous?.processing_lineage).toEqual(storedLineage);
    expect(replacement?.payload?.l2).toBe("protected replacement");
    expect(previous?.payload?.tags).toEqual(["keep-previous"]);
  }, 30_000);

  it("preserves an existing protected survivor while joining both stored lineages", async () => {
    const source = fixture();
    const previousLineage = restrictedLineage(source.minted.lineage, ["audio_derived"]);
    const survivorLineage = restrictedLineage(source.minted.lineage, ["producer_local_only"]);
    await insertRawMemory(db, {
      id: "native-supersede-existing-prev",
      userId: source.targetUser.userId,
      text: "protected prior",
      lineage: previousLineage,
    });
    await insertRawMemory(db, {
      id: "native-supersede-existing",
      userId: source.targetUser.userId,
      text: "rich survivor",
      lineage: survivorLineage,
      tags: ["survivor"],
      pinnedAt: "2026-01-01T00:00:00.000Z",
    });
    await db.query("UPDATE type::record('semiote', $id) SET payload.confidence = $confidence;", {
      id: "native-supersede-existing",
      confidence: 0.93,
    });

    await supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
      previousId: "native-supersede-existing-prev",
      replacement: {
        id: "native-supersede-existing",
        text: "incoming text must not replace survivor",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
        scope: "user",
        writeSource: "session_summary",
      },
      supersedeProvenance: "llm-generated",
    });

    const survivor = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-existing" }))[0]?.[0];
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-existing-prev" }))[0]?.[0];
    const joined = restrictedLineage(source.minted.lineage, ["audio_derived", "producer_local_only"]);
    expect(survivor?.payload?.l2).toBe("rich survivor");
    expect(survivor?.payload?.tags).toEqual(["survivor"]);
    expect(survivor?.payload?.confidence).toBe(0.93);
    expect(survivor?.processing_lineage).toEqual(joined);
    expect(previous?.processing_lineage).toEqual(joined);
    expect(previous?.active).toBe(false);
  }, 30_000);

  it("rolls back protected fresh supersede on a known precommit failure", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-rollback-prev",
      userId: source.targetUser.userId,
      text: "rollback previous",
      lineage: source.minted.lineage,
    });
    const original = db.queryTransaction.bind(db);
    (db as any).queryTransaction = (body: string, vars?: Record<string, unknown>) =>
      original(`${body}\nTHROW "protected supersede rollback probe";`, vars);
    try {
      const failure = await supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
        previousId: "native-supersede-rollback-prev",
        replacement: {
          id: "native-supersede-rollback-new",
          text: "must roll back",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      }).then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({
        protectedSupersedeOutcome: "rolled_back",
        protectedSupersedeMetadataReadback: { previousExists: true, replacementExists: false },
      });
      expect(String((failure as Error).message)).toMatch(/transaction failed/);
    } finally {
      (db as any).queryTransaction = original;
    }
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-rollback-prev" }))[0]?.[0];
    const replacement = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-rollback-new" });
    expect(previous?.active).toBe(true);
    expect(replacement[0]).toHaveLength(0);
  }, 30_000);

  it("rejects a protected supersede that would close a cycle before mutation", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-cycle-prev",
      userId: source.targetUser.userId,
      text: "cycle previous",
      lineage: source.minted.lineage,
    });
    await db.query(
      "UPDATE type::record('semiote', $id) SET supersedes = $replacement;",
      { id: "native-supersede-cycle-prev", replacement: "native-supersede-cycle-new" },
    );

    await expect(supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
      previousId: "native-supersede-cycle-prev",
      replacement: {
        id: "native-supersede-cycle-new",
        text: "must not close cycle",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
        scope: "user",
        writeSource: "session_summary",
      },
      supersedeProvenance: "deterministic",
    })).rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });

    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-cycle-prev" }))[0]?.[0];
    const replacement = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-cycle-new" });
    expect(previous?.active).toBe(true);
    expect(replacement[0]).toHaveLength(0);
  }, 30_000);

  it("keeps generic absent-lineage supersede branches atomic with row assertions", async () => {
    const source = fixture();
    await upsertMemory(db, "native-generic-supersede-prev", "generic previous", source.targetUser.userId, EMBEDDING, {}, "user", undefined, undefined, "semiote");
    await supersedeMemory(
      db,
      {
        id: "native-generic-supersede-prev",
        l2: "generic previous",
        similarity: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: "native-generic-supersede-new",
        text: "generic replacement",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
        scope: "user",
        writeSource: "session_summary",
      },
      "deterministic",
      undefined,
      "superseded",
      "semiote",
    );
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-supersede-prev" }))[0]?.[0];
    const replacement = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-supersede-new" }))[0]?.[0];
    expect(previous?.active).toBe(false);
    expect(replacement?.active).toBe(true);

    await upsertMemory(db, "native-generic-supersede-survivor", "rich generic survivor", source.targetUser.userId, EMBEDDING, { confidence: 0.91 }, "user", undefined, undefined, "semiote");
    await supersedeMemory(
      db,
      {
        id: "native-generic-supersede-prev",
        l2: "generic previous",
        similarity: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: "native-generic-supersede-survivor",
        text: "ignored generic incoming",
        userId: source.targetUser.userId,
        embedding: EMBEDDING,
        scope: "user",
        writeSource: "session_summary",
      },
      "llm-generated",
      true,
      "superseded",
      "semiote",
    );
    const survivor = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-supersede-survivor" }))[0]?.[0];
    expect(survivor?.payload?.l2).toBe("rich generic survivor");
    expect(survivor?.payload?.confidence).toBe(0.91);
  }, 30_000);

  it("rejects a copied mint before any metadata SQL", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-copied-prev",
      userId: source.targetUser.userId,
      text: "copied mint previous",
      lineage: source.minted.lineage,
    });
    const copiedMint = { ...source.minted };
    const originalQuery = db.query.bind(db);
    let queryCount = 0;
    (db as any).query = async (...args: any[]) => {
      queryCount++;
      return originalQuery(...args);
    };
    try {
      await expect(supersedeMemoryWithProcessingLineage(db, source.authority, copiedMint, {
        previousId: "native-supersede-copied-prev",
        replacement: {
          id: "native-supersede-copied-new",
          text: "must not run",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      })).rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });
    } finally {
      (db as any).query = originalQuery;
    }
    expect(queryCount).toBe(0);
  }, 30_000);

  it("refuses legacy, invalid, and mixed-authority protected rows before transaction", async () => {
    const source = fixture("capture_ingest");
    const other = fixture("scheduled_maintenance");
    const cases = [
      { id: "native-supersede-legacy", lineage: undefined },
      { id: "native-supersede-invalid", lineage: { ...source.minted.lineage, state: "forged" } },
      { id: "native-supersede-mixed", lineage: other.minted.lineage },
    ] as const;
    for (const item of cases) {
      await insertRawMemory(db, {
        id: item.id,
        userId: source.targetUser.userId,
        text: `protected ${item.id}`,
        ...(item.lineage === undefined ? {} : { lineage: item.lineage }),
      });
      await expect(supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
        previousId: item.id,
        replacement: {
          id: `${item.id}-replacement`,
          text: "must not process",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      })).rejects.toMatchObject({ reason: "lineage_invalid", contentFree: true });
      const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: item.id }))[0]?.[0];
      const replacement = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: `${item.id}-replacement` });
      expect(previous?.active).toBe(true);
      expect(replacement[0]).toHaveLength(0);
    }
  }, 30_000);

  it("refuses a fresh-id collision that appears after metadata preflight", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-collision-prev",
      userId: source.targetUser.userId,
      text: "collision previous",
      lineage: source.minted.lineage,
    });
    const originalQuery = db.query.bind(db);
    let replacementRead = false;
    (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
      const result = await originalQuery(sql, vars);
      if (!replacementRead && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage") && vars?.recordId === "native-supersede-collision-new") {
        replacementRead = true;
        await insertRawMemory(db, {
          id: "native-supersede-collision-new",
          userId: source.targetUser.userId,
          text: "raced legacy collision",
        });
      }
      return result;
    };
    try {
      await expect(supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
        previousId: "native-supersede-collision-prev",
        replacement: {
          id: "native-supersede-collision-new",
          text: "must not overwrite collision",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      })).rejects.toThrow(/transaction failed/);
    } finally {
      (db as any).query = originalQuery;
    }
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-collision-prev" }))[0]?.[0];
    const collision = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-collision-new" }))[0]?.[0];
    expect(previous?.active).toBe(true);
    expect(collision?.payload?.l2).toBe("raced legacy collision");
  }, 30_000);

  it("classifies a post-COMMIT transport error from metadata readback without retrying", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-ambiguous-prev",
      userId: source.targetUser.userId,
      text: "ambiguous previous",
      lineage: source.minted.lineage,
    });
    const originalTransaction = db.queryTransaction.bind(db);
    let attempts = 0;
    (db as any).queryTransaction = async (body: string, vars?: Record<string, unknown>) => {
      attempts++;
      await originalTransaction(body, vars);
      throw new Error("synthetic transport failure after COMMIT");
    };
    try {
      const failure = await supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
        previousId: "native-supersede-ambiguous-prev",
        replacement: {
          id: "native-supersede-ambiguous-new",
          text: "ambiguous replacement",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      }).then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({
        protectedSupersedeOutcome: "committed",
        protectedSupersedeMetadataReadback: { previousExists: true, replacementExists: true },
      });
      expect(String((failure as Error).message)).toContain("after COMMIT");
    } finally {
      (db as any).queryTransaction = originalTransaction;
    }
    expect(attempts).toBe(1);
  }, 30_000);

  it("detects previous-row user, lineage, deletion, status, and branch CAS races", async () => {
    const mutations: Array<{ label: string; apply: (id: string, lineage: ProcessingLineageV1) => Promise<unknown> }> = [
      { label: "user", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET user_id = $other;", { id, other: "other-user" }) },
      { label: "lineage", apply: async (id: string, lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET processing_lineage = $lineage;", { id, lineage: restrictedLineage(lineage, ["audio_derived"]) }) },
      { label: "deletion", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("DELETE type::record('semiote', $id);", { id }) },
      { label: "status", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET active = false;", { id }) },
      { label: "branch", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET supersedes = $other;", { id, other: "raced-branch" }) },
    ];
    for (const mutation of mutations) {
      const source = fixture();
      const previousId = `native-supersede-cas-${mutation.label}`;
      const replacementId = `${previousId}-replacement`;
      await insertRawMemory(db, {
        id: previousId,
        userId: source.targetUser.userId,
        text: `cas ${mutation.label}`,
        lineage: source.minted.lineage,
      });
      const originalQuery = db.query.bind(db);
      let mutated = false;
      (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
        const result = await originalQuery(sql, vars);
        if (!mutated && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage") && vars?.recordId === replacementId) {
          mutated = true;
          await mutation.apply(previousId, source.minted.lineage);
        }
        return result;
      };
      try {
        await expect(supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
          previousId,
          replacement: {
            id: replacementId,
            text: "must not land after race",
            userId: source.targetUser.userId,
            embedding: EMBEDDING,
            scope: "user",
            writeSource: "session_summary",
          },
          supersedeProvenance: "deterministic",
        })).rejects.toThrow(/transaction failed/);
      } finally {
        (db as any).query = originalQuery;
      }
      expect(mutated).toBe(true);
      const replacement = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: replacementId });
      expect(replacement[0]).toHaveLength(0);
    }
  }, 30_000);

  it("refuses generic supersede for valid or invalid-present lineage and closes a lineage race", async () => {
    const source = fixture();
    const rows = [
      { id: "native-generic-protected-valid", lineage: source.minted.lineage },
      { id: "native-generic-protected-invalid", lineage: { ...source.minted.lineage, state: "forged" } },
    ] as const;
    for (const row of rows) {
      await insertRawMemory(db, {
        id: row.id,
        userId: source.targetUser.userId,
        text: row.id,
        lineage: row.lineage,
      });
      let transactionCalls = 0;
      const originalTransaction = db.queryTransaction.bind(db);
      (db as any).queryTransaction = async (...args: any[]) => {
        transactionCalls++;
        return originalTransaction(...args);
      };
      try {
        await expect(supersedeMemory(
          db,
          { id: row.id, l2: row.id, similarity: 1, createdAt: new Date().toISOString() },
          {
            id: `${row.id}-replacement`,
            text: "generic must not process protected",
            userId: source.targetUser.userId,
            embedding: EMBEDDING,
            scope: "user",
            writeSource: "session_summary",
          },
          "deterministic",
          undefined,
          "superseded",
          "semiote",
        )).rejects.toMatchObject({ reason: "lineage_present", contentFree: true });
      } finally {
        (db as any).queryTransaction = originalTransaction;
      }
      expect(transactionCalls).toBe(0);
    }

    await insertRawMemory(db, {
      id: "native-generic-race-prev",
      userId: source.targetUser.userId,
      text: "generic race previous",
    });
    const originalQuery = db.query.bind(db);
    let raced = false;
    (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
      const result = await originalQuery(sql, vars);
      if (!raced && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage") && vars?.recordId === "native-generic-race-new") {
        raced = true;
        await db.query("UPDATE type::record('semiote', $id) SET processing_lineage = $lineage;", { id: "native-generic-race-prev", lineage: source.minted.lineage });
      }
      return result;
    };
    try {
      await expect(supersedeMemory(
        db,
        { id: "native-generic-race-prev", l2: "generic race previous", similarity: 1, createdAt: new Date().toISOString() },
        {
          id: "native-generic-race-new",
          text: "generic race replacement",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        "deterministic",
        undefined,
        "superseded",
        "semiote",
      )).rejects.toThrow(/transaction failed/);
    } finally {
      (db as any).query = originalQuery;
    }
    expect(raced).toBe(true);
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-race-prev" }))[0]?.[0];
    const replacement = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-race-new" });
    expect(previous?.active).toBe(true);
    expect(replacement[0]).toHaveLength(0);
  }, 30_000);

  it("detects replacement-row user, lineage, deletion, status, and branch CAS races", async () => {
    const mutations: Array<{ label: string; apply: (id: string, lineage: ProcessingLineageV1) => Promise<unknown> }> = [
      { label: "user", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET user_id = $other;", { id, other: "other-survivor-user" }) },
      { label: "lineage", apply: async (id: string, lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET processing_lineage = $lineage;", { id, lineage: restrictedLineage(lineage, ["producer_local_only"]) }) },
      { label: "deletion", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("DELETE type::record('semiote', $id);", { id }) },
      { label: "status", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET active = false;", { id }) },
      { label: "branch", apply: async (id: string, _lineage: ProcessingLineageV1) => db.query("UPDATE type::record('semiote', $id) SET supersedes = $other;", { id, other: "raced-survivor-branch" }) },
    ];
    for (const mutation of mutations) {
      const source = fixture();
      const previousId = `native-supersede-replacement-cas-prev-${mutation.label}`;
      const replacementId = `native-supersede-replacement-cas-${mutation.label}`;
      await insertRawMemory(db, { id: previousId, userId: source.targetUser.userId, text: previousId, lineage: source.minted.lineage });
      await insertRawMemory(db, { id: replacementId, userId: source.targetUser.userId, text: replacementId, lineage: source.minted.lineage, tags: ["survivor"] });
      const originalQuery = db.query.bind(db);
      let mutated = false;
      (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
        const result = await originalQuery(sql, vars);
        if (!mutated && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage") && vars?.recordId === replacementId) {
          mutated = true;
          await mutation.apply(replacementId, source.minted.lineage);
        }
        return result;
      };
      try {
        await expect(supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
          previousId,
          replacement: {
            id: replacementId,
            text: "must not replace raced survivor",
            userId: source.targetUser.userId,
            embedding: EMBEDDING,
            scope: "user",
            writeSource: "session_summary",
          },
          supersedeProvenance: "deterministic",
        })).rejects.toThrow(/transaction failed/);
      } finally {
        (db as any).query = originalQuery;
      }
      expect(mutated).toBe(true);
      const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: previousId }))[0]?.[0];
      expect(previous?.active).toBe(true);
    }
  }, 30_000);

  it("blocks the transaction when the exact producer registration is revoked after preflight", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-revoke-prev",
      userId: source.targetUser.userId,
      text: "revoke previous",
      lineage: source.minted.lineage,
    });
    const originalQuery = db.query.bind(db);
    let revoked = false;
    (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
      const result = await originalQuery(sql, vars);
      if (!revoked && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage") && vars?.recordId === "native-supersede-revoke-new") {
        revoked = true;
        revokeProducerRegistration(source.authority, source.minted.context.registrationRef);
      }
      return result;
    };
    let transactionCalls = 0;
    const originalTransaction = db.queryTransaction.bind(db);
    (db as any).queryTransaction = async (...args: any[]) => {
      transactionCalls++;
      return originalTransaction(...args);
    };
    try {
      await expect(supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
        previousId: "native-supersede-revoke-prev",
        replacement: {
          id: "native-supersede-revoke-new",
          text: "must not write after revoke",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      })).rejects.toMatchObject({ reason: "registration_revoked", contentFree: true });
    } finally {
      (db as any).query = originalQuery;
      (db as any).queryTransaction = originalTransaction;
    }
    expect(revoked).toBe(true);
    expect(transactionCalls).toBe(0);
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-revoke-prev" }))[0]?.[0];
    const replacement = await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-supersede-revoke-new" });
    expect(previous?.active).toBe(true);
    expect(replacement[0]).toHaveLength(0);
  }, 30_000);

  it("preserves an other-user generic collision that appears after the absent pre-read", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-generic-collision-prev",
      userId: source.targetUser.userId,
      text: "generic collision previous",
    });
    const originalQuery = db.query.bind(db);
    let collided = false;
    (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
      const result = await originalQuery(sql, vars);
      if (!collided && sql.includes("SELECT id, user_id") && sql.includes("processing_lineage") && vars?.recordId === "native-generic-collision-new") {
        collided = true;
        await insertRawMemory(db, {
          id: "native-generic-collision-new",
          userId: "other-generic-user",
          text: "other user's collision",
        });
      }
      return result;
    };
    try {
      await expect(supersedeMemory(
        db,
        { id: "native-generic-collision-prev", l2: "generic collision previous", similarity: 1, createdAt: new Date().toISOString() },
        {
          id: "native-generic-collision-new",
          text: "must not overwrite other user",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        "deterministic",
        undefined,
        "superseded",
        "semiote",
      )).rejects.toThrow(/transaction failed/);
    } finally {
      (db as any).query = originalQuery;
    }
    expect(collided).toBe(true);
    const previous = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-collision-prev" }))[0]?.[0];
    const collision = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-generic-collision-new" }))[0]?.[0];
    expect(previous?.active).toBe(true);
    expect(collision?.payload?.l2).toBe("other user's collision");
    expect(collision?.user_id).toBe("other-generic-user");
  }, 30_000);

  it("classifies a post-COMMIT metadata mismatch as unresolved", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-supersede-mismatch-prev",
      userId: source.targetUser.userId,
      text: "mismatch previous",
      lineage: source.minted.lineage,
    });
    const originalTransaction = db.queryTransaction.bind(db);
    let attempts = 0;
    (db as any).queryTransaction = async (body: string, vars?: Record<string, unknown>) => {
      attempts++;
      await originalTransaction(body, vars);
      await db.query("UPDATE type::record('semiote', $id) SET inactive_reason = $reason;", {
        id: "native-supersede-mismatch-prev",
        reason: "post-commit-tamper",
      });
      throw new Error("synthetic response failure after mismatched commit");
    };
    try {
      const failure = await supersedeMemoryWithProcessingLineage(db, source.authority, source.minted, {
        previousId: "native-supersede-mismatch-prev",
        replacement: {
          id: "native-supersede-mismatch-new",
          text: "mismatch replacement",
          userId: source.targetUser.userId,
          embedding: EMBEDDING,
          scope: "user",
          writeSource: "session_summary",
        },
        supersedeProvenance: "deterministic",
      }).then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({ protectedSupersedeOutcome: "inconsistent_or_unresolved" });
      expect(String((failure as Error).message)).toContain("mismatched commit");
    } finally {
      (db as any).queryTransaction = originalTransaction;
    }
    expect(attempts).toBe(1);
  }, 30_000);

  it("returns actual guarded archive affected rows when lineage races the pre-read", async () => {
    const source = fixture();
    await insertRawMemory(db, {
      id: "native-archive-race",
      userId: source.targetUser.userId,
      text: "archive race",
    });
    await db.query("UPDATE type::record('semiote', $id) SET active = false, inactive_at = <datetime>$old;", {
      id: "native-archive-race",
      old: "2020-01-01T00:00:00.000Z",
    });
    const originalQuery = db.query.bind(db);
    let raced = false;
    (db as any).query = async (sql: string, vars?: Record<string, unknown>) => {
      const result = await originalQuery(sql, vars);
      if (!raced && sql.includes("SELECT id FROM semiote") && vars?.cutoff === "2021-01-01T00:00:00.000Z") {
        raced = true;
        await db.query("UPDATE type::record('semiote', $id) SET processing_lineage = $lineage;", { id: "native-archive-race", lineage: source.minted.lineage });
      }
      return result;
    };
    try {
      const archived = await softArchiveInactiveOlderThan(db, source.targetUser.userId, "user", "2021-01-01T00:00:00.000Z", "semiote");
      expect(archived).toBe(0);
    } finally {
      (db as any).query = originalQuery;
    }
    expect(raced).toBe(true);
    const row = (await db.query<any>("SELECT * FROM type::record('semiote', $id);", { id: "native-archive-race" }))[0]?.[0];
    expect(row?.archived).not.toBe(true);
  }, 30_000);
});
