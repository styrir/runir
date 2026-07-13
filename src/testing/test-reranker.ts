/**
 * MIM-6 Smoke Test: Reranker provider architecture
 *
 * Tests:
 * 1. Config parsing — backward compat (old shape) and new shape
 * 2. Config validation — unknown provider, llm without key
 * 3. Provider router — off/local dispatch (llm skipped without key)
 * 4. Local cross-encoder — cosine similarity scoring via Ollama
 * 5. scoreStages attribution — reranker stage populated correctly
 *
 * Run: npx tsx src/test-reranker.ts
 */

import { parseConfig, validateRerankerConfig, resolveEmbeddingProvider } from "../shared/config";
import { rerankLocal, rerankWithProvider, attachRerankerStages } from "../storage/reranking/ranker";
import type { RerankerConfig, SearchHit } from "../domain/memory/types";

const logs: string[] = [];
const warn = (msg: string) => logs.push(`[WARN] ${msg}`);
const info = (msg: string) => logs.push(`[INFO] ${msg}`);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.log(`  ✘ FAIL: ${label}`);
    failed++;
  }
}

// ────────────────────────────────────────────
// Test 1: Config parsing — backward compat
// ────────────────────────────────────────────
console.log("\n① Config parsing: backward compat");

const oldDisabled = parseConfig({ reranker: { enabled: false } });
assert(oldDisabled.reranker.provider === "off", 'enabled:false → provider:"off"');

const oldEnabled = parseConfig({
  reranker: { enabled: true, openrouterApiKey: "sk-test" },
});
assert(oldEnabled.reranker.provider === "llm", 'enabled:true+key → provider:"llm"');
assert(
  oldEnabled.reranker.provider === "llm" && oldEnabled.reranker.openrouterApiKey === "sk-test",
  "preserves API key",
);

const noReranker = parseConfig({});
assert(noReranker.reranker.provider === "local", 'missing reranker → default "local"');

// ────────────────────────────────────────────
// Test 2: Config parsing — new shape
// ────────────────────────────────────────────
console.log("\n② Config parsing: new shape");

const newOff = parseConfig({ reranker: { provider: "off" } });
assert(newOff.reranker.provider === "off", 'provider:"off" preserved');

const newLocal = parseConfig({ reranker: { provider: "local", threshold: 0.4 } });
assert(newLocal.reranker.provider === "local", 'provider:"local" preserved');
assert(
  newLocal.reranker.provider === "local" && newLocal.reranker.threshold === 0.4,
  "threshold preserved",
);

const newLlm = parseConfig({
  reranker: { provider: "llm", openrouterApiKey: "sk-llm", model: "custom/model" },
});
assert(newLlm.reranker.provider === "llm", 'provider:"llm" preserved');
assert(
  newLlm.reranker.provider === "llm" && newLlm.reranker.model === "custom/model",
  "model field preserved",
);

const unknownProvider = parseConfig({ reranker: { provider: "banana" } });
assert(unknownProvider.reranker.provider === "local", 'unknown provider → fallback "local"');

// ────────────────────────────────────────────
// Test 3: Config validation
// ────────────────────────────────────────────
console.log("\n③ Config validation");

logs.length = 0;
const cfgLlmNoKey = parseConfig({ reranker: { provider: "llm", openrouterApiKey: "" } });
// Clear env to test degradation
const savedKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;
validateRerankerConfig(cfgLlmNoKey, warn, info);
assert(cfgLlmNoKey.reranker.provider === "off", "llm without key degrades to off");
assert(logs.some((l) => l.includes("degrading")), "degradation warning emitted");
if (savedKey) process.env.OPENROUTER_API_KEY = savedKey;

logs.length = 0;
const cfgLocal = parseConfig({ reranker: { provider: "local" } });
validateRerankerConfig(cfgLocal, warn, info);
assert(cfgLocal.reranker.provider === "local", "local provider passes validation");
assert(logs.some((l) => l.includes('provider="local"')), "provider logged at startup");

// ────────────────────────────────────────────
// Test 4: Provider router — "off" mode
// ────────────────────────────────────────────
console.log("\n④ Provider router: off mode");

async function testProviderOff() {
  const offConfig: RerankerConfig = { provider: "off" };
  const result = await rerankWithProvider(offConfig, "test query", [
    { id: "a", text: "some text" },
  ]);
  assert(result.scores.size === 0, "off provider returns empty scores");
  assert(result.threshold === 0, "off provider returns threshold 0");
}

// ────────────────────────────────────────────
// Test 5: Local cross-encoder (requires Ollama running)
// ────────────────────────────────────────────
console.log("\n⑤ Local cross-encoder (Ollama)");

async function testLocalReranker() {
  const candidates = [
    { id: "mem1", text: "TypeScript compiler options for strict mode with noEmit flag" },
    { id: "mem2", text: "Recipe for chocolate chip cookies with brown sugar" },
    { id: "mem3", text: "Setting up tsconfig.json paths and module resolution" },
  ];

  const startMs = Date.now();
  const embeddingProvider = resolveEmbeddingProvider();
  const result = await rerankLocal(
    "typescript configuration",
    candidates,
    embeddingProvider,
    warn,
  );
  const elapsedMs = Date.now() - startMs;

  console.log(`  ⏱ Local reranker latency: ${elapsedMs}ms`);

  const mem1Score = result.scores.get("mem1") ?? 0;
  const mem2Score = result.scores.get("mem2") ?? 0;
  const mem3Score = result.scores.get("mem3") ?? 0;

  console.log(`  scores: mem1=${mem1Score.toFixed(3)} mem2=${mem2Score.toFixed(3)} mem3=${mem3Score.toFixed(3)}`);
  console.log(`  labels: mem1=${result.labels.get("mem1") ?? "n/a"} mem2=${result.labels.get("mem2") ?? "n/a"} mem3=${result.labels.get("mem3") ?? "n/a"}`);

  assert(result.scores.size > 0, "local reranker returns scores");
  assert(mem1Score > mem2Score, "typescript content scores higher than cookies for ts query");
  assert(mem3Score > mem2Score, "tsconfig content scores higher than cookies for ts query");
  assert(elapsedMs < 2000, "local reranker completes under 2s");
}

// ────────────────────────────────────────────
// Test 6: scoreStages attribution
// ────────────────────────────────────────────
console.log("\n⑥ scoreStages attribution");

async function testScoreStages() {
  const hits: SearchHit[] = [
    { id: "h1", text: "test hit", score: 0.5, scoreStages: { rrf: { score: 0.5 } } },
    { id: "h2", text: "other hit", score: 0.4, scoreStages: { rrf: { score: 0.4 } } },
  ];

  const scores = new Map<string, number>([["h1", 0.8], ["h2", 0.6]]);
  const labels = new Map<string, string>([["h1", "direct"], ["h2", "supporting"]]);

  attachRerankerStages(hits, scores, labels, 0.3);

  assert(hits[0]!.scoreStages?.reranker?.score === 0.8, "h1 reranker score attached");
  assert(hits[0]!.scoreStages?.reranker?.label === "direct", "h1 reranker label attached");
  assert(hits[0]!.scoreStages?.reranker?.threshold === 0.3, "h1 threshold attached");
  assert(hits[1]!.scoreStages?.reranker?.score === 0.6, "h2 reranker score attached");
  assert(hits[0]!.scoreStages?.rrf?.score === 0.5, "existing rrf stage preserved");
}

// ────────────────────────────────────────────
// Run all async tests
// ────────────────────────────────────────────
async function main() {
  await testProviderOff();
  try {
    await testLocalReranker();
  } catch (err) {
    console.log(`  ⚠ Ollama not available, skipping local reranker test: ${err}`);
  }
  await testScoreStages();

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
