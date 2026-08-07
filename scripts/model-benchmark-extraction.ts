#!/usr/bin/env npx tsx
/**
 * Rúnir extraction model benchmark CLI.
 *
 * Default is dry-run (zero network). Paid calls require explicit --confirm-cost
 * after human approval. See docs brief: runir-model-benchmark-agent-brief.md
 */
import { runBenchmark } from "../src/testing/model-benchmark/run.js";

const result = await runBenchmark(process.argv.slice(2));
process.exit(result.code);
