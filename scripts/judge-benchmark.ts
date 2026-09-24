#!/usr/bin/env npx tsx
/**
 * Rúnir judge benchmark.
 *
 * Default `run` is a zero-network preflight. Paid calls require --confirm-cost
 * and --max-total-cost-usd. REQUESTY_API_KEY is read from the environment and
 * never logged.
 */
import { runJudgeBenchmark } from "../src/testing/judge-benchmark/run.js";

async function main(): Promise<void> {
  const result = await runJudgeBenchmark(process.argv.slice(2));
  if (result.error) console.error(result.error);
  process.exit(result.code);
}

void main();
