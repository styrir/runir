// OM-6 live smoke: runir_recall tool against a live service with a real semiote id.
// Uses the caller's configuration, as the extension does: RUNIR_USER_ID and
// RUNIR_API_KEY from the environment, else RUNIR_ENV_FILE (default
// ~/Code/runir/.env). RUNIR_BASE defaults to the local service.
// RUNIR_SMOKE_SEMIOTE_ID must be a memory id in that tenant (from /memory/search).
import { requireLiveConfig } from "./live-smoke-config.mjs";

process.env.RUNIR_BASE ??= "http://127.0.0.1:7700";
requireLiveConfig("om6-live-smoke");
const REAL_ID = process.env.RUNIR_SMOKE_SEMIOTE_ID?.trim();
if (!REAL_ID) {
  console.error("om6-live-smoke: set RUNIR_SMOKE_SEMIOTE_ID to a memory id in your tenant");
  process.exit(2);
}

const { default: runirMemory } = await import("./runir-memory-bundle.mjs?om6live=1");

const tools = new Map();
const messages = [];
runirMemory({
  on: () => {},
  registerCommand: () => {},
  registerTool: (tool) => tools.set(tool.name, tool),
  sendMessage: (msg) => messages.push(msg),
});
if (!tools.has("runir_recall")) {
  console.error("om6-live-smoke: no tenant; set RUNIR_USER_ID in the environment or RUNIR_ENV_FILE");
  process.exit(2);
}

const ctx = {
  cwd: process.cwd(),
  mode: "print",
  sessionManager: { getSessionFile: () => "/x/om6-live.jsonl", getBranch: () => [] },
  ui: { setStatus: () => {}, theme: undefined },
  getContextUsage: () => undefined,
};

const t0 = Date.now();
const result = await tools
  .get("runir_recall")
  .execute("live1", { id: `semiote:${REAL_ID}`, lineage: true }, undefined, undefined, ctx);
console.log(`── runir_recall (${Date.now() - t0}ms) ──`);
console.log(result.content[0].text.split("\n").slice(0, 14).join("\n"));
console.log("...");
console.log(`text length: ${result.content[0].text.length}`);

// unknown id → honest not-found, no throw
const missing = await tools
  .get("runir_recall")
  .execute("live2", { id: "00000000-0000-0000-0000-000000000000" }, undefined, undefined, ctx);
console.log(`\n── unknown id ── ${missing.content[0].text.split("\n")[0]}`);
