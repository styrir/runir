import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SurrealClient,
  upsertMemory,
  supersedeMemory,
} from "../storage/surreal/surreal-store.js";
import { ensureMemoryEnrichmentSchema } from "../storage/surreal/memory-schema-bootstrap.js";
import type { SimilarCandidate } from "../domain/memory/types";

// This native proof fixture owns its loopback MEMORY process and uses synthetic data.
// It never selects an endpoint or credential from process configuration.
const TABLE = "semiote";
const PASSWORD = "safe-supersede-synthetic";
const USER = "safe-supersede-user";
const VECTOR = [1, 0, 0];
const RUN_ID = `safe_supersede_${process.pid}_${randomUUID().replaceAll("-", "_")}`;
const SENTINEL_ENV_KEYS = [
  "SURREAL_URL",
  "SURREAL_USER",
  "SURREAL_PASS",
  "SURREAL_NS",
  "SURREAL_DB",
  "SURREAL_DATABASE",
] as const;

type Row = {
  active?: boolean;
  supersedes?: unknown;
  superseded_by?: unknown;
  supersede_provenance?: unknown;
  inactive_reason?: unknown;
  payload?: {
    active?: boolean;
    confidence?: number;
    inactiveReason?: unknown;
    supersededById?: unknown;
    supersedesId?: unknown;
    supersede_provenance?: unknown;
    arbitrationOutcome?: unknown;
    writeSource?: unknown;
  };
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

function previousCandidate(memoryId: string, text = "older fact"): SimilarCandidate {
  return {
    id: memoryId,
    l2: text,
    similarity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    scope: "user",
  } as SimilarCandidate;
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
  if (!/^\d+\.\d+\.\d+$/.test(token)) {
    throw new Error(`surreal CLI version output has no version token: ${output.trim()}`);
  }
  if (token !== "3.1.4") {
    throw new Error(`safe fixture requires SurrealDB 3.1.4; resolved ${token}`);
  }
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
  if (!port) throw new Error("safe supersede fixture did not allocate a port");
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
  throw new Error(`safe supersede fixture did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

const SDK_VERSION = resolvedPackageVersion("surrealdb");
let db: SurrealClient;
let server: ChildProcess;
let port = 0;
let sentinelServer: ReturnType<typeof createServer>;
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
    sentinelServer.once("error", reject);
    sentinelServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = sentinelServer.address();
  sentinelPort = typeof address === "object" && address ? address.port : 0;
  if (!sentinelPort) throw new Error("safe fixture sentinel did not allocate a port");
  for (const key of SENTINEL_ENV_KEYS) {
    savedSentinelEnvironment[key] = process.env[key];
  }
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
          sentinelServer.close((error) => error ? reject(error) : resolve());
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
  if (errors.length > 0) {
    throw new AggregateError(errors, "sentinel cleanup failed");
  }
}

const CLEANUP_DEADLINE_MS = 2_000;

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
  if (socketOpen) errors.push(new Error("safe fixture left its owned loopback socket open"));
  if (child && child.exitCode === null && child.signalCode === null) {
    errors.push(new Error("safe fixture left its owned Surreal process alive"));
  }
  console.log(`safe fixture cleanup ownedPid=${child?.pid ?? "none"} processAlive=${child ? child.exitCode === null && child.signalCode === null : false} socketOpen=${socketOpen}`);
  if (errors.length > 0) throw new AggregateError(errors, "owned cleanup failed");
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

async function getRow(memoryId: string): Promise<Row | undefined> {
  const result = await db.query<Row>(
    `SELECT active, supersedes, superseded_by, supersede_provenance, inactive_reason, payload FROM type::record('${TABLE}', $id);`,
    { id: memoryId },
  );
  return result[0]?.[0];
}

function normalizeRecordId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "object" && value !== null && "id" in value
    ? (value as { id: unknown }).id
    : value;
  return String(raw).replace(/^[^:]+:/, "");
}

function expectInactiveBookkeeping(row: Row | undefined, replacementId: string): void {
  expect(row?.active).toBe(false);
  expect(row?.supersede_provenance).toBe("deterministic");
  expect(row?.inactive_reason).toBe("superseded");
  expect(normalizeRecordId(row?.superseded_by)).toBe(replacementId);
  expect(row?.payload?.active).toBe(false);
  expect(row?.payload?.inactiveReason).toBe("superseded");
  expect(row?.payload?.supersededById).toBe(replacementId);
  expect(row?.payload?.supersede_provenance).toBe("deterministic");
}

function expectReplacementBookkeeping(row: Row | undefined, previousId: string): void {
  expect(row?.active).toBe(true);
  expect(normalizeRecordId(row?.supersedes)).toBe(previousId);
  expect(row?.supersede_provenance).toBe("deterministic");
  expect(row?.payload?.active).toBe(true);
  expect(row?.payload?.supersedesId).toBe(previousId);
  expect(row?.payload?.supersede_provenance).toBe("deterministic");
  expect(row?.payload?.arbitrationOutcome).toBe("supersede");
  expect(row?.payload?.writeSource).toBe("session_summary");
}

function expectUnbookkeptActive(row: Row | undefined): void {
  expect(row?.active).toBe(true);
  expect(row?.supersede_provenance == null).toBe(true);
  expect(row?.inactive_reason == null).toBe(true);
  expect(row?.superseded_by == null).toBe(true);
  expect(row?.supersedes == null).toBe(true);
  expect(row?.payload?.active).toBe(true);
  expect(row?.payload?.inactiveReason == null).toBe(true);
  expect(row?.payload?.supersededById == null).toBe(true);
  expect(row?.payload?.supersedesId == null).toBe(true);
  expect(row?.payload?.supersede_provenance == null).toBe(true);
  expect(row?.payload?.arbitrationOutcome == null).toBe(true);
}

async function countRows(): Promise<number> {
  const result = await db.query<{ total: number }>(`SELECT count() AS total FROM ${TABLE} GROUP ALL;`);
  return result[0]?.[0]?.total ?? 0;
}

async function seed(memoryId: string, text: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await upsertMemory(db, memoryId, text, USER, VECTOR, metadata, "user", undefined, undefined, TABLE);
}

async function supersede(
  previousId: string,
  replacementId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await supersedeMemory(
    db,
    previousCandidate(previousId),
    {
      id: replacementId,
      l2: text,
      userId: USER,
      embedding: VECTOR,
      metadata,
      scope: "user",
      writeSource: "session_summary",
    },
    "deterministic",
    undefined,
    "superseded",
    TABLE,
  );
}

function assertFixtureConfigurationIsolation(source: string): void {
  const configKeys = "URL|USER|PASS|NS|DB|DATABASE";
  const directReads = source.split(/\r?\n/).filter((line) =>
    new RegExp(`process\\.env\\.SURREAL_(?:${configKeys})(?!\\s*=)`).test(line),
  );
  expect(directReads).toEqual([]);
  expect(source).not.toMatch(new RegExp(`process\\.env\\s*\\[\\s*["']SURREAL_(?:${configKeys})`));
  expect(source).not.toMatch(new RegExp(`process\\.env\\s*\\??\\?`));
  expect(source).not.toContain(["dot", "env"].join(""));
  for (const token of [["application", "Config"], ["load", "Config"], ["read", "Config"]].map((parts) => parts.join(""))) {
    expect(source).not.toContain(token);
  }
}

describe("supersedeMemory — safe owned native transaction fixture", () => {
  beforeAll(async () => {
    try {
      await installEndpointSentinel();
      const source = readFileSync(new URL("./supersede-transaction.test.ts", import.meta.url), "utf8");
      expect(source).not.toContain(["localhost", "8000"].join(":"));
      assertFixtureConfigurationIsolation(source);
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
      db = new SurrealClient({
        url: ownedUrl,
        username: "root",
        password: PASSWORD,
        namespace: `${RUN_ID}_ns`,
        database: `${RUN_ID}_db`,
      });
      await db.query("INFO FOR DB;");
      await db.query(`DEFINE TABLE ${TABLE} SCHEMALESS;`);
      await ensureMemoryEnrichmentSchema(db);
      expect(surreal.version).toBe("3.1.4");
    } catch (error) {
      const errors: Error[] = [toError(error)];
      try {
        await stopOwnedProcess();
      } catch (cleanupError) {
        errors.push(toError(cleanupError));
      } finally {
        try {
          await closeEndpointSentinel();
        } catch (sentinelError) {
          errors.push(toError(sentinelError));
        }
      }
      throw new AggregateError(errors, "safe fixture setup failed");
    }
  }, 30_000);

  afterAll(async () => {
    const errors: Error[] = [];
    try {
      await stopOwnedProcess();
    } catch (cleanupError) {
      errors.push(toError(cleanupError));
    }
    console.log(`safe fixture sentinel accepted connections=${sentinelConnections}`);
    if (sentinelConnections !== 0) errors.push(new Error(`sentinel accepted ${sentinelConnections} unexpected connections`));
    try {
      await closeEndpointSentinel();
    } catch (sentinelError) {
      errors.push(toError(sentinelError));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "safe fixture cleanup failed");
    }
  });

  it("commits the fresh replacement branch and inactivates the previous row", async () => {
    const previousId = id("fresh_commit_previous");
    const replacementId = id("fresh_commit_replacement");
    const initial = await countRows();
    await seed(previousId, "older fact");
    const before = await countRows();
    await supersede(previousId, replacementId, "newer fact");

    const replacement = await getRow(replacementId);
    const previous = await getRow(previousId);
    expect(before).toBe(initial + 1);
    expect(await countRows()).toBe(before + 1);
    expectReplacementBookkeeping(replacement, previousId);
    expectInactiveBookkeeping(previous, replacementId);
  }, 20_000);

  it("commits the existing survivor branch while preserving its payload", async () => {
    const previousId = id("existing_commit_previous");
    const replacementId = id("existing_commit_replacement");
    const initial = await countRows();
    await seed(previousId, "older fact");
    await seed(replacementId, "survivor fact", { confidence: 0.93 });
    const before = await countRows();
    await supersede(previousId, replacementId, "survivor fact");

    const replacement = await getRow(replacementId);
    const previous = await getRow(previousId);
    expect(before).toBe(initial + 2);
    expect(await countRows()).toBe(before);
    expectReplacementBookkeeping(replacement, previousId);
    expect(replacement?.payload?.confidence).toBe(0.93);
    expectInactiveBookkeeping(previous, replacementId);
  }, 20_000);

  it("rolls back the fresh branch without creating a replacement", async () => {
    const previousId = id("fresh_rollback_previous");
    const replacementId = id("fresh_rollback_replacement");
    const initial = await countRows();
    await seed(previousId, "older fact");
    const before = await countRows();
    const original = db.queryTransaction.bind(db);
    db.queryTransaction = async (body, vars) => original(`${body}\nTHROW "safe fresh rollback probe";`, vars);
    try {
      await expect(supersede(previousId, replacementId, "newer fact")).rejects.toThrow(/transaction failed/);
    } finally {
      db.queryTransaction = original;
    }

    expect(before).toBe(initial + 1);
    expect(await countRows()).toBe(before);
    expect(await getRow(replacementId)).toBeUndefined();
    expectUnbookkeptActive(await getRow(previousId));
  }, 20_000);

  it("rolls back the existing survivor branch without bookkeeping", async () => {
    const previousId = id("existing_rollback_previous");
    const replacementId = id("existing_rollback_replacement");
    const initial = await countRows();
    await seed(previousId, "older fact");
    await seed(replacementId, "survivor fact", { confidence: 0.93 });
    const before = await countRows();
    const original = db.queryTransaction.bind(db);
    db.queryTransaction = async (body, vars) => original(`${body}\nTHROW "safe existing rollback probe";`, vars);
    try {
      await expect(supersede(previousId, replacementId, "survivor fact")).rejects.toThrow(/transaction failed/);
    } finally {
      db.queryTransaction = original;
    }

    expect(before).toBe(initial + 2);
    expect(await countRows()).toBe(before);
    expectUnbookkeptActive(await getRow(previousId));
    const survivor = await getRow(replacementId);
    expectUnbookkeptActive(survivor);
    expect(survivor?.payload?.confidence).toBe(0.93);
  }, 20_000);
});

function fakeCleanupChild(): { child: OwnedChild; signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 99123,
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

describe("safe supersede fixture guards", () => {
  it("requires the exact parsed CLI version token", () => {
    expect(parseSurrealVersion("3.1.4 for macos on aarch64")).toBe("3.1.4");
    expect(() => parseSurrealVersion("13.1.4 for macos on aarch64")).toThrow();
    expect(() => parseSurrealVersion("3.1.40 for macos on aarch64")).toThrow();
    expect(() => parseSurrealVersion("version unavailable")).toThrow();
  });

  it("bounds a hanging SDK close and still terminates the owned child", async () => {
    const { child, signals } = fakeCleanupChild();
    const started = Date.now();
    await expect(cleanupOwnedResources({
      closeSdk: () => new Promise<void>(() => {}),
      child,
      port: 0,
      waitForExit: hangingChildWait,
      canConnect: async () => false,
    }, 20)).rejects.toThrow(/owned cleanup failed/);
    expect(Date.now() - started).toBeLessThan(500);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("preserves a rejected SDK close while completing owned child cleanup", async () => {
    const { child, signals } = fakeCleanupChild();
    await expect(cleanupOwnedResources({
      closeSdk: async () => { throw new Error("synthetic SDK close rejection"); },
      child,
      port: 0,
      waitForExit: hangingChildWait,
      canConnect: async () => false,
    }, 20)).rejects.toThrow(/owned cleanup failed/);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("restricts configuration access to the process-scoped sentinel seam", () => {
    const source = readFileSync(new URL("./supersede-transaction.test.ts", import.meta.url), "utf8");
    assertFixtureConfigurationIsolation(source);
    expect(source).toContain("SURREAL_DB");
    expect(source).toContain("SURREAL_DATABASE");
    expect(source).not.toContain(["localhost", "8000"].join(":"));
  });
});
