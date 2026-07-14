// OM-4 race-case stub harness (Codex brief-review R7).
// Drives the bundled runir-memory extension with a fake Pi runtime and a
// controllable stub Runir server. Run: node om4-harness.mjs
import { createServer } from "node:http";
import assert from "node:assert/strict";

// ── stub Runir server ────────────────────────────────────────────────────────
const requests = [];
let behavior = () => ({ status: 200, json: { prependContext: null, count: 0 } });

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, body });
    const { status = 200, json = {}, delayMs = 0 } = behavior(req.url, body);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// env BEFORE import (module-level constants)
process.env.RUNIR_BASE = `http://127.0.0.1:${PORT}`;
process.env.RUNIR_API_KEY = "harness-key";
process.env.RUNIR_ENV_FILE = "/nonexistent-env-file";
process.env.RUNIR_USER_ID = "harness";
process.env.RUNIR_OM_RECALL_TIMEOUT_MS = "800";
process.env.RUNIR_OM_PRE_BUDGET_TOKENS = "1000";
process.env.RUNIR_OM_POST_BUDGET_TOKENS = "500";

const { default: runirMemory } = await import("./runir-memory-bundle.mjs");

// ── fake Pi runtime ──────────────────────────────────────────────────────────
function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  return {
    pi: {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: (name, spec) => commands.set(name, spec),
      registerTool: () => {},
      sendMessage: (msg) => messages.push(msg),
    },
    handlers,
    commands,
    messages,
  };
}

function makeCtx(overrides = {}) {
  return {
    cwd: "/work/project-a",
    mode: "print",
    sessionManager: {
      getSessionFile: () => "/x/session-A.jsonl",
      getBranch: () => [],
    },
    ui: { setStatus: () => {}, theme: undefined },
    getContextUsage: () => undefined,
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYS = "BASE-SYSTEM-PROMPT";

function freshExtension() {
  const rig = makePi();
  runirMemory(rig.pi);
  return rig;
}

async function beforeCompact(rig, ctx, { reason = "manual", willRetry = false, signal } = {}) {
  return rig.handlers.get("session_before_compact")(
    { type: "session_before_compact", reason, willRetry, signal: signal ?? new AbortController().signal, preparation: {}, branchEntries: [] },
    ctx,
  );
}

async function sessionCompact(rig, ctx, { reason = "manual", willRetry = false } = {}) {
  return rig.handlers.get("session_compact")(
    { type: "session_compact", reason, willRetry, compactionEntry: {}, fromExtension: false },
    ctx,
  );
}

async function agentStart(rig, ctx, prompt) {
  return rig.handlers.get("before_agent_start")(
    { type: "before_agent_start", prompt, systemPrompt: SYS },
    ctx,
  );
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

const projection = (kind, text) => (url, body) =>
  url === "/hooks/recall" && body.sessionKind === kind
    ? { status: 200, json: { prependContext: text, count: 3 } }
    : { status: 200, json: { prependContext: null, count: 0 } };

// 1. skip-prompt still injects staged pre (R4/R7)
await test("skip prompt still injects staged pre", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  const result = await agentStart(rig, ctx, "ok"); // ACK → skip filter
  assert.equal(result?.systemPrompt, `PRE-PROJECTION\n\n${SYS}`);
});

// 2. one-shot: second turn gets nothing
await test("injection is one-shot", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  await agentStart(rig, ctx, "ok");
  const second = await agentStart(rig, ctx, "ok");
  assert.equal(second, undefined);
});

// 3. post happy-path replaces pre (R1)
await test("post_validation replaces staged pre", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  behavior = projection("post_compaction_validation", "POST-PROJECTION");
  await sessionCompact(rig, ctx);
  await sleep(50); // fire-and-forget settle
  const result = await agentStart(rig, ctx, "ok");
  assert.equal(result?.systemPrompt, `POST-PROJECTION\n\n${SYS}`);
});

// 4. post honest-empty keeps pre as fallback (R1)
await test("post honest-empty keeps pre fallback", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  behavior = () => ({ status: 200, json: { prependContext: null, count: 0 } });
  await sessionCompact(rig, ctx);
  await sleep(50);
  const result = await agentStart(rig, ctx, "ok");
  assert.equal(result?.systemPrompt, `PRE-PROJECTION\n\n${SYS}`);
});

// 5. late willRetry pre cannot overwrite newer post (R3)
await test("late willRetry pre cannot overwrite post", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = (url, body) =>
    body.sessionKind === "pre_compaction"
      ? { status: 200, json: { prependContext: "LATE-PRE" }, delayMs: 150 }
      : { status: 200, json: { prependContext: "POST-PROJECTION" } };
  await beforeCompact(rig, ctx, { willRetry: true }); // fire-and-forget, delayed
  await sessionCompact(rig, ctx);
  await sleep(60); // post landed, pre still in flight
  await sleep(150); // pre resolves late
  const result = await agentStart(rig, ctx, "ok");
  assert.equal(result?.systemPrompt, `POST-PROJECTION\n\n${SYS}`);
});

// 6. late fetch cannot re-stage after consumption (R3 epoch guard)
await test("late fetch cannot re-stage after consumption", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("post_compaction_validation", "POST-PROJECTION");
  await sessionCompact(rig, ctx);
  await sleep(50);
  behavior = (url, body) =>
    body.sessionKind === "pre_compaction"
      ? { status: 200, json: { prependContext: "LATE-PRE" }, delayMs: 120 }
      : { status: 200, json: { prependContext: null } };
  await beforeCompact(rig, ctx, { willRetry: true }); // delayed pre in flight
  const first = await agentStart(rig, ctx, "ok"); // consumes POST, bumps epoch
  assert.equal(first?.systemPrompt, `POST-PROJECTION\n\n${SYS}`);
  await sleep(200); // late pre resolves under stale epoch
  const second = await agentStart(rig, ctx, "ok");
  assert.equal(second, undefined);
});

// 6b. late fetch cannot stage after an empty-slot turn closed the window
// (Codex arch-review finding 1: every turn start bumps the epoch, even when
// nothing is staged yet)
await test("late fetch cannot stage after empty-slot turn", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = (url, body) =>
    body.sessionKind === "post_compaction_validation"
      ? { status: 200, json: { prependContext: "LATE-POST" }, delayMs: 150 }
      : { status: 200, json: { prependContext: null } };
  await sessionCompact(rig, ctx); // post fetch in flight, slot empty
  const first = await agentStart(rig, ctx, "ok"); // window closes with empty slot
  assert.equal(first, undefined);
  await sleep(250); // late post resolves under stale epoch
  const second = await agentStart(rig, ctx, "ok");
  assert.equal(second, undefined);
});

// 7. session change drops staged content (R5)
await test("session change drops staged projection", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  const otherSession = makeCtx({
    sessionManager: { getSessionFile: () => "/x/session-B.jsonl", getBranch: () => [] },
  });
  const result = await agentStart(rig, otherSession, "ok");
  assert.equal(result, undefined);
});

// 8. path change drops staged content (R5)
await test("path change drops staged projection", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  const result = await agentStart(rig, makeCtx({ cwd: "/work/project-b" }), "ok");
  assert.equal(result, undefined);
});

// 9. session_start invalidates staged content (R5)
await test("session_start invalidates staged projection", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  behavior = () => ({ status: 200, json: { prependContext: null } }); // opener recall
  await rig.handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);
  const result = await agentStart(rig, ctx, "ok");
  assert.equal(result, undefined);
});

// 10. per-turn recall failure still injects staged (R4)
await test("recall failure still injects staged", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("post_compaction_validation", "POST-PROJECTION");
  await sessionCompact(rig, ctx);
  await sleep(50);
  behavior = () => ({ status: 500, json: { error: "boom" } });
  const result = await agentStart(rig, ctx, "real question about the project");
  assert.equal(result?.systemPrompt, `POST-PROJECTION\n\n${SYS}`);
});

// 11. missing API key still consumes/injects staged (R4)
await test("missing API key still injects staged", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await beforeCompact(rig, ctx);
  delete process.env.RUNIR_API_KEY;
  try {
    const result = await agentStart(rig, ctx, "ok");
    assert.equal(result?.systemPrompt, `PRE-PROJECTION\n\n${SYS}`);
  } finally {
    process.env.RUNIR_API_KEY = "harness-key";
  }
});

// 12. pre-aborted Pi signal cancels the OM fetch (R2)
await test("aborted signal cancels pre fetch", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = (url, body) =>
    body.sessionKind === "pre_compaction"
      ? { status: 200, json: { prependContext: "SHOULD-NOT-STAGE" }, delayMs: 400 }
      : { status: 200, json: { prependContext: null } };
  const aborted = new AbortController();
  aborted.abort();
  const startedAt = Date.now();
  await beforeCompact(rig, ctx, { signal: aborted.signal });
  assert.ok(Date.now() - startedAt < 300, "handler waited despite aborted signal");
  await sleep(450);
  const result = await agentStart(rig, ctx, "ok");
  assert.equal(result, undefined);
});

// 13. normal recall composes staged + per-turn recall (ordering)
await test("staged composes ahead of per-turn recall", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = projection("post_compaction_validation", "POST-PROJECTION");
  await sessionCompact(rig, ctx);
  await sleep(50);
  behavior = () => ({ status: 200, json: { prependContext: "TURN-RECALL", count: 1 } });
  const result = await agentStart(rig, ctx, "real question about the project");
  assert.equal(result?.systemPrompt, `POST-PROJECTION\n\nTURN-RECALL\n\n${SYS}`);
});

// 14. budgets ride the request payloads
await test("budget tokens sent per kind", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  requests.length = 0;
  behavior = () => ({ status: 200, json: { prependContext: null } });
  await beforeCompact(rig, ctx);
  await sessionCompact(rig, ctx);
  await sleep(50);
  const pre = requests.find((r) => r.body.sessionKind === "pre_compaction");
  const post = requests.find((r) => r.body.sessionKind === "post_compaction_validation");
  assert.equal(pre?.body.budgetTokens, 1000);
  assert.equal(post?.body.budgetTokens, 500);
  assert.equal(pre?.body.prompt, "");
});

// 15. /om:ping reports reachability + authenticated hook check; /om:view renders
await test("/om:ping and /om:view respond", async () => {
  const rig = freshExtension();
  const ctx = makeCtx();
  behavior = () => ({ status: 200, json: { skipped: true } });
  await rig.commands.get("om:ping").handler("", ctx);
  const ping = rig.messages.at(-1);
  assert.ok(ping.content.includes("Rúnir"), "ping message missing");
  assert.ok(ping.content.includes("auth: ok"), "ping missing authenticated check");
  behavior = () => ({ status: 401, json: { error: "unauthorized" } });
  await rig.commands.get("om:ping").handler("", ctx);
  assert.ok(
    rig.messages.at(-1).content.includes("auth: FAILED"),
    "ping did not surface auth failure",
  );
  await rig.commands.get("om:view").handler("", ctx);
  const view = rig.messages.at(-1);
  assert.ok(view.content.includes("om staged: none"), "view missing staged line");
});

// 16. invalid OM config values fall back to defaults (Codex finding 2)
await test("invalid config values use defaults", async () => {
  process.env.RUNIR_OM_PRE_BUDGET_TOKENS = "NaN-garbage";
  process.env.RUNIR_OM_POST_BUDGET_TOKENS = "-5";
  process.env.RUNIR_OM_STAGED_TTL_MS = "Infinity";
  const { default: runirMemoryBad } = await import("./runir-memory-bundle.mjs?badcfg=1");
  delete process.env.RUNIR_OM_PRE_BUDGET_TOKENS;
  delete process.env.RUNIR_OM_POST_BUDGET_TOKENS;
  delete process.env.RUNIR_OM_STAGED_TTL_MS;
  const rig = makePi();
  runirMemoryBad(rig.pi);
  const ctx = makeCtx();
  requests.length = 0;
  behavior = () => ({ status: 200, json: { prependContext: null } });
  await rig.handlers.get("session_before_compact")(
    { type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: {}, branchEntries: [] },
    ctx,
  );
  await rig.handlers.get("session_compact")(
    { type: "session_compact", reason: "manual", willRetry: false, compactionEntry: {}, fromExtension: false },
    ctx,
  );
  await sleep(50);
  const pre = requests.find((r) => r.body.sessionKind === "pre_compaction");
  const post = requests.find((r) => r.body.sessionKind === "post_compaction_validation");
  assert.equal(pre?.body.budgetTokens, 1000, "pre budget did not use default");
  assert.equal(post?.body.budgetTokens, 500, "post budget did not use default");
});

// TTL expiry needs a tiny TTL → cache-busted second import
await test("TTL expiry drops staged projection", async () => {
  process.env.RUNIR_OM_STAGED_TTL_MS = "40";
  const { default: runirMemoryTtl } = await import("./runir-memory-bundle.mjs?ttl=1");
  delete process.env.RUNIR_OM_STAGED_TTL_MS;
  const rig = makePi();
  runirMemoryTtl(rig.pi);
  const ctx = makeCtx();
  behavior = projection("pre_compaction", "PRE-PROJECTION");
  await rig.handlers.get("session_before_compact")(
    { type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: {}, branchEntries: [] },
    ctx,
  );
  await sleep(80); // past TTL
  const result = await rig.handlers.get("before_agent_start")(
    { type: "before_agent_start", prompt: "ok", systemPrompt: SYS },
    ctx,
  );
  assert.equal(result, undefined);
});

server.close();
console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
