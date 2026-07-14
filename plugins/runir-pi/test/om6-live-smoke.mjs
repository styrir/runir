// OM-6 live smoke: runir_recall tool against prod :7700 with a real semiote id.
process.env.RUNIR_BASE = "http://127.0.0.1:7700";
process.env.RUNIR_ENV_FILE = "/Users/brooks/Code/runir/.env";
process.env.RUNIR_USER_ID = "brooks";
delete process.env.RUNIR_API_KEY;

const { default: runirMemory } = await import("./runir-memory-bundle.mjs?om6live=1");

const tools = new Map();
const messages = [];
runirMemory({
  on: () => {},
  registerCommand: () => {},
  registerTool: (tool) => tools.set(tool.name, tool),
  sendMessage: (msg) => messages.push(msg),
});

const ctx = {
  cwd: "/Users/brooks/Code/runir",
  mode: "print",
  sessionManager: { getSessionFile: () => "/x/om6-live.jsonl", getBranch: () => [] },
  ui: { setStatus: () => {}, theme: undefined },
  getContextUsage: () => undefined,
};

const REAL_ID = "08c6180e-5c26-435a-a51b-94b28de9279d"; // from /memory/search, tenant brooks
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
