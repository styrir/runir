import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordId } from "surrealdb";
import { PROCESSING_LINEAGE_VERSION } from "../src/domain/memory/processing-lineage.js";
import {
  attachSelectedSearchHitLineage,
  getSearchHitLineage,
} from "../src/domain/memory/search-hit-lineage.js";
import type { SearchHit } from "../src/domain/memory/types.js";
import {
  createOverlayRegistry,
  type OverlayEntry,
  type OverlayRegistry,
} from "../src/storage/overlay/overlay-store.js";
import type { OverlayLockKey } from "../src/storage/writes/overlay-supersession.js";
import { SurrealClient } from "../src/storage/surreal/surreal-client.js";
import { ensurePhase2Schema } from "../src/storage/surreal/phase2-store.js";
import { mergeOverlayLeg } from "../src/recall/query/overlay-merge.js";

const SURREAL_BIN = "/usr/local/bin/surreal";
const RUN_ID = `sourcec_r3_${process.pid}_${randomUUID().replaceAll("-", "_")}`;
const PASSWORD = "sourcec-r3-native-synthetic";
const USER = "user.sourcec.r3.native";
const OTHER_USER = "user.sourcec.r3.other";
const NAMESPACE = `${RUN_ID}_ns`;
const DATABASE = `${RUN_ID}_db`;
const VECTOR = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
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
  producer_principal_ref: "principal.sourcec.r3.native",
  producer_registration_ref: "registration.sourcec.r3.native",
  processing_policy_version: "runir.minni.local/v1",
  admitted_operation: "capture_ingest",
  target_user_id: USER,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "ordinary",
    restrictions: [],
  },
} as const;
const RESTRICTED_LINEAGE = {
  ...VALID_LINEAGE,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "local_only",
    restrictions: ["audio_derived", "excluded_source", "producer_local_only"],
  },
} as const;
const INVALID_LINEAGE = { ...VALID_LINEAGE, state: "forged" };

type SeedInput = {
  id: string;
  userId?: string;
  payloadUserId?: string;
  active?: boolean;
  lineage?: unknown | typeof OMIT;
};

type OwnedChild = Pick<ChildProcess, "exitCode" | "signalCode" | "pid" | "once"> & {
  kill: (signal?: NodeJS.Signals) => boolean;
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
  if (!/^\d+\.\d+\.\d+$/.test(token)) throw new Error(`SurrealDB CLI version output has no version token: ${output.trim()}`);
  if (token !== "3.1.4") throw new Error(`R3 native fixture requires SurrealDB 3.1.4; resolved ${token}`);
  return token;
}

function resolvedSurrealBinary(): { path: string; version: string } {
  if (!existsSync(SURREAL_BIN)) throw new Error("reviewed SurrealDB CLI path is unavailable");
  return { path: SURREAL_BIN, version: parseSurrealVersion(execFileSync(SURREAL_BIN, ["version"], { encoding: "utf8" })) };
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
  if (!port) throw new Error("R3 native fixture did not allocate a port");
  return port;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
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
  throw new Error(`R3 native fixture did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
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
  const address = sentinelServer?.address();
  sentinelPort = typeof address === "object" && address ? address.port : 0;
  if (!sentinelPort) throw new Error("R3 endpoint sentinel did not allocate a port");
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
        await boundedCall("R3 endpoint sentinel close", () => new Promise<void>((resolve, reject) => {
          sentinelServer?.close((error) => error ? reject(error) : resolve());
        }));
      } catch (error) {
        errors.push(toError(error));
        (sentinelServer as typeof sentinelServer & { closeAllConnections?: () => void }).closeAllConnections?.();
      }
    }
    if (sentinelServer?.listening) errors.push(new Error("R3 endpoint sentinel listener remained open"));
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
  if (errors.length > 0) throw new AggregateError(errors, "R3 endpoint sentinel cleanup failed");
}

function assertFixtureConfigurationIsolation(source: string): void {
  const configKeys = "URL|USER|PASS|NS|DB|DATABASE";
  const directReads = source.split(/\r?\n/).filter((line) => new RegExp(`process\\.env\\.SURREAL_(?:${configKeys})(?!\\s*=)`).test(line));
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
  canConnectFn: (ownedPort: number) => Promise<boolean> = canConnect,
): Promise<void> {
  const errors: Error[] = [];
  try { await boundedCall("R3 SDK close", closeSdk, deadlineMs); } catch (error) { errors.push(toError(error)); }
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch (error) { errors.push(toError(error)); }
  }
  if (child) {
    try { await boundedCall("R3 child SIGTERM exit", () => waitForExit(child), deadlineMs); } catch (error) { errors.push(toError(error)); }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch (error) { errors.push(toError(error)); }
      try { await boundedCall("R3 child SIGKILL exit", () => waitForExit(child), deadlineMs); } catch (error) { errors.push(toError(error)); }
    }
  }
  let socketOpen = false;
  try { socketOpen = await boundedCall("R3 socket check", () => canConnectFn(port), deadlineMs); } catch (error) { errors.push(toError(error)); }
  if (socketOpen) errors.push(new Error("R3 native fixture left its owned loopback socket open"));
  if (child && child.exitCode === null && child.signalCode === null) errors.push(new Error("R3 native fixture left its owned Surreal process alive"));
  console.log(`R3 native cleanup ownedPid=${child?.pid ?? "none"} processAlive=${child ? child.exitCode === null && child.signalCode === null : false} socketOpen=${socketOpen}`);
  if (errors.length > 0) throw new AggregateError(errors, "R3 native cleanup failed");
}

function fakeCleanupChild(): { child: OwnedChild; signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 87362,
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

async function insertSemiote(db: SurrealClient, input: SeedInput): Promise<void> {
  const lineageClause = input.lineage === OMIT ? "" : ", processing_lineage: $lineage";
  const vars: Record<string, unknown> = {
    id: input.id,
    userId: input.userId ?? USER,
    payloadUserId: input.payloadUserId ?? input.userId ?? USER,
    active: input.active ?? true,
    text: `R3 ${input.id}`,
    now: "2026-10-02T00:00:00.000Z",
    embedding: VECTOR,
  };
  if (input.lineage !== OMIT) vars.lineage = input.lineage;
  await db.query(
    `CREATE type::record('semiote', $id) CONTENT {
       embedding: $embedding,
       payload: { l2: $text, userId: $payloadUserId, tags: ['synthetic'] },
       text_norm: $text,
       user_id: $userId,
       scope: 'user',
       created_at: <datetime>$now,
       updated_at: <datetime>$now,
       active: $active${lineageClause}
     };`,
    vars,
  );
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

function expectProductionEmbeddingIndexes(schemaInfo: { semiote: unknown; noema: unknown }): void {
  for (const [table, info, indexName] of [
    ["semiote", schemaInfo.semiote, "idx_semiote_embedding"],
    ["noema", schemaInfo.noema, "idx_noema_embedding"],
  ] as const) {
    const definition = infoIndexText(info, indexName).replace(/\s+/g, " ").toUpperCase();
    expect(definition, `${table} ${indexName}`).toMatch(/\bHNSW\b/);
    expect(definition, `${table} ${indexName}`).toMatch(/\bDIMENSION\s+768\b/);
    expect(definition, `${table} ${indexName}`).toMatch(/\bDIST\s+COSINE\b/);
    expect(definition, `${table} ${indexName}`).toMatch(/\bTYPE\s+F32\b/);
  }
}

function entry(memoryId: string, userId = USER, active = true): OverlayEntry {
  const lockKey: OverlayLockKey = { factKey: `r3:${memoryId}`, continuitySubjectKey: `r3:${memoryId}` };
  return {
    memoryId,
    text: `overlay-${memoryId}`,
    lockKey,
    userId,
    score: 0.95,
    committedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_120_000,
    lastAccessedAtMs: 1_700_000_000_000,
    active,
    outcome: "create",
  };
}

function newRegistry(): OverlayRegistry {
  return createOverlayRegistry({ perTenantCap: 256, ttlMs: 120_000, globalAggregateCap: 5_000, now: () => 1_700_000_000_000 });
}

async function mergeOne(db: SurrealClient, id: string, userId = USER, tableName = "semiote" as const): Promise<SearchHit[]> {
  const registry = newRegistry();
  const item = entry(id, userId);
  registry.forUser(userId).put(item.lockKey, item);
  return mergeOverlayLeg({ db, userId, overlay: { registry }, durableHits: [], tableName });
}

const SDK_VERSION = resolvedPackageVersion("surrealdb");

describe("R3 native overlay propagation — owned current-user typed fallback", () => {
  let db: SurrealClient | undefined;
  let server: ChildProcess | undefined;
  let port = 0;

  const ownedDb = (): SurrealClient => {
    if (!db) throw new Error("R3 native database was not initialized");
    return db;
  };

  const stopOwnedProcess = async (): Promise<void> => cleanupOwnedResources(async () => { if (db) await db.close(); }, server, port);

  beforeAll(async () => {
    try {
      await installEndpointSentinel();
      const source = readFileSync(new URL("./processing-lineage-overlay-native.test.ts", import.meta.url), "utf8");
      assertFixtureConfigurationIsolation(source);
      expect(SDK_VERSION).toBe("2.0.3");
      const surreal = resolvedSurrealBinary();
      expect(surreal.version).toBe("3.1.4");
      port = await freePort();
      server = spawn(surreal.path, ["start", "memory", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", PASSWORD, "--log", "none", "--no-banner"], { stdio: ["ignore", "ignore", "ignore"] });
      await waitForServer(port);
      db = new SurrealClient({ url: `http://127.0.0.1:${port}`, username: "root", password: PASSWORD, namespace: NAMESPACE, database: DATABASE });
      const owned = ownedDb();
      await owned.query("INFO FOR DB;");
      await ensurePhase2Schema(owned, 768);
      expectProductionEmbeddingIndexes({
        semiote: await owned.query("INFO FOR TABLE semiote;"),
        noema: await owned.query("INFO FOR TABLE noema;"),
      });
      await insertSemiote(owned, { id: "r3-legacy", lineage: OMIT });
      await insertSemiote(owned, { id: "r3-valid", lineage: VALID_LINEAGE });
      await insertSemiote(owned, { id: "r3-restricted", lineage: RESTRICTED_LINEAGE });
      await insertSemiote(owned, { id: "r3-invalid", lineage: INVALID_LINEAGE });
      await insertSemiote(owned, { id: "r3-wrong-root", userId: OTHER_USER, payloadUserId: USER, lineage: OMIT });
      await insertSemiote(owned, { id: "r3-wrong-payload", userId: USER, payloadUserId: OTHER_USER, lineage: OMIT });
      await insertSemiote(owned, { id: "r3-foreign", userId: OTHER_USER, lineage: OMIT });
      await insertSemiote(owned, { id: "r3-inactive", active: false, lineage: OMIT });
      const seeded = await owned.query<Record<string, unknown>>("SELECT embedding FROM type::record('semiote', $id);", { id: "r3-legacy" });
      expect(seeded[0]?.[0]?.embedding).toEqual(VECTOR);
      await owned.query("DEFINE TABLE r3_legacy_overlay SCHEMALESS;");
      await owned.query("CREATE type::record('r3_legacy_overlay', $id) CONTENT $content;", { id: "r3-missing", content: { active: true } });
      await owned.query("CREATE type::record('r3_legacy_overlay', $id) CONTENT $content;", { id: "r3-null", content: { user_id: null, payload: { userId: null }, active: true } });
      await owned.query("CREATE type::record('r3_legacy_overlay', $id) CONTENT $content;", { id: "r3-bad-type", content: { user_id: 7, payload: { userId: USER }, active: true } });
      expect(sentinelConnections).toBe(0);
    } catch (error) {
      const errors: Error[] = [toError(error)];
      try { await stopOwnedProcess(); } catch (cleanupError) { errors.push(toError(cleanupError)); }
      try { await closeEndpointSentinel(); } catch (sentinelError) { errors.push(toError(sentinelError)); }
      throw new AggregateError(errors, "R3 native setup failed");
    }
  }, 60_000);

  afterAll(async () => {
    const errors: Error[] = [];
    try { await stopOwnedProcess(); } catch (error) { errors.push(toError(error)); }
    console.log(`R3 native endpoint sentinel connections=${sentinelConnections}`);
    if (sentinelConnections !== 0) errors.push(new Error(`R3 endpoint sentinel accepted ${sentinelConnections} unexpected connections`));
    try { await closeEndpointSentinel(); } catch (error) { errors.push(toError(error)); }
    if (errors.length > 0) throw new AggregateError(errors, "R3 native cleanup failed");
  });

  it("pins exact CLI and SDK versions", () => {
    expect(SDK_VERSION).toBe("2.0.3");
    expect(resolvedSurrealBinary().version).toBe("3.1.4");
  });

  it("bounds rejected and hanging SDK close while terminating the owned child", async () => {
    const hanging = fakeCleanupChild();
    await expect(cleanupOwnedResources(() => new Promise<void>(() => {}), hanging.child, 0, 20, async () => false)).rejects.toThrow(/cleanup failed/);
    expect(hanging.signals).toEqual(["SIGTERM", "SIGKILL"]);
    const rejected = fakeCleanupChild();
    await expect(cleanupOwnedResources(async () => { throw new Error("synthetic close rejection"); }, rejected.child, 0, 20, async () => false)).rejects.toThrow(/cleanup failed/);
    expect(rejected.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("classifies current owned legacy, valid, restricted, and invalid lineage through the actual export", async () => {
    const owned = ownedDb();
    for (const [id, expected] of [["r3-legacy", "legacy_unknown"], ["r3-valid", "minni_verified"], ["r3-restricted", "minni_verified"], ["r3-invalid", "invalid"]] as const) {
      const hits = await mergeOne(owned, id);
      expect(hits).toHaveLength(1);
      expect(getSearchHitLineage(hits[0]).state).toBe(expected);
      expect(JSON.stringify(hits)).not.toContain("processing_lineage");
    }
  }, 30_000);

  it("drops mismatched, foreign, inactive, and schemaless missing/null/type identities before lineage", async () => {
    const owned = ownedDb();
    for (const id of ["r3-wrong-root", "r3-wrong-payload", "r3-foreign", "r3-inactive"] as const) {
      expect(await mergeOne(owned, id)).toEqual([]);
    }
    for (const id of ["r3-missing", "r3-null", "r3-bad-type"] as const) {
      expect(await mergeOne(owned, id, USER, "r3_legacy_overlay" as "semiote")).toEqual([]);
    }
    const observed = await owned.query("SELECT id, user_id, payload.userId AS payload_user_id, active FROM r3_legacy_overlay WHERE id IN $ids;", { ids: [new RecordId("r3_legacy_overlay", "r3-missing"), new RecordId("r3_legacy_overlay", "r3-null"), new RecordId("r3_legacy_overlay", "r3-bad-type")] });
    expect(observed[0]).toHaveLength(3);
  }, 30_000);

  it("uses one actual typed-id fallback batch and keeps overlay precedence, durable stage, and wire omission", async () => {
    const owned = ownedDb();
    const ids = ["r3-batch-a", "r3-batch-b", "r3-batch-c"];
    for (const id of ids) await insertSemiote(owned, { id, lineage: OMIT });
    const registry = newRegistry();
    for (const id of ids) {
      const item = entry(id);
      registry.forUser(USER).put(item.lockKey, item);
    }
    const originalQuery = owned.query.bind(owned);
    let observedVars: Record<string, unknown> | undefined;
    let queryCount = 0;
    (owned as unknown as { query: SurrealClient["query"] }).query = async (...args) => {
      queryCount += 1;
      observedVars = args[1] as Record<string, unknown> | undefined;
      return originalQuery(...args);
    };
    let merged: SearchHit[];
    try {
      merged = await mergeOverlayLeg({ db: owned, userId: USER, overlay: { registry }, durableHits: [], tableName: "semiote" });
    } finally {
      (owned as unknown as { query: SurrealClient["query"] }).query = originalQuery;
    }
    expect(queryCount).toBe(1);
    const boundIds = observedVars?.ids as RecordId<string>[];
    expect(boundIds).toHaveLength(3);
    expect(boundIds.every((id) => id instanceof RecordId)).toBe(true);
    expect(boundIds.map((id) => id.toJSON())).toEqual(ids.map((id) => new RecordId("semiote", id).toJSON()));
    expect(observedVars?.requestedUser).toBe(USER);
    expect(merged).toHaveLength(3);

    const durable = attachSelectedSearchHitLineage({ id: "r3-batch-a", text: "durable", score: 0.1, active: true }, VALID_LINEAGE);
    const durableRegistry = newRegistry();
    const durableEntry = { ...entry("r3-batch-a"), active: false };
    durableRegistry.forUser(USER).put(durableEntry.lockKey, durableEntry);
    const overlayWins = await mergeOverlayLeg({ db: owned, userId: USER, overlay: { registry: durableRegistry }, durableHits: [durable], tableName: "semiote" });
    expect(overlayWins[0].text).toBe("overlay-r3-batch-a");
    expect(getSearchHitLineage(overlayWins[0]).state).toBe("minni_verified");
    expect(JSON.stringify(overlayWins)).not.toContain("processing_lineage");

    const unavailable = await mergeOverlayLeg({
      db: owned,
      userId: USER,
      overlay: { registry: durableRegistry },
      durableHits: [{ id: "r3-batch-a", text: "durable", score: 0.1, active: true, processing_lineage: "spoof" } as SearchHit & { processing_lineage: string }],
      tableName: "semiote",
    });
    expect(getSearchHitLineage(unavailable[0]).state).toBe("unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("processing_lineage");

    const empty = await mergeOverlayLeg({ db: owned, userId: USER, overlay: { registry: newRegistry() }, durableHits: [durable], tableName: "semiote" });
    expect(empty).toEqual([durable]);
  }, 30_000);
});
