// Tenant-resolution harness (vk-2997).
// Loads the bundled extension with a fake Pi runtime: no Pi runtime and no
// Runir service required. Run: node tenant-harness.mjs (or via test/run.sh)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "runir-tenant-"));
const envWithTenant = join(dir, "with-tenant.env");
writeFileSync(envWithTenant, "RUNIR_API_KEY=file-key\nRUNIR_USER_ID=\"file-tenant\"\n");
const envWithoutTenant = join(dir, "without-tenant.env");
writeFileSync(envWithoutTenant, "RUNIR_API_KEY=file-key\n");
// A home directory whose default env file (~/Code/runir/.env) has a tenant.
const home = join(dir, "home");
mkdirSync(join(home, "Code", "runir"), { recursive: true });
writeFileSync(join(home, "Code", "runir", ".env"), "RUNIR_API_KEY=home-key\nRUNIR_USER_ID=home-tenant\n");
const realHome = process.env.HOME;

// No live service: every request is answered here and recorded.
const requests = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  requests.push({ url: String(url), body });
  const json = String(url).includes("/memory/store")
    ? { success: true, id: "m1", outcome: "create" }
    : { prependContext: null, count: 0 };
  return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
};

/** Loads a fresh copy of the extension (module constants read env at import). */
async function load(env) {
  for (const key of ["RUNIR_USER_ID", "RUNIR_API_KEY", "RUNIR_ENV_FILE"]) delete process.env[key];
  Object.assign(process.env, { RUNIR_BASE: "http://127.0.0.1:9", HOME: realHome }, env);
  requests.length = 0;
  const { default: runirMemory } = await import(`./runir-memory-bundle.mjs?case=${Math.random()}`);
  const handlers = new Map();
  const commands = new Map();
  const tools = [];
  runirMemory({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool: (tool) => tools.push(tool),
    sendMessage: () => {},
  });
  return { handlers, commands, tools };
}

/** A Pi context; `hasUI: false` is print or JSON mode, where Pi's UI calls are no-ops. */
function makeCtx({ hasUI = true } = {}) {
  const status = new Map();
  const statusHistory = [];
  const notices = [];
  return {
    status,
    statusHistory,
    notices,
    ctx: {
      cwd: "/work/project-a",
      mode: hasUI ? "tui" : "print",
      hasUI,
      sessionManager: { getSessionFile: () => "/x/session-A.jsonl", getBranch: () => [] },
      ui: {
        setStatus: (key, value) => {
          status.set(key, value);
          statusHistory.push(value);
        },
        notify: (message, level) => notices.push({ message, level }),
        theme: undefined,
      },
      getContextUsage: () => undefined,
    },
  };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

await test("tenant only in RUNIR_ENV_FILE: registers recall, capture and commands", async () => {
  const rig = await load({ RUNIR_ENV_FILE: envWithTenant });
  for (const event of ["session_start", "before_agent_start", "agent_end"]) {
    assert.ok(rig.handlers.has(event), `missing ${event} handler`);
  }
  assert.ok(rig.commands.size > 0, "no commands registered");
  assert.ok(rig.tools.length > 0, "no tools registered");
  const { ctx, statusHistory, notices } = makeCtx();
  await rig.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(statusHistory[0], "ᚱ ready");
  assert.equal(notices.length, 0);
  const opener = requests.find((r) => r.body?.userId !== undefined);
  assert.ok(opener, "session start sent no tenant-scoped request");
  assert.equal(opener.body.userId, "file-tenant");
});

await test("tenant in neither place: no recall or capture, an off badge and a warning", async () => {
  const rig = await load({ RUNIR_ENV_FILE: envWithoutTenant });
  assert.deepEqual([...rig.handlers.keys()], ["session_start"]);
  assert.equal(rig.commands.size, 0);
  assert.equal(rig.tools.length, 0);
  const { ctx, status, notices } = makeCtx();
  await rig.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(status.get("runir"), "ᚱ off: no RUNIR_USER_ID");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "warning");
  assert.match(notices[0].message, /RUNIR_USER_ID/);
  assert.match(notices[0].message, /RUNIR_ENV_FILE/);
});

await test("tenant in neither place, print or JSON mode: the warning goes to stderr", async () => {
  const rig = await load({ RUNIR_ENV_FILE: envWithoutTenant });
  const { ctx, statusHistory, notices } = makeCtx({ hasUI: false });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await rig.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RUNIR_USER_ID/);
  assert.match(warnings[0], /RUNIR_ENV_FILE/);
  assert.deepEqual(statusHistory, []);
  assert.equal(notices.length, 0);
  assert.equal(requests.length, 0);
});

await test("tenant only in the default ~/Code/runir/.env: used without RUNIR_ENV_FILE", async () => {
  const rig = await load({ HOME: home });
  const { ctx, statusHistory } = makeCtx();
  await rig.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(statusHistory[0], "ᚱ ready");
  const opener = requests.find((r) => r.body?.userId !== undefined);
  assert.ok(opener, "session start sent no tenant-scoped request");
  assert.equal(opener.body.userId, "home-tenant");
});

await test("tenant only in RUNIR_ENV_FILE: runir_store sends it", async () => {
  const rig = await load({ RUNIR_ENV_FILE: envWithTenant });
  const store = rig.tools.find((tool) => tool.name === "runir_store");
  const { ctx } = makeCtx();
  await store.execute("call-0", { text: "remember this" }, undefined, undefined, ctx);
  const storeRequest = requests.find((r) => r.url.includes("/memory/store"));
  assert.ok(storeRequest, "no /memory/store request");
  assert.equal(storeRequest.body.userId, "file-tenant");
});

await test("tenant missing and env file absent: same off badge and warning", async () => {
  const rig = await load({ RUNIR_ENV_FILE: join(dir, "missing.env"), RUNIR_API_KEY: "env-key" });
  const { ctx, status, notices } = makeCtx();
  await rig.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(requests.length, 0);
  assert.equal(status.get("runir"), "ᚱ off: no RUNIR_USER_ID");
  assert.equal(notices.length, 1);
});

await test("process env tenant wins over RUNIR_ENV_FILE", async () => {
  const rig = await load({ RUNIR_ENV_FILE: envWithTenant, RUNIR_USER_ID: "env-tenant" });
  const store = rig.tools.find((tool) => tool.name === "runir_store");
  assert.ok(store, "runir_store tool missing");
  const { ctx } = makeCtx();
  await store.execute("call-1", { text: "remember this" }, undefined, undefined, ctx);
  const storeRequest = requests.find((r) => r.url.includes("/memory/store"));
  assert.ok(storeRequest, "no /memory/store request");
  assert.equal(storeRequest.body.userId, "env-tenant");
});

process.env.HOME = realHome;
rmSync(dir, { recursive: true, force: true });
console.log(results.join("\n"));
