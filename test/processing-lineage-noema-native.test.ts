import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "surrealdb";
import {
  ensurePhase2Schema,
  promoteSemioteToNoema,
  promoteSyntheticForcedMaintenanceToNoema,
  promoteSyntheticScheduledMaintenanceToNoema,
} from "../src/storage/surreal/phase2-store.js";
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
} from "../src/app/processing-policy/authority.js";
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
const VECTOR = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);

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

function lineageFixture(state: string, userId = USER, restrictions: readonly string[] = []): Record<string, unknown> {
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
      disposition: restrictions.length > 0 ? "local_only" : "ordinary",
      restrictions,
    },
  };
}

type ProtectedMaintenanceOperation = "scheduled_maintenance" | "forced_maintenance";

function protectedAuthority(
  operation: ProtectedMaintenanceOperation,
  userId = USER,
  registrationOverrides: { expiresAt?: string } = {},
) {
  const principalRef = `principal.sourcec.n2p.${operation}`;
  const registrationRef = `registration.sourcec.n2p.${operation}`;
  const principal = createServerAuthenticatedProducerPrincipal(principalRef);
  const registration = createTrustedProducerRegistration({
    registrationRef,
    principalRef,
    authorizedOperations: [operation],
    authorizedTargetUsers: [userId],
    ...registrationOverrides,
  });
  const authority = createProducerAuthority([registration]);
  const admission = authority.resolve({
    principal,
    operation: createServerSelectedProducerOperation(operation),
    targetUser: createServerResolvedTargetUser(userId),
  });
  if (!admission.ok) throw new Error(`native protected authority admission failed: ${admission.reason}`);
  const minted = mintProcessingLineage(authority, admission.context, syntheticProducerDeliveryResolver);
  if (!minted.ok) throw new Error(`native protected authority mint failed: ${minted.reason}`);
  return { authority, minted, registrationRef };
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
         noemaSupportSemioteIds: $supportIds,
         userId: $userId,
         active: true
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
       payload: { l2: "Synthetic support", l0: "Synthetic support", category: "support", confidence: 0.8, userId: $userId, active: true },
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

type ProtectedIdentityVariant =
  | "missing-root"
  | "missing-payload"
  | "null-root"
  | "null-payload"
  | "wrong-root-type"
  | "wrong-payload-type"
  | "disagreeing"
  | "foreign";

async function insertIdentityVariant(idValue: string, variant: ProtectedIdentityVariant): Promise<boolean> {
  const rootClause = variant === "missing-root" ? "" : "user_id: $rootUserId,";
  const rootUserId = variant === "null-root" ? null
    : variant === "wrong-root-type" ? 42
      : variant === "foreign" ? "other-user" : USER;
  const payloadUserId = variant === "missing-payload" ? undefined
    : variant === "null-payload" ? null
      : variant === "wrong-payload-type" ? 42
        : variant === "disagreeing" || variant === "foreign" ? "other-user" : USER;
  try {
    await db.query(
      `CREATE type::record('semiote', $id) CONTENT {
         payload: { userId: $payloadUserId, l2: "Synthetic identity fixture", l0: "Synthetic identity fixture", category: "support", confidence: 0.8, active: true },
         ${rootClause}
         scope: "user",
         path: "/synthetic/identity",
         memory_role: "current_status",
         active: true,
         created_at: <datetime>$now,
         updated_at: <datetime>$now,
         processing_lineage: $lineage
       };`,
      { id: idValue, rootUserId, payloadUserId, lineage: lineageFixture("minni_verified"), now: new Date().toISOString() },
    );
    return true;
  } catch {
    return false;
  }
}

async function readRow(table: "semiote" | "noema", idValue: string): Promise<Record<string, any> | undefined> {
  const rows = await db.query<Record<string, any>>(
    `SELECT * FROM type::record('${table}', $id);`,
    { id: idValue },
  );
  return rows[0]?.[0];
}

function canonicalNativeRow(value: unknown): unknown {
  if (value instanceof DateTime) return { __datetime: value.toJSON() };
  if (Array.isArray(value)) return value.map((item) => canonicalNativeRow(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalNativeRow((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function nativeRowSnapshot(value: unknown): string {
  return JSON.stringify(canonicalNativeRow(value));
}

function infoIndexText(raw: unknown, indexName: string): string {
  const outer = Array.isArray(raw) ? raw[0] : raw;
  const value = Array.isArray(outer) ? outer[0] : outer;
  const indexes = value && typeof value === "object" ? (value as { indexes?: unknown }).indexes : undefined;
  const entry = Array.isArray(indexes)
    ? indexes.find((candidate) => candidate && typeof candidate === "object" && (candidate as { name?: unknown }).name === indexName)
    : indexes && typeof indexes === "object" ? (indexes as Record<string, unknown>)[indexName] : undefined;
  return typeof entry === "string" ? entry : JSON.stringify(entry ?? "");
}

function expectProductionEmbeddingIndexes(schema: { semiote: unknown; noema: unknown }): void {
  for (const [table, info, indexName] of [
    ["semiote", schema.semiote, "idx_semiote_embedding"],
    ["noema", schema.noema, "idx_noema_embedding"],
  ] as const) {
    const definition = infoIndexText(info, indexName).replace(/\s+/g, " ").toUpperCase();
    expect(definition, `${table} ${indexName}`).toMatch(/\bHNSW\b/);
    expect(definition, `${table} ${indexName}`).toMatch(/\bDIMENSION\s+768\b/);
    expect(definition, `${table} ${indexName}`).toMatch(/\bDIST\s+COSINE\b/);
    expect(definition, `${table} ${indexName}`).toMatch(/\bTYPE\s+F32\b/);
  }
}

function injectTransactionFailureAfter(sql: string, marker: string, message: string): string {
  const markerIndex = sql.indexOf(marker);
  if (markerIndex < 0) throw new Error(`native P injection marker missing: ${marker}`);
  const statementEnd = sql.indexOf("};", markerIndex);
  if (statementEnd < 0) throw new Error(`native P injection end missing: ${marker}`);
  const insertion = statementEnd + 2;
  return `${sql.slice(0, insertion)}\nTHROW "${message}";\n${sql.slice(insertion)}`;
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
      await ensurePhase2Schema(db, 768);
      schemaInfo = {
        semiote: await db.query("INFO FOR TABLE semiote;"),
        noema: await db.query("INFO FOR TABLE noema;"),
      };
      expectProductionEmbeddingIndexes(schemaInfo);
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

  it("records production-schema identity write failures and refuses persisted source/support variants", async () => {
    const variants: ProtectedIdentityVariant[] = [
      "missing-root",
      "missing-payload",
      "null-root",
      "null-payload",
      "wrong-root-type",
      "wrong-payload-type",
      "disagreeing",
      "foreign",
    ];
    for (const variant of variants) {
      await clearTables();
      const fixture = protectedAuthority("scheduled_maintenance");
      const source = id(`identity-source-${variant}`);
      const inserted = await insertIdentityVariant(source, variant);
      if (!inserted) {
        expect(await readRow("semiote", source)).toBeUndefined();
        continue;
      }
      await expect(promoteSyntheticScheduledMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ reason: "target_user_mismatch" });
      expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
      expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
    }

    for (const variant of variants) {
      await clearTables();
      const fixture = protectedAuthority("forced_maintenance");
      const support = id(`identity-support-${variant}`);
      const source = id(`identity-support-source-${variant}`);
      await insertSource({ id: source, supportIds: [support], lineage: lineageFixture("minni_verified") });
      const inserted = await insertIdentityVariant(support, variant);
      if (!inserted) {
        expect(await readRow("semiote", support)).toBeUndefined();
        continue;
      }
      await expect(promoteSyntheticForcedMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ reason: "target_user_mismatch" });
      expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
      expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
    }
  }, 60_000);

  it.each([
    "scheduled_maintenance",
    "forced_maintenance",
  ] as const)("writes the protected %s plan with every capture support", async (operation) => {
    const fixture = protectedAuthority(operation);
    const supportA = id(`protected-${operation}-support-a`);
    const supportB = id(`protected-${operation}-support-b`);
    const source = id(`protected-${operation}-source`);
    await insertSupport(supportA, USER, lineageFixture("minni_verified", USER, ["audio_derived"]));
    await insertSupport(supportB, USER, lineageFixture("minni_verified", USER, ["excluded_source", "producer_local_only"]));
    await insertSource({ id: source, supportIds: [supportA, supportB], lineage: lineageFixture("minni_verified") });

    const result = operation === "scheduled_maintenance"
      ? await promoteSyntheticScheduledMaintenanceToNoema(db, fixture.authority, fixture.minted, USER, source)
      : await promoteSyntheticForcedMaintenanceToNoema(db, fixture.authority, fixture.minted, USER, source);

    expect(result).toEqual(expect.objectContaining({ promoted: true, operation, embeddingWritten: false }));
    const target = await readRow("noema", noemaId(result.id ?? ""));
    const sourceRow = await readRow("semiote", source);
    expect(target?.user_id).toBe(USER);
    expect(target?.processing_lineage?.admitted_operation).toBe("capture_ingest");
    expect(new Set(target?.processing_lineage?.delivery?.restrictions)).toEqual(
      new Set(["audio_derived", "excluded_source", "producer_local_only"]),
    );
    expect(new Set(target?.support_semiote_ids)).toEqual(new Set([source, supportA, supportB]));
    expect(new Set(sourceRow?.payload?.noemaSupportSemioteIds)).toEqual(new Set([source, supportA, supportB]));
    expect(sourceRow?.payload?.noemaStatus).toBe(target?.status);
    for (const supportId of [supportA, supportB]) {
      const support = await readRow("semiote", supportId);
      expect(support?.processing_lineage?.admitted_operation).toBe("capture_ingest");
      expect(support?.active).toBe(true);
    }
  }, 30_000);

  it("rolls back after every generated target/support/source statement on fresh and existing branches", async () => {
    const markers = ["$noemaRows", "$supportRows0", "$supportRows1", "$sourceRows"];
    for (const existing of [false, true]) {
      const suffix = existing ? "existing" : "fresh";
      const supportA = id(`statement-${suffix}-support-a`);
      const supportB = id(`statement-${suffix}-support-b`);
      const source = id(`statement-${suffix}-source`);
      let fixture = protectedAuthority("scheduled_maintenance");
      await insertSupport(supportA, USER, lineageFixture("minni_verified", USER, ["audio_derived"]));
      await insertSupport(supportB, USER, lineageFixture("minni_verified", USER, ["excluded_source"]));
      await insertSource({ id: source, supportIds: [supportA, supportB], lineage: lineageFixture("minni_verified") });
      const first = await promoteSyntheticScheduledMaintenanceToNoema(db, fixture.authority, fixture.minted, USER, source);
      const targetId = noemaId(first.id);
      if (!existing) {
        await clearTables();
        fixture = protectedAuthority("scheduled_maintenance");
        await insertSupport(supportA, USER, lineageFixture("minni_verified", USER, ["audio_derived"]));
        await insertSupport(supportB, USER, lineageFixture("minni_verified", USER, ["excluded_source"]));
        await insertSource({ id: source, supportIds: [supportA, supportB], lineage: lineageFixture("minni_verified") });
      } else {
        fixture = protectedAuthority("scheduled_maintenance");
      }
      const sourceBefore = await readRow("semiote", source);
      const supportABefore = await readRow("semiote", supportA);
      const supportBBefore = await readRow("semiote", supportB);
      const targetBefore = await readRow("noema", targetId);
      const originalTransaction = db.queryTransaction.bind(db);
      for (const [index, marker] of markers.entries()) {
        (db as any).queryTransaction = async (sql: string, variables: Record<string, unknown>) =>
          originalTransaction(injectTransactionFailureAfter(sql, marker, `P statement failure ${suffix}-${index}`), variables);
        try {
          await expect(promoteSyntheticScheduledMaintenanceToNoema(db, fixture.authority, fixture.minted, USER, source))
            .rejects.toMatchObject({ noemaPromotionOutcome: "rolled_back" });
        } finally {
          (db as any).queryTransaction = originalTransaction;
        }
        expect(nativeRowSnapshot(await readRow("semiote", source))).toBe(nativeRowSnapshot(sourceBefore));
        expect(nativeRowSnapshot(await readRow("semiote", supportA))).toBe(nativeRowSnapshot(supportABefore));
        expect(nativeRowSnapshot(await readRow("semiote", supportB))).toBe(nativeRowSnapshot(supportBBefore));
        expect(nativeRowSnapshot(await readRow("noema", targetId))).toBe(nativeRowSnapshot(targetBefore));
      }
      await clearTables();
    }
  }, 60_000);

  it("refuses wrong-user and copied minted authority before any protected mutation", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const source = id("protected-authority-source");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });

    await expect(promoteSyntheticScheduledMaintenanceToNoema(
      db,
      fixture.authority,
      fixture.minted,
      "other-user",
      source,
    )).rejects.toMatchObject({ reason: "target_user_mismatch" });
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();

    const copied = JSON.parse(JSON.stringify(fixture.minted));
    await expect(promoteSyntheticScheduledMaintenanceToNoema(
      db,
      fixture.authority,
      copied,
      USER,
      source,
    )).rejects.toMatchObject({ reason: "lineage_invalid" });
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
  }, 30_000);

  it("refuses wrong authority, literal operation mismatch, expiry, and replaced grants", async () => {
    const source = id("protected-authority-matrix-source");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });
    const scheduled = protectedAuthority("scheduled_maintenance");
    const otherAuthority = protectedAuthority("scheduled_maintenance");

    await expect(promoteSyntheticScheduledMaintenanceToNoema(
      db,
      otherAuthority.authority,
      scheduled.minted,
      USER,
      source,
    )).rejects.toMatchObject({ reason: "authority_mismatch" });

    await expect(promoteSyntheticForcedMaintenanceToNoema(
      db,
      scheduled.authority,
      scheduled.minted,
      USER,
      source,
    )).rejects.toMatchObject({ reason: "operation_mismatch" });

    replaceProducerRegistration(
      scheduled.authority,
      createTrustedProducerRegistration({
        registrationRef: scheduled.registrationRef,
        principalRef: "principal.sourcec.n2p.scheduled_maintenance",
        authorizedOperations: ["scheduled_maintenance"],
        authorizedTargetUsers: [USER],
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    await expect(promoteSyntheticScheduledMaintenanceToNoema(
      db,
      scheduled.authority,
      scheduled.minted,
      USER,
      source,
    )).rejects.toMatchObject({ reason: "registration_expired" });

    const replaced = protectedAuthority("forced_maintenance");
    replaceProducerRegistration(
      replaced.authority,
      createTrustedProducerRegistration({
        registrationRef: replaced.registrationRef,
        principalRef: "principal.sourcec.n2p.forced_maintenance",
        authorizedOperations: ["capture_ingest"],
        authorizedTargetUsers: [USER],
      }),
    );
    await expect(promoteSyntheticForcedMaintenanceToNoema(
      db,
      replaced.authority,
      replaced.minted,
      USER,
      source,
    )).rejects.toMatchObject({ reason: "operation_not_authorized" });
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
  }, 30_000);

  it("refuses missing, mixed-user, and invalid stored supports before the protected transaction", async () => {
    const cases: Array<{ label: string; supportId: string; setup?: () => Promise<void>; reason: string }> = [
      { label: "missing", supportId: id("protected-support-missing"), reason: "lineage_invalid" },
      {
        label: "mixed-user",
        supportId: id("protected-support-mixed"),
        setup: () => insertSupport(id("protected-support-mixed"), "other-user", lineageFixture("minni_verified", "other-user")),
        reason: "target_user_mismatch",
      },
      {
        label: "invalid-lineage",
        supportId: id("protected-support-invalid"),
        setup: () => insertSupport(id("protected-support-invalid"), USER, lineageFixture("forged")),
        reason: "lineage_invalid",
      },
    ];
    for (const item of cases) {
      await clearTables();
      await item.setup?.();
      const fixture = protectedAuthority("scheduled_maintenance");
      const source = id(`protected-support-source-${item.label}`);
      await insertSource({ id: source, supportIds: [item.supportId], lineage: lineageFixture("minni_verified") });
      await expect(promoteSyntheticScheduledMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ reason: item.reason });
      expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
      expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
    }
  }, 30_000);

  it("classifies a support snapshot race without reporting a false commit", async () => {
    const fixture = protectedAuthority("forced_maintenance");
    const support = id("protected-support-race");
    const source = id("protected-source-race");
    await insertSupport(support, USER, lineageFixture("minni_verified"));
    await insertSource({ id: source, supportIds: [support], lineage: lineageFixture("minni_verified") });
    const originalQuery = db.query.bind(db);
    let armed = true;
    (db as any).query = async (sql: string, variables?: Record<string, unknown>) => {
      const result = await originalQuery(sql, variables);
      if (armed && sql.includes("SELECT id, user_id") && variables?.id === support) {
        armed = false;
        await originalQuery("UPDATE type::record('semiote', $id) SET active = false;", { id: support });
      }
      return result;
    };
    try {
      await expect(promoteSyntheticForcedMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });
    } finally {
      (db as any).query = originalQuery;
    }
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
    expect((await readRow("semiote", support))?.active).toBe(false);
  }, 30_000);

  it("classifies a source CAS zero-row race without reporting a false commit", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const source = id("protected-source-cas-race");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });
    const originalQuery = db.query.bind(db);
    let armed = true;
    (db as any).query = async (sql: string, variables?: Record<string, unknown>) => {
      const result = await originalQuery(sql, variables);
      if (armed && sql.includes("SELECT id, user_id") && variables?.id === source) {
        armed = false;
        await originalQuery("UPDATE type::record('semiote', $id) SET active = false;", { id: source });
      }
      return result;
    };
    try {
      await expect(promoteSyntheticScheduledMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });
    } finally {
      (db as any).query = originalQuery;
    }
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
    expect((await readRow("semiote", source))?.active).toBe(false);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
  }, 30_000);

  it("classifies a fresh target collision after preflight without overwriting it", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const source = id("protected-collision-source");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });
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
      await expect(promoteSyntheticScheduledMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });
    } finally {
      (db as any).query = originalQuery;
    }
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(1);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
  }, 30_000);

  it("revalidates a revoked registration after all preflight awaits", async () => {
    const fixture = protectedAuthority("forced_maintenance");
    const source = id("protected-revocation-source");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });
    const originalQuery = db.query.bind(db);
    let armed = true;
    (db as any).query = async (sql: string, variables?: Record<string, unknown>) => {
      const result = await originalQuery(sql, variables);
      if (armed && sql.includes("FROM type::record('noema'") && sql.includes("SELECT id, user_id")) {
        armed = false;
        revokeProducerRegistration(fixture.authority, fixture.registrationRef);
      }
      return result;
    };
    try {
      await expect(promoteSyntheticForcedMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ reason: "registration_revoked" });
    } finally {
      (db as any).query = originalQuery;
    }
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toBeUndefined();
  }, 30_000);

  it("reinforces a protected target without reactivating terminal state", async () => {
    const firstFixture = protectedAuthority("scheduled_maintenance");
    const source = id("protected-terminal-source");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });
    const first = await promoteSyntheticScheduledMaintenanceToNoema(
      db,
      firstFixture.authority,
      firstFixture.minted,
      USER,
      source,
    );
    await db.query("UPDATE type::record('noema', $id) SET status = 'superseded', active = false;", {
      id: noemaId(first.id ?? ""),
    });
    const secondFixture = protectedAuthority("scheduled_maintenance");
    const second = await promoteSyntheticScheduledMaintenanceToNoema(
      db,
      secondFixture.authority,
      secondFixture.minted,
      USER,
      source,
    );
    expect(second).toEqual(expect.objectContaining({ promoted: true, id: first.id }));
    const rows = await db.query<any>("SELECT * FROM noema;");
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]?.[0]?.status).toBe("superseded");
    expect(rows[0]?.[0]?.active).toBe(false);
  }, 30_000);

  it("refuses an existing unlineaged target instead of retroactively claiming it", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const source = id("protected-unlineaged-target-source");
    await insertSource({ id: source, lineage: lineageFixture("minni_verified") });
    const first = await promoteSyntheticScheduledMaintenanceToNoema(
      db,
      fixture.authority,
      fixture.minted,
      USER,
      source,
    );
    await db.query("UPDATE type::record('noema', $id) SET processing_lineage = NONE;", {
      id: noemaId(first.id ?? ""),
    });
    await expect(promoteSyntheticScheduledMaintenanceToNoema(
      db,
      fixture.authority,
      fixture.minted,
      USER,
      source,
    )).rejects.toMatchObject({ reason: "lineage_invalid" });
    const target = await readRow("noema", noemaId(first.id ?? ""));
    expect(target?.processing_lineage).toBeUndefined();
    expect(target?.status).toBe("active");
  }, 30_000);

  it("creates Noema and source markers atomically with every stored support snapshot", async () => {
    const supportA = id("support-a");
    const supportB = id("support-b");
    const source = id("source-create");
    await insertSupport(supportA);
    await insertSupport(supportB);
    await insertSource({ id: source, supportIds: [supportA, supportB] });

    const result = await promoteSemioteToNoema(db, source);

    expect(result.promoted).toBe(true);
    expect(result.embeddingWritten).toBe(false);
    const target = await readRow("noema", noemaId(result.id ?? ""));
    const sourceRow = await readRow("semiote", source);
    expect(target?.user_id).toBe(USER);
    expect(target?.embedding).toBeUndefined();
    expect(new Set(target?.support_semiote_ids)).toEqual(new Set([source, supportA, supportB]));
    expect(new Set(sourceRow?.payload?.noemaSupportSemioteIds)).toEqual(new Set([source, supportA, supportB]));
    for (const supportId of [source, supportA, supportB]) {
      const row = await readRow("semiote", supportId);
      expect(row?.user_id).toBe(USER);
      expect(row?.processing_lineage).toBeUndefined();
    }
  }, 30_000);

  it("persists and reads back an exact 768-element ordinary promotion vector", async () => {
    const support = id("support-positive-embedding");
    const source = id("source-positive-embedding");
    await insertSupport(support);
    await insertSource({ id: source, supportIds: [support] });
    let embedCalls = 0;
    const result = await promoteSemioteToNoema(db, source, async () => {
      embedCalls += 1;
      return [...VECTOR];
    });
    expect(result).toEqual(expect.objectContaining({ promoted: true, embeddingWritten: true }));
    expect(embedCalls).toBe(1);
    const target = await readRow("noema", noemaId(result.id ?? ""));
    expect(target?.embedding).toHaveLength(768);
    expect(target?.embedding?.[0]).toBe(1);
    expect(target?.embedding?.slice(1).every((value: unknown) => value === 0)).toBe(true);
    expect((await readRow("semiote", source))?.payload?.promotedToNoemaId).toMatch(/^noema:/);
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
      let embedCalls = 0;
      const embedText = async () => {
        embedCalls += 1;
        return [...VECTOR];
      };
      const result = await promoteSemioteToNoema(db, source, embedText);
      expect(result).toEqual({ promoted: false, id: null, embeddingWritten: false });
      expect(embedCalls).toBe(0);
      const targets = await db.query<any>("SELECT * FROM noema;");
      expect(targets[0]).toHaveLength(0);
    }
  }, 30_000);

  it("refuses a changed support snapshot while embedding is pending", async () => {
    const support = id("support-race");
    const source = id("source-support-race");
    await insertSupport(support);
    await insertSource({ id: source, supportIds: [support] });

    const sourceBefore = await readRow("semiote", source);
    const supportBefore = await readRow("semiote", support);
    let embedCalls = 0;
    let supportAfterCallbackSnapshot: string | undefined;
    await expect(promoteSemioteToNoema(db, source, async () => {
      await db.query("UPDATE type::record('semiote', $id) SET active = false;", { id: support });
      supportAfterCallbackSnapshot = nativeRowSnapshot(await readRow("semiote", support));
      embedCalls += 1;
      return [...VECTOR];
    })).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });

    expect(embedCalls).toBe(1);
    expect((await db.query<any>("SELECT * FROM noema;"))[0]).toHaveLength(0);
    expect(nativeRowSnapshot(await readRow("semiote", source))).toBe(nativeRowSnapshot(sourceBefore));
    expect(supportAfterCallbackSnapshot).toBeDefined();
    expect(supportAfterCallbackSnapshot).not.toBe(nativeRowSnapshot(supportBefore));
    expect(nativeRowSnapshot(await readRow("semiote", support))).toBe(supportAfterCallbackSnapshot);
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

  it("rolls back every protected source marker failure with full row cleanup", async () => {
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
      const fixture = protectedAuthority("scheduled_maintenance");
      const support = id(`protected-marker-support-${index}`);
      const source = id(`protected-marker-${index}`);
      await insertSupport(support, USER, lineageFixture("minni_verified"));
      await insertSource({ id: source, supportIds: [support], lineage: lineageFixture("minni_verified") });
      const sourceBefore = await readRow("semiote", source);
      const supportBefore = await readRow("semiote", support);
      const targetsBefore = await db.query<any>("SELECT * FROM noema;");
      expect(targetsBefore[0]).toHaveLength(0);
      await db.query(`DEFINE FIELD ${field} ON TABLE semiote TYPE option<int> ASSERT $value = NONE OR $value = 0;`);
      try {
        await expect(promoteSyntheticScheduledMaintenanceToNoema(
          db,
          fixture.authority,
          fixture.minted,
          USER,
          source,
        )).rejects.toMatchObject({ noemaPromotionOutcome: "rolled_back" });
      } finally {
        await db.query(`REMOVE FIELD ${field} ON TABLE semiote;`);
      }
      const targetsAfter = await db.query<any>("SELECT * FROM noema;");
      expect(targetsAfter[0]).toHaveLength(0);
      const sourceAfter = await readRow("semiote", source);
      const supportAfter = await readRow("semiote", support);
      expect(nativeRowSnapshot(sourceAfter)).toBe(nativeRowSnapshot(sourceBefore));
      expect(nativeRowSnapshot(supportAfter)).toBe(nativeRowSnapshot(supportBefore));
      expect(sourceAfter?.payload?.promotedToNoemaId).toBeUndefined();
      expect(sourceAfter?.payload?.noemaSupportSemioteIds).toEqual([support]);
      expect(sourceAfter?.payload?.noemaClaimKey).toBeUndefined();
      expect(sourceAfter?.payload?.noemaRevisionHash).toBeUndefined();
      expect(sourceAfter?.payload?.noemaStatus).toBeUndefined();
      expect(sourceAfter?.payload?.noemaStableClaim).toBeUndefined();
      expect(sourceAfter).toMatchObject({
        user_id: sourceBefore?.user_id,
        active: sourceBefore?.active,
        processing_lineage: sourceBefore?.processing_lineage,
        payload: expect.objectContaining({
          l2: sourceBefore?.payload?.l2,
          active: sourceBefore?.payload?.active,
          noemaSupportSemioteIds: [support],
        }),
      });
      expect(supportAfter).toMatchObject({
        user_id: supportBefore?.user_id,
        active: supportBefore?.active,
        processing_lineage: supportBefore?.processing_lineage,
        payload: expect.objectContaining({ l2: supportBefore?.payload?.l2, active: supportBefore?.payload?.active }),
      });
    }
  }, 60_000);

  it("rejects protected no-effect transactions with exact 1ns timestamp churn", async () => {
    const fixture = protectedAuthority("forced_maintenance");
    const support = id("protected-no-effect-support");
    const source = id("protected-no-effect-source");
    await insertSupport(support, USER, lineageFixture("minni_verified"));
    await insertSource({ id: source, supportIds: [support], lineage: lineageFixture("minni_verified") });
    const first = await promoteSyntheticForcedMaintenanceToNoema(
      db,
      fixture.authority,
      fixture.minted,
      USER,
      source,
    );
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
      await db.query(
        "UPDATE type::record('semiote', $sourceId) SET updated_at = <datetime>$sourceTimestamp; UPDATE type::record('noema', $targetId) SET updated_at = <datetime>$targetTimestamp;",
        { sourceId: source, targetId, sourceTimestamp: unrelated, targetTimestamp: unrelated },
      );
      throw new Error("synthetic protected no-effect transaction error");
    };
    try {
      await expect(promoteSyntheticForcedMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ noemaPromotionOutcome: "inconsistent_or_unresolved" });
    } finally {
      (db as any).queryTransaction = originalTransaction;
    }
    expect(expectedPostTimestamp).toBeDefined();
    expect(unrelatedTimestamp).toBeDefined();
    const sourceAfter = await readRow("semiote", source);
    const targetAfter = await readRow("noema", targetId);
    expect((sourceAfter?.updated_at as DateTime).equals(unrelatedTimestamp)).toBe(true);
    expect((targetAfter?.updated_at as DateTime).equals(unrelatedTimestamp)).toBe(true);
    expect((sourceAfter?.updated_at as DateTime).equals(expectedPostTimestamp)).toBe(false);
    expect((targetAfter?.updated_at as DateTime).equals(expectedPostTimestamp)).toBe(false);
    expect((await readRow("semiote", support))?.active).toBe(true);
  }, 30_000);

  it("classifies a post-commit SDK error from full protected readback", async () => {
    const fixture = protectedAuthority("scheduled_maintenance");
    const support = id("protected-post-commit-support");
    const source = id("protected-post-commit-source");
    await insertSupport(support, USER, lineageFixture("minni_verified"));
    await insertSource({ id: source, supportIds: [support], lineage: lineageFixture("minni_verified") });
    const originalTransaction = db.queryTransaction.bind(db);
    (db as any).queryTransaction = async (sql: string, variables: Record<string, unknown>) => {
      await originalTransaction(sql, variables);
      throw new Error("synthetic protected post-commit transport error");
    };
    try {
      await expect(promoteSyntheticScheduledMaintenanceToNoema(
        db,
        fixture.authority,
        fixture.minted,
        USER,
        source,
      )).rejects.toMatchObject({ noemaPromotionOutcome: "committed" });
    } finally {
      (db as any).queryTransaction = originalTransaction;
    }
    const targets = await db.query<any>("SELECT * FROM noema;");
    expect(targets[0]).toHaveLength(1);
    const target = targets[0]?.[0];
    const sourceAfter = await readRow("semiote", source);
    const supportAfter = await readRow("semiote", support);
    expect(target?.processing_lineage?.admitted_operation).toBe("capture_ingest");
    expect(new Set(target?.support_semiote_ids)).toEqual(new Set([source, support]));
    expect(sourceAfter?.payload?.promotedToNoemaId).toBe(`noema:${target?.id?.id ?? target?.id}`);
    expect(sourceAfter?.payload?.noemaSupportSemioteIds).toEqual(expect.arrayContaining([source, support]));
    expect(supportAfter?.processing_lineage?.admitted_operation).toBe("capture_ingest");
    expect(supportAfter?.active).toBe(true);
  }, 30_000);

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
