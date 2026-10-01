import { spawn, type ChildProcess } from "node:child_process";
import { createServer, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROCESSING_LINEAGE_VERSION } from "../src/domain/memory/processing-lineage.js";
import { getSearchHitLineage } from "../src/domain/memory/search-hit-lineage.js";
import {
  findSimilarMemories,
  getMemoryById,
  hydrateLatestStateRepresentativeHits,
  listMemories,
  listNearbyExistingForCaptureContext,
  listRecentFactsForCaptureContext,
  listRecentMemories,
} from "../src/storage/surreal/memory-crud-store.js";
import { listContinuityMemoryHits } from "../src/storage/surreal/project-state-store.js";
import { extractId, mapMemoryRowToSearchHit, SurrealClient } from "../src/storage/surreal/surreal-client.js";
import { ensureProcessingLineageSchema } from "../src/storage/surreal/processing-lineage-schema.js";

const PASSWORD = "sourcec-r1-native-synthetic";
const USER = "user.sourcec.r1.native";
const OTHER_USER = "user.sourcec.r1.other";
const PATH = "/synthetic/sourcec-r1-native";
const VALID_LINEAGE = {
  state: "minni_verified",
  origin: "minni",
  producer_principal_ref: "principal.sourcec.r1.native",
  producer_registration_ref: "registration.sourcec.r1.native",
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

function rowId(entry: any): string {
  return extractId(entry.id);
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
  if (!port) throw new Error("Sourcec-R1 native fixture did not allocate a port");
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
  throw new Error(`Sourcec-R1 native fixture did not listen on ${port}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function insertMemory(
  db: SurrealClient,
  input: { id: string; userId?: string; lineage?: unknown; payloadLineage?: unknown; memoryRole?: string },
): Promise<void> {
  const now = "2026-10-01T21:00:00.000Z";
  const lineageClause = input.lineage === undefined ? "" : ", processing_lineage: $lineage";
  await db.query(
    `CREATE type::record('semiote', $id) CONTENT {
       embedding: [1, 0, 0],
       payload: {
         l2: $text,
         userId: $userId,
         path: $path,
         memoryRole: $memoryRole,
         continuitySubjectKey: 'subject.sourcec.r1.native',
         tags: ['synthetic'],
         client: 'spoof-client',
         source: 'spoof-source',
         processing_lineage: $payloadLineage
       },
       user_id: $userId,
       scope: 'user',
       created_at: <datetime>$now,
       updated_at: <datetime>$now,
       active: true${lineageClause}
     };`,
    {
      id: input.id,
      text: `synthetic ${input.id}`,
      userId: input.userId ?? USER,
      path: PATH,
      memoryRole: input.memoryRole ?? "current_status",
      payloadLineage: input.payloadLineage,
      lineage: input.lineage,
      now,
    },
  );
}

describe("Sourcec-R1 native storage lineage reads", () => {
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
      namespace: "sourcec_r1",
      database: "sourcec_r1",
    });
    await db.query("DEFINE TABLE semiote SCHEMALESS;");
    await ensureProcessingLineageSchema(db, "semiote");
  }, 30_000);

  beforeEach(async () => {
    await db.query("DELETE semiote;");
  });

  afterAll(async () => {
    try { await db?.close(); } finally {
      if (server && server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
      if (server) {
        await Promise.race([
          waitForExit(server),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
      }
    }
  });

  it("classifies every actual storage projection and keeps users separated", async () => {
    await insertMemory(db, { id: "native-valid", lineage: VALID_LINEAGE });
    await insertMemory(db, { id: "native-restricted", lineage: RESTRICTED_LINEAGE });
    await insertMemory(db, { id: "native-invalid", lineage: { ...VALID_LINEAGE, state: "forged", extra: true } });
    await insertMemory(db, { id: "native-malformed", lineage: { ...VALID_LINEAGE, processing_policy_version: "runir.minni.local/v2" } });
    await insertMemory(db, { id: "native-legacy", payloadLineage: VALID_LINEAGE });
    await insertMemory(db, { id: "native-other-user", userId: OTHER_USER, lineage: VALID_LINEAGE });

    const unselectedRows = await db.query<any>(
      "SELECT id, payload, created_at, updated_at FROM semiote WHERE id = type::record('semiote', $id);",
      { id: "native-valid" },
    );
    expect(getSearchHitLineage(mapMemoryRowToSearchHit(unselectedRows[0][0]))).toEqual({ state: "unavailable" });

    const listed = await listMemories(db, USER, undefined, "semiote");
    const ids = new Set(listed.map(rowId));
    expect(ids).toEqual(new Set(["native-valid", "native-restricted", "native-invalid", "native-malformed", "native-legacy"]));
    const byId = new Map(listed.map((entry: any) => [rowId(entry), getSearchHitLineage(entry)]));
    expect(byId.get("native-valid")).toMatchObject({ state: "minni_verified" });
    expect(byId.get("native-restricted")).toMatchObject({ state: "minni_verified" });
    expect((byId.get("native-restricted") as any).lineage.delivery.restrictions).toEqual(["audio_derived", "excluded_source", "producer_local_only"]);
    expect(byId.get("native-invalid")).toMatchObject({ state: "invalid" });
    expect(byId.get("native-malformed")).toMatchObject({ state: "invalid" });
    expect(byId.get("native-legacy")).toEqual({ state: "legacy_unknown" });
    expect(listed.every((entry: any) => !Object.prototype.hasOwnProperty.call(entry, "processing_lineage"))).toBe(true);
    expect(listed.every((entry: any) => Object.getOwnPropertySymbols(entry).length > 0)).toBe(true);
    const selected = listed.find((entry: any) => rowId(entry) === "native-valid");
    expect(selected).toBeDefined();
    const serialized = JSON.stringify(selected);
    expect(serialized).not.toContain("processing_lineage");
    expect(serialized).not.toContain("minni_verified");
    expect(getSearchHitLineage({ ...(selected as any) })).toMatchObject({ state: "minni_verified" });

    const fetched = await getMemoryById(db, "native-valid", USER, "semiote");
    expect(getSearchHitLineage(fetched[0])).toMatchObject({ state: "minni_verified" });
    const recent = await listRecentMemories(db, USER, "2026-10-01T00:00:00.000Z", 10, undefined, "semiote");
    expect(new Set(recent.map(rowId))).toEqual(ids);
    expect(getSearchHitLineage(recent.find((entry: any) => rowId(entry) === "native-invalid"))).toMatchObject({ state: "invalid" });

    const identity = { contextScopeKind: "project", raw: { path: PATH } } as any;
    const recentFacts = await listRecentFactsForCaptureContext(db, USER, identity);
    const nearby = await listNearbyExistingForCaptureContext(db, USER, identity);
    expect(recentFacts.map((hit) => getSearchHitLineage(hit).state)).toEqual(expect.arrayContaining(["minni_verified", "invalid", "legacy_unknown"]));
    expect(nearby.map((hit) => getSearchHitLineage(hit).state)).toEqual(expect.arrayContaining(["minni_verified", "invalid", "legacy_unknown"]));

    const continuity = await listContinuityMemoryHits(db, USER, { path: PATH });
    expect(continuity.map((hit) => getSearchHitLineage(hit).state)).toEqual(expect.arrayContaining(["minni_verified", "invalid", "legacy_unknown"]));

    const latest = await hydrateLatestStateRepresentativeHits(db, USER, { continuitySubjectKeys: ["subject.sourcec.r1.native"] });
    expect(latest.map((hit) => getSearchHitLineage(hit).state)).toEqual(expect.arrayContaining(["minni_verified", "invalid", "legacy_unknown"]));

    const similar = await findSimilarMemories(db, USER, [1, 0, 0], 24, 10);
    expect(similar.map((hit) => hit.id)).toEqual(["native-legacy"]);
    expect(getSearchHitLineage(similar[0])).toEqual({ state: "legacy_unknown" });
  }, 30_000);
});
