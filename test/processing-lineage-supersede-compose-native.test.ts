import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime, RecordId, Uuid, type Surreal as SurrealClient } from "surrealdb";
import {
  composePreparedSupersedeBatch,
  composeUpsertMemory,
  findSimilarMemories,
  getMemoryById,
  listMemories,
  prepareSupersedeMemory,
  supersedeMemory,
  SurrealClient as ExportedSurrealClient,
  upsertMemory,
  type PreparedGenericSupersede,
} from "../src/storage/surreal/surreal-store.js";
import { ensureMemoryEnrichmentSchema } from "../src/storage/surreal/memory-schema-bootstrap.js";
import { ensurePhase2Schema } from "../src/storage/surreal/phase2-store.js";
import type { SimilarCandidate } from "../src/domain/memory/types.js";
import { getSearchHitLineage } from "../src/domain/memory/search-hit-lineage.js";

// This fixture owns one loopback MEMORY process and uses synthetic rows only.
// It never selects an endpoint, credential, namespace, or database from config.
const TABLE = "semiote";
const PASSWORD = "h1-safe-supersede-synthetic";
const USER = "h1-safe-supersede-user";
const VECTOR = Array.from({ length: 768 }, (_, index) => [0.11, 0.22, 0.33][index % 3]);
const PRESENT_LINEAGE = {
  state: "minni_verified",
  origin: "synthetic-h1-test",
  producer_principal_ref: "h1-test-principal",
  producer_registration_ref: "h1-test-registration",
  processing_policy_version: "v1",
  admitted_operation: "h1-test-operation",
  target_user_id: USER,
  delivery: {
    version: "v1",
    disposition: "ordinary",
    restrictions: [],
  },
};
const RUN_ID = `h1_supersede_${process.pid}_${randomUUID().replaceAll("-", "_")}`;
const SENTINEL_ENV_KEYS = [
  "SURREAL_URL",
  "SURREAL_USER",
  "SURREAL_PASS",
  "SURREAL_NS",
  "SURREAL_DB",
  "SURREAL_DATABASE",
] as const;
const CLEANUP_DEADLINE_MS = 2_000;

type Row = {
  [key: string]: unknown;
  id?: unknown;
  active?: boolean;
  supersedes?: unknown;
  superseded_by?: unknown;
  supersede_provenance?: unknown;
  inactive_reason?: unknown;
  payload?: Record<string, unknown>;
};

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

function id(label: string): string {
  return `${RUN_ID}_${label}`;
}

function previousCandidate(memoryId: string): SimilarCandidate {
  return {
    id: memoryId,
    l2: `previous ${memoryId}`,
    similarity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    scope: "user",
  };
}

function replacement(memoryId: string, metadata: Record<string, unknown> = {}) {
  return {
    id: memoryId,
    l2: `replacement ${memoryId}`,
    userId: USER,
    embedding: [...VECTOR],
    metadata,
    scope: "user" as const,
    writeSource: "session_summary" as const,
  };
}

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
  if (!/^\d+\.\d+\.\d+$/.test(token)) throw new Error(`surreal CLI version output has no version token: ${output.trim()}`);
  if (token !== "3.1.4") throw new Error(`H1 fixture requires SurrealDB 3.1.4; resolved ${token}`);
  return token;
}

function resolvedSurrealBinary(): { path: string; version: string } {
  const path = "/usr/local/bin/surreal";
  if (!existsSync(path)) throw new Error("reviewed surreal CLI path is unavailable");
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
  if (!port) throw new Error("H1 fixture did not allocate a loopback port");
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
  throw new Error(`H1 fixture did not listen on ${port}`);
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
  if (socketOpen) errors.push(new Error("H1 fixture left its owned loopback socket open"));
  if (child && child.exitCode === null && child.signalCode === null) errors.push(new Error("H1 fixture left its owned Surreal process alive"));
  console.log(`H1 cleanup ownedPid=${child?.pid ?? "none"} processAlive=${child ? child.exitCode === null && child.signalCode === null : false} socketOpen=${socketOpen}`);
  if (errors.length > 0) throw new AggregateError(errors, "H1 owned cleanup failed");
}

function fakeCleanupChild(): { child: OwnedChild; signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 99124,
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals): boolean {
      if (signal) signals.push(signal);
      if (signal === "SIGKILL") child.signalCode = signal;
      return true;
    },
  } satisfies OwnedChild;
  return { child, signals };
}

async function hangingChildWait(child: OwnedChild): Promise<void> {
  if (child.signalCode === "SIGKILL") return;
  await new Promise<void>(() => {});
}

function assertFixtureConfigurationIsolation(source: string): void {
  const configKeys = "URL|USER|PASS|NS|DB|DATABASE";
  const directReads = source.split(/\r?\n/).filter((line) =>
    new RegExp(`process\\.env\\.SURREAL_(?:${configKeys})(?!\\s*=)`).test(line),
  );
  expect(directReads).toEqual([]);
  expect(source).not.toMatch(new RegExp(`process\\.env\\s*\\[\\s*["']SURREAL_(?:${configKeys})`));
  expect(source).not.toMatch(new RegExp(`process\\.env\\s*\\?\\?`));
  expect(source).not.toContain(["dot", "env"].join(""));
  for (const token of [["application", "Config"], ["load", "Config"], ["read", "Config"]].map((parts) => parts.join(""))) {
    expect(source).not.toContain(token);
  }
}

const SDK_VERSION = resolvedPackageVersion("surrealdb");
let db: ExportedSurrealClient;
let server: ChildProcess | undefined;
let port = 0;
let sentinelServer: ReturnType<typeof createServer> | undefined;
let sentinelPort = 0;
let sentinelConnections = 0;
let sentinelEnvironmentInstalled = false;
const sentinelSockets = new Set<Socket>();
const savedSentinelEnvironment: Partial<Record<(typeof SENTINEL_ENV_KEYS)[number], string | undefined>> = {};

async function installEndpointSentinel(): Promise<void> {
  sentinelServer = createServer((socket) => {
    sentinelConnections += 1;
    sentinelSockets.add(socket);
    socket.once("close", () => sentinelSockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    sentinelServer!.once("error", reject);
    sentinelServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = sentinelServer.address();
  sentinelPort = typeof address === "object" && address ? address.port : 0;
  if (!sentinelPort) throw new Error("H1 sentinel did not allocate a port");
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
          sentinelServer!.close((error) => error ? reject(error) : resolve());
        }));
      } catch (error) {
        errors.push(toError(error));
        const closeAllConnections = (sentinelServer as typeof sentinelServer & { closeAllConnections?: () => void }).closeAllConnections;
        closeAllConnections?.();
      }
    }
    if (sentinelServer?.listening) errors.push(new Error("sentinel listener remained open"));
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
  if (errors.length > 0) throw new AggregateError(errors, "H1 sentinel cleanup failed");
}

async function stopOwnedProcess(): Promise<void> {
  await cleanupOwnedResources({
    closeSdk: async () => { if (db) await db.close(); },
    child: server,
    port,
    waitForExit: (child) => waitForExit(child as ChildProcess),
    canConnect,
  });
}

async function readRow(memoryId: string): Promise<Row | undefined> {
  const result = await db.query<Row>(
    `SELECT * FROM type::record('${TABLE}', $id);`,
    { id: memoryId },
  );
  return result[0]?.[0];
}

async function castServerClock(value: unknown): Promise<DateTime> {
  if (typeof value !== "string") throw new Error("native H1 expected a generated payload clock string");
  const result = await db.query<DateTime>(
    "RETURN <datetime>$clock;",
    { clock: value },
  );
  const clock = result[0]?.[0];
  if (!(clock instanceof DateTime)) throw new Error("native H1 server clock cast did not return DateTime");
  return clock;
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { kind: "undefined" };
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return { kind: "bigint", value: value.toString() };
  if (value instanceof DateTime) {
    const [seconds, nanoseconds] = value.toCompact();
    return { kind: "datetime", seconds: seconds.toString(), nanoseconds: nanoseconds.toString() };
  }
  if (value instanceof Date) return { kind: "date", value: value.toISOString() };
  if (value instanceof Uuid) return { kind: "uuid", value: value.toString() };
  if (value instanceof RecordId) {
    return { kind: "record-id", table: value.table.name, id: canonicalValue(value.id) };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return String(value);
}

function expectRowsEqual(actual: Row | undefined, expected: Row | undefined): void {
  expect(canonicalValue(actual)).toEqual(canonicalValue(expected));
}

async function snapshotRows(ids: readonly string[]): Promise<Map<string, Row | undefined>> {
  const rows = new Map<string, Row | undefined>();
  for (const memoryId of ids) rows.set(memoryId, await readRow(memoryId));
  return rows;
}

function expectSnapshotEqual(
  actual: Map<string, Row | undefined>,
  expected: Map<string, Row | undefined>,
): void {
  expect([...actual.keys()]).toEqual([...expected.keys()]);
  for (const [memoryId, expectedRow] of expected) expectRowsEqual(actual.get(memoryId), expectedRow);
}

function injectBefore(statement: string, marker: string, message: string): string {
  const index = statement.indexOf(marker);
  if (index < 0) throw new Error(`native H1 marker not found: ${marker}`);
  return `${statement.slice(0, index)}THROW "${message}";\n${statement.slice(index)}`;
}

function nextNanosecond(value: unknown): DateTime {
  if (!(value instanceof DateTime)) throw new Error("native H1 expected an SDK DateTime value");
  const [seconds, nanoseconds] = value.toCompact();
  return nanoseconds === 999_999_999n
    ? new DateTime([seconds + 1n, 0n])
    : new DateTime([seconds, nanoseconds + 1n]);
}

async function setLinkedMetadata(
  memoryId: string,
  links: { supersedes: RecordId; supersededBy?: RecordId; lineageRootId: RecordId },
): Promise<void> {
  await db.query(
    `UPDATE type::record('${TABLE}', $id) SET
       supersedes = $supersedesText,
       superseded_by = $supersededByText,
       lineage_root_id = $lineageRootIdText,
       payload.supersedesId = $supersedesText,
       payload.supersededById = $supersededByText,
       payload.lineageRootId = $lineageRootIdText,
       payload.h1RichSupersedes = $supersedes,
       payload.h1RichSupersededBy = $supersededBy,
       payload.h1RichLineageRoot = $lineageRootId
     WHERE payload.userId = $userId;`,
    {
      id: memoryId,
      userId: USER,
      supersedes: links.supersedes,
      supersededBy: links.supersededBy,
      lineageRootId: links.lineageRootId,
      supersedesText: links.supersedes.toString(),
      supersededByText: links.supersededBy?.toString(),
      lineageRootIdText: links.lineageRootId.toString(),
    },
  );
}

function normalizeRecordId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "object" && value !== null && "id" in value ? (value as { id: unknown }).id : value;
  return String(raw).replace(/^[^:]+:/, "");
}

async function seed(memoryId: string, text = `seed ${memoryId}`, metadata: Record<string, unknown> = {}): Promise<void> {
  await upsertMemory(db, memoryId, text, USER, VECTOR, metadata, "user", undefined, undefined, TABLE);
}

async function preparePlan(previousId: string, replacementId: string, metadata: Record<string, unknown> = {}): Promise<PreparedGenericSupersede> {
  return prepareSupersedeMemory(
    db,
    previousCandidate(previousId),
    replacement(replacementId, metadata),
    "deterministic",
    undefined,
    "superseded",
    TABLE,
  );
}

async function commitPlan(plan: PreparedGenericSupersede): Promise<void> {
  const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
  await db.queryTransaction(composed.statement, composed.vars);
}

describe("generic supersede H1 — owned native SurrealDB proof", () => {
  beforeAll(async () => {
    try {
      await installEndpointSentinel();
      const source = readFileSync(new URL("./processing-lineage-supersede-compose-native.test.ts", import.meta.url), "utf8");
      assertFixtureConfigurationIsolation(source);
      expect(source).toContain("SURREAL_DB");
      expect(source).toContain("SURREAL_DATABASE");
      expect(source).not.toContain(["localhost", "8000"].join(":"));
      expect(SDK_VERSION).toBe("2.0.3");
      const surreal = resolvedSurrealBinary();
      port = await freePort();
      const ownedUrl = `http://127.0.0.1:${port}`;
      server = spawn(
        surreal.path,
        ["start", "memory", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", PASSWORD, "--log", "none", "--no-banner"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      await waitForServer(port);
      db = new ExportedSurrealClient({
        url: ownedUrl,
        username: "root",
        password: PASSWORD,
        namespace: `${RUN_ID}_ns`,
        database: `${RUN_ID}_db`,
      });
      await db.query("INFO FOR DB;");
      await ensurePhase2Schema(db, 768);
      await ensureMemoryEnrichmentSchema(db);
      expect(surreal.version).toBe("3.1.4");
    } catch (error) {
      const errors: Error[] = [toError(error)];
      try {
        await stopOwnedProcess();
      } catch (cleanupError) {
        errors.push(toError(cleanupError));
      }
      try {
        await closeEndpointSentinel();
      } catch (sentinelError) {
        errors.push(toError(sentinelError));
      }
      throw new AggregateError(errors, "H1 fixture setup failed");
    }
  }, 30_000);

  afterAll(async () => {
    const errors: Error[] = [];
    try {
      await stopOwnedProcess();
    } catch (cleanupError) {
      errors.push(toError(cleanupError));
    }
    console.log(`H1 sentinel accepted connections=${sentinelConnections}`);
    if (sentinelConnections !== 0) errors.push(new Error(`H1 sentinel accepted ${sentinelConnections} unexpected connections`));
    try {
      await closeEndpointSentinel();
    } catch (sentinelError) {
      errors.push(toError(sentinelError));
    }
    if (errors.length > 0) throw new AggregateError(errors, "H1 fixture cleanup failed");
  });

  it("commits a fresh prepared replacement and preserves one exact timestamp", async () => {
    const previousId = id("fresh_previous");
    const replacementId = id("fresh_replacement");
    await seed(previousId, "older native fact");
    const plan = await preparePlan(previousId, replacementId, { confidence: 0.72, factKey: "h1-fresh" });
    const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
    expect(composed.statement).toContain("LET $h1_batch_now = time::now()");
    expect(composed.statement).toContain("$h1_batch_now_string");
    expect(composed.vars.h1_0_now).toBeUndefined();
    await db.queryTransaction(composed.statement, composed.vars);

    const previous = await readRow(previousId);
    const replacementRow = await readRow(replacementId);
    expect(previous?.active).toBe(false);
    expect(normalizeRecordId(previous?.superseded_by)).toBe(replacementId);
    expect(previous?.supersede_provenance).toBe("deterministic");
    expect(replacementRow?.active).toBe(true);
    expect(normalizeRecordId(replacementRow?.supersedes)).toBe(previousId);
    expect(replacementRow?.payload).toMatchObject({
      confidence: 0.72,
      factKey: "h1-fresh",
      supersedesId: previousId,
      arbitrationOutcome: "supersede",
      writeSource: "session_summary",
    });
  }, 20_000);

  it("uses one precise server clock only for missing payload clocks and preserves ordinary explicit metadata", async () => {
    const cases = [
      {
        label: "missing",
        metadata: { factKey: "h1-clock-missing" },
        missing: ["createdAt", "updatedAt"],
      },
      {
        label: "created-only",
        metadata: { createdAt: "2001-02-03T04:05:06.123456789Z", factKey: "h1-clock-created" },
        missing: ["updatedAt"],
      },
      {
        label: "updated-only",
        metadata: { updatedAt: "2002-03-04T05:06:07.987654321Z", factKey: "h1-clock-updated" },
        missing: ["createdAt"],
      },
      {
        label: "both-explicit",
        metadata: {
          createdAt: "2003-04-05T06:07:08.111222333Z",
          updatedAt: "2004-05-06T07:08:09.444555666Z",
          factKey: "h1-clock-both",
        },
        missing: [],
      },
      {
        label: "literal-explicit",
        metadata: {
          createdAt: "2005-06-07T08:09:10.777888999Z",
          updatedAt: "2006-07-08T09:10:11.222333444Z",
          factKey: "__h1_server_timestamp__",
        },
        missing: [],
      },
    ] as const;

    for (const testCase of cases) {
      const previousId = id(`clock_${testCase.label}_previous`);
      const replacementId = id(`clock_${testCase.label}_replacement`);
      await seed(previousId, `clock source ${testCase.label}`);
      const plan = await preparePlan(previousId, replacementId, testCase.metadata);
      const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
      const preparedPayload = composed.vars.h1_0_sup_payload as Record<string, unknown>;
      expect(composed.statement).not.toContain("__h1_server_timestamp__");
      for (const field of ["createdAt", "updatedAt"] as const) {
        if (testCase.missing.includes(field)) {
          expect(Object.prototype.hasOwnProperty.call(preparedPayload, field)).toBe(false);
        } else {
          expect(preparedPayload[field]).toBe(testCase.metadata[field]);
        }
      }
      await db.queryTransaction(composed.statement, composed.vars);

      const replacementRow = await readRow(replacementId);
      const payload = replacementRow?.payload ?? {};
      const createdAt = replacementRow?.created_at;
      const updatedAt = replacementRow?.updated_at;
      expect(createdAt).toBeInstanceOf(DateTime);
      expect(updatedAt).toBeInstanceOf(DateTime);
      expect((createdAt as DateTime).toCompact()).toEqual((updatedAt as DateTime).toCompact());
      for (const field of ["createdAt", "updatedAt"] as const) {
        if (testCase.missing.includes(field)) {
          const nativeClock = field === "createdAt" ? createdAt : updatedAt;
          expect(nativeClock).toBeInstanceOf(DateTime);
          expect((await castServerClock(payload[field])).toCompact()).toEqual((nativeClock as DateTime).toCompact());
        } else {
          expect(payload[field]).toBe(testCase.metadata[field]);
        }
      }
      if (testCase.label === "literal-explicit") {
        expect(payload.factKey).toBe("__h1_server_timestamp__");
      }
      if (testCase.missing.includes("createdAt") && testCase.missing.includes("updatedAt")) {
        expect(payload.createdAt).toBe(payload.updatedAt);
      }
    }

    const projectionReplacementId = id("clock_both-explicit_replacement");
    const generatedProjectionReplacementId = id("clock_missing_replacement");
    const listed = await listMemories(db, USER, undefined, TABLE);
    const listedRow = listed.find((row) => normalizeRecordId(row?.id) === projectionReplacementId);
    expect(listedRow?.payload?.createdAt).toBe("2003-04-05T06:07:08.111222333Z");
    expect(getSearchHitLineage(listedRow)).toMatchObject({ state: "legacy_unknown" });
    const listedGeneratedRow = listed.find((row) => normalizeRecordId(row?.id) === generatedProjectionReplacementId);
    expect(listedGeneratedRow?.payload?.createdAt).toBeTypeOf("string");
    expect((await castServerClock(listedGeneratedRow?.payload?.createdAt)).toCompact()).toEqual(
      (listedGeneratedRow?.created_at as DateTime).toCompact(),
    );
    expect(getSearchHitLineage(listedGeneratedRow)).toMatchObject({ state: "legacy_unknown" });
    const fetched = await getMemoryById(db, projectionReplacementId, USER, TABLE);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.payload?.updatedAt).toBe("2004-05-06T07:08:09.444555666Z");
    expect(getSearchHitLineage(fetched[0])).toMatchObject({ state: "legacy_unknown" });
    const fetchedGenerated = await getMemoryById(db, generatedProjectionReplacementId, USER, TABLE);
    expect(fetchedGenerated).toHaveLength(1);
    expect((await castServerClock(fetchedGenerated[0]?.payload?.updatedAt)).toCompact()).toEqual(
      (fetchedGenerated[0]?.updated_at as DateTime).toCompact(),
    );
    expect(getSearchHitLineage(fetchedGenerated[0])).toMatchObject({ state: "legacy_unknown" });
    const similar = await findSimilarMemories(db, USER, VECTOR, 24 * 365 * 24, 100, "user", undefined, TABLE);
    const searchHit = similar.find((hit) => hit.id === projectionReplacementId);
    expect(searchHit?.createdAt).toBe("2003-04-05T06:07:08.111222333Z");
    expect(getSearchHitLineage(searchHit)).toMatchObject({ state: "legacy_unknown" });
    const generatedSearchHit = similar.find((hit) => hit.id === generatedProjectionReplacementId);
    expect(generatedSearchHit?.createdAt).toBeTypeOf("string");
    expect((await castServerClock(generatedSearchHit?.createdAt)).toCompact()).toEqual(
      (await castServerClock(listedGeneratedRow?.payload?.createdAt)).toCompact(),
    );
    expect(getSearchHitLineage(generatedSearchHit)).toMatchObject({ state: "legacy_unknown" });

    for (const control of [
      { label: "undefined-null", metadata: { createdAt: undefined, updatedAt: null, factKey: "h1-clock-undefined-null" } },
      { label: "null-undefined", metadata: { createdAt: null, updatedAt: undefined, factKey: "h1-clock-null-undefined" } },
    ] as const) {
      const controlId = id(`clock_${control.label}_control`);
      await upsertMemory(db, controlId, "ordinary clock control", USER, VECTOR, control.metadata, "user", undefined, undefined, TABLE);
      const controlRow = await readRow(controlId);
      const controlPayload = controlRow?.payload ?? {};
      const ordinaryComposition = composeUpsertMemory(
        id(`clock_${control.label}_composition_control`),
        "ordinary composition control",
        USER,
        VECTOR,
        control.metadata,
        "user",
        undefined,
        { active: true },
        TABLE,
      );
      const ordinaryPayload = ordinaryComposition.vars.payload as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(ordinaryPayload, "createdAt")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(ordinaryPayload, "updatedAt")).toBe(true);

      const previousId = id(`clock_${control.label}_previous`);
      const replacementId = id(`clock_${control.label}_replacement`);
      await seed(previousId, `clock ${control.label} source`);
      const plan = await preparePlan(previousId, replacementId, control.metadata);
      const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
      await db.queryTransaction(composed.statement, composed.vars);
      const replacementRow = await readRow(replacementId);
      const replacementPayload = replacementRow?.payload ?? {};
      for (const field of ["createdAt", "updatedAt"] as const) {
        expect(Object.prototype.hasOwnProperty.call(replacementPayload, field)).toBe(
          Object.prototype.hasOwnProperty.call(controlPayload, field),
        );
        expect(canonicalValue(replacementPayload[field])).toEqual(canonicalValue(controlPayload[field]));
      }
    }
  }, 30_000);

  it("rejects wrong-user and present-lineage rows before any body witness query", async () => {
    const wrongUserId = id("metadata_first_wrong_user");
    await upsertMemory(db, wrongUserId, "wrong user", "other-user", VECTOR, { branch: "wrong-user" }, "user", undefined, undefined, TABLE);
    const originalQuery = db.query.bind(db);
    const wrongUserQueries: string[] = [];
    const wrappedDb = db as unknown as { query: typeof db.query };
    wrappedDb.query = async (...args: Parameters<typeof db.query>) => {
      wrongUserQueries.push(String(args[0]));
      return originalQuery(...args);
    };
    try {
      await expect(preparePlan(wrongUserId, id("metadata_first_wrong_user_replacement"))).rejects.toThrow(/previous generic snapshot mismatch/);
    } finally {
      wrappedDb.query = originalQuery;
    }
    expect(wrongUserQueries.some((statement) => statement.includes("crypto::sha256"))).toBe(false);

    const lineageId = id("metadata_first_lineage");
    await seed(lineageId, "present lineage", { branch: "lineage" });
    await db.query(
      `UPDATE type::record('${TABLE}', $id) SET processing_lineage = $lineage;`,
      { id: lineageId, lineage: PRESENT_LINEAGE },
    );
    const lineageQueries: string[] = [];
    wrappedDb.query = async (...args: Parameters<typeof db.query>) => {
      lineageQueries.push(String(args[0]));
      return originalQuery(...args);
    };
    try {
      await expect(preparePlan(lineageId, id("metadata_first_lineage_replacement"))).rejects.toThrow();
    } finally {
      wrappedDb.query = originalQuery;
    }
    expect(lineageQueries.some((statement) => statement.includes("crypto::sha256"))).toBe(false);
  }, 30_000);

  it("refuses an eligibility race between metadata and the constrained body witness", async () => {
    const previousId = id("metadata_first_race_previous");
    const replacementId = id("metadata_first_race_replacement");
    await seed(previousId, "metadata first race", { branch: "metadata-race" });
    const originalQuery = db.query.bind(db);
    const metadataQueries: string[] = [];
    let eligibilityReads = 0;
    const wrappedDb = db as unknown as { query: typeof db.query };
    wrappedDb.query = async (...args: Parameters<typeof db.query>) => {
      const statement = String(args[0]);
      metadataQueries.push(statement);
      if (statement.includes("payload.userId AS payload_user_id") && statement.includes("lineage_absent")) {
        eligibilityReads += 1;
        const result = await originalQuery(...args);
        if (eligibilityReads === 2) {
          await originalQuery(
            `UPDATE type::record('${TABLE}', $id) SET processing_lineage = $lineage;`,
            { id: previousId, lineage: PRESENT_LINEAGE },
          );
        }
        return result;
      }
      return originalQuery(...args);
    };
    try {
      await expect(preparePlan(previousId, replacementId)).rejects.toThrow(/metadata changed before complete-row witness/);
    } finally {
      wrappedDb.query = originalQuery;
    }
    expect(metadataQueries.some((statement) => statement.includes("crypto::sha256"))).toBe(true);
  }, 30_000);

  it("refuses proxy, proxy-prototype, and sparse embedding inputs before native queries or transactions", async () => {
    const previousId = id("proxy_dense_previous");
    await seed(previousId, "proxy dense previous");
    const originalQuery = db.query.bind(db);
    const originalQueryTransaction = db.queryTransaction.bind(db);
    const queryStatements: string[] = [];
    let transactionCalls = 0;
    const wrappedDb = db as unknown as {
      query: typeof db.query;
      queryTransaction: typeof db.queryTransaction;
    };
    wrappedDb.query = async (...args: Parameters<typeof db.query>) => {
      queryStatements.push(String(args[0]));
      return originalQuery(...args);
    };
    wrappedDb.queryTransaction = async (...args: Parameters<typeof db.queryTransaction>) => {
      transactionCalls += 1;
      return originalQueryTransaction(...args);
    };
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
        throw new Error("native proxy getPrototypeOf invoked");
      },
      ownKeys() {
        trapCalls.ownKeys += 1;
        throw new Error("native proxy ownKeys invoked");
      },
      getOwnPropertyDescriptor() {
        trapCalls.getOwnPropertyDescriptor += 1;
        throw new Error("native proxy descriptor invoked");
      },
      get() {
        trapCalls.get += 1;
        throw new Error("native proxy get invoked");
      },
      has() {
        trapCalls.has += 1;
        throw new Error("native proxy has invoked");
      },
    };
    const makeReplacement = (replacementId: string, embedding: number[] = [...VECTOR], metadata: Record<string, unknown> = {}) => {
      const input = replacement(replacementId, metadata);
      input.embedding = embedding;
      return input;
    };
    const proxiedEmbedding = new Proxy([...VECTOR], handler) as unknown as number[];
    const revoked = Proxy.revocable({ revoked: true }, handler);
    revoked.revoke();
    const proxyPrototype = new Proxy({}, handler);
    const objectWithProxyPrototype = Object.create(proxyPrototype) as Record<string, unknown>;
    objectWithProxyPrototype.value = "unsupported";
    const arrayWithProxyPrototype: unknown[] = ["unsupported"];
    Object.setPrototypeOf(arrayWithProxyPrototype, proxyPrototype);
    const sparse = [...VECTOR];
    delete sparse[1];
    let accessorReads = 0;
    const accessor = [...VECTOR];
    Object.defineProperty(accessor, "1", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("native embedding accessor invoked");
      },
    });
    let coercions = 0;
    const coercible = [...VECTOR] as unknown as Array<number | Record<string, unknown>>;
    coercible[1] = {
      valueOf: () => {
        coercions += 1;
        return 0.2;
      },
    };
    try {
      const cases: Array<[string, ReturnType<typeof makeReplacement>]> = [
        ["proxy", makeReplacement(id("proxy_dense_replacement"), proxiedEmbedding)],
        ["revoked", makeReplacement(id("revoked_dense_replacement"), [...VECTOR], { revoked: revoked.proxy })],
        ["nested-proxy", makeReplacement(id("nested_proxy_replacement"), [...VECTOR], { nested: { value: new Proxy({}, handler) } })],
        ["proxy-object-prototype", makeReplacement(id("proxy_object_prototype_replacement"), [...VECTOR], { objectWithProxyPrototype })],
        ["proxy-array-prototype", makeReplacement(id("proxy_array_prototype_replacement"), [...VECTOR], { arrayWithProxyPrototype })],
        ["sparse", makeReplacement(id("sparse_embedding_replacement"), sparse)],
        ["accessor", makeReplacement(id("accessor_embedding_replacement"), accessor)],
        ["coercible", makeReplacement(id("coercible_embedding_replacement"), coercible as unknown as number[])],
        ["nonfinite", makeReplacement(id("nonfinite_embedding_replacement"), [0.1, Number.NaN, 0.3])],
      ];
      for (const [label, input] of cases) {
        await expect(prepareSupersedeMemory(
          db,
          previousCandidate(previousId),
          input,
          "deterministic",
          undefined,
          "superseded",
          TABLE,
        )).rejects.toThrow(/Proxy|embedding|accessor|executable/);
        expect(queryStatements).toEqual([]);
        expect(transactionCalls, label).toBe(0);
      }
    } finally {
      wrappedDb.query = originalQuery;
      wrappedDb.queryTransaction = originalQueryTransaction;
    }
    expect(accessorReads).toBe(0);
    expect(coercions).toBe(0);
    expect(trapCalls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
      has: 0,
    });

    const validPlan = await preparePlan(previousId, id("proxy_collection_valid_replacement"));
    const beforeQueries = queryStatements.length;
    const beforeTransactions = transactionCalls;
    let collectionTrapCalls = 0;
    const proxiedPlans = new Proxy([validPlan], {
      getPrototypeOf() {
        collectionTrapCalls += 1;
        throw new Error("native plan collection prototype trap invoked");
      },
      ownKeys() {
        collectionTrapCalls += 1;
        throw new Error("native plan collection ownKeys trap invoked");
      },
      get() {
        collectionTrapCalls += 1;
        throw new Error("native plan collection get trap invoked");
      },
    });
    expect(() => composePreparedSupersedeBatch(db, TABLE, USER, proxiedPlans)).toThrow(/Proxy/);
    expect(collectionTrapCalls).toBe(0);
    expect(queryStatements.length).toBe(beforeQueries);
    expect(transactionCalls).toBe(beforeTransactions);
  }, 30_000);

  it("commits an existing survivor without replacing its rich payload", async () => {
    const previousId = id("existing_previous");
    const replacementId = id("existing_survivor");
    await seed(previousId, "older native fact");
    await seed(replacementId, "rich survivor", { confidence: 0.93, factKey: "survivor-key", tier: "durable" });
    const plan = await preparePlan(previousId, replacementId, { confidence: 0.01, factKey: "ignored-input" });
    await commitPlan(plan);

    const previous = await readRow(previousId);
    const survivor = await readRow(replacementId);
    expect(previous?.active).toBe(false);
    expect(survivor?.active).toBe(true);
    expect(normalizeRecordId(survivor?.supersedes)).toBe(previousId);
    expect(survivor?.payload).toMatchObject({
      confidence: 0.93,
      factKey: "survivor-key",
      tier: "durable",
      arbitrationOutcome: "supersede",
      writeSource: "session_summary",
    });
  }, 20_000);

  it("binds nonempty RecordId and nested Uuid metadata through the real native path", async () => {
    const previousId = id("typed_previous");
    const replacementId = id("typed_survivor");
    await seed(previousId, "typed previous", { branch: "typed-previous" });
    await seed(replacementId, "typed survivor", { branch: "typed-survivor", confidence: 0.91 });
    const uuid = new Uuid("0189dcd5-5311-7d40-8db0-9496a2eef37b");
    const previousLinks = new RecordId(TABLE, {
      branch: "previous",
      uuid,
      nested: ["stable", { uuid }],
    });
    const previousSuccessor = new RecordId(TABLE, "typed-successor");
    const previousRoot = new RecordId(TABLE, uuid);
    const replacementLinks = new RecordId(TABLE, ["replacement", { uuid }]);
    const replacementRoot = new RecordId(TABLE, { root: "typed-root", uuid });
    await setLinkedMetadata(previousId, {
      supersedes: previousLinks,
      supersededBy: previousSuccessor,
      lineageRootId: previousRoot,
    });
    await setLinkedMetadata(replacementId, {
      supersedes: replacementLinks,
      lineageRootId: replacementRoot,
    });

    const plan = await preparePlan(previousId, replacementId, { confidence: 0.01, ignored: true });
    const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
    expect(composed.vars.h1_0_previousRowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(composed.vars.h1_0_replacementRowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(composed.vars).some((value) => value instanceof RecordId || value instanceof Uuid || value instanceof DateTime)).toBe(false);
    expect(() => JSON.stringify(composed.vars)).not.toThrow();
    await db.queryTransaction(composed.statement, composed.vars);

    const previous = await readRow(previousId);
    const survivor = await readRow(replacementId);
    expect(previous?.active).toBe(false);
    expect(normalizeRecordId(previous?.superseded_by)).toBe(replacementId);
    expect(survivor?.active).toBe(true);
    expect(normalizeRecordId(survivor?.supersedes)).toBe(previousId);
    expect(survivor?.payload).toMatchObject({
      branch: "typed-survivor",
      confidence: 0.91,
      arbitrationOutcome: "supersede",
      writeSource: "session_summary",
    });
    expect(previous?.supersedes).toBe(previousLinks.toString());
    expect(canonicalValue(previous?.payload?.h1RichSupersedes)).toEqual(canonicalValue(previousLinks));
    expect(previous?.payload?.h1RichSupersedes).toBeInstanceOf(RecordId);
    expect(Object.keys(previous ?? {})).toEqual(expect.arrayContaining([
      "id", "embedding", "payload", "text_norm", "created_at", "updated_at", "user_id", "scope",
      "active", "supersedes", "lineage_root_id",
    ]));
    expect(Object.keys(survivor ?? {})).toEqual(expect.arrayContaining([
      "id", "embedding", "payload", "text_norm", "created_at", "updated_at", "user_id", "scope",
      "active", "supersedes", "lineage_root_id",
    ]));
  }, 30_000);

  it("refuses a complete-row body and extra-key race without relying on updated_at", async () => {
    const previousId = id("full_row_body_race_previous");
    const replacementId = id("full_row_body_race_replacement");
    await seed(previousId, "full row body race", { branch: "body-race", nested: { preserved: true } });
    const plan = await preparePlan(previousId, replacementId, { confidence: 0.42 });
    const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
    const beforeMutation = await readRow(previousId);
    await db.query(
      `UPDATE type::record('${TABLE}', $id) SET payload.h1FullRowExtra = $extra;`,
      { id: previousId, extra: { changed: true, nested: ["body"] } },
    );
    const afterMutation = await readRow(previousId);
    expect(canonicalValue(afterMutation)).not.toEqual(canonicalValue(beforeMutation));
    expect(afterMutation?.updated_at).toEqual(beforeMutation?.updated_at);
    const raceSnapshot = await snapshotRows([previousId, replacementId]);
    await expect(db.queryTransaction(composed.statement, composed.vars)).rejects.toThrow();
    expectSnapshotEqual(await snapshotRows([previousId, replacementId]), raceSnapshot);
    expect(await readRow(replacementId)).toBeUndefined();
  }, 30_000);

  it("refuses a one-nanosecond current metadata race before any fresh mutation", async () => {
    const previousId = id("nanosecond_previous");
    const replacementId = id("nanosecond_replacement");
    await seed(previousId, "nanosecond race", { branch: "nanosecond" });
    const plan = await preparePlan(previousId, replacementId);
    const composed = composePreparedSupersedeBatch(db, TABLE, USER, [plan]);
    const preparedPrevious = await readRow(previousId);
    const preparedUpdatedAt = preparedPrevious?.updated_at;
    const racedUpdatedAt = nextNanosecond(preparedUpdatedAt);
    await db.query(
      `UPDATE type::record('${TABLE}', $id) SET updated_at = <datetime>$updatedAt WHERE payload.userId = $userId;`,
      { id: previousId, userId: USER, updatedAt: racedUpdatedAt },
    );
    const racedPreimage = await snapshotRows([previousId, replacementId]);
    await expect(db.queryTransaction(composed.statement, composed.vars)).rejects.toThrow();
    expectSnapshotEqual(await snapshotRows([previousId, replacementId]), racedPreimage);
    expect(await readRow(replacementId)).toBeUndefined();
    const readBackUpdatedAt = (await readRow(previousId))?.updated_at;
    expect(readBackUpdatedAt).toBeInstanceOf(DateTime);
    expect((readBackUpdatedAt as DateTime).toCompact()).toEqual(racedUpdatedAt.toCompact());
    expect((readBackUpdatedAt as DateTime).toCompact()).not.toEqual((preparedUpdatedAt as DateTime).toCompact());
  }, 30_000);

  it("classifies committed and rolled-back SDK errors from full native readback", async () => {
    const committedPrevious = id("postcommit_committed_previous");
    const committedReplacement = id("postcommit_committed_replacement");
    await seed(committedPrevious, "postcommit committed", { branch: "committed" });
    const committedPlan = await preparePlan(committedPrevious, committedReplacement);
    const committed = composePreparedSupersedeBatch(db, TABLE, USER, [committedPlan]);
    const committedBefore = await snapshotRows([committedPrevious, committedReplacement]);
    const realQueryTransaction = db.queryTransaction.bind(db);
    const wrappedDb = db as unknown as {
      queryTransaction: (...args: Parameters<typeof db.queryTransaction>) => ReturnType<typeof db.queryTransaction>;
    };
    wrappedDb.queryTransaction = async (...args) => {
      await realQueryTransaction(...args);
      throw new Error("synthetic SDK wrapper rejection after COMMIT");
    };
    try {
      await expect(wrappedDb.queryTransaction(committed.statement, committed.vars))
        .rejects.toThrow("synthetic SDK wrapper rejection after COMMIT");
    } finally {
      wrappedDb.queryTransaction = realQueryTransaction;
    }
    const committedAfter = await snapshotRows([committedPrevious, committedReplacement]);
    expect(committedAfter.get(committedPrevious)?.active).toBe(false);
    expect(committedAfter.get(committedReplacement)?.active).toBe(true);
    expect(canonicalValue(committedAfter.get(committedPrevious))).not.toEqual(canonicalValue(committedBefore.get(committedPrevious)));
    expect(canonicalValue(committedAfter.get(committedReplacement))).not.toEqual(canonicalValue(committedBefore.get(committedReplacement)));

    const rolledBackPrevious = id("postcommit_rollback_previous");
    const rolledBackReplacement = id("postcommit_rollback_replacement");
    await seed(rolledBackPrevious, "postcommit rollback", { branch: "rolled-back" });
    const rolledBackPlan = await preparePlan(rolledBackPrevious, rolledBackReplacement);
    const rolledBack = composePreparedSupersedeBatch(db, TABLE, USER, [rolledBackPlan]);
    const rolledBackBefore = await snapshotRows([rolledBackPrevious, rolledBackReplacement]);
    const rollbackStatement = injectBefore(rolledBack.statement, "LET $h1_0_previousRows", "H1 rollback outcome");
    let rollbackError: Error | undefined;
    try {
      await db.queryTransaction(rollbackStatement, rolledBack.vars);
    } catch (error) {
      rollbackError = error instanceof Error ? error : new Error(String(error));
    }
    expect(rollbackError).toBeInstanceOf(Error);
    expectSnapshotEqual(await snapshotRows([rolledBackPrevious, rolledBackReplacement]), rolledBackBefore);
    // The fixture deliberately classifies these outcomes locally from readback;
    // the public legacy API remains void/error and is not changed here.
  }, 30_000);

  it("commits row-disjoint fresh and existing plans together", async () => {
    const firstPrevious = id("batch_first_previous");
    const firstReplacement = id("batch_first_replacement");
    const secondPrevious = id("batch_second_previous");
    const secondReplacement = id("batch_second_replacement");
    const thirdPrevious = id("batch_third_previous");
    const thirdReplacement = id("batch_third_replacement");
    await seed(firstPrevious, "batch first previous", { branch: "first" });
    await seed(secondPrevious, "batch second previous", { branch: "second" });
    await seed(secondReplacement, "batch existing survivor", { branch: "existing", tier: "durable" });
    await seed(thirdPrevious, "batch third previous", { branch: "third" });
    const first = await preparePlan(firstPrevious, firstReplacement, {
      createdAt: "2011-02-03T04:05:06.123456789Z",
      branch: "first",
    });
    const second = await preparePlan(secondPrevious, secondReplacement);
    const third = await preparePlan(thirdPrevious, thirdReplacement, {
      updatedAt: "2012-03-04T05:06:07.987654321Z",
      branch: "third",
    });
    const composed = composePreparedSupersedeBatch(db, TABLE, USER, [first, second, third]);
    await db.queryTransaction(composed.statement, composed.vars);
    const rows = await snapshotRows([
      firstPrevious,
      firstReplacement,
      secondPrevious,
      secondReplacement,
      thirdPrevious,
      thirdReplacement,
    ]);
    expect(rows.get(firstPrevious)?.active).toBe(false);
    expect(rows.get(secondPrevious)?.active).toBe(false);
    expect(rows.get(thirdPrevious)?.active).toBe(false);
    expect(rows.get(firstReplacement)?.active).toBe(true);
    expect(rows.get(secondReplacement)?.active).toBe(true);
    expect(rows.get(thirdReplacement)?.active).toBe(true);
    expect(rows.get(secondReplacement)?.payload).toMatchObject({
      branch: "existing",
      tier: "durable",
      arbitrationOutcome: "supersede",
      writeSource: "session_summary",
    });
    const topLevelClocks = [
      firstPrevious,
      firstReplacement,
      secondPrevious,
      secondReplacement,
      thirdPrevious,
      thirdReplacement,
    ].map((memoryId) => (rows.get(memoryId)?.updated_at as DateTime).toCompact());
    for (const clock of topLevelClocks) expect(clock).toEqual(topLevelClocks[0]);
    const firstReplacementRow = rows.get(firstReplacement);
    const thirdReplacementRow = rows.get(thirdReplacement);
    expect(firstReplacementRow?.payload?.createdAt).toBe("2011-02-03T04:05:06.123456789Z");
    expect((await castServerClock(firstReplacementRow?.payload?.updatedAt)).toCompact()).toEqual(
      (firstReplacementRow?.updated_at as DateTime).toCompact(),
    );
    expect((await castServerClock(thirdReplacementRow?.payload?.createdAt)).toCompact()).toEqual(
      (thirdReplacementRow?.created_at as DateTime).toCompact(),
    );
    expect(thirdReplacementRow?.payload?.updatedAt).toBe("2012-03-04T05:06:07.987654321Z");
    expect((await castServerClock(rows.get(firstPrevious)?.payload?.updatedAt)).toCompact()).toEqual(
      (rows.get(firstPrevious)?.updated_at as DateTime).toCompact(),
    );
    expect((await castServerClock(rows.get(thirdPrevious)?.payload?.updatedAt)).toCompact()).toEqual(
      (rows.get(thirdPrevious)?.updated_at as DateTime).toCompact(),
    );
    const generatedClockString = firstReplacementRow?.payload?.updatedAt;
    expect(generatedClockString).toEqual(thirdReplacementRow?.payload?.createdAt);
    expect(generatedClockString).toEqual(rows.get(firstPrevious)?.payload?.updatedAt);
    expect(generatedClockString).toEqual(rows.get(thirdPrevious)?.payload?.updatedAt);
    for (const previousId of [firstPrevious, secondPrevious, thirdPrevious]) {
      const previousRow = rows.get(previousId);
      expect(previousRow?.inactive_at).toBeInstanceOf(DateTime);
      expect((previousRow?.inactive_at as DateTime).toCompact()).toEqual((previousRow?.updated_at as DateTime).toCompact());
      expect((await castServerClock(previousRow?.payload?.inactiveAt)).toCompact()).toEqual(
        (previousRow?.inactive_at as DateTime).toCompact(),
      );
    }
  }, 30_000);

  it("rolls back a fresh CREATE collision and a fresh source failure with full readback", async () => {
    const collisionPrevious = id("fresh_create_failure_previous");
    const collisionReplacement = id("fresh_create_failure_replacement");
    await seed(collisionPrevious, "fresh create failure", { branch: "collision" });
    const collisionPlan = await preparePlan(collisionPrevious, collisionReplacement);
    const collision = composePreparedSupersedeBatch(db, TABLE, USER, [collisionPlan]);
    const collisionPreimage = await snapshotRows([collisionPrevious, collisionReplacement]);
    await seed(collisionReplacement, "raced collision row", { branch: "collision-preimage" });
    collisionPreimage.set(collisionReplacement, await readRow(collisionReplacement));
    await expect(db.queryTransaction(collision.statement, collision.vars)).rejects.toThrow();
    expectSnapshotEqual(await snapshotRows([collisionPrevious, collisionReplacement]), collisionPreimage);

    const sourcePrevious = id("fresh_source_failure_previous");
    const sourceReplacement = id("fresh_source_failure_replacement");
    await seed(sourcePrevious, "fresh source failure", { branch: "source" });
    const sourcePlan = await preparePlan(sourcePrevious, sourceReplacement);
    const source = composePreparedSupersedeBatch(db, TABLE, USER, [sourcePlan]);
    const sourcePreimage = await snapshotRows([sourcePrevious, sourceReplacement]);
    const sourceFailure = injectBefore(source.statement, "LET $h1_0_previousRows", "H1 fresh source mutation failure");
    await expect(db.queryTransaction(sourceFailure, source.vars)).rejects.toThrow();
    expectSnapshotEqual(await snapshotRows([sourcePrevious, sourceReplacement]), sourcePreimage);
  }, 30_000);

  it("rolls back existing target and source mutation failures with full readback", async () => {
    const targetPrevious = id("existing_target_failure_previous");
    const targetReplacement = id("existing_target_failure_replacement");
    await seed(targetPrevious, "existing target failure", { branch: "target" });
    await seed(targetReplacement, "existing target survivor", { branch: "target-survivor", tier: "durable" });
    const targetPlan = await preparePlan(targetPrevious, targetReplacement);
    const target = composePreparedSupersedeBatch(db, TABLE, USER, [targetPlan]);
    const targetPreimage = await snapshotRows([targetPrevious, targetReplacement]);
    const targetUpdatedAt = nextNanosecond((await readRow(targetReplacement))?.updated_at);
    await db.query(
      `UPDATE type::record('${TABLE}', $id) SET updated_at = <datetime>$updatedAt WHERE payload.userId = $userId;`,
      { id: targetReplacement, userId: USER, updatedAt: targetUpdatedAt },
    );
    const targetRacePreimage = await snapshotRows([targetPrevious, targetReplacement]);
    await expect(db.queryTransaction(target.statement, target.vars)).rejects.toThrow();
    expectSnapshotEqual(await snapshotRows([targetPrevious, targetReplacement]), targetRacePreimage);
    expect(canonicalValue(targetPreimage.get(targetReplacement))).not.toEqual(canonicalValue(targetRacePreimage.get(targetReplacement)));

    const sourcePrevious = id("existing_source_failure_previous");
    const sourceReplacement = id("existing_source_failure_replacement");
    await seed(sourcePrevious, "existing source failure", { branch: "source" });
    await seed(sourceReplacement, "existing source survivor", { branch: "source-survivor", confidence: 0.88 });
    const sourcePlan = await preparePlan(sourcePrevious, sourceReplacement);
    const source = composePreparedSupersedeBatch(db, TABLE, USER, [sourcePlan]);
    const sourcePreimage = await snapshotRows([sourcePrevious, sourceReplacement]);
    const sourceFailure = injectBefore(source.statement, "LET $h1_0_previousRows", "H1 existing source mutation failure");
    await expect(db.queryTransaction(sourceFailure, source.vars)).rejects.toThrow();
    expectSnapshotEqual(await snapshotRows([sourcePrevious, sourceReplacement]), sourcePreimage);
  }, 30_000);

  it("rolls back every mutation boundary in a mixed row-disjoint batch", async () => {
    const cases = [
      { name: "plan0-target-create", marker: "collision" as const },
      { name: "plan0-source-update", marker: "h1_0_previousRows" as const },
      { name: "plan1-target-update", marker: "h1_1_replacementRows" as const },
      { name: "plan1-source-update", marker: "h1_1_previousRows" as const },
    ];
    for (const failureCase of cases) {
      const firstPrevious = id(`batch_failure_${failureCase.name}_first_previous`);
      const firstReplacement = id(`batch_failure_${failureCase.name}_first_replacement`);
      const secondPrevious = id(`batch_failure_${failureCase.name}_second_previous`);
      const secondReplacement = id(`batch_failure_${failureCase.name}_second_replacement`);
      await seed(firstPrevious, "batch failure first previous", { branch: "first" });
      await seed(secondPrevious, "batch failure second previous", { branch: "second" });
      await seed(secondReplacement, "batch failure existing survivor", { branch: "existing", tier: "durable" });
      const first = await preparePlan(firstPrevious, firstReplacement);
      const second = await preparePlan(secondPrevious, secondReplacement);
      const composed = composePreparedSupersedeBatch(db, TABLE, USER, [first, second]);
      const ids = [firstPrevious, firstReplacement, secondPrevious, secondReplacement];
      const preimage = await snapshotRows(ids);
      let statement = composed.statement;
      if (failureCase.marker === "collision") {
        await seed(firstReplacement, "batch collision row", { branch: "collision-preimage" });
        preimage.set(firstReplacement, await readRow(firstReplacement));
      } else {
        statement = injectBefore(statement, `LET $${failureCase.marker}`, `H1 batch ${failureCase.name} failure`);
      }
      await expect(db.queryTransaction(statement, composed.vars)).rejects.toThrow();
      expectSnapshotEqual(await snapshotRows(ids), preimage);
    }
  }, 60_000);

  it("refuses copied, foreign-context, and overlapping plans before native transaction execution", async () => {
    const previousId = id("guard_previous");
    const replacementId = id("guard_replacement");
    await seed(previousId);
    const plan = await preparePlan(previousId, replacementId);
    const copied = { kind: plan.kind } as PreparedGenericSupersede;
    expect(() => composePreparedSupersedeBatch(db, TABLE, USER, [copied])).toThrow(/not owned/);
    expect(() => composePreparedSupersedeBatch(db, "memories", USER, [plan])).toThrow(/table mismatch/);
    expect(() => composePreparedSupersedeBatch(db, TABLE, "other-user", [plan])).toThrow(/user mismatch/);
    expect(() => composePreparedSupersedeBatch({} as SurrealClient, TABLE, USER, [plan])).toThrow(/database mismatch/);

    const overlap = await preparePlan(previousId, id("guard_other_replacement"));
    expect(() => composePreparedSupersedeBatch(db, TABLE, USER, [plan, overlap])).toThrow(/rows overlap/);
    expect(await readRow(previousId)).toMatchObject({ active: true });
  });

  it("keeps the public single-call API on the same native prepared path", async () => {
    const previousId = id("legacy_previous");
    const replacementId = id("legacy_replacement");
    await seed(previousId);
    await supersedeMemory(
      db,
      previousCandidate(previousId),
      replacement(replacementId),
      "deterministic",
      undefined,
      "superseded",
      TABLE,
    );
    expect((await readRow(previousId))?.active).toBe(false);
    expect((await readRow(replacementId))?.active).toBe(true);
  }, 20_000);
});

describe("H1 native fixture guards", () => {
  it("requires exact native versions and bounds hanging or rejected SDK close", async () => {
    expect(SDK_VERSION).toBe("2.0.3");
    expect(parseSurrealVersion("3.1.4 for macos on aarch64")).toBe("3.1.4");
    expect(() => parseSurrealVersion("3.1.40 for macos on aarch64")).toThrow();
    expect(() => parseSurrealVersion("version unavailable")).toThrow();
    const hanging = fakeCleanupChild();
    const started = Date.now();
    await expect(cleanupOwnedResources({
      closeSdk: () => new Promise<void>(() => {}),
      child: hanging.child,
      port: 0,
      waitForExit: hangingChildWait,
      canConnect: async () => false,
    }, 20)).rejects.toThrow(/owned cleanup failed/);
    expect(Date.now() - started).toBeLessThan(500);
    expect(hanging.signals).toEqual(["SIGTERM", "SIGKILL"]);
    const rejected = fakeCleanupChild();
    await expect(cleanupOwnedResources({
      closeSdk: async () => { throw new Error("synthetic SDK close rejection"); },
      child: rejected.child,
      port: 0,
      waitForExit: hangingChildWait,
      canConnect: async () => false,
    }, 20)).rejects.toThrow(/owned cleanup failed/);
    expect(rejected.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
