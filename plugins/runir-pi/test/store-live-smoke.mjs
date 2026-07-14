// Live nonce smoke for explicit remember (Rúnir-sh1 gates 7–8).
// Hits the REAL service on RUNIR_BASE (default http://127.0.0.1:7700).
// Requires RUNIR_API_KEY + RUNIR_USER_ID (no defaults — explicit-write contract).
//
// Run individually:
//   RUNIR_API_KEY=… RUNIR_USER_ID=… node store-live-smoke.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const BASE = (process.env.RUNIR_BASE ?? "http://127.0.0.1:7700").replace(
  /\/$/,
  "",
);
const API_KEY = process.env.RUNIR_API_KEY?.trim();
const USER_ID = process.env.RUNIR_USER_ID?.trim();
const WRONG_USER = `wrong-tenant-${randomUUID().slice(0, 8)}`;

if (!API_KEY || !USER_ID) {
  console.error(
    "store-live-smoke: set RUNIR_API_KEY and RUNIR_USER_ID (no defaults on the explicit-write path)",
  );
  process.exit(2);
}

process.env.RUNIR_BASE = BASE;
process.env.RUNIR_API_KEY = API_KEY;
process.env.RUNIR_USER_ID = USER_ID;
process.env.RUNIR_ENV_FILE = "/nonexistent-env-file-live-smoke";
process.env.RUNIR_PI_CLIENT = "pi-coding-agent";

const { default: runirMemory } = await import(
  `./runir-memory-bundle.mjs?live=${Date.now()}`
);

const tools = new Map();
runirMemory({
  on: () => {},
  registerCommand: () => {},
  registerTool: (tool) => tools.set(tool.name, tool),
  sendMessage: () => {},
});

const ctx = {
  cwd: process.cwd(),
  sessionManager: {
    getSessionFile: () => `/tmp/runir-store-live-${Date.now()}.jsonl`,
  },
};

// Natural-language fact with a unique token — bare UUID-only strings can be
// arbitrated as skip-without-id noise on the live service.
const token = `runir-store-live-${randomUUID()}`;
const text = `Live smoke verification fact for explicit remember: token ${token}.`;
const storeTool = tools.get("runir_store");
assert.ok(storeTool, "runir_store tool not registered");

console.log(`store-live-smoke: POST store as userId=${USER_ID} base=${BASE}`);
const storeResult = await storeTool.execute(
  "live",
  { text },
  undefined,
  undefined,
  ctx,
);
const storeText = storeResult.content[0].text;
console.log(`  tool: ${storeText}`);

const id = storeResult.details?.id;
assert.equal(typeof id, "string", "details.id must be a string");
assert.ok(id.length > 0, "details.id must be non-empty");
assert.ok(
  storeText.endsWith(`: ${id}`) || storeText.includes(`: ${id}`),
  `formatted result must include id; got: ${storeText}`,
);

async function getMemory(userId) {
  const res = await fetch(
    `${BASE}/memory/get/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = body;
  }
  return { status: res.status, json };
}

// Gate 7: same-tenant GET returns exact stored text
const same = await getMemory(USER_ID);
console.log(`  GET same tenant: HTTP ${same.status}`);
assert.equal(
  same.status,
  200,
  `same-tenant get failed: ${JSON.stringify(same.json)}`,
);
const memoryText =
  typeof same.json?.memory === "string" ? same.json.memory : "";
// Service may normalize l2 slightly; require the unique token survives verbatim
// and that the full client-sent text is recoverable or substring-present.
assert.ok(
  memoryText.includes(token),
  `stored memory missing unique token.\n  token: ${token}\n  got: ${JSON.stringify(memoryText)}`,
);
assert.ok(
  memoryText.includes("Live smoke verification fact") ||
    memoryText === text,
  `stored memory lost semantic content.\n  sent: ${JSON.stringify(text)}\n  got: ${JSON.stringify(memoryText)}`,
);
console.log("  PASS gate 7: same-tenant GET returns stored text with unique token");

// Gate 8: wrong-tenant GET must be the route's 404 (not 5xx)
const wrong = await getMemory(WRONG_USER);
console.log(`  GET wrong tenant (${WRONG_USER}): HTTP ${wrong.status}`);
assert.equal(
  wrong.status,
  404,
  `wrong-tenant must be HTTP 404; got ${wrong.status}: ${JSON.stringify(wrong.json)}`,
);
console.log("  PASS gate 8: wrong-tenant returns 404");
console.log("\nstore-live-smoke: OK");
