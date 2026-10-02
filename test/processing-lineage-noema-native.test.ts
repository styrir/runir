import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "surrealdb";
import { ensurePhase2Schema, promoteSemioteToNoema } from "../src/storage/surreal/phase2-store.js";
import { SurrealClient } from "../src/storage/surreal/surreal-client.js";

const runNative = process.env.RUNIR_LINEAGE_NATIVE_NOEMA === "1";
const PASSWORD = "sourcec-n2-native-synthetic";
const USER = "native-n2-user";
const SENTINEL_ENV_KEYS = [
  "SURREAL_URL",
  "SURREAL_USER",
  "SURREAL_PASS",
  "SURREAL_NS",
  "SURREAL_DB",
  "SURREAL_DATABASE",
] as const;
const CLEANUP_DEADLINE_MS = 2_000;
const RUN_ID = `sourcec_n2_${process.pid}`;

function resolvedPackageVersion(packageName: string): string {
  const entry = execFileSync(
    process.execPath,
    ["-e", `process.stdout.write(require.resolve(${JSON.stringify(packageName)}))`],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  let current = dirname(entry);
  while (current !== dirname(current)) {
    const packageJson = `${current}/package.json`;
    if (existsSync(packageJson)) {
      const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string; version?: string };
      if (parsed.name === packageName && typeof parsed.version === "string") return parsed.version;
    }
    current = dirname(current);
  }
  throw new Error(`could not resolve installed package version for ${packageName}`);
}

function parseSurrealVersion(output: string): string {
  const token = output.trim().split(/\s+/)[0] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(token)) {
    throw new Error(`native Sourcec-N2 fixture could not parse CLI version: ${output.trim()}`);
  }
  if (token !== "3.1.4") {
    throw new Error(`native Sourcec-N2 fixture requires SurrealDB 3.1.4; resolved ${token}`);
  }
  return token;
}

function resolvedSurrealBinary(): { path: string; version: string } {
  const path = "/usr/local/bin/surreal";
  if (!existsSync(path)) throw new Error("reviewed SurrealDB CLI path is unavailable");
  return { path, version: parseSurrealVersion(execFileSync(path, ["version"], { encoding: "utf8" })) };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("native Sourcec-N2 fixture did not allocate a port");
  return port;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`native Sourcec-N2 fixture did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function boundedCall<T>(label: string, operation: () => Promise<T>, deadlineMs = CLEANUP_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${deadlineMs}ms`)), deadlineMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type OwnedChild = Pick<ChildProcess, "exitCode" | "signalCode" | "pid"> & {
  kill: (signal?: NodeJS.Signals) => boolean;
};

type CleanupSeam = {
  closeSdk: () => Promise<void>;
  child?: OwnedChild;
  port: number;
  waitForExit: (child: OwnedChild) => Promise<void>;
  canConnect: (port: number) => Promise<boolean>;
};

async function cleanupOwnedResources(seam: CleanupSeam, deadlineMs = CLEANUP_DEADLINE_MS): Promise<void> {
  const errors: Error[] = [];
  try {
    await boundedCall("SDK close", seam.closeSdk, deadlineMs);
  } catch (error) {
    errors.push(toError(error));
  }
  const child = seam.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      errors.push(toError(error));
    }
  }
  if (child) {
    try {
      await boundedCall("owned child SIGTERM exit", () => seam.waitForExit(child), deadlineMs);
    } catch (error) {
      errors.push(toError(error));
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        errors.push(toError(error));
      }
      try {
        await boundedCall("owned child SIGKILL exit", () => seam.waitForExit(child), deadlineMs);
      } catch (error) {
        errors.push(toError(error));
      }
    }
  }
  let socketOpen = false;
  try {
    socketOpen = await boundedCall("owned socket check", () => seam.canConnect(seam.port), deadlineMs);
  } catch (error) {
    errors.push(toError(error));
  }
  if (socketOpen) errors.push(new Error("native Sourcec-N2 fixture left its owned loopback socket open"));
  if (child && child.exitCode === null && child.signalCode === null) {
    errors.push(new Error("native Sourcec-N2 fixture left its owned Surreal process alive"));
  }
  console.log(`sourcec-n2 cleanup ownedPid=${child?.pid ?? "none"} processAlive=${child ? child.exitCode === null && child.signalCode === null : false} socketOpen=${socketOpen}`);
  if (errors.length > 0) {
    throw new AggregateError(errors, `native Sourcec-N2 cleanup failed: ${errors.map((error) => error.message).join("; ")}`);
  }
}

let sentinelServer: ReturnType<typeof createServer> | undefined;
let sentinelPort = 0;
let sentinelConnections = 0;
const sentinelSockets = new Set<Socket>();
let sentinelEnvironmentInstalled = false;
const savedSentinelEnvironment: Partial<Record<(typeof SENTINEL_ENV_KEYS)[number], string | undefined>> = {};

async function installEndpointSentinel(): Promise<void> {
  sentinelServer = createServer((socket) => {
    sentinelConnections += 1;
    sentinelSockets.add(socket);
    socket.once("close", () => sentinelSockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    sentinelServer?.once("error", reject);
    sentinelServer?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = sentinelServer.address();
  sentinelPort = typeof address === "object" && address ? address.port : 0;
  if (!sentinelPort) throw new Error("native Sourcec-N2 sentinel did not allocate a port");
  for (const key of SENTINEL_ENV_KEYS) savedSentinelEnvironment[key] = process.env[key];
  process.env.SURREAL_URL = `http://127.0.0.1:${sentinelPort}`;
  process.env.SURREAL_USER = "sentinel-user";
  process.env.SURREAL_PASS = "sentinel-pass";
  process.env.SURREAL_NS = "sentinel-namespace";
  process.env.SURREAL_DB = "sentinel-database";
  process.env.SURREAL_DATABASE = "sentinel-database";
  sentinelEnvironmentInstalled = true;
}

async function closeEndpointSentinel(): Promise<void> {
  const errors: Error[] = [];
  try {
    for (const socket of sentinelSockets) socket.destroy();
    if (sentinelServer?.listening) {
      try {
        await boundedCall("sentinel close", () => new Promise<void>((resolve, reject) => {
          sentinelServer?.close((error) => error ? reject(error) : resolve());
        }));
      } catch (error) {
        errors.push(toError(error));
        const closeAllConnections = (sentinelServer as typeof sentinelServer & { closeAllConnections?: () => void }).closeAllConnections;
        closeAllConnections?.();
      }
    }
    if (sentinelServer?.listening) errors.push(new Error("native Sourcec-N2 sentinel listener remained open"));
  } finally {
    if (sentinelEnvironmentInstalled) {
      for (const key of SENTINEL_ENV_KEYS) {
        const value = savedSentinelEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      sentinelEnvironmentInstalled = false;
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "native Sourcec-N2 sentinel cleanup failed");
}

const CLI = resolvedSurrealBinary();
const SDK_VERSION = resolvedPackageVersion("surrealdb");

let db: SurrealClient;
let server: ChildProcess;
let port = 0;
let schemaInfo: { semiote: unknown; noema: unknown };

function id(label: string): string {
  return `${RUN_ID}_${label}`;
}

function lineageFixture(state: string, userId = USER): Record<string, unknown> {
  return {
    state,
    origin: "minni",
    producer_principal_ref: "principal.sourcec.n2.native",
    producer_registration_ref: "registration.sourcec.n2.native",
    processing_policy_version: "runir.minni.local/v1",
    admitted_operation: "capture_ingest",
    target_user_id: userId,
    delivery: {
      version: "runir.minni.delivery/v1",
      disposition: "ordinary",
      restrictions: [],
    },
  };
}

async function insertSource(
  input: { id: string; userId?: string; text?: string; supportIds?: string[]; lineage?: unknown },
): Promise<void> {
  await db.query(
    `CREATE type::record('semiote', $id) CONTENT {
       payload: {
         l2: $text,
         l0: "Synthetic atomic source",
         category: "cases",
         factKey: "cases:atomic-native",
         continuitySubjectKey: "atomic-native",
         claimPredicate: "is",
         confidence: 0.95,
         noemaSupportSemioteIds: $supportIds
       },
       user_id: $userId,
       scope: "user",
       path: "/synthetic/atomic",
       memory_role: "current_status",
       usefulness_score: 0.84,
       successful_use_count: 3,
       cross_session_use_count: 2,
       contradiction_count: 0,
       active: true,
       created_at: <datetime>$now,
       updated_at: <datetime>$now${input.lineage === undefined ? "" : ", processing_lineage: $lineage"}
     };`,
    {
      id: input.id,
      userId: input.userId ?? USER,
      text: input.text ?? "The native atomic source is eligible.",
      supportIds: input.supportIds,
      lineage: input.lineage,
      now: new Date().toISOString(),
    },
  );
}

async function insertSupport(idValue: string, userId = USER, lineage?: unknown): Promise<void> {
  await db.query(
    `CREATE type::record('semiote', $id) CONTENT {
       payload: { l2: "Synthetic support", l0: "Synthetic support", category: "support", confidence: 0.8 },
       user_id: $userId,
       scope: "user",
       path: "/synthetic/support",
       memory_role: "current_status",
       active: true,
       created_at: <datetime>$now,
       updated_at: <datetime>$now${lineage === undefined ? "" : ", processing_lineage: $lineage"}
     };`,
    { id: idValue, userId, lineage, now: new Date().toISOString() },
  );
}

async function readRow(table: "semiote" | "noema", idValue: string): Promise<Record<string, any> | undefined> {
  const rows = await db.query<Record<string, any>>(
    `SELECT * FROM type::record('${table}', $id);`,
    { id: idValue },
  );
  return rows[0]?.[0];
}

function noemaId(value: string): string {
  return value.replace(/^noema:/, "");
}

async function clearTables(): Promise<void> {
  await db.query("DELETE noema; DELETE semiote;");
}

describe.skipIf(!runNative)("Sourcec-N2 native atomic Noema promotion", () => {
  beforeAll(async () => {
    await installEndpointSentinel();
    try {
      port = await freePort();
      server = spawn(
        CLI.path,
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
      await ensurePhase2Schema(db, 3);
      schemaInfo = {
        semiote: await db.query("INFO FOR TABLE semiote;"),
        noema: await db.query("INFO FOR TABLE noema;"),
      };
      expect(JSON.stringify(schemaInfo.semiote)).toContain("processing_lineage");
      expect(JSON.stringify(schemaInfo.noema)).toContain("processing_lineage");
      expect(JSON.stringify(schemaInfo.semiote)).toContain("text_norm");
      expect(JSON.stringify(schemaInfo.noema)).toContain("support_semiote_ids");
    } catch (error) {
      try { await cleanupOwnedResources({ closeSdk: async () => db?.close(), child: server, port, waitForExit, canConnect }); } catch { /* preserve original setup error */ }
      try { await closeEndpointSentinel(); } catch { /* preserve original setup error */ }
      throw error;
    }
  }, 60_000);

  beforeEach(async () => {
    await clearTables();
  });

  afterAll(async () => {
    const errors: Error[] = [];
    try {
      await cleanupOwnedResources({ closeSdk: async () => { if (db) await db.close(); }, child: server, port, waitForExit, canConnect });
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await closeEndpointSentinel();
    } catch (error) {
      errors.push(toError(error));
    }
    if (sentinelConnections !== 0) errors.push(new Error(`native Sourcec-N2 sentinel accepted ${sentinelConnections} unexpected connections`));
    if (errors.length > 0) throw new AggregateError(errors, "native Sourcec-N2 afterAll cleanup failed");
  });

  it("uses exact installed versions and the actual production phase-2 schema", () => {
    expect(CLI.version).toBe("3.1.4");
    expect(SDK_VERSION).toBe("2.0.3");
    expect(JSON.stringify(schemaInfo.semiote)).toContain("processing_lineage.delivery.restrictions");
    expect(JSON.stringify(schemaInfo.noema)).toContain("processing_lineage.delivery.restrictions");
    expect(sentinelConnections).toBe(0);
  });

  it("creates Noema and source markers atomically with every stored support snapshot", async () => {
    const supportA = id("support-a");
    const supportB = id("support-b");
    const source = id("source-create");
    await insertSupport(supportA);
    await insertSupport(supportB);
    await insertSource({ id: source, supportIds: [supportA, supportB] });

    const result = await promoteSemioteToNoema(db, source);

    expect(result.promoted).toBe(true);
    const target = await readRow("noema", noemaId(result.id ?? ""));
    const sourceRow = await readRow("semiote", source);
    expect(target?.user_id).toBe(USER);
    expect(new Set(target?.support_semiote_ids)).toEqual(new Set([source, supportA, supportB]));
    expect(new Set(sourceRow?.payload?.noemaSupportSemioteIds)).toEqual(new Set([source, supportA, supportB]));
    for (const supportId of [source, supportA, supportB]) {
      const row = await readRow("semiote", supportId);
      expect(row?.user_id).toBe(USER);
      expect(row?.processing_lineage).toBeUndefined();
    }
  }, 30_000);

  it("reinforces an existing legacy target without reactivating terminal state", async () => {
    const source = id("source-reinforce");
    await insertSource({ id: source });
    const first = await promoteSemioteToNoema(db, source);
    expect(first.promoted).toBe(true);
    await db.query("UPDATE type::record('noema', $id) SET status = 'superseded', active = false;", { id: noemaId(first.id ?? "") });

    const second = await promoteSemioteToNoema(db, source);

    expect(second).toEqual(expect.objectContaining({ promoted: true, id: first.id }));
    const rows = await db.query<any>("SELECT * FROM noema;");
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]?.[0]?.status).toBe("superseded");
    expect(rows[0]?.[0]?.active).toBe(false);
  }, 30_000);

  it("refuses missing, mixed-user, valid-lineage and invalid-lineage supports before provider or transaction", async () => {
    const cases: Array<{ label: string; supportId: string; setup?: () => Promise<void> }> = [
      { label: "missing", supportId: id("support-missing") },
      { label: "mixed-user", supportId: id("support-mixed"), setup: () => insertSupport(id("support-mixed"), "other-user") },
      { label: "valid-lineage", supportId: id("support-valid"), setup: () => insertSupport(id("support-valid"), USER, lineageFixture("minni_verified")) },
      { label: "invalid-lineage", supportId: id("support-invalid"), setup: () => insertSupport(id("support-invalid"), USER, lineageFixture("forged")) },
    ];
    for (const item of cases) {
      await clearTables();
      await item.setup?.();
      const source = id(`source-${item.label}`);
      await insertSource({ id: source, supportIds: [item.supportId] });
      const embedText = async () => [1, 2, 3];
      const result = await promoteSemioteToNoema(db, source, embedText);
      expect(result).toEqual({ promoted: false, id: null, embeddingWritten: false });
      const targets = await db.query<any>("SELECT * FROM noema;");
      expect(targets[0]).toHaveLength(0);
    }
  }, 30_000);

  it("refuses a changed support snapshot while embedding is pending", async () => {
    const support = id("support-race");
    const source = id("source-support-race");
    await insertSupport(support);
    await insertSource({ id: source, supportIds: [support] });

    await expect(promoteSemioteToNoema(db, source, async () => {
      await db.query("UPDATE type::record('semiote', $id) SET active = false;", { id: support });
      return [1, 2, 3];
    })).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });

    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
  }, 30_000);

  it("rolls back every source marker failure after the production transaction starts", async () => {
    const markerFields = [
      "payload.promotedToNoemaId",
      "payload.noemaSupportSemioteIds",
      "payload.noemaClaimKey",
      "payload.noemaRevisionHash",
      "payload.noemaStatus",
      "payload.noemaStableClaim",
    ];
    for (const [index, field] of markerFields.entries()) {
      await clearTables();
      const source = id(`source-marker-${index}`);
      await insertSource({ id: source });
      await db.query(`DEFINE FIELD ${field} ON TABLE semiote TYPE option<int> ASSERT $value = NONE OR $value = 0;`);
      await expect(promoteSemioteToNoema(db, source)).rejects.toMatchObject({ noemaPromotionOutcome: "rolled_back" });
      expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
      expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
      await db.query(`REMOVE FIELD ${field} ON TABLE semiote;`);
    }
  }, 30_000);

  it("classifies a target collision introduced after metadata preflight", async () => {
    const source = id("source-collision");
    await insertSource({ id: source });
    const originalQuery = db.query.bind(db);
    let armed = true;
    (db as any).query = async (sql: string, variables?: Record<string, unknown>) => {
      const result = await originalQuery(sql, variables);
      if (armed && sql.includes("FROM type::record('noema'") && sql.includes("SELECT id, user_id")) {
        armed = false;
        await originalQuery(
          "CREATE type::record('noema', $id) CONTENT { canonical: { text: 'collision' }, canonical_text: 'collision', canonical_norm: 'collision', claim_key: 'collision', revision_hash: 'collision', support_semiote_ids: [], user_id: $userId, status: 'active', active: true, created_at: <datetime>$now, updated_at: <datetime>$now };",
          { id: variables?.id, userId: USER, now: new Date().toISOString() },
        );
      }
      return result;
    };
    try {
      await expect(promoteSemioteToNoema(db, source)).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });
      expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
    } finally {
      (db as any).query = originalQuery;
    }
  }, 30_000);

  it("classifies an SDK error after commit from full source, target and support readback", async () => {
    const support = id("support-ambiguous");
    const source = id("source-ambiguous");
    await insertSupport(support);
    await insertSource({ id: source, supportIds: [support] });
    const originalTransaction = db.queryTransaction.bind(db);
    (db as any).queryTransaction = async (sql: string, variables: Record<string, unknown>) => {
      await originalTransaction(sql, variables);
      throw new Error("synthetic post-commit transport error");
    };
    try {
      await expect(promoteSemioteToNoema(db, source)).rejects.toMatchObject({ noemaPromotionOutcome: "committed" });
      expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(1);
      expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toMatch(/^noema:/);
      expect((await readRow("semiote", support))?.active).toBe(true);
    } finally {
      (db as any).queryTransaction = originalTransaction;
    }
  }, 30_000);

  it.each(["source", "target", "both"] as const)(
    "does not call a no-effect transaction committed when %s timestamp churn is only a 1ns mismatch",
    async (churn) => {
      const support = id(`support-no-effect-${churn}`);
      const source = id(`source-no-effect-${churn}`);
      await insertSupport(support);
      await insertSource({ id: source, supportIds: [support] });
      const first = await promoteSemioteToNoema(db, source);
      expect(first.promoted).toBe(true);
      const targetId = noemaId(first.id ?? "");
      const originalTransaction = db.queryTransaction.bind(db);
      let expectedPostTimestamp: DateTime | undefined;
      let unrelatedTimestamp: DateTime | undefined;
      (db as any).queryTransaction = async (_sql: string, variables: Record<string, unknown>) => {
        const expected = variables.now instanceof DateTime
          ? variables.now
          : new DateTime(String(variables.now));
        const unrelated = DateTime.fromEpochNanoseconds(expected.nanoseconds + 1n);
        expectedPostTimestamp = expected;
        unrelatedTimestamp = unrelated;
        const sourceTimestamp = churn === "source" || churn === "both" ? unrelated : expected;
        const targetTimestamp = churn === "target" || churn === "both" ? unrelated : expected;
        await db.query(
          "UPDATE type::record('semiote', $sourceId) SET updated_at = <datetime>$sourceTimestamp; UPDATE type::record('noema', $targetId) SET updated_at = <datetime>$targetTimestamp;",
          { sourceId: source, targetId, sourceTimestamp, targetTimestamp },
        );
        throw new Error("synthetic no-effect transaction error");
      };
      try {
        await expect(promoteSemioteToNoema(db, source)).rejects.toMatchObject({
          noemaPromotionOutcome: "inconsistent_or_unresolved",
        });
      } finally {
        (db as any).queryTransaction = originalTransaction;
      }
      expect(expectedPostTimestamp).toBeDefined();
      expect(unrelatedTimestamp).toBeDefined();
      const sourceAfter = await readRow("semiote", source);
      const targetAfter = await readRow("noema", targetId);
      const sourceAfterTimestamp = sourceAfter?.updated_at as DateTime;
      const targetAfterTimestamp = targetAfter?.updated_at as DateTime;
      expect(sourceAfterTimestamp.equals(
        churn === "source" || churn === "both" ? unrelatedTimestamp : expectedPostTimestamp,
      )).toBe(true);
      expect(targetAfterTimestamp.equals(
        churn === "target" || churn === "both" ? unrelatedTimestamp : expectedPostTimestamp,
      )).toBe(true);
    },
  );

  it("bounds a hanging SDK close and still terminates the owned child", async () => {
    const child = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, pid: 17, kill: () => { child.exitCode = 0; return true; } };
    await expect(cleanupOwnedResources({
      closeSdk: () => new Promise<void>(() => {}),
      child,
      port: 1,
      waitForExit: async () => undefined,
      canConnect: async () => false,
    }, 20)).rejects.toThrow(/SDK close timed out/);
    expect(child.exitCode).toBe(0);
  });

  it("preserves a rejected SDK close while completing owned cleanup", async () => {
    const child = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, pid: 18, kill: () => { child.exitCode = 0; return true; } };
    await expect(cleanupOwnedResources({
      closeSdk: async () => { throw new Error("synthetic SDK close rejection"); },
      child,
      port: 1,
      waitForExit: async () => undefined,
      canConnect: async () => false,
    }, 20)).rejects.toThrow(/synthetic SDK close rejection/);
    expect(child.exitCode).toBe(0);
  });
});
