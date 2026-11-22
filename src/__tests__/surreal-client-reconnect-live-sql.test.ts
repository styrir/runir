import { randomUUID } from "node:crypto";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ConnectionUnavailableError, type Surreal } from "surrealdb";
import { QueryOutcomeUnknownError, SurrealClient } from "../storage/surreal/surreal-client.js";
import { AbandonedQueryError, runAbandonable } from "../storage/surreal/query-abandonment.js";
import { withTimeoutFlagged } from "../recall/query/memory-query.js";
import { acquireLock, releaseLock } from "../lifecycle/semion/lock.js";

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

type ProxyMode = "forward" | "refuse" | "hold" | "mute";
type Proxy = {
  url: string; connections: () => number; dropAll: () => void; close: () => Promise<void>;
  /**
   * forward: normal. refuse: new connections are closed at once. hold: accepted,
   * forwarded only after `forward`. mute: the server's replies are discarded, so
   * a query runs but its response is lost.
   */
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
    upstream.on("data", (chunk: Buffer) => { if (mode !== "mute") client.write(chunk); });
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

/** Sends carrying `tag`, optionally only those whose SQL contains `sqlPart`. */
function sendsOf(tag: string, sqlPart?: string): number {
  const needles = [tag, sqlPart].filter((n): n is string => n !== undefined).map((n) => Buffer.from(n));
  return sentPayloads.filter((payload) => needles.every((needle) => payload.includes(needle))).length;
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

async function leaseCount(key: string): Promise<number> {
  const [rows] = await direct.query<{ count: number }>(
    "SELECT count() AS count FROM consolidation_locks WHERE lock_key = $key GROUP ALL;", { key });
  return rows?.[0]?.count ?? 0;
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
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
  await direct.query("DEFINE TABLE consolidation_locks SCHEMALESS;");
  await direct.query("DEFINE INDEX idx_cl_key ON TABLE consolidation_locks COLUMNS lock_key UNIQUE;");
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
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[runir\] surreal connection #\d+ reconnecting \(runir\): request failed: CallTerminatedError/));
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

const STATEMENT_ERROR_MESSAGES = ["Not enough permissions", "Anonymous access not allowed", "ConnectionUnavailable"];

it("does not re-send a write batch after one of its statements failed, whatever the message", async (ctx) => {
  if (!connected) return ctx.skip();
  for (const message of STATEMENT_ERROR_MESSAGES) {
    const tag = `stmt-error-${randomUUID()}`;
    await expect(viaProxy.query(`CREATE replay_probe SET tag = $tag; THROW '${message}';`, { tag }))
      .rejects.toThrow(message);
    expect(await probeCount(tag)).toBe(1);
    expect(sendsOf(tag)).toBe(1);
  }
});

it("does not re-send a read-only batch after one of its statements failed, whatever the message", async (ctx) => {
  if (!connected) return ctx.skip();
  for (const message of STATEMENT_ERROR_MESSAGES) {
    const tag = `stmt-error-read-${randomUUID()}`;
    await expect(viaProxy.query(`RETURN $tag; THROW '${message}';`, { tag })).rejects.toThrow(message);
    expect(sendsOf(tag)).toBe(1);
  }
});

it("signs in again and re-sends once when the server refuses the whole request as unauthenticated", async (ctx) => {
  if (!connected) return ctx.skip();
  const sdk = sdkOf(viaProxy);
  await sdk.invalidate();
  // The server's shape for a lost sign-in: the whole request is refused, no statement results.
  const shapeTag = `auth-shape-${randomUUID()}`;
  const refusal = await sdk.query("CREATE replay_probe SET tag = $tag;", { tag: shapeTag }).responses()
    .then(() => undefined, (err: unknown) => err);
  expect(refusal).toMatchObject({ name: "NotAllowedError", kind: "NotAllowed" });
  expect(await probeCount(shapeTag)).toBe(0);

  const warn = vi.spyOn(console, "warn");
  const tag = `auth-${randomUUID()}`;
  await viaProxy.query("CREATE replay_probe SET tag = $tag;", { tag });
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(2);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reconnecting \(runir\): request failed: NotAllowedError/));
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

it("re-sends a write once when the real SDK refused to send it on a closed socket", async (ctx) => {
  if (!connected) return ctx.skip();
  const warn = vi.spyOn(console, "warn");
  const tag = `sdk-refused-${randomUUID()}`;
  // Skip the client's readiness check once, so the SDK itself meets the closed socket.
  const client = viaProxy as unknown as { ensureConnected: () => Promise<void> };
  const ensureConnected = client.ensureConnected;
  client.ensureConnected = async () => { client.ensureConnected = ensureConnected; };
  proxy.dropAll();
  await waitFor(async () => sdkOf(viaProxy).status === "disconnected", "the SDK to see the drop");
  await viaProxy.query("CREATE replay_probe SET tag = $tag;", { tag });
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reconnecting \(runir\): request failed: ConnectionUnavailableError/));
  expect(await probeCount(tag)).toBe(1);
  expect(sendsOf(tag)).toBe(1);
});

it("acquireLock returns its lease when the CREATE committed but the response was lost", async (ctx) => {
  if (!connected) return ctx.skip();
  const key = `lock-lost-${randomUUID()}`;
  proxy.setMode("mute");
  const pending = acquireLock(viaProxy, key, 60);
  await waitFor(async () => (await leaseCount(key)) === 1, "the lease to commit");
  proxy.setMode("forward");
  proxy.dropAll();
  const holder = await pending;
  const [rows] = await direct.query<{ holder: string }>(
    "SELECT holder FROM consolidation_locks WHERE lock_key = $key;", { key });
  expect(rows).toEqual([{ holder }]);
  expect(sendsOf(key, "CREATE consolidation_locks")).toBe(1);
  expect(sendsOf(key, "SELECT id FROM consolidation_locks")).toBe(1);
});

it("releaseLock re-sends its holder-scoped DELETE once when the response was lost", async (ctx) => {
  if (!connected) return ctx.skip();
  const key = `release-lost-${randomUUID()}`;
  const holder = randomUUID();
  await direct.query("CREATE consolidation_locks SET lock_key = $key, holder = $holder, expires_at = time::now() + 60s;",
    { key, holder });
  proxy.setMode("mute");
  const pending = releaseLock(viaProxy, key, holder);
  await waitFor(async () => (await leaseCount(key)) === 0, "the lease to be deleted");
  proxy.setMode("forward");
  proxy.dropAll();
  await expect(pending).resolves.toBeUndefined();
  expect(sendsOf(key, "DELETE consolidation_locks")).toBe(2);
  expect(await leaseCount(key)).toBe(0);
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
