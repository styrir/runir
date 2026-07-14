// Explicit-remember harness (Rúnir-sh1 Slice 1 — unit gates 1–6).
// Stub-server based — no Pi runtime and no live Runir service required.
// Run: node store-harness.mjs  (or via test/run.sh)
import { createServer } from "node:http";
import assert from "node:assert/strict";

const requests = [];
let behavior = () => ({ status: 404, json: { error: "no route" } });

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
    });
    const { status = 200, json = {}, delayMs = 0, raw: rawResp } = behavior(
      req.url,
      body,
      req,
    );
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(rawResp !== undefined ? rawResp : JSON.stringify(json));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

process.env.RUNIR_BASE = `http://127.0.0.1:${PORT}`;
process.env.RUNIR_API_KEY = "harness-key";
process.env.RUNIR_ENV_FILE = "/nonexistent-env-file";
process.env.RUNIR_USER_ID = "harness-user";
process.env.RUNIR_STORE_TIMEOUT_MS = "800";
process.env.RUNIR_PI_CLIENT = "pi-coding-agent";

const { default: runirMemory } = await import(
  "./runir-memory-bundle.mjs?store=main"
);

function makeRig(opts = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  runirMemory({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool: (tool) => tools.set(tool.name, tool),
    sendMessage: (msg) => messages.push(msg),
  });
  const sessionFile =
    opts.sessionFile === undefined
      ? "/x/store-session.jsonl"
      : opts.sessionFile;
  const ctx = {
    cwd: "/work/project-a",
    mode: "print",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, theme: undefined },
    getContextUsage: () => undefined,
  };
  return { handlers, commands, tools, messages, ctx };
}

const results = [];
async function test(name, fn) {
  requests.length = 0;
  behavior = () => ({ status: 404, json: { error: "no route" } });
  // Restore env defaults each test (some tests mutate).
  process.env.RUNIR_API_KEY = "harness-key";
  process.env.RUNIR_USER_ID = "harness-user";
  process.env.RUNIR_ENV_FILE = "/nonexistent-env-file";
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function storeOk(outcome = "create", id = "mem-1") {
  return () => ({ status: 200, json: { success: true, id, outcome } });
}

// ── Gate 1: validation before HTTP ──────────────────────────────────────────

await test("empty text rejected before HTTP (tool)", async () => {
  const rig = makeRig();
  behavior = storeOk();
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "   " }, undefined, undefined, rig.ctx),
    /non-empty string/,
  );
  assert.equal(requests.length, 0);
});

await test("non-string text rejected in prepareArguments", async () => {
  const rig = makeRig();
  behavior = storeOk();
  assert.throws(
    () => rig.tools.get("runir_store").prepareArguments({ text: 42 }),
    /must be a string/,
  );
  assert.equal(requests.length, 0);
});

// ── Gate 2: exact HTTP body (no tags/metadata/source/writeSource/proof keys) ─

await test("HTTP body is only text/userId/client/scope for user scope", async () => {
  const rig = makeRig();
  behavior = storeOk("create", "id-body");
  await rig.tools
    .get("runir_store")
    .execute("t1", { text: "I prefer dark mode" }, undefined, undefined, rig.ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/memory/store");
  const body = requests[0].body;
  assert.deepEqual(Object.keys(body).sort(), [
    "client",
    "scope",
    "text",
    "userId",
  ]);
  assert.equal(body.text, "I prefer dark mode");
  assert.equal(body.userId, "harness-user");
  assert.equal(body.client, "pi-coding-agent");
  assert.equal(body.scope, "user");
  assert.equal(body.tags, undefined);
  assert.equal(body.metadata, undefined);
  assert.equal(body.source, undefined);
  assert.equal(body.writeSource, undefined);
  assert.equal(body.noemaClaimKey, undefined);
  assert.equal(body.atomicFact, undefined);
  assert.equal(body.sessionId, undefined);
});

await test("session scope includes sessionId from real session file", async () => {
  const rig = makeRig({ sessionFile: "/sessions/real-sess-99.jsonl" });
  behavior = storeOk("create", "id-sess");
  await rig.tools.get("runir_store").execute(
    "t1",
    { text: "session note", scope: "session" },
    undefined,
    undefined,
    rig.ctx,
  );
  assert.equal(requests.length, 1);
  const body = requests[0].body;
  assert.equal(body.scope, "session");
  assert.equal(body.sessionId, "real-sess-99");
  assert.deepEqual(Object.keys(body).sort(), [
    "client",
    "scope",
    "sessionId",
    "text",
    "userId",
  ]);
});

await test("raw text whitespace is preserved in the HTTP body", async () => {
  const rig = makeRig();
  behavior = storeOk("create", "id-ws");
  const raw = "  leading and trailing spaces  ";
  await rig.tools
    .get("runir_store")
    .execute("t1", { text: raw }, undefined, undefined, rig.ctx);
  assert.equal(requests[0].body.text, raw);
});

// ── Gate 3: tenant/key refusal ──────────────────────────────────────────────

await test("missing RUNIR_USER_ID refuses before HTTP", async () => {
  const rig = makeRig();
  delete process.env.RUNIR_USER_ID;
  behavior = storeOk();
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /RUNIR_USER_ID is required/,
  );
  assert.equal(requests.length, 0);
});

await test("missing RUNIR_API_KEY refuses before HTTP", async () => {
  const rig = makeRig();
  delete process.env.RUNIR_API_KEY;
  behavior = storeOk();
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /RUNIR_API_KEY missing/,
  );
  assert.equal(requests.length, 0);
});

// ── Gate 4: malformed / non-2xx → tool error ────────────────────────────────

await test("HTTP 500 is a tool error (no invented success)", async () => {
  const rig = makeRig();
  behavior = () => ({ status: 500, json: { error: "boom" } });
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /HTTP 500/,
  );
});

await test("malformed 2xx body is a tool error", async () => {
  const rig = makeRig();
  behavior = () => ({ status: 200, raw: "not-json{" });
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /malformed JSON/,
  );
});

await test("missing id on create is a tool error", async () => {
  const rig = makeRig();
  behavior = () => ({
    status: 200,
    json: { success: true, outcome: "create" },
  });
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /missing id/,
  );
});

await test("success:false is a tool error (not invented success)", async () => {
  const rig = makeRig();
  behavior = () => ({
    status: 200,
    json: { success: false, id: "x", outcome: "create" },
  });
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /success was not true/,
  );
});

await test("missing success field is a tool error", async () => {
  const rig = makeRig();
  behavior = () => ({
    status: 200,
    json: { id: "x", outcome: "create" },
  });
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /success was not true/,
  );
});

await test("oversized error body is snippet-capped", async () => {
  const rig = makeRig();
  const big = "E".repeat(500);
  behavior = () => ({ status: 502, raw: big });
  await assert.rejects(
    async () => {
      try {
        await rig.tools
          .get("runir_store")
          .execute("t1", { text: "x" }, undefined, undefined, rig.ctx);
      } catch (error) {
        const msg = String(error.message);
        assert.ok(msg.includes("HTTP 502"));
        assert.ok(msg.includes("…"), "expected ellipsis on snippet");
        assert.ok(msg.length < 300, `error too long: ${msg.length}`);
        throw error;
      }
    },
    /HTTP 502/,
  );
});

// ── Gate 5: honest outcome formatting (all four, id required on skip) ───────

for (const [outcome, expect] of [
  ["create", "Remembered (new): id-create"],
  ["skip", "Already remembered — no new record: id-skip"],
  ["merge-update", "Updated existing memory: id-merge"],
  ["supersede", "Superseded prior version: id-super"],
]) {
  await test(`outcome ${outcome} formats honestly with id`, async () => {
    const rig = makeRig();
    const id = `id-${outcome === "merge-update" ? "merge" : outcome === "supersede" ? "super" : outcome}`;
    behavior = () => ({
      status: 200,
      json: { success: true, id, outcome },
    });
    const result = await rig.tools
      .get("runir_store")
      .execute("t1", { text: "fact" }, undefined, undefined, rig.ctx);
    assert.equal(result.content[0].text, expect);
    assert.ok(result.content[0].text.includes(id));
  });
}

await test("missing id on skip is a tool error", async () => {
  const rig = makeRig();
  behavior = () => ({
    status: 200,
    json: { success: true, outcome: "skip" },
  });
  await assert.rejects(
    () =>
      rig.tools
        .get("runir_store")
        .execute("t1", { text: "x" }, undefined, undefined, rig.ctx),
    /missing id for outcome skip/,
  );
});

// ── Gate 6: session without real id refused before HTTP ─────────────────────

await test("scope=session with no session file fails before HTTP", async () => {
  const rig = makeRig({ sessionFile: null });
  behavior = storeOk();
  await assert.rejects(
    () =>
      rig.tools.get("runir_store").execute(
        "t1",
        { text: "x", scope: "session" },
        undefined,
        undefined,
        rig.ctx,
      ),
    /real Pi session file id/,
  );
  assert.equal(requests.length, 0);
});

await test("scope=session with pi-default session file fails before HTTP", async () => {
  const rig = makeRig({ sessionFile: "/sessions/pi-default.jsonl" });
  behavior = storeOk();
  await assert.rejects(
    () =>
      rig.tools.get("runir_store").execute(
        "t1",
        { text: "x", scope: "session" },
        undefined,
        undefined,
        rig.ctx,
      ),
    /real Pi session file id/,
  );
  assert.equal(requests.length, 0);
});

// ── Slash /runir remember (fail-soft) ───────────────────────────────────────

await test("/runir remember stores user-scope and displays outcome", async () => {
  const rig = makeRig();
  behavior = storeOk("create", "slash-1");
  await rig.commands.get("runir").handler("remember I like terse answers", rig.ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.scope, "user");
  assert.equal(requests[0].body.text, "I like terse answers");
  assert.equal(rig.messages.length, 1);
  assert.ok(rig.messages[0].content.includes("Remembered (new): slash-1"));
});

await test("/runir remember without text shows usage (no HTTP)", async () => {
  const rig = makeRig();
  behavior = storeOk();
  await rig.commands.get("runir").handler("remember", rig.ctx);
  assert.equal(requests.length, 0);
  assert.ok(rig.messages[0].content.includes("Usage:"));
});

await test("/runir remember is fail-soft on HTTP error", async () => {
  const rig = makeRig();
  behavior = () => ({ status: 503, json: { error: "down" } });
  await rig.commands.get("runir").handler("remember keep this", rig.ctx);
  assert.equal(requests.length, 1);
  assert.ok(rig.messages[0].content.includes("Rúnir store failed"));
  assert.ok(rig.messages[0].content.includes("HTTP 503"));
});

// ── Auth header present ─────────────────────────────────────────────────────

await test("Authorization bearer is sent", async () => {
  const rig = makeRig();
  behavior = storeOk();
  await rig.tools
    .get("runir_store")
    .execute("t1", { text: "auth check" }, undefined, undefined, rig.ctx);
  assert.equal(requests[0].headers.authorization, "Bearer harness-key");
});

server.close();
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(
  failed
    ? `\nstore-harness: ${failed} failed / ${results.length} total`
    : `\nstore-harness: ${results.length} passed`,
);
process.exit(failed ? 1 : 0);
