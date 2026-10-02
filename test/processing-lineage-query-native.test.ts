import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROCESSING_LINEAGE_VERSION } from "../src/domain/memory/processing-lineage.js";
import { getSearchHitLineage } from "../src/domain/memory/search-hit-lineage.js";
import { mapMemoryRowToSearchHit, SurrealClient } from "../src/storage/surreal/surreal-client.js";
import { ensurePhase2Schema } from "../src/storage/surreal/phase2-store.js";
import {
  bm25Search,
  nativeRrfSearch,
  runHybridQueryWithEvidenceTable,
  vectorSearch,
} from "../src/recall/query/memory-query.js";

const SURREAL_BIN = "/usr/local/bin/surreal";
const RUN_ID = `sourcec_r2_${process.pid}_${randomUUID().replaceAll("-", "_")}`;
const PASSWORD = "sourcec-r2-native-synthetic";
const USER = "user.sourcec.r2.native";
const OTHER_USER = "user.sourcec.r2.other";
const NAMESPACE = `${RUN_ID}_ns`;
const DATABASE = `${RUN_ID}_db`;
const VECTOR = [1, 0, 0];
const OMIT = Symbol("omit");
const CLEANUP_DEADLINE_MS = 2_000;
const SENTINEL_ENV_KEYS = [
  "SURREAL_URL",
  "SURREAL_USER",
  "SURREAL_PASS",
  "SURREAL_NS",
  "SURREAL_DB",
  "SURREAL_DATABASE",
] as const;

const VALID_LINEAGE = {
  state: "minni_verified",
  origin: "minni",
  producer_principal_ref: "principal.sourcec.r2.native",
  producer_registration_ref: "registration.sourcec.r2.native",
  processing_policy_version: "runir.minni.local/v1",
  admitted_operation: "capture_ingest",
  target_user_id: USER,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "ordinary",
    restrictions: [],
  },
} as const;
const INVALID_LINEAGE = { ...VALID_LINEAGE, state: "forged" };

type InsertInput = {
  id: string;
  text?: string;
  userId?: string;
  scope?: string;
  active?: boolean;
  lineage?: unknown | typeof OMIT;
  payloadLineage?: unknown | typeof OMIT;
};

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
    throw new Error(`R2 native fixture requires SurrealDB 3.1.4; resolved ${token}`);
  }
  return token;
}

function resolvedSurrealBinary(): { path: string; version: string } {
  if (!existsSync(SURREAL_BIN)) throw new Error("reviewed surreal CLI path is unavailable");
  return {
    path: SURREAL_BIN,
    version: parseSurrealVersion(execFileSync(SURREAL_BIN, ["version"], { encoding: "utf8" })),
  };
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

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("R2 native fixture did not allocate a port");
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
  throw new Error(`R2 native fixture did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

type OwnedChild = Pick<ChildProcess, "exitCode" | "signalCode" | "pid" | "once"> & {
  kill: (signal?: NodeJS.Signals) => boolean;
};

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
  const sentinel = sentinelServer;
  await new Promise<void>((resolve, reject) => {
    sentinel.once("error", reject);
    sentinel.listen(0, "127.0.0.1", () => resolve());
  });
  const address = sentinel.address();
  sentinelPort = typeof address === "object" && address ? address.port : 0;
  if (!sentinelPort) throw new Error("R2 native sentinel did not allocate a port");
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
        await boundedCall("R2 endpoint sentinel close", () => new Promise<void>((resolve, reject) => {
          sentinelServer?.close((error) => error ? reject(error) : resolve());
        }));
      } catch (error) {
        errors.push(toError(error));
        const closeAllConnections = (sentinelServer as typeof sentinelServer & { closeAllConnections?: () => void }).closeAllConnections;
        closeAllConnections?.();
      }
    }
    if (sentinelServer?.listening) errors.push(new Error("R2 endpoint sentinel listener remained open"));
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
  if (errors.length > 0) throw new AggregateError(errors, "R2 endpoint sentinel cleanup failed");
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
  expect(source).not.toContain(["localhost", "8000"].join(":"));
}

async function cleanupOwnedResources(
  closeSdk: () => Promise<void>,
  child: OwnedChild | undefined,
  port: number,
  deadlineMs = CLEANUP_DEADLINE_MS,
  waitForChildExit: (ownedChild: OwnedChild) => Promise<void> = (ownedChild) => waitForExit(ownedChild),
  canConnectFn: (ownedPort: number) => Promise<boolean> = canConnect,
): Promise<void> {
  const errors: Error[] = [];
  try {
    await boundedCall("R2 SDK close", closeSdk, deadlineMs);
  } catch (error) {
    errors.push(toError(error));
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      errors.push(toError(error));
    }
  }
  if (child) {
    try {
      await boundedCall("R2 owned child SIGTERM exit", () => waitForChildExit(child), deadlineMs);
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
        await boundedCall("R2 owned child SIGKILL exit", () => waitForChildExit(child), deadlineMs);
      } catch (error) {
        errors.push(toError(error));
      }
    }
  }
  let socketOpen = false;
  try {
    socketOpen = await boundedCall("R2 owned socket check", () => canConnectFn(port), deadlineMs);
  } catch (error) {
    errors.push(toError(error));
  }
  if (socketOpen) errors.push(new Error("R2 native fixture left its owned loopback socket open"));
  if (child && child.exitCode === null && child.signalCode === null) {
    errors.push(new Error("R2 native fixture left its owned Surreal process alive"));
  }
  console.log(`R2 native cleanup ownedPid=${child?.pid ?? "none"} processAlive=${child ? child.exitCode === null && child.signalCode === null : false} socketOpen=${socketOpen}`);
  if (errors.length > 0) throw new AggregateError(errors, "R2 native owned cleanup failed");
}

const SDK_VERSION = resolvedPackageVersion("surrealdb");

function fakeCleanupChild(): { child: OwnedChild; signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 99123,
    exitCode: null,
    signalCode: null,
    once: () => child,
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

async function insertSemiote(db: SurrealClient, input: InsertInput): Promise<void> {
  const lineageClause = input.lineage === OMIT ? "" : ", processing_lineage: $lineage";
  const payloadLineageClause = input.payloadLineage === OMIT ? "" : "processing_lineage: $payloadLineage,";
  const vars: Record<string, unknown> = {
    id: input.id,
    text: input.text ?? `lineage ${input.id}`,
    norm: input.text ?? `lineage ${input.id}`,
    userId: input.userId ?? USER,
    scope: input.scope ?? "user",
    active: input.active ?? true,
    now: "2026-10-01T21:00:00.000Z",
  };
  if (input.lineage !== OMIT) vars.lineage = input.lineage;
  if (input.payloadLineage !== OMIT) vars.payloadLineage = input.payloadLineage;
  await db.query(
    `CREATE type::record('semiote', $id) CONTENT {
       embedding: $embedding,
       payload: {
         l2: $text,
         userId: $userId,
         tags: ['synthetic'],
         ${payloadLineageClause}
       },
       text_norm: $norm,
       user_id: $userId,
       scope: $scope,
       created_at: <datetime>$now,
       updated_at: <datetime>$now,
       active: $active${lineageClause}
     };`,
    { ...vars, embedding: VECTOR },
  );
}

async function insertNoema(db: SurrealClient, input: { id: string; lineage?: unknown | typeof OMIT }): Promise<void> {
  const lineageClause = input.lineage === OMIT ? "" : ", processing_lineage: $lineage";
  const vars: Record<string, unknown> = {
    id: input.id,
    text: `noema lineage ${input.id}`,
    norm: `noema lineage ${input.id}`,
    userId: USER,
    now: "2026-10-01T21:00:00.000Z",
    embedding: VECTOR,
  };
  if (input.lineage !== OMIT) vars.lineage = input.lineage;
  await db.query(
    `CREATE type::record('noema', $id) CONTENT {
       canonical: { text: $text },
       canonical_text: $text,
       canonical_norm: $norm,
       embedding: $embedding,
       user_id: $userId,
       status: 'active',
       active: true,
       confidence: 0.9,
       stability: 0.8,
       created_at: <datetime>$now,
       updated_at: <datetime>$now${lineageClause}
     };`,
    vars,
  );
}

describe("R2 native query lineage reads", () => {
  let db: SurrealClient | undefined;
  let server: ChildProcess | undefined;

  function ownedDb(): SurrealClient {
    if (!db) throw new Error("R2 native fixture database was not initialized");
    return db;
  }

  async function stopOwnedProcess(): Promise<void> {
    await cleanupOwnedResources(
      async () => { if (db) await db.close(); },
      server,
      port,
    );
  }

  let port = 0;

  beforeAll(async () => {
    try {
      await installEndpointSentinel();
      const source = readFileSync(new URL("./processing-lineage-query-native.test.ts", import.meta.url), "utf8");
      assertFixtureConfigurationIsolation(source);
      expect(SDK_VERSION).toBe("2.0.3");
      const surreal = resolvedSurrealBinary();
      expect(surreal.path).toBe(SURREAL_BIN);
      expect(surreal.version).toBe("3.1.4");
      port = await freePort();
      server = spawn(
        surreal.path,
        ["start", "memory", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", PASSWORD, "--log", "none", "--no-banner"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      await waitForServer(port);
      db = new SurrealClient({
        url: `http://127.0.0.1:${port}`,
        username: "root",
        password: PASSWORD,
        namespace: NAMESPACE,
        database: DATABASE,
      });
      const owned = ownedDb();
      await owned.query("INFO FOR DB;");
      await ensurePhase2Schema(owned, 3);
      await insertSemiote(owned, { id: "r2-valid", lineage: VALID_LINEAGE, payloadLineage: OMIT });
      await insertSemiote(owned, { id: "r2-legacy", lineage: OMIT, payloadLineage: VALID_LINEAGE });
      await insertSemiote(owned, { id: "r2-invalid", lineage: INVALID_LINEAGE, payloadLineage: OMIT });
      await insertSemiote(owned, { id: "r2-other-user", userId: OTHER_USER, lineage: VALID_LINEAGE, payloadLineage: OMIT });
      await insertSemiote(owned, { id: "r2-alpha", text: "alpha", lineage: VALID_LINEAGE });
      await insertSemiote(owned, { id: "r2-beta", text: "beta", lineage: OMIT, payloadLineage: VALID_LINEAGE });
      await insertSemiote(owned, { id: "r2-both", text: "alpha beta", lineage: INVALID_LINEAGE });
      await insertSemiote(owned, { id: "r2-other-user-alpha", text: "alpha", userId: OTHER_USER, lineage: VALID_LINEAGE });
      await insertSemiote(owned, { id: "r2-inactive-beta", text: "beta", active: false, lineage: VALID_LINEAGE });
      await insertSemiote(owned, { id: "r2-other-scope-beta", text: "beta", scope: "session", lineage: VALID_LINEAGE });
      await insertNoema(owned, { id: "r2-noema-valid", lineage: VALID_LINEAGE });
      await insertNoema(owned, { id: "r2-noema-legacy", lineage: OMIT });
      await insertNoema(owned, { id: "r2-noema-invalid", lineage: INVALID_LINEAGE });
      expect(sentinelConnections).toBe(0);
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
      throw new AggregateError(errors, "R2 native fixture setup failed");
    }
  }, 60_000);

  afterAll(async () => {
    const errors: Error[] = [];
    try {
      await stopOwnedProcess();
    } catch (cleanupError) {
      errors.push(toError(cleanupError));
    }
    if (sentinelConnections !== 0) errors.push(new Error(`R2 endpoint sentinel accepted ${sentinelConnections} unexpected connections`));
    console.log(`R2 native endpoint sentinel connections=${sentinelConnections}`);
    try {
      await closeEndpointSentinel();
    } catch (sentinelError) {
      errors.push(toError(sentinelError));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "R2 native fixture cleanup failed");
    }
  });

  it("pins the reviewed native CLI and SDK versions", () => {
    expect(SDK_VERSION).toBe("2.0.3");
    expect(resolvedSurrealBinary().version).toBe("3.1.4");
  });

  it("bounds a hanging SDK close and still terminates the owned child", async () => {
    const { child, signals } = fakeCleanupChild();
    const started = Date.now();
    await expect(cleanupOwnedResources(
      () => new Promise<void>(() => {}),
      child,
      0,
      20,
      hangingChildWait,
      async () => false,
    )).rejects.toThrow(/owned cleanup failed/);
    expect(Date.now() - started).toBeLessThan(500);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("preserves a rejected SDK close while completing owned child cleanup", async () => {
    const { child, signals } = fakeCleanupChild();
    await expect(cleanupOwnedResources(
      async () => { throw new Error("synthetic SDK close rejection"); },
      child,
      0,
      20,
      hangingChildWait,
      async () => false,
    )).rejects.toThrow(/owned cleanup failed/);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("proves selected classification across direct, fused-RRF, and Noema full-row constructors", async () => {
    const owned = ownedDb();
    const vectorHits = await vectorSearch(owned, USER, VECTOR, 10, undefined, "semiote");
    expect(new Set(vectorHits.map((hit) => getSearchHitLineage(hit).state))).toEqual(
      new Set(["minni_verified", "legacy_unknown", "invalid"]),
    );
    expect(vectorHits.some((hit) => hit.id === "r2-other-user")).toBe(false);

    const bm25Hits = await bm25Search(owned, USER, "lineage", 10, new Map(), undefined, "semiote");
    expect(new Set(bm25Hits.map((hit) => getSearchHitLineage(hit).state))).toEqual(
      new Set(["minni_verified", "legacy_unknown", "invalid"]),
    );

    const multiBm25Hits = await bm25Search(
      owned,
      USER,
      "alpha beta",
      3,
      new Map(),
      { whereClause: "AND scope = $scope", vars: { scope: "user" } },
      "semiote",
    );
    expect(multiBm25Hits).toHaveLength(3);
    expect(multiBm25Hits.map((hit) => hit.id)).toEqual(["r2-both", "r2-alpha", "r2-beta"]);
    expect(multiBm25Hits[0].score).toBeGreaterThan(multiBm25Hits[1].score);
    expect(multiBm25Hits[0].scoreStages?.bm25?.matchedTerms).toEqual(["alpha", "beta"]);
    expect(multiBm25Hits.every((hit) => !["r2-other-user-alpha", "r2-inactive-beta", "r2-other-scope-beta"].includes(hit.id))).toBe(true);

    const rrfHits = await nativeRrfSearch(owned, USER, VECTOR, "", 10, undefined, undefined, 0, undefined, undefined, "semiote");
    expect(new Set(rrfHits.map((hit) => getSearchHitLineage(hit).state))).toEqual(
      new Set(["minni_verified", "legacy_unknown", "invalid"]),
    );

    const primaryPolicy = {
      id: "noema-admissibility-v1",
      mode: "primary",
      reason: "synthetic-r2-native",
      preferNoemaOverSupportingSemiote: true,
      fallbackOnly: false,
    } as const;
    const merged = await runHybridQueryWithEvidenceTable({
      db: owned,
      userId: USER,
      query: "",
      embedding: VECTOR,
      limit: 10,
      evidenceTable: "semiote",
      noemaRetrieval: { policy: primaryPolicy },
    });
    const noemaHits = merged.filter((hit) => hit.sourceKind === "noema");
    expect(new Set(noemaHits.map((hit) => getSearchHitLineage(hit).state))).toEqual(
      new Set(["minni_verified", "legacy_unknown", "invalid"]),
    );
    console.log(`R2 native selected counts vector=${vectorHits.length} bm25=${bm25Hits.length} multiBm25=${multiBm25Hits.length} rrf=${rrfHits.length} noema=${noemaHits.length}`);

    const selectedHits = [...vectorHits, ...bm25Hits, ...multiBm25Hits, ...rrfHits, ...noemaHits];
    for (const hit of selectedHits) {
      const state = getSearchHitLineage(hit);
      expect(state.state).toMatch(/^(minni_verified|legacy_unknown|invalid)$/);
      expect(JSON.stringify(hit)).not.toContain("processing_lineage");
      expect(JSON.stringify(hit)).not.toContain("minni_verified");
      expect(getSearchHitLineage({ ...hit })).toEqual(state);
    }

    const unselectedRows = await owned.query<any>(
      "SELECT id, payload FROM semiote WHERE id = type::record('semiote', $id);",
      { id: "r2-valid" },
    );
    expect(getSearchHitLineage(mapMemoryRowToSearchHit(unselectedRows[0][0]))).toEqual({ state: "unavailable" });
  }, 60_000);
});
