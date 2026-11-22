import { randomUUID } from "node:crypto";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ConnectionUnavailableError, type Surreal } from "surrealdb";
import { QueryOutcomeUnknownError, SurrealClient } from "../storage/surreal/surreal-client.js";
import { AbandonedQueryError, runAbandonable } from "../storage/surreal/query-abandonment.js";
import { withTimeoutFlagged } from "../recall/query/memory-query.js";

// vk-2993 / vk-2995: a dropped WebSocket must not turn into an endless replay
// loop, and a lost query is re-sent at most once and only when that cannot run
// it twice. The client talks to the live SurrealDB through a TCP proxy the
// test can cut.
// - WRITE_PROBE creates one row and then sleeps, so the row count is the
//   number of times the server executed it.
// - READ_PROBE writes nothing, so the test counts how many times the client
//   sent it over the socket.

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `runir2993reconnect${suffix}`;
const database = `reconnect${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe live SQL target");

const WRITE_PROBE = "CREATE replay_probe SET tag = $tag; SLEEP 1500ms; RETURN 'done';";
const READ_PROBE = "RETURN $tag; SLEEP 1500ms; RETURN 'done';";

type ProxyMode = "forward" | "refuse" | "hold";
type Proxy = {
  url: string; connections: () => number; dropAll: () => void; close: () => Promise<void>;
  /** forward: normal. refuse: new connections are closed at once. hold: accepted, forwarded only after `forward`. */
  setMode: (mode: ProxyMode) => void;
};

async function startProxy(targetHost: string, targetPort: number): Promise<Proxy> {
  const pairs = new Set<[Socket, Socket]>();
  const held: Socket[] = [];
  let connections = 0;
  let mode: ProxyMode = "forward";
  const pipe = (client: Socket) => {
    if (client.destroyed) return;
    const upstream = connect(targetPort, targetHost);
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    const end = () => { client.destroy(); upstream.destroy(); pairs.delete(pair); };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const server: Server = createServer((client) => {
    connections++;
    if (mode === "refuse") { client.destroy(); return; }
    if (mode === "hold") { client.on("error", () => undefined); held.push(client); return; }
    pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    dropAll: () => { for (const [client, upstream] of pairs) { client.destroy(); upstream.destroy(); } },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setMode: (next) => {
      mode = next;
      if (next === "forward") for (const client of held.splice(0)) pipe(client);
    },
  };
}

/** Every payload the proxied client sends; a probe's tag appears in each send of it. */
const sentPayloads: Buffer[] = [];
class CountingWebSocket extends WebSocket {
  override send(data: Parameters<WebSocket["send"]>[0]): void {
    if (ArrayBuffer.isView(data)) sentPayloads.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    else if (typeof data === "string") sentPayloads.push(Buffer.from(data));
    super.send(data);
  }
}

function sendsOf(tag: string): number {
  const needle = Buffer.from(tag);
  return sentPayloads.filter((payload) => payload.includes(needle)).length;
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

/** Waits until the read probe was sent `atLeast` times, then lets the server start running it. */
async function waitForReadInFlight(tag: string, atLeast: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (sendsOf(tag) < atLeast) {
    if (Date.now() > deadline) throw new Error(`probe ${tag} never reached ${atLeast} sends`);
    await sleep(10);
  }
  await sleep(150);
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
  viaProxy = new SurrealClient({ url: proxy.url, ...credentials },
    { connectTimeoutMs: 1_000, driverOptions: { websocketImpl: CountingWebSocket } });
  await viaProxy.query("RETURN 1;");
});

afterEach(() => { vi.restoreAllMocks(); proxy?.setMode("forward"); });

afterAll(async () => {
  await viaProxy?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  if (connected) await direct.query(`REMOVE NAMESPACE ${namespace};`);
  await direct?.close().catch(() => undefined);
});

it("re-sends a read pending during a dropped socket once, then recovers and logs the drop", async (ctx) => {
  if (!connected) return ctx.skip();
  const warn = vi.spyOn(console, "warn");
  const tag = `read-once-${randomUUID()}`;
  const pending = viaProxy.query(READ_PROBE, { tag });
  await waitForReadInFlight(tag, 1);
  proxy.dropAll();
  const result = await pending;
  expect(result.at(-1)).toEqual(["done"]);
  expect(sendsOf(tag)).toBe(2);
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  // The SDK's disconnected event has no reason; the client reports the socket's close code.
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[runir\] surreal connection #\d+ disconnected: .*close code=\d+/));
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[runir\] surreal connection #\d+ reconnecting \(runir\): CallTerminatedError/));
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[runir\] surreal connection #\d+ connected: surrealdb-/));
});

it("does not re-send a write lost with its socket and reports its outcome as unknown", async (ctx) => {
  if (!connected) return ctx.skip();
  const warn = vi.spyOn(console, "warn");
  const tag = `write-lost-${randomUUID()}`;
  const pending = viaProxy.query(WRITE_PROBE, { tag });
  await waitForProbeCount(tag, 1);
  proxy.dropAll();
  const outcome = await pending.then(() => undefined, (err: unknown) => err);
  expect(outcome).toBeInstanceOf(QueryOutcomeUnknownError);
  expect(((outcome as Error).cause as Error).name).toBe("CallTerminatedError");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("[runir] surreal query not re-sent: it may write"));
  // Recover first, then count: a re-send would ride on the new connection.
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  await sleep(2_000);
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(1);
});

/** The SDK instance behind the proxied client, for forcing failures the proxy cannot. */
const sdkOf = (client: SurrealClient) => (client as unknown as { surreal: Surreal }).surreal;

it("does not re-send a batch whose write committed before a later statement failed with an auth-like message", async (ctx) => {
  if (!connected) return ctx.skip();
  for (const message of ["Not enough permissions", "Anonymous access not allowed", "ConnectionUnavailable"]) {
    const tag = `stmt-error-${randomUUID()}`;
    await expect(viaProxy.query(`CREATE replay_probe SET tag = $tag; THROW '${message}';`, { tag }))
      .rejects.toThrow(message);
    expect(await probeCount(tag)).toBe(1);
    expect(sendsOf(tag)).toBe(1);
  }
});

it("signs in again and re-sends once when the server rejects a write as unauthenticated", async (ctx) => {
  if (!connected) return ctx.skip();
  const warn = vi.spyOn(console, "warn");
  const tag = `auth-${randomUUID()}`;
  await sdkOf(viaProxy).invalidate();
  await viaProxy.query("CREATE replay_probe SET tag = $tag;", { tag });
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(2);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reconnecting \(runir\): \w*Error: .*(permission|Anonymous|auth)/i));
});

it("reports an unknown outcome when the socket drops during a write's permitted re-send", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `auth-then-lost-${randomUUID()}`;
  await sdkOf(viaProxy).invalidate();
  const pending = viaProxy.query(WRITE_PROBE, { tag }).then(() => undefined, (err: unknown) => err);
  await waitForProbeCount(tag, 1);
  proxy.dropAll();
  const outcome = await pending;
  expect(outcome).toBeInstanceOf(QueryOutcomeUnknownError);
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  await sleep(2_000);
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(2);
});

it("re-sends a write once when the SDK refused the first send with ConnectionUnavailableError", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `never-sent-${randomUUID()}`;
  const sdk = sdkOf(viaProxy);
  const original = sdk.query.bind(sdk);
  // Patched by hand: vi.spyOn records results by calling .then on the SDK's
  // thenable query object, which would itself send the query.
  (sdk as { query: unknown }).query = () => {
    (sdk as { query: unknown }).query = original;
    return { responses: () => Promise.reject(new ConnectionUnavailableError()) };
  };
  await viaProxy.query("CREATE replay_probe SET tag = $tag;", { tag });
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(1);
});

it("sends a write issued after the socket dropped exactly once, on a new connection", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `write-after-drop-${randomUUID()}`;
  proxy.dropAll();
  await sleep(100);
  await viaProxy.query("CREATE replay_probe SET tag = $tag;", { tag });
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(1);
});

it("fails instead of looping when the socket drops again during a read's re-send", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `read-loop-${randomUUID()}`;
  const settled = viaProxy.query(READ_PROBE, { tag }).then(() => "resolved", (err: unknown) => err);
  await waitForReadInFlight(tag, 1);
  proxy.dropAll();
  await waitForReadInFlight(tag, 2);
  proxy.dropAll();
  const outcome = await settled;
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).name).toBe("CallTerminatedError");
  const connectionsAfterFailure = proxy.connections();
  // The SDK's replay re-sent the query on every reconnect; nothing may be sent now.
  await sleep(2_500);
  expect(sendsOf(tag)).toBe(2);
  expect(proxy.connections()).toBe(connectionsAfterFailure);
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
});

it("does not re-send a read whose caller timed out before the socket dropped", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `abandoned-${randomUUID()}`;
  const race = await withTimeoutFlagged(
    () => viaProxy.query(READ_PROBE, { tag }), 300, [] as unknown[][], "replay probe");
  expect(race.timedOut).toBe(true);
  expect(sendsOf(tag)).toBe(1);
  proxy.dropAll();
  // Recover first, then count: a re-send would ride on the new connection.
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  await sleep(2_000);
  expect(sendsOf(tag)).toBe(1);
});

it("does not re-send a read whose caller timed out while the reconnect was under way", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `mid-reconnect-${randomUUID()}`;
  const race = withTimeoutFlagged(
    () => viaProxy.query(READ_PROBE, { tag }), 600, [] as unknown[][], "replay probe");
  await waitForReadInFlight(tag, 1);
  proxy.setMode("hold");
  proxy.dropAll();
  expect((await race).timedOut).toBe(true);
  proxy.setMode("forward");
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  await sleep(2_000);
  expect(sendsOf(tag)).toBe(1);
});

it("fails fast while reconnects are refused and recovers once the database is reachable", async (ctx) => {
  if (!connected) return ctx.skip();
  const warn = vi.spyOn(console, "warn");
  const tag = `refused-${randomUUID()}`;
  const pending = viaProxy.query(READ_PROBE, { tag });
  await waitForReadInFlight(tag, 1);
  proxy.setMode("refuse");
  proxy.dropAll();
  await expect(pending).rejects.toMatchObject({ name: "SurrealConnectError" });
  const started = Date.now();
  await expect(viaProxy.query("RETURN 1;")).rejects.toMatchObject({ name: "SurrealConnectError" });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/surreal connection #\d+ reconnect failed \(runir\): SurrealConnectError/));
  proxy.setMode("forward");
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
  expect(sendsOf(tag)).toBe(1);
});

it("gives up on a reconnect whose handshake never completes, then recovers", async (ctx) => {
  if (!connected) return ctx.skip();
  proxy.setMode("hold");
  proxy.dropAll();
  const started = Date.now();
  await expect(viaProxy.query("RETURN 1;")).rejects.toThrow(/not ready after 1000ms/);
  expect(Date.now() - started).toBeLessThan(2_000);
  proxy.setMode("forward");
  expect(await viaProxy.query("RETURN 1;")).toEqual([[1]]);
});

it("does not send queries from work that was abandoned before they started", async (ctx) => {
  if (!connected) return ctx.skip();
  const tag = `unsent-${randomUUID()}`;
  const { promise, abandon } = runAbandonable(async () => {
    await sleep(100);
    return viaProxy.query(WRITE_PROBE, { tag });
  });
  abandon();
  await expect(promise).rejects.toBeInstanceOf(AbandonedQueryError);
  expect(await probeCount(tag)).toBe(0);
  expect(sendsOf(tag)).toBe(0);
});
