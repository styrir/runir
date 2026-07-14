// OM-6 recall-bridge harness (brief §Verification + Codex R1–R6).
// Run: node om6-harness.mjs
import { createServer } from "node:http";
import assert from "node:assert/strict";

const requests = [];
let behavior = () => ({ status: 404, json: { error: "no route" } });

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    requests.push({ url: req.url, method: req.method });
    const { status = 200, json = {}, delayMs = 0, raw } = behavior(req.url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(raw !== undefined ? raw : JSON.stringify(json));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

process.env.RUNIR_BASE = `http://127.0.0.1:${PORT}`;
process.env.RUNIR_API_KEY = "harness-key";
process.env.RUNIR_ENV_FILE = "/nonexistent-env-file";
process.env.RUNIR_USER_ID = "harness user"; // space → must be URL-encoded
process.env.RUNIR_OM_RECALL_TIMEOUT_MS = "800";

const { default: runirMemory } = await import("./runir-memory-bundle.mjs?om6=main");

const GET_OK = {
  status: 200,
  json: {
    id: "abc-123",
    memory: "The deploy sequence is X.",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    tags: ["t1", "t2"],
    source: "conversation",
  },
};
const LINEAGE_OK = {
  status: 200,
  json: {
    memoryId: "abc-123",
    chainLength: 2,
    lineage: [
      { id: "old-1", text: "Old value", active: false, createdAt: "2026-06-01", supersededBy: "abc-123" },
      { id: "abc-123", text: "New value", active: true, createdAt: "2026-07-01" },
    ],
  },
};
const NOT_FOUND = { status: 404, json: { error: "Memory not found: x" } };

const routeMap = (getResp, lineageResp) => (url) =>
  url.startsWith("/memory/lineage/") ? lineageResp : url.startsWith("/memory/get/") ? getResp : { status: 404, json: {} };

function makeRig() {
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
  const ctx = {
    cwd: "/work/project-a",
    mode: "print",
    sessionManager: { getSessionFile: () => "/x/om6.jsonl", getBranch: () => [] },
    ui: { setStatus: () => {}, theme: undefined },
    getContextUsage: () => undefined,
  };
  return { handlers, commands, tools, messages, ctx };
}

const results = [];
async function test(name, fn) {
  requests.length = 0;
  behavior = () => ({ status: 404, json: { error: "no route" } });
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

// 1. tool happy path: memory + UNTRUSTED wrapper + metadata; no lineage call
await test("tool returns wrapped memory on 200", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  const result = await rig.tools.get("runir_recall").execute("t1", { id: "abc-123" }, undefined, undefined, rig.ctx);
  const text = result.content[0].text;
  assert.ok(text.includes("The deploy sequence is X."));
  assert.ok(text.includes("[UNTRUSTED DATA"));
  assert.ok(text.includes("tags: t1, t2"));
  assert.ok(!requests.some((r) => r.url.startsWith("/memory/lineage/")), "lineage fetched without being asked");
});

// 2. userId is URL-encoded on the query string
await test("userId is URL-encoded", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  await rig.tools.get("runir_recall").execute("t1", { id: "abc-123" }, undefined, undefined, rig.ctx);
  assert.ok(requests[0].url.includes("userId=harness%20user"), requests[0].url);
});

// 3. prefix + balanced outer ⟨⟩ stripped; request path uses the bare id
await test("prefixed and bracket-wrapped ids normalize", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  await rig.tools.get("runir_recall").execute("t1", { id: "semiote:⟨abc-123⟩" }, undefined, undefined, rig.ctx);
  assert.ok(requests[0].url.startsWith("/memory/get/abc-123?"), requests[0].url);
});

// 4. interior brackets / invalid chars → friendly text, ZERO requests
await test("invalid ids rejected client-side", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  for (const bad of ["a⟨b⟩c", "../etc", "id with spaces", ""]) {
    const result = await rig.tools.get("runir_recall").execute("t1", { id: bad }, undefined, undefined, rig.ctx);
    assert.ok(result.content[0].text.includes("Invalid memory id"), `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(requests.length, 0);
});

// 5. lineage=true → both endpoints; stale/current markers present
await test("lineage renders stale and current markers", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  const result = await rig.tools.get("runir_recall").execute("t1", { id: "abc-123", lineage: true }, undefined, undefined, rig.ctx);
  const text = result.content[0].text;
  assert.ok(text.includes("lineage (2 states, oldest → newest)"));
  assert.ok(text.includes("[CURRENT] abc-123"));
  assert.ok(text.includes("[stale — superseded by abc-123] old-1"));
  assert.ok(requests.some((r) => r.url.startsWith("/memory/lineage/")));
});

// 6. get-404 + chain → superseded report, even WITHOUT the lineage flag (R2)
await test("superseded id reports lineage instead of not-found", async () => {
  const rig = makeRig();
  behavior = routeMap(NOT_FOUND, LINEAGE_OK);
  const result = await rig.tools.get("runir_recall").execute("t1", { id: "old-1" }, undefined, undefined, rig.ctx);
  const text = result.content[0].text;
  assert.ok(text.includes("not in the active set"));
  assert.ok(text.includes("[CURRENT] abc-123"));
});

// 7. get-404 + lineage-404 → honest not-found (no throw)
await test("unknown id returns honest not-found", async () => {
  const rig = makeRig();
  behavior = routeMap(NOT_FOUND, NOT_FOUND);
  const result = await rig.tools.get("runir_recall").execute("t1", { id: "nope-1" }, undefined, undefined, rig.ctx);
  assert.ok(result.content[0].text.includes("Memory not found: nope-1"));
});

// 8. 5xx → tool THROWS (R1); command stays fail-soft
await test("5xx throws for the tool, fail-soft for the command", async () => {
  const rig = makeRig();
  behavior = () => ({ status: 500, json: { error: "boom" } });
  await assert.rejects(
    rig.tools.get("runir_recall").execute("t1", { id: "abc-123" }, undefined, undefined, rig.ctx),
    /HTTP 500/,
  );
  await rig.commands.get("om:recall").handler("abc-123", rig.ctx);
  assert.ok(rig.messages.at(-1).content.includes("Rúnir recall failed"), "command threw instead of fail-soft");
});

// 9. missing API key → tool throws (R1)
await test("missing key throws for the tool", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  delete process.env.RUNIR_API_KEY;
  try {
    await assert.rejects(
      rig.tools.get("runir_recall").execute("t1", { id: "abc-123" }, undefined, undefined, rig.ctx),
      /RUNIR_API_KEY missing/,
    );
  } finally {
    process.env.RUNIR_API_KEY = "harness-key";
  }
});

// 10. pre-aborted signal → tool throws
await test("aborted signal rejects the tool call", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    rig.tools.get("runir_recall").execute("t1", { id: "abc-123" }, aborted.signal, undefined, rig.ctx),
  );
});

// 11. /om:recall command: no args → usage; happy path renders; trace recorded
await test("/om:recall command renders and traces", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, LINEAGE_OK);
  await rig.commands.get("om:recall").handler("", rig.ctx);
  assert.ok(rig.messages.at(-1).content.includes("Usage: /om:recall"));
  await rig.commands.get("om:recall").handler("abc-123 lineage", rig.ctx);
  assert.ok(rig.messages.at(-1).content.includes("The deploy sequence is X."));
  await rig.commands.get("om:view").handler("", rig.ctx);
  const view = rig.messages.at(-1).content;
  assert.ok(view.includes("returned id=abc-123 +lineage"), "om-recall trace status missing from om view");
});

// 12. malformed 2xx JSON is a protocol error, never not-found (arch finding 1)
await test("malformed 200 body throws instead of not-found", async () => {
  const rig = makeRig();
  behavior = () => ({ status: 200, raw: "not-json{{" });
  await assert.rejects(
    rig.tools.get("runir_recall").execute("t1", { id: "abc-123" }, undefined, undefined, rig.ctx),
    /Malformed JSON/,
  );
});

// 13. lineage 200 with an empty/malformed chain is a protocol error (arch finding 2)
await test("empty lineage 200 throws as protocol error", async () => {
  const rig = makeRig();
  behavior = routeMap(GET_OK, { status: 200, json: { memoryId: "abc-123", chainLength: 0, lineage: [] } });
  await assert.rejects(
    rig.tools.get("runir_recall").execute("t1", { id: "abc-123", lineage: true }, undefined, undefined, rig.ctx),
    /Malformed lineage payload/,
  );
  behavior = routeMap(GET_OK, { status: 200, json: { lineage: [{ noId: true }] } });
  await assert.rejects(
    rig.tools.get("runir_recall").execute("t1", { id: "abc-123", lineage: true }, undefined, undefined, rig.ctx),
    /Malformed lineage payload/,
  );
});

// 14. prepareArguments rejects raw non-string ids before Pi coercion (arch finding 3)
await test("prepareArguments rejects non-string ids", async () => {
  const rig = makeRig();
  const tool = rig.tools.get("runir_recall");
  for (const bad of [{ id: 123 }, { id: null }, { id: true }, {}]) {
    assert.throws(() => tool.prepareArguments(bad), /'id' must be a string/);
  }
  assert.deepEqual(tool.prepareArguments({ id: "abc-123" }), { id: "abc-123" });
});

server.close();
console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
