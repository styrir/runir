// OM-4 live smoke against prod :7700 via the real extension code path.
process.env.RUNIR_BASE = "http://127.0.0.1:7700";
process.env.RUNIR_ENV_FILE = "/Users/brooks/Code/runir/.env";
process.env.RUNIR_USER_ID = "brooks";
delete process.env.RUNIR_API_KEY; // force the RUNIR_ENV_FILE path

const { default: runirMemory } = await import("./runir-memory-bundle.mjs?live=1");

const handlers = new Map();
const messages = [];
const commands = new Map();
runirMemory({
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, spec) => commands.set(name, spec),
  registerTool: () => {},
  sendMessage: (msg) => messages.push(msg),
});

const ctx = {
  cwd: "/Users/brooks/Code/runir",
  mode: "print",
  sessionManager: {
    getSessionFile: () => "/x/om4-live-smoke.jsonl",
    getBranch: () => [],
  },
  ui: { setStatus: () => {}, theme: undefined },
  getContextUsage: () => undefined,
};

// 1. /om:ping
await commands.get("om:ping").handler("", ctx);
console.log("── /om:ping ──");
console.log(messages.at(-1).content);

// 2. pre_compaction staged via session_before_compact (awaited path)
const t0 = Date.now();
await handlers.get("session_before_compact")(
  { type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: {}, branchEntries: [] },
  ctx,
);
console.log(`\n── session_before_compact returned in ${Date.now() - t0}ms ──`);

// 3. /om:view shows the staged slot
await commands.get("om:view").handler("", ctx);
const view = messages.at(-1).content;
console.log("── /om:view (head) ──");
console.log(view.split("\n").slice(0, 14).join("\n"));

// 4. post_compaction_validation replaces it
await handlers.get("session_compact")(
  { type: "session_compact", reason: "manual", willRetry: false, compactionEntry: {}, fromExtension: false },
  ctx,
);
await new Promise((r) => setTimeout(r, 3000)); // fire-and-forget settle

// 5. injection on next turn
const result = await handlers.get("before_agent_start")(
  { type: "before_agent_start", prompt: "ok", systemPrompt: "SYS" },
  ctx,
);
console.log("\n── injected systemPrompt (head) ──");
console.log((result?.systemPrompt ?? "(none)").split("\n").slice(0, 12).join("\n"));
console.log("...");
console.log(`injected length: ${result?.systemPrompt?.length ?? 0} chars`);
console.log(`contains compaction_projection root: ${result?.systemPrompt?.includes("compaction_projection:") ?? false}`);
console.log(`phase line: ${(result?.systemPrompt?.match(/ {2}phase: \S+/) ?? ["(none)"])[0]}`);
