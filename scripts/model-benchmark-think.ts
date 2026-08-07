#!/usr/bin/env npx tsx
/**
 * Rúnir fixed-evidence Think synthesis benchmark.
 *
 * Default is a zero-network preflight. Network calls require the explicit
 * cost-confirmation, price, cap, credential, and clean-worktree gates.
 */
import { runThinkBenchmark } from "../src/testing/think-benchmark/run.js";

const result = await runThinkBenchmark(process.argv.slice(2));
if (result.error) console.error(result.error);
process.exit(result.code);
