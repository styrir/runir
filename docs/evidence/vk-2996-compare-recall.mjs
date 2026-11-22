// Compares /hooks/recall responses from two Rúnir instances (vk-2996).
//
// Each prompt goes to A, then B, then A again. Nothing is removed before
// comparing: the script lists every JSON path whose value differs, so the
// reader can see exactly what differs. A-vs-A shows what changes between two
// requests to the same code (fresh ids, timings, and the effect of recall's
// own writes such as traces and access counts).
//
// Prints counts and differing paths only, never memory text.
// Usage: RECALL_USER_ID=<tenant> node compare-recall.mjs <urlA> <urlB>
import os from "node:os";
import path from "node:path";

const [urlA, urlB] = process.argv.slice(2);
const userId = process.env.RECALL_USER_ID;
if (!urlA || !urlB || !userId) throw new Error("usage: RECALL_USER_ID=<tenant> node compare-recall.mjs <urlA> <urlB>");
const code = path.join(os.homedir(), "Code");

const PROMPTS = [
  ["verba two-factor auth", "verba"],
  ["surreal reconnect replay loop", "runir"],
  ["verk review policy checks", "verk"],
  ["how is the launchd service started", "runir"],
  ["entity leg rrf weight", "runir"],
  ["which leit services need to be running", "leit"],
  // The live suite's session-opener case runs on a stale path and finds nothing.
  ["let's continue where we left off", "runir"],
];

async function recall(url, prompt, project, sessionId) {
  const res = await fetch(`${url}/hooks/recall`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, userId, client: "pi-coding-agent", sessionId, path: path.join(code, project) }),
  });
  return { status: res.status, body: await res.json() };
}

/** Every JSON path at which `a` and `b` differ (array elements by index). */
function differingPaths(a, b, at = "$") {
  if (Object.is(a, b)) return [];
  const bothObjects = a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) return [at];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => differingPaths(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : `${at}.${k}`));
}

/** Collapses array indexes so the same field across memories reports once. */
const fieldOf = (p) => p.replace(/\[\d+\]/g, "[]");
const fields = (paths) => [...new Set(paths.map(fieldOf))].sort();

/** Value at a differingPaths path. */
const valueAt = (obj, p) => p.slice(1).split(/\.|\[|\]/).filter(Boolean).reduce((o, k) => o?.[k], obj);

/** Largest absolute difference among numeric differing paths, per field. */
function maxNumericDelta(x, y, paths) {
  const out = {};
  for (const p of paths) {
    const [u, v] = [valueAt(x, p), valueAt(y, p)];
    if (typeof u === "number" && typeof v === "number") out[fieldOf(p)] = Math.max(out[fieldOf(p)] ?? 0, Math.abs(u - v));
  }
  return out;
}

const rows = [];
for (const [i, [prompt, project]] of PROMPTS.entries()) {
  const sessionId = `vk2996-compare-${i}-${Date.now()}`;
  const a1 = await recall(urlA, prompt, project, sessionId);
  const b = await recall(urlB, prompt, project, sessionId);
  const a2 = await recall(urlA, prompt, project, sessionId);
  rows.push({
    prompt, project,
    status: [a1.status, b.status, a2.status],
    count: [a1.body.count, b.body.count, a2.body.count],
    error: a1.body.error ?? b.body.error,
    topLevelKeys: Object.keys(a1.body).sort(),
    aVsB: fields(differingPaths(a1.body, b.body)),
    aVsA: fields(differingPaths(a1.body, a2.body)),
    aVsBMaxDelta: maxNumericDelta(a1.body, b.body, differingPaths(a1.body, b.body)),
    aVsAMaxDelta: maxNumericDelta(a1.body, a2.body, differingPaths(a1.body, a2.body)),
  });
}
console.log(JSON.stringify(rows, null, 2));
