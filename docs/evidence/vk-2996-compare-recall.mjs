// Compares /hooks/recall responses from two Rúnir instances (vk-2996).
//
// Each prompt goes to A, then B, then A again. Nothing is removed before
// comparing: the script lists every JSON path whose value differs, so the
// reader can see exactly what differs. A-vs-A shows what changes between two
// requests to the same code (fresh ids, timings, and the effect of recall's
// own writes such as traces and access counts).
//
// Prompts and project paths are the operator's own, so they live in a local
// JSON file and are not committed: [{ "label": "...", "prompt": "...",
// "path": "/abs/project" }]. Labels should not name anything private.
// Prints labels, counts and differing paths only, never prompts or memory text.
//
// Usage: RECALL_USER_ID=<tenant> RECALL_PROMPTS=<prompts.json> \
//   node compare-recall.mjs <urlA> <urlB>
import { readFileSync } from "node:fs";

const [urlA, urlB] = process.argv.slice(2);
const userId = process.env.RECALL_USER_ID;
const promptsFile = process.env.RECALL_PROMPTS;
if (!urlA || !urlB || !userId || !promptsFile) {
  throw new Error("usage: RECALL_USER_ID=<tenant> RECALL_PROMPTS=<prompts.json> node compare-recall.mjs <urlA> <urlB>");
}
const prompts = JSON.parse(readFileSync(promptsFile, "utf8"));

async function recall(url, { prompt, path }, sessionId) {
  const res = await fetch(`${url}/hooks/recall`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, userId, client: "pi-coding-agent", sessionId, path }),
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

/** Value at a differingPaths path. */
const valueAt = (obj, p) => p.slice(1).split(/\.|\[|\]/).filter(Boolean).reduce((o, k) => o?.[k], obj);

/** Each differing path, with the absolute difference when both values are numbers. */
function describe(x, y) {
  return differingPaths(x, y).map((p) => {
    const [u, v] = [valueAt(x, p), valueAt(y, p)];
    return typeof u === "number" && typeof v === "number" ? `${p} (Δ ${Math.abs(u - v).toExponential(1)})` : p;
  });
}

const rows = [];
for (const [i, entry] of prompts.entries()) {
  const sessionId = `vk2996-compare-${i}-${Date.now()}`;
  const a1 = await recall(urlA, entry, sessionId);
  const b = await recall(urlB, entry, sessionId);
  const a2 = await recall(urlA, entry, sessionId);
  rows.push({
    label: entry.label,
    status: [a1.status, b.status, a2.status],
    count: [a1.body.count, b.body.count, a2.body.count],
    skipped: [a1.body.skipped, b.body.skipped, a2.body.skipped],
    error: a1.body.error ?? b.body.error,
    aVsB: describe(a1.body, b.body),
    aVsA: describe(a1.body, a2.body),
  });
}
console.log(JSON.stringify(rows, null, 2));
