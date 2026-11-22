// OM-5 live smoke: band flow against prod :7700 via the real extension code.
// Uses the caller's configuration, as the extension does: RUNIR_USER_ID and
// RUNIR_API_KEY from the environment, else RUNIR_ENV_FILE (default
// ~/Code/runir/.env). RUNIR_BASE defaults to the local service.
import { requireLiveConfig } from "./live-smoke-config.mjs";

process.env.RUNIR_BASE ??= "http://127.0.0.1:7700";
requireLiveConfig("om5-live-smoke");

const { default: runirMemory } = await import("./runir-memory-bundle.mjs?om5live=1");

const handlers = new Map();
const commands = new Map();
const messages = [];
runirMemory({
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, spec) => commands.set(name, spec),
  registerTool: () => {},
  sendMessage: (msg) => messages.push(msg),
});
if (!handlers.has("before_agent_start")) {
  console.error("om5-live-smoke: no tenant; set RUNIR_USER_ID in the environment or RUNIR_ENV_FILE");
  process.exit(2);
}

const compactCalls = [];
const ctx = {
  cwd: process.cwd(),
  mode: "print",
  usage: undefined,
  sessionManager: {
    getSessionFile: () => "/x/om5-live-smoke.jsonl",
    getBranch: () => [],
  },
  ui: { setStatus: () => {}, theme: undefined },
  getContextUsage: () => ctx.usage,
  // Pi's compact() is fire-and-forget and reports completion later; the
  // extension's agent_end waits for that, so complete on the next tick.
  compact: (options) => {
    compactCalls.push(options ?? {});
    setTimeout(() => options?.onComplete?.(), 0);
  },
};

// plan band at 72%
ctx.usage = { percent: 72, tokens: 144000, contextWindow: 200000 };
const t0 = Date.now();
await handlers.get("turn_end")({ type: "turn_end" }, ctx);
await new Promise((r) => setTimeout(r, 4000)); // real fetch settle
await commands.get("om:view").handler("", ctx);
const viewLines = messages.at(-1).content.split("\n");
console.log("── after plan band (72%) ──");
console.log(viewLines.filter((l) => l.startsWith("om ")).join("\n"));

// forced band at 90% → agent_end executes
ctx.usage = { percent: 90, tokens: 180000, contextWindow: 200000 };
await handlers.get("turn_end")({ type: "turn_end" }, ctx);
await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
console.log(`\n── forced execution (${Date.now() - t0}ms total) ──`);
console.log(`compact calls: ${compactCalls.length}`);
const ci = compactCalls[0]?.customInstructions;
console.log(`customInstructions present: ${Boolean(ci)}`);
if (ci) {
  console.log(ci.split("\n").slice(0, 8).join("\n"));
  console.log("...");
  console.log(`length: ${ci.length} chars; contains compaction_projection: ${ci.includes("compaction_projection:")}`);
}

