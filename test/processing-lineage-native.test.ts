import { spawn, type ChildProcess } from "node:child_process";
import { createServer, Socket } from "node:net";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../src/storage/surreal/surreal-client.js";
import {
  assessProcessingLineageSchema,
  ensureProcessingLineageSchema,
  processingLineageSchemaStatements,
} from "../src/storage/surreal/processing-lineage-schema.js";
import { classifyProcessingLineage, PROCESSING_LINEAGE_VERSION } from "../src/domain/memory/processing-lineage.js";
import { ensureStalenessBacklogTable } from "../src/lifecycle/semion/lock.js";

const runNative = process.env.RUNIR_LINEAGE_NATIVE === "1";

function lineage(restrictions: string[], disposition: "ordinary" | "local_only") {
  return {
    state: "minni_verified",
    origin: "minni",
    producer_principal_ref: "principal.native.sourcea",
    producer_registration_ref: "registration.native.sourcea",
    processing_policy_version: "runir.minni.local/v1",
    admitted_operation: "capture_ingest",
    target_user_id: "user.native.sourcea",
    delivery: { version: PROCESSING_LINEAGE_VERSION, disposition, restrictions },
  };
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
  if (!port) throw new Error("native fixture did not allocate a port");
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
  throw new Error(`native fixture server did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe.skipIf(!runNative)("Sourcea processing-lineage native schema", () => {
  let db: SurrealClient;
  let server: ChildProcess;

  beforeAll(async () => {
    const port = await freePort();
    server = spawn(
      "/usr/local/bin/surreal",
      ["start", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "sourcea-native-synthetic", "--log", "none", "--no-banner"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    await waitForServer(port);
    db = new SurrealClient({
      url: `http://127.0.0.1:${port}`,
      username: "root",
      password: "sourcea-native-synthetic",
      namespace: "main",
      database: "main",
    });
  }, 30_000);

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

  it("creates exact optional hierarchy, preserves legacy absence, and round-trips full values", async () => {
    await db.query("DEFINE TABLE semiote SCHEMALESS; DEFINE TABLE noema SCHEMALESS;");
    await db.query("CREATE semiote:legacy SET marker = 'legacy'; CREATE noema:legacy SET marker = 'legacy';");
    expect(await ensureProcessingLineageSchema(db, "semiote")).toMatchObject({ table: "semiote", created: true, verified: true });
    expect(await ensureProcessingLineageSchema(db, "noema")).toMatchObject({ table: "noema", created: true, verified: true });
    expect(await ensureProcessingLineageSchema(db, "semiote")).toMatchObject({ table: "semiote", created: false, verified: true });
    expect(assessProcessingLineageSchema(await db.query("INFO FOR TABLE semiote;"))).toEqual({ kind: "compatible" });
    await db.query("REMOVE TABLE IF EXISTS staleness_backlog;");
    await ensureStalenessBacklogTable(db);
    expect(assessProcessingLineageSchema(await db.query("INFO FOR TABLE staleness_backlog;"))).toEqual({ kind: "compatible" });
    await ensureStalenessBacklogTable(db);

    for (const table of ["semiote", "noema"] as const) {
      const legacyRows = await db.query<Record<string, unknown>>(`SELECT * FROM ${table}:legacy;`);
      expect(legacyRows[0]?.[0]).not.toHaveProperty("processing_lineage");
      const cases = [
        ["ordinary", lineage([], "ordinary")],
        ["audio", lineage(["audio_derived"], "local_only")],
        ["excluded", lineage(["excluded_source"], "local_only")],
        ["producer", lineage(["producer_local_only"], "local_only")],
        ["all", lineage(["audio_derived", "excluded_source", "producer_local_only"], "local_only")],
        ["mixed", lineage(["audio_derived", "excluded_source"], "local_only")],
      ] as const;
      for (const [label, expected] of cases) {
        await db.query(`CREATE ${table}:sourcea_${label} SET marker = $label, processing_lineage = $lineage;`, { label, lineage: expected });
        const selected = await db.query<Record<string, unknown>>(`SELECT * FROM ${table}:sourcea_${label};`);
        expect(selected[0]?.[0]?.processing_lineage).toEqual(expected);
      }
    }
  }, 30_000);

  it("keeps schema-mode and parser boundaries explicit for unknown values", async () => {
    await ensureStalenessBacklogTable(db);

    const base = lineage(["audio_derived"], "local_only");
    await db.query("CREATE semiote:sourcea_unknown_root SET marker = 'unknown', processing_lineage = $lineage;", { lineage: { ...base, unknown_root: "synthetic" } });
    await db.query("CREATE semiote:sourcea_unknown_nested SET marker = 'unknown', processing_lineage = $lineage;", { lineage: { ...base, delivery: { ...base.delivery, unknown_nested: "synthetic" } } });
    const backlogBase = { userId: "native-user", scope: "native-scope", facts: [], status: "pending" };
    await expect(db.query("CREATE staleness_backlog:sourcea_unknown_root SET user_id = $userId, scope = $scope, triggered_at = time::now(), facts = $facts, status = $status, processing_lineage = $lineage;", { ...backlogBase, lineage: { ...base, unknown_root: "synthetic" } })).rejects.toThrow();
    await expect(db.query("CREATE staleness_backlog:sourcea_unknown_nested SET user_id = $userId, scope = $scope, triggered_at = time::now(), facts = $facts, status = $status, processing_lineage = $lineage;", { ...backlogBase, lineage: { ...base, delivery: { ...base.delivery, unknown_nested: "synthetic" } } })).rejects.toThrow();
    expect(classifyProcessingLineage({ ...base, delivery: { ...base.delivery, restrictions: ["unknown_reason"] } })).toMatchObject({ state: "invalid", reason: "unknown_restriction" });
    expect(classifyProcessingLineage({ ...base, delivery: { ...base.delivery, restrictions: [{ code: "audio_derived" }] } })).toMatchObject({ state: "invalid", reason: "unknown_restriction" });
  }, 30_000);

  it("refuses partial, incompatible, and extra production backlog hierarchies before fields, then rolls back through the wrapper", async () => {
    await db.query("REMOVE TABLE IF EXISTS staleness_backlog;");
    await db.query("DEFINE TABLE staleness_backlog SCHEMAFULL; DEFINE FIELD processing_lineage ON TABLE staleness_backlog TYPE option<object>;");
    await expect(ensureStalenessBacklogTable(db)).rejects.toMatchObject({ name: "ProcessingLineageSchemaError", assessment: { kind: "partial" } });

    await db.query("REMOVE TABLE IF EXISTS staleness_backlog;");
    await db.query("DEFINE TABLE staleness_backlog SCHEMAFULL; DEFINE FIELD processing_lineage ON TABLE staleness_backlog TYPE option<string>;");
    await expect(ensureStalenessBacklogTable(db)).rejects.toMatchObject({ name: "ProcessingLineageSchemaError", assessment: { kind: "incompatible" } });

    await db.query("REMOVE TABLE IF EXISTS staleness_backlog;");
    await db.query("DEFINE TABLE staleness_backlog SCHEMAFULL;");
    await db.query(processingLineageSchemaStatements("staleness_backlog").join("\n") + "\nDEFINE FIELD IF NOT EXISTS processing_lineage.unexpected ON TABLE staleness_backlog TYPE string;");
    await expect(ensureStalenessBacklogTable(db)).rejects.toMatchObject({ name: "ProcessingLineageSchemaError", assessment: { kind: "extra" } });

    await db.query("DEFINE TABLE sourcea_transaction SCHEMALESS;");
    const expected = lineage(["audio_derived", "excluded_source", "producer_local_only"], "local_only");
    await expect(db.queryTransaction("CREATE sourcea_transaction:rollback SET marker = 'synthetic', processing_lineage = $lineage; THROW 'sourcea rollback';", { lineage: expected })).rejects.toThrow();
    const rows = await db.query("SELECT * FROM sourcea_transaction;");
    expect(rows[0]).toHaveLength(0);
  }, 30_000);
});
