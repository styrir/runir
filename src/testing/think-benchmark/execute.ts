import { resolve } from "node:path";
import {
  buildThinkPrompt,
  THINK_MAX_EVIDENCE_ITEMS,
  THINK_MAX_EVIDENCE_TEXT_CHARS,
  THINK_PROMPT_OVERHEAD_CHARS,
} from "../../recall/orchestrator/think-synthesis.js";
import { resolveLlmBaseUrl } from "../../shared/config.js";
import type { ThinkBenchmarkOptions } from "./cli.js";
import type { ThinkRetrievalFixture } from "./retrieval.js";
import {
  executeThinkE2eCase,
} from "./run-cases.js";
import { executeThinkSynthesisCase } from "./run-synthesis-case.js";
import {
  estimatedCost,
  normalizedBaseUrlIdentity,
  reportFor,
  validateLoopbackService,
} from "./run-helpers.js";
import type {
  ThinkBenchmarkDeps,
  ThinkBenchmarkResult,
  ThinkRetrievalPreflight,
} from "./runner-types.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
  THINK_SCORING_CONTRACT_VERSION,
  type ThinkBenchmarkCase,
  type ThinkBenchmarkRow,
  type ThinkRunManifest,
} from "./types.js";

export type ThinkExecutionPlan = {
  readonly options: ThinkBenchmarkOptions;
  readonly deps: ThinkBenchmarkDeps;
  readonly corpus: readonly ThinkBenchmarkCase[];
  readonly retrievalFixture: ThinkRetrievalFixture | undefined;
  readonly retrievalPreflight: ThinkRetrievalPreflight | undefined;
  readonly git: { readonly sha: string; readonly dirty: boolean };
  readonly plannedRequestCount: number;
  readonly effectiveMaxOutputTokens: number;
  readonly promptTemplateHash: string;
  readonly fixtureContentHash: string;
  readonly cwd: string;
  readonly fileExists: (path: string) => boolean;
  readonly writeFile: (path: string, value: string) => void;
};

export async function executePaidThinkBenchmark(
  plan: ThinkExecutionPlan,
): Promise<ThinkBenchmarkResult> {
  const { options } = plan;
  if (!options.confirmCost || options.maxTotalCostUsd === null ||
      options.inputUsdPer1M === null || options.outputUsdPer1M === null) {
    return {
      code: 4,
      options,
      rows: [],
      error: "Paid run refused: confirmation, cap, and input/output prices are all required",
    };
  }
  if (options.requireCleanGit && plan.git.dirty) {
    return {
      code: 4,
      options,
      rows: [],
      error: "Paid run refused: Git worktree is dirty",
    };
  }
  const env = plan.deps.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (options.suiteId === "runir-think-synthesis" && !apiKey) {
    return {
      code: 4,
      options,
      rows: [],
      error: "Paid run refused: injected OPENROUTER_API_KEY is unavailable",
    };
  }
  if (options.suiteId === "runir-think-e2e") {
    const serviceError = validateLoopbackService(options.serviceUrl);
    if (serviceError) return { code: 4, options, rows: [], error: serviceError };
    if (!plan.retrievalFixture) {
      return {
        code: 3,
        options,
        rows: [],
        error: "Retrieval fixture validation failed: validated fixture is unavailable",
      };
    }
  }

  const e2eWorstPromptTokens = Math.ceil(
    (THINK_MAX_EVIDENCE_ITEMS * THINK_MAX_EVIDENCE_TEXT_CHARS +
      THINK_PROMPT_OVERHEAD_CHARS) / 4,
  );
  const worstPromptTokens = options.suiteId === "runir-think-e2e"
    ? plan.plannedRequestCount * e2eWorstPromptTokens
    : plan.corpus.reduce((sum, item) => {
      const prompt = buildThinkPrompt(item.question, item.evidence);
      return sum + Math.ceil((prompt.system.length + prompt.user.length) / 4);
    }, 0) * options.repetitions;
  const worstCost = estimatedCost(
    worstPromptTokens,
    plan.plannedRequestCount * plan.effectiveMaxOutputTokens,
    options.inputUsdPer1M,
    options.outputUsdPer1M,
  );
  if (worstCost > options.maxTotalCostUsd) {
    return {
      code: 4,
      options,
      rows: [],
      error: `Paid run refused: worst-case estimate $${worstCost.toFixed(6)} exceeds cap`,
    };
  }

  const rawPath = resolve(plan.cwd, options.outRaw);
  const reportPath = resolve(plan.cwd, options.outReport);
  const manifestPath = rawPath.endsWith(".jsonl")
    ? rawPath.replace(/\.jsonl$/u, ".manifest.json")
    : `${rawPath}.manifest.json`;
  if (!options.allowOverwrite &&
      [rawPath, manifestPath, reportPath].some(plan.fileExists)) {
    return {
      code: 5,
      options,
      rows: [],
      error: "Artifact target exists; use --allow-overwrite or choose new paths",
    };
  }

  const now = plan.deps.now ?? (() => new Date());
  const runId = plan.deps.randomId?.() ??
    `think-${now().toISOString().replace(/[:.]/gu, "-")}`;
  const fetchFn = plan.deps.fetchFn ?? fetch;
  const rows: ThinkBenchmarkRow[] = [];
  let cumulativeCostUsd = 0;
  let stopReason: ThinkRunManifest["completion"]["stopReason"];
  outer: for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    for (const benchmarkCase of plan.corpus) {
      try {
        const common = {
          options,
          benchmarkCase,
          repetition,
          runId,
          now,
          fetchFn,
          effectiveMaxOutputTokens: plan.effectiveMaxOutputTokens,
          inputUsdPer1M: options.inputUsdPer1M,
          outputUsdPer1M: options.outputUsdPer1M,
        };
        let outcome;
        if (options.suiteId === "runir-think-e2e") {
          if (!plan.retrievalFixture) {
            throw new Error("validated retrieval fixture is unavailable");
          }
          outcome = await executeThinkE2eCase({
            ...common,
            retrievalFixture: plan.retrievalFixture,
            worstPromptTokens: e2eWorstPromptTokens,
            serviceApiKey: env.RUNIR_API_KEY?.trim(),
          });
        } else {
          if (!apiKey) throw new Error("injected OPENROUTER_API_KEY is unavailable");
          outcome = await executeThinkSynthesisCase({ ...common, apiKey });
        }
        rows.push(outcome.row);
        cumulativeCostUsd += outcome.observedCostUsd;
        if (cumulativeCostUsd >= options.maxTotalCostUsd) {
          stopReason = "cost_cap";
          break outer;
        }
      } catch (error) {
        stopReason = String(error).toLowerCase().includes("timeout")
          ? "timeout"
          : "runtime_error";
        break outer;
      }
    }
  }

  const completed = rows.length === plan.plannedRequestCount;
  const manifest: ThinkRunManifest = {
    schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
    runId,
    suiteId: options.suiteId,
    createdAt: now().toISOString(),
    git: plan.git,
    fixtureContentHash: plan.fixtureContentHash,
    ...(plan.retrievalPreflight
      ? {
        retrievalFixtureContentHash:
          plan.retrievalPreflight.retrieval.fixtureContentHash,
        retrievalMetricContractVersion: THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
      }
      : {}),
    promptTemplateHash: plan.promptTemplateHash,
    scoringContractVersion: THINK_SCORING_CONTRACT_VERSION,
    rowCount: rows.length,
    disclosure: {
      candidateId: options.candidateId,
      candidateLabel: options.candidateLabel,
      modelId: options.modelId,
      repetitions: options.repetitions,
      plannedRequestCount: plan.plannedRequestCount,
      dryRun: false,
      synthetic: false,
      maxOutputTokens: plan.effectiveMaxOutputTokens,
      timeoutMs: options.timeoutMs,
      gatewayBaseUrl: normalizedBaseUrlIdentity(
        options.suiteId === "runir-think-e2e"
          ? options.serviceUrl
          : resolveLlmBaseUrl(),
      ),
      costObservation: options.suiteId === "runir-think-e2e"
        ? "route_usage_or_reservation"
        : "gateway_or_usage",
    },
    completion: {
      status: completed ? "complete" : "partial",
      plannedRequestCount: plan.plannedRequestCount,
      completedRequestCount: rows.length,
      cumulativeCostUsd,
      ...(stopReason ? { stopReason } : {}),
    },
  };
  const report = reportFor(manifest, rows);
  plan.writeFile(
    rawPath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
  );
  plan.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  plan.writeFile(reportPath, report);
  return {
    code: completed ? 0 : 6,
    options,
    rows,
    manifest,
    report,
    ...(completed ? {} : { error: `Run stopped: ${stopReason ?? "incomplete"}` }),
  };
}
