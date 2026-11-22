import { randomUUID } from "node:crypto";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-client.js";
import { AbandonedQueryError, runAbandonable } from "../storage/surreal/query-abandonment.js";
import { withTimeoutFlagged } from "../recall/query/memory-query.js";

// vk-2993: a dropped WebSocket must not turn into an endless replay loop. The
// client talks to the live SurrealDB through a TCP proxy the test can cut.
// The probe query creates one row and then sleeps, so the row count is the
// number of times the server executed it.

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `runir2993reconnect${suffix}`;
const database = `reconnect${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe live SQL target");

const PROBE = "CREATE replay_probe SET tag = $tag; SLEEP 1500ms; RETURN 'done';";

type Proxy = { url: string; connections: () => number; dropAll: () => void; close: () => Promise<void> };

async function startProxy(targetHost: string, targetPort: number): Promise<Proxy> {
  const pairs = new Set<[Socket, Socket]>();
  let connections = 0;
  const server: Server = createServer((client) => {
    connections++;
    const upstream = connect(targetPort, targetHost);
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    const end = () => { client.destroy(); upstream.destroy(); pairs.delete(pair); };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    dropAll: () => { for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); } },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let direct: SurrealClient;
let proxy: Proxy;
let viaProxy: SurrealClient;
let connected = false;

async function probeCount(tag: string): Promise<number> {
  const [rows] = await direct.query<{ count: number }>(
    "SELECT count() AS count FROM replay_probe WHERE tag = $tag GROUP ALL;", { tag });
  return rows?.[0]?.count ?? 0;
}

async function waitForProbeCount(tag: string, atLeast: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (await probeCount(tag) < atLeast) {
    if (Date.now() > deadline) throw new Error(`probe ${tag} never reached ${atLeast} executions`);
    await sleep(25);
  }
}

beforeAll(async () => {
  const slow = process.env.RUNIR_TEST_SLOW_LANE === "1";
  const url = slow
    ? process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000"
    : process.env.SURREAL_URL ?? "http://127.0.0.1:8000";
  if (slow) {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    if (!health?.ok) throw new Error("slow lane SurrealDB unreachable");
  }
  const credentials = { username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root", namespace, database };
  direct = new SurrealClient({ url, ...credentials });
  try { await direct.query("INFO FOR DB;"); connected = true; }
  catch { if (slow) throw new Error("slow lane SurrealDB unreachable"); return; }
  await direct.query("DEFINE TABLE replay_probe SCHEMALESS;");
  const target = new URL(url);
  proxy = await startProxy(target.hostname, Number(target.port || 80));
  viaProxy = new SurrealClient({ url: proxy.url, ...credentials });
  await viaProxy.query("RETURN 1;");
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await viaProxy?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  if (connected) await direct.query(`REMOVE NAMESPACE ${namespace};`);
  await direct?.close().catch(() => undefined);
});

it("re-sends a query pending during a dropped socket once, then recovers and logs the drop", async (ctx) => {
  if (!connected) return ctx.skip();
  const warn = vi.spyOn(console, "warn");
  const tag = `once-${randomUUID()}`;
  const pending = viaProxy.query(PROBE, { tag });
  await waitForProbeCount(tag, 1);
  proxy.dropAll();
  const result = await pending;
  expect(result.at(-1)).toEqual(["done"]);
  expect(await probeCount(tag)).toBe(2);
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("[runir] surreal connection disconnected"));
});

it("fails instead of looping when the socket drops again during the re-send", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `loop-${randomUUID()}`;
  const pending = viaProxy.query(PROBE, { tag });
  const settled = pending.then(() => "resolved", (err: unknown) => err);
  await waitForProbeCount(tag, 1);
  proxy.dropAll();
  await waitForProbeCount(tag, 2);
  proxy.dropAll();
  const outcome = await settled;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).name).toBe("CallTerminatedError");
  const connectionsAfterFailure = proxy.connections();
  // The SDK's replay re-ran the query on every reconnect; nothing may run now.
  await sleep(2_500);
  expect(await probeCount(tag)).toBe(2);
  expect(proxy.connections()).toBe(connectionsAfterFailure);
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
});

it("does not re-send a query whose caller timed out before the socket dropped", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `abandoned-${randomUUID()}`;
  const race = await withTimeoutFlagged(
    () => viaProxy.query(PROBE, { tag }), 300, [] as unknown[][], "replay probe");
  expect(race.timedOut).toBe(true);
  await waitForProbeCount(tag, 1);
  proxy.dropAll();
  await sleep(2_500);
  expect(await probeCount(tag)).toBe(1);
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
});

it("does not send queries from work that was abandoned before they started", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `unsent-${randomUUID()}`;
  const { promise, abandon } = runAbandonable(async () => {
    await sleep(100);
    return viaProxy.query(PROBE, { tag });
  });
  abandon();
  await expect(promise).rejects.toBeInstanceOf(AbandonedQueryError);
  expect(await probeCount(tag)).toBe(0);
});
