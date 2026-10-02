import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../src/storage/surreal/surreal-client.js";
import {
  ensureStalenessBacklogTable,
  writeCurrentSnapshotStalenessBacklog,
} from "../src/lifecycle/semion/lock.js";
import { ensurePhase2Schema } from "../src/storage/surreal/phase2-store.js";
import { processingLineageSchemaStatements } from "../src/storage/surreal/processing-lineage-schema.js";

const runNative = process.env.RUNIR_LINEAGE_NATIVE_BACKLOG === "1";
const PASSWORD = "backlog-native-synthetic";
const USER = "root";
const NAMESPACE = "backlog_native_ns";
const DATABASE = "backlog_native_db";
const SENTINEL_ENV_KEYS = ["SURREAL_URL", "SURREAL_USER", "SURREAL_PASS", "SURREAL_NS", "SURREAL_DB", "SURREAL_DATABASE"] as const;

type OwnedChild = Pick<ChildProcess, "exitCode" | "signalCode" | "pid"> & { kill: (signal?: NodeJS.Signals) => boolean };

function resolvedPackageVersion(packageName: string): string {
  const entry = execFileSync(process.execPath, ["-e", `process.stdout.write(require.resolve(${JSON.stringify(packageName)}))`], { encoding: "utf8" }).trim();
  let current = dirname(entry);
  while (current !== dirname(current)) {
    const packageJson = `${current}/package.json`;
    if (existsSync(packageJson)) {
      const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string; version?: string };
      if (parsed.name === packageName && typeof parsed.version === "string") return parsed.version;
    }
    current = dirname(current);
  }
  throw new Error(`installed ${packageName} package version unavailable`);
}

function surrealVersion(): string {
  const output = execFileSync("/usr/local/bin/surreal", ["version"], { encoding: "utf8" }).trim();
  const version = output.split(/\s+/)[0] ?? "";
  if (version !== "3.1.4") throw new Error(`native backlog fixture requires SurrealDB 3.1.4, got ${version}`);
  return version;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("native backlog fixture did not allocate a port");
  return port;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
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
  throw new Error(`native backlog fixture did not listen on ${port}`);
}

async function bounded<T>(label: string, operation: () => Promise<T>, deadlineMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), deadlineMs); });
  try { return await Promise.race([operation(), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function cleanupOwnedResources(db: SurrealClient | undefined, child: OwnedChild | undefined, port: number): Promise<void> {
  const errors: Error[] = [];
  if (db) {
    try { await bounded("SDK close", () => db.close()); }
    catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (child) {
    try {
      await bounded("owned child exit", () => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const processChild = child as ChildProcess;
        if (typeof processChild.once !== "function") {
          resolve();
          return;
        }
        const onExit = () => resolve();
        processChild.once("exit", onExit);
        processChild.kill("SIGTERM");
      }));
    }
    catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (await canConnect(port)) errors.push(new Error("owned loopback socket remained open"));
  if (errors.length > 0) throw new AggregateError(errors, `native backlog cleanup failed: ${errors.map((error) => error.message).join("; ")}`);
}

function infoFields(raw: unknown): Record<string, string> {
  const outer = Array.isArray(raw) ? raw[0] : raw;
  const value = Array.isArray(outer) ? outer[0] : outer;
  const fields = value && typeof value === "object" ? (value as { fields?: unknown }).fields : undefined;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields as Record<string, string> : {};
}

function legacyCreate(id: string, text = "stored native fact", confidence = 0.9, supportIds: string[] = []): string {
  const support = supportIds.length > 0 ? `, noemaSupportSemioteIds: ${JSON.stringify(supportIds)}` : "";
  return `CREATE semiote:${id} SET user_id = 'native-user', scope = 'user', payload = { userId: 'native-user', scope: 'user', active: true, l2: '${text}', confidence: ${confidence}${support} }, active = true, created_at = time::now(), updated_at = time::now();`;
}

async function removeAndDefineTable(db: SurrealClient, factsDDL: string[] = []): Promise<void> {
  await db.query("REMOVE TABLE IF EXISTS staleness_backlog;");
  await db.query("DEFINE TABLE staleness_backlog SCHEMAFULL;");
  await db.query(processingLineageSchemaStatements("staleness_backlog").join("\n"));
  if (factsDDL.length > 0) await db.query(factsDDL.join("\n"));
}

function insertThrowAfter(sql: string, marker: string, message: string): string {
  const markerIndex = sql.indexOf(marker);
  if (markerIndex < 0) throw new Error(`native injection marker missing: ${marker}`);
  const end = sql.indexOf("};", markerIndex);
  if (end < 0) throw new Error(`native injection end missing: ${marker}`);
  const insertion = end + 2;
  return `${sql.slice(0, insertion)}\nTHROW "${message}";\n${sql.slice(insertion)}`;
}

function stableValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === undefined) return "<NONE>";
  if (value === null) return "<NULL>";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value !== "object") return `<${typeof value}>`;
  if (ancestors.has(value)) return "<CYCLE>";
  ancestors.add(value);
  try {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.toJSON === "function") return stableValue(candidate.toJSON(), ancestors);
    if (Array.isArray(value)) return `[${value.map((item) => stableValue(item, ancestors)).join(",")}]`;
    return `{${Object.keys(candidate).sort().map((key) => `${JSON.stringify(key)}:${stableValue(candidate[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function fullRowDigest(db: SurrealClient, table: "semiote" | "staleness_backlog", id: string): Promise<string | undefined> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM type::record('${table}', $id) LIMIT 1;`,
    { id },
  );
  const row = result[0]?.[0];
  return row && typeof row === "object" ? stableValue(row) : undefined;
}

describe.skipIf(!runNative)("Sourcec CG generic current-snapshot backlog native proof", () => {
  let db: SurrealClient;
  let server: ChildProcess;
  let port = 0;
  let sentinel: ReturnType<typeof createServer>;
  let sentinelConnections = 0;
  const sentinelSockets = new Set<Socket>();
  const savedEnvironment: Partial<Record<(typeof SENTINEL_ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(async () => {
    expect(surrealVersion()).toBe("3.1.4");
    expect(resolvedPackageVersion("surrealdb")).toBe("2.0.3");
    port = await freePort();
    server = spawn("/usr/local/bin/surreal", ["start", "memory", "--bind", `127.0.0.1:${port}`, "--user", USER, "--pass", PASSWORD, "--log", "none", "--no-banner"], { stdio: ["ignore", "ignore", "ignore"] });
    await waitForServer(port);
    sentinel = createServer((socket) => { sentinelConnections += 1; sentinelSockets.add(socket); socket.once("close", () => sentinelSockets.delete(socket)); socket.destroy(); });
    await new Promise<void>((resolve, reject) => { sentinel.once("error", reject); sentinel.listen(0, "127.0.0.1", resolve); });
    const address = sentinel.address();
    const sentinelPort = typeof address === "object" && address ? address.port : 0;
    for (const key of SENTINEL_ENV_KEYS) savedEnvironment[key] = process.env[key];
    process.env.SURREAL_URL = `http://127.0.0.1:${sentinelPort}`;
    process.env.SURREAL_USER = "sentinel-user";
    process.env.SURREAL_PASS = "sentinel-pass";
    process.env.SURREAL_NS = "sentinel-ns";
    process.env.SURREAL_DB = "sentinel-db";
    process.env.SURREAL_DATABASE = "sentinel-db";
    db = new SurrealClient({ url: `http://127.0.0.1:${port}`, username: USER, password: PASSWORD, namespace: NAMESPACE, database: DATABASE });
    await ensurePhase2Schema(db, 8);
    await ensureStalenessBacklogTable(db);
  }, 30_000);

  afterAll(async () => {
    try {
      for (const socket of sentinelSockets) socket.destroy();
      if (sentinel?.listening) await new Promise<void>((resolve) => sentinel.close(() => resolve()));
      await cleanupOwnedResources(db, server, port);
    } finally {
      for (const key of SENTINEL_ENV_KEYS) {
        const value = savedEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(sentinelConnections).toBe(0);
  });

  it("reproduces the parent-only facts failure and qualifies identical repaired persistence", async () => {
    const exactFacts = [{ text: "parent-only exact fact", confidence: 0.75, replacementMemoryId: "semiote:cg_source" }];
    await db.query(`
      REMOVE TABLE IF EXISTS staleness_backlog;
      DEFINE TABLE staleness_backlog SCHEMAFULL;
      DEFINE FIELD facts ON TABLE staleness_backlog TYPE array;
      DEFINE FIELD user_id ON TABLE staleness_backlog TYPE string;
      DEFINE FIELD scope ON TABLE staleness_backlog TYPE string;
      DEFINE FIELD session_id ON TABLE staleness_backlog TYPE option<string>;
      DEFINE FIELD triggered_at ON TABLE staleness_backlog TYPE datetime;
      DEFINE FIELD status ON TABLE staleness_backlog TYPE string;
    `);
    const parentOnlyFields = infoFields(await db.query("INFO FOR TABLE staleness_backlog;"));
    expect(Object.keys(parentOnlyFields).sort()).toEqual(["facts", "scope", "session_id", "status", "triggered_at", "user_id"]);
    await expect(db.query(
      "CREATE ONLY staleness_backlog:parent_only_exact CONTENT { user_id: 'cg-user', scope: 'user', session_id: NONE, triggered_at: time::now(), facts: $facts, status: 'pending' };",
      { facts: exactFacts },
    )).rejects.toThrow(/facts\[0\]\.confidence/);
    expect(await fullRowDigest(db, "staleness_backlog", "parent_only_exact")).toBeUndefined();

    await db.query(`
      REMOVE TABLE IF EXISTS staleness_backlog;
      DEFINE TABLE staleness_backlog SCHEMAFULL;
      DEFINE FIELD facts ON TABLE staleness_backlog TYPE array;
      DEFINE FIELD user_id ON TABLE staleness_backlog TYPE string;
      DEFINE FIELD scope ON TABLE staleness_backlog TYPE string;
      DEFINE FIELD session_id ON TABLE staleness_backlog TYPE option<string>;
      DEFINE FIELD triggered_at ON TABLE staleness_backlog TYPE datetime;
      DEFINE FIELD status ON TABLE staleness_backlog TYPE string;
    `);
    await ensureStalenessBacklogTable(db);
    let fields = infoFields(await db.query("INFO FOR TABLE staleness_backlog;"));
    expect(fields.facts).toMatch(/TYPE array/i);
    expect(fields["facts.*.text"]).toMatch(/TYPE string/i);
    expect(fields["facts.*.confidence"]).toMatch(/TYPE float/i);
    expect(fields["facts.*.replacementMemoryId"]).toMatch(/TYPE string/i);

    await db.query(
      "CREATE ONLY staleness_backlog:repaired CONTENT { user_id: 'cg-user', scope: 'user', session_id: NONE, triggered_at: time::now(), facts: $facts, status: 'pending' };",
      { facts: exactFacts },
    );
    const repairedRows = await db.query<Record<string, unknown>>("SELECT * FROM staleness_backlog:repaired;");
    const repairedRow = repairedRows[0]?.[0] as Record<string, unknown> | undefined;
    expect(repairedRow).toMatchObject({ user_id: "cg-user", scope: "user", status: "pending" });
    expect(repairedRow?.facts).toEqual(exactFacts);
    expect(await fullRowDigest(db, "staleness_backlog", "repaired")).toBeDefined();

    await ensureStalenessBacklogTable(db);
    fields = infoFields(await db.query("INFO FOR TABLE staleness_backlog;"));
    expect(Object.keys(fields).filter((key) => key === "facts" || key.startsWith("facts.")).sort()).toEqual([
      "facts", "facts.*.confidence", "facts.*.replacementMemoryId", "facts.*.text",
    ]);

    for (const factsDDL of [
      ["DEFINE FIELD facts ON TABLE staleness_backlog TYPE array;", "DEFINE FIELD facts.*.text ON TABLE staleness_backlog TYPE string;"],
      ["DEFINE FIELD facts ON TABLE staleness_backlog TYPE string;"],
      ["DEFINE FIELD facts ON TABLE staleness_backlog TYPE array;", "DEFINE FIELD facts.*.text ON TABLE staleness_backlog TYPE string;", "DEFINE FIELD facts.*.confidence ON TABLE staleness_backlog TYPE float;", "DEFINE FIELD facts.*.replacementMemoryId ON TABLE staleness_backlog TYPE string;", "DEFINE FIELD facts.*.extra ON TABLE staleness_backlog TYPE string;"],
    ]) {
      await removeAndDefineTable(db, factsDDL);
      await expect(ensureStalenessBacklogTable(db)).rejects.toThrow(/facts schema refused/);
    }

    await removeAndDefineTable(db, ["DEFINE FIELD facts ON TABLE staleness_backlog TYPE array;"]);
    const originalQuery = db.query.bind(db);
    let raced = false;
    (db as any).query = async (sql: string, ...args: unknown[]) => {
      const result = await originalQuery(sql, ...args);
      if (!raced && sql.includes("facts.*.text")) {
        raced = true;
        await originalQuery("DEFINE FIELD facts.*.race ON TABLE staleness_backlog TYPE string;");
      }
      return result;
    };
    await expect(ensureStalenessBacklogTable(db)).rejects.toThrow(/facts schema refused/);
    (db as any).query = originalQuery;
    await removeAndDefineTable(db);
    await ensureStalenessBacklogTable(db);
  }, 30_000);

  it("commits exact stored legacy facts and never stores lineage", async () => {
    await ensureStalenessBacklogTable(db);
    await db.query(legacyCreate("native_replacement", "stored native fact", 0.9));
    const result = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_replacement" }]);
    expect(result.status).toBe("committed");
    const rows = await db.query<Record<string, unknown>>("SELECT * FROM staleness_backlog ORDER BY triggered_at DESC LIMIT 1;");
    const row = rows[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({ user_id: "native-user", scope: "user", status: "pending" });
    expect(row).not.toHaveProperty("processing_lineage");
    expect((row.facts as Array<Record<string, unknown>>)[0]).toEqual({ text: "stored native fact", confidence: 0.9, replacementMemoryId: "native_replacement" });
  }, 30_000);

  it("reconciles a real commit followed by a wrapper rejection with full source/backlog witnesses", async () => {
    await db.query(legacyCreate("native_postcommit", "postcommit fact", 0.61));
    const sourceBefore = await fullRowDigest(db, "semiote", "native_postcommit");
    const originalTransaction = db.queryTransaction.bind(db);
    (db as any).queryTransaction = async (sql: string, vars: Record<string, unknown>) => {
      await originalTransaction(sql, vars);
      throw new Error("synthetic wrapper rejection after COMMIT");
    };
    const result = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_postcommit" }]);
    (db as any).queryTransaction = originalTransaction;
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(await fullRowDigest(db, "semiote", "native_postcommit")).toBe(sourceBefore);
    expect(await fullRowDigest(db, "staleness_backlog", result.backlogId)).toContain("postcommit fact");
  }, 30_000);

  it("requires strict top-level and payload user/scope bindings before reading facts", async () => {
    await db.query("CREATE semiote:native_top_only SET user_id = 'native-user', scope = 'user', active = true, payload = { active: true, l2: 'should not read', confidence: 0.4 }, created_at = time::now(), updated_at = time::now();");
    await expect(writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_top_only" }]))
      .resolves.toMatchObject({ status: "refused", reason: "source_user_mismatch", contentFree: true });
    await db.query("CREATE semiote:native_payload_only SET user_id = 'native-user', scope = 'user', payload = { scope: 'user', active: true, l2: 'should not read', confidence: 0.4 }, active = true, created_at = time::now(), updated_at = time::now();");
    await expect(writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_payload_only" }]))
      .resolves.toMatchObject({ status: "refused", reason: "source_user_mismatch", contentFree: true });
  }, 30_000);

  it("checks support metadata, lineage absence, user/session/branch, and collision before facts", async () => {
    await db.query(legacyCreate("native_support", "support", 0.4));
    await db.query(legacyCreate("native_with_support", "source", 0.7, ["native_support"]));
    const committed = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_with_support" }]);
    expect(committed.status).toBe("committed");

    await db.query("CREATE semiote:native_lineage SET user_id = 'native-user', scope = 'user', processing_lineage = { state: 'minni_verified', origin: 'minni', producer_principal_ref: 'principal', producer_registration_ref: 'registration', processing_policy_version: 'runir.minni.local/v1', admitted_operation: 'capture_ingest', target_user_id: 'native-user', delivery: { version: 'runir.minni.delivery/v1', disposition: 'ordinary', restrictions: [] } }, payload = { userId: 'native-user', scope: 'user', active: true, l2: 'protected', confidence: 0.4 }, active = true, created_at = time::now(), updated_at = time::now();");
    await expect(writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_lineage" }]))
      .resolves.toMatchObject({ status: "refused", reason: "source_lineage_present", contentFree: true });

    await db.query("CREATE staleness_backlog:native_collision SET user_id = 'native-user', scope = 'user', triggered_at = time::now(), facts = [], status = 'pending';");
    const originalRandomUUID = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = () => "native_collision";
    try {
      await expect(writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_replacement" }]))
        .resolves.toMatchObject({ status: "refused", reason: "backlog_collision", contentFree: true });
    } finally {
      globalThis.crypto.randomUUID = originalRandomUUID;
    }

    await db.query("CREATE semiote:native_inactive SET user_id = 'native-user', scope = 'user', payload = { userId: 'native-user', scope: 'user', l2: 'inactive', confidence: 0.4 }, active = false, inactive_reason = 'old', created_at = time::now(), updated_at = time::now();");
    await expect(writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_inactive" }]))
      .resolves.toMatchObject({ status: "refused", reason: "source_status_mismatch", contentFree: true });
  }, 30_000);

  it("rolls back after every source/support/create statement and refuses body races", async () => {
    await db.query(legacyCreate("native_support_a", "support-a", 0.15));
    await db.query(legacyCreate("native_source_a", "a", 0.2, ["native_support_a"]));
    await db.query(legacyCreate("native_support_b", "support-b", 0.25));
    await db.query(legacyCreate("native_source_b", "b", 0.3, ["native_support_b"]));
    const originalTransaction = db.queryTransaction.bind(db);
    const injections = ["$sourceRows0", "$sourceRows1", "$supportRows0", "$supportRows1", "$backlogRows"];
    for (const [index, marker] of injections.entries()) {
      const beforeA = await fullRowDigest(db, "semiote", "native_source_a");
      const beforeB = await fullRowDigest(db, "semiote", "native_source_b");
      const beforeSupport = await fullRowDigest(db, "semiote", "native_support_a");
      const beforeSupportB = await fullRowDigest(db, "semiote", "native_support_b");
      (db as any).queryTransaction = async (sql: string, vars: Record<string, unknown>) => originalTransaction(insertThrowAfter(sql, marker, `CG failure ${index}`), vars);
      const result = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_source_a" }, { replacementMemoryId: "native_source_b" }]);
      expect(result.status).toBe("rolled_back");
      if (result.status === "rolled_back") expect(await fullRowDigest(db, "staleness_backlog", result.backlogId)).toBeUndefined();
      expect(await fullRowDigest(db, "semiote", "native_source_a")).toBe(beforeA);
      expect(await fullRowDigest(db, "semiote", "native_source_b")).toBe(beforeB);
      expect(await fullRowDigest(db, "semiote", "native_support_a")).toBe(beforeSupport);
      expect(await fullRowDigest(db, "semiote", "native_support_b")).toBe(beforeSupportB);
    }
    (db as any).queryTransaction = originalTransaction;

    await db.query(legacyCreate("native_body_race", "before", 0.5));
    const raceTransaction = db.queryTransaction.bind(db);
    (db as any).queryTransaction = async (sql: string, vars: Record<string, unknown>) => {
      await db.query("UPDATE semiote:native_body_race SET payload.l2 = 'after', updated_at = updated_at;");
      return raceTransaction(sql, vars);
    };
    const race = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_body_race" }]);
    expect(race).toMatchObject({ status: "indeterminate", contentFree: true });
    expect(await fullRowDigest(db, "staleness_backlog", race.status === "indeterminate" ? race.backlogId : "missing")).toBeUndefined();
    (db as any).queryTransaction = originalTransaction;

    await db.query(legacyCreate("native_nanosecond_race", "nanosecond before", 0.55));
    await db.query("UPDATE semiote:native_nanosecond_race SET updated_at = <datetime>'2026-10-01T00:00:00.000000000Z', payload.updatedAt = <datetime>'2026-10-01T00:00:00.000000000Z';");
    const nanoBefore = await fullRowDigest(db, "semiote", "native_nanosecond_race");
    (db as any).queryTransaction = async (sql: string, vars: Record<string, unknown>) => {
      await db.query("UPDATE semiote:native_nanosecond_race SET updated_at = <datetime>'2026-10-01T00:00:00.000000001Z', payload.updatedAt = <datetime>'2026-10-01T00:00:00.000000001Z';");
      return raceTransaction(sql, vars);
    };
    const nanoRace = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_nanosecond_race" }]);
    expect(nanoRace).toMatchObject({ status: "indeterminate", contentFree: true });
    expect(await fullRowDigest(db, "semiote", "native_nanosecond_race")).not.toBe(nanoBefore);
    expect(await fullRowDigest(db, "staleness_backlog", nanoRace.status === "indeterminate" ? nanoRace.backlogId : "missing")).toBeUndefined();
    (db as any).queryTransaction = originalTransaction;
  }, 30_000);

  it("does not let an old matching marker or unrelated timestamp prove this attempt committed", async () => {
    await db.query(legacyCreate("native_old_witness", "witness source", 0.73));
    const originalTransaction = db.queryTransaction.bind(db);
    (db as any).queryTransaction = async (_sql: string, vars: Record<string, unknown>) => {
      await db.query(
        `CREATE ONLY type::record('staleness_backlog', $backlogId) CONTENT {
          user_id: $userId,
          scope: $scope,
          triggered_at: <datetime>$old,
          facts: $facts,
          status: 'pending'
        };`,
        { ...vars, old: "2020-01-01T00:00:00.000Z" },
      );
      throw new Error("synthetic no-effect wrapper failure with old witness");
    };
    const result = await writeCurrentSnapshotStalenessBacklog(db, "native-user", "user", undefined, [{ replacementMemoryId: "native_old_witness" }]);
    (db as any).queryTransaction = originalTransaction;
    expect(result).toMatchObject({ status: "indeterminate", contentFree: true });
    if (result.status === "indeterminate") {
      expect(await fullRowDigest(db, "staleness_backlog", result.backlogId)).toBeDefined();
      await db.query("DELETE type::record('staleness_backlog', $id);", { id: result.backlogId });
    }
  }, 30_000);

  it("bounds rejected and hanging SDK close diagnostics", async () => {
    const child = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, pid: 17, kill: () => true };
    await expect(cleanupOwnedResources({ close: async () => new Promise<void>(() => {}) } as SurrealClient, child, 1)).rejects.toThrow(/SDK close timed out/);
    const rejected = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, pid: 18, kill: () => true };
    await expect(cleanupOwnedResources({ close: async () => { throw new Error("synthetic close rejection"); } } as SurrealClient, rejected, 1)).rejects.toThrow(/synthetic close rejection/);
  });
});
