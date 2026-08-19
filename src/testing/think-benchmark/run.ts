import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildThinkChatRequest,
  buildThinkPrompt,
  THINK_MAX_OUTPUT_TOKENS,
} from "../../recall/orchestrator/think-synthesis.js";
import {
  canonicalHash,
  canonicalJson,
  sha256Text,
} from "../model-benchmark/provenance.js";
import {
  parseThinkBenchmarkArgs,
  thinkBenchmarkUsage,
  type ThinkBenchmarkOptions,
} from "./cli.js";
import { validateThinkCorpus } from "./corpus.js";
import {
  executePaidThinkBenchmark,
} from "./execute.js";
import {
  retrievalGoldForCase,
  validateThinkRetrievalFixture,
  type ThinkRetrievalFixture,
} from "./retrieval.js";
import {
  defaultGit,
} from "./run-helpers.js";
import type {
  ThinkBenchmarkDeps,
  ThinkBenchmarkResult,
} from "./runner-types.js";
import { scoreThinkRetrieval } from "./score.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
  type ThinkBenchmarkCase,
} from "./types.js";

export async function runThinkBenchmark(
  argv: readonly string[],
  deps: ThinkBenchmarkDeps = {},
): Promise<ThinkBenchmarkResult> {
  let options: ThinkBenchmarkOptions;
  try {
    options = parseThinkBenchmarkArgs(argv);
  } catch (error) {
    const fallback = parseThinkBenchmarkArgs([]);
    return { code: 2, options: fallback, rows: [], error: String(error) };
  }
  const log = deps.log ?? console.log;
  if (options.help) {
    log(thinkBenchmarkUsage());
    return { code: 0, options, rows: [] };
  }
  const cwd = deps.cwd ?? process.cwd();
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile = deps.writeFile ?? ((path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, "utf8");
  });
  const fileExists = deps.fileExists ?? existsSync;
  const fixturePath = resolve(cwd, options.fixturesPath);
  let corpus: ThinkBenchmarkCase[];
  try {
    corpus = validateThinkCorpus(JSON.parse(readFile(fixturePath)) as unknown);
  } catch (error) {
    return { code: 3, options, rows: [], error: `Fixture validation failed: ${String(error)}` };
  }
  let retrievalFixture: ThinkRetrievalFixture | undefined;
  let retrievalPreflight: ThinkBenchmarkResult["preflight"];
  if (options.suiteId === "runir-think-e2e") {
    try {
      retrievalFixture = validateThinkRetrievalFixture(
        JSON.parse(readFile(resolve(cwd, options.retrievalFixturesPath))) as unknown,
        corpus,
      );
      retrievalPreflight = {
        retrieval: {
          seedCount: retrievalFixture.memories.length,
          retrievalWindow: retrievalFixture.retrievalWindow,
          synthesisCap: retrievalFixture.synthesisCap,
          fixtureContentHash: canonicalHash(retrievalFixture),
          metricContractVersion: THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
          attributionScores: scoreThinkRetrieval(
            retrievalGoldForCase(retrievalFixture, retrievalFixture.attributionProbe.caseId),
            retrievalFixture.attributionProbe.selectedIds,
            retrievalFixture.attributionProbe.retainedIds,
          ),
        },
      };
    } catch (error) {
      return { code: 3, options, rows: [], error: `Retrieval fixture validation failed: ${String(error)}` };
    }
  }
  const git = deps.git?.() ?? defaultGit(cwd);
  const plannedRequestCount = corpus.length * options.repetitions;
  const effectiveMaxOutputTokens = options.suiteId === "runir-think-e2e"
    ? THINK_MAX_OUTPUT_TOKENS
    : options.maxOutputTokens;
  const promptTemplateHash = sha256Text(canonicalJson({
    prompt: buildThinkPrompt("__QUESTION__", [{ id: "__EVIDENCE_ID__", text: "__EVIDENCE__" }]),
    request: buildThinkChatRequest("__MODEL__", "__SYSTEM__", "__USER__", {
      maxOutputTokens: effectiveMaxOutputTokens,
    }),
    responseParserVersion: THINK_RESPONSE_PARSER_VERSION,
  }));
  const fixtureContentHash = canonicalHash(corpus);
  const disclosure = {
    schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
    suiteId: options.suiteId,
    modelId: options.modelId,
    candidateId: options.candidateId,
    cases: corpus.length,
    repetitions: options.repetitions,
    plannedRequestCount,
    dryRun: options.dryRun,
    source: { git, fixtureContentHash, promptTemplateHash },
    ...(retrievalPreflight ? { retrieval: retrievalPreflight.retrieval } : {}),
    costCapUsd: options.maxTotalCostUsd,
    credentialSource: "process environment (Infisical-compatible; value never logged)",
  };
  log(JSON.stringify(disclosure, null, 2));
  if (options.dryRun) {
    return { code: 0, options, rows: [], ...(retrievalPreflight ? { preflight: retrievalPreflight } : {}) };
  }
  return executePaidThinkBenchmark({
    options,
    deps,
    corpus,
    retrievalFixture,
    retrievalPreflight,
    git,
    plannedRequestCount,
    effectiveMaxOutputTokens,
    promptTemplateHash,
    fixtureContentHash,
    cwd,
    fileExists,
    writeFile,
  });
}
