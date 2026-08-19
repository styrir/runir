import { jsonrepair } from "jsonrepair";
import {
  buildThinkChatRequest,
  buildThinkPrompt,
  parseThinkResponse,
  THINK_MAX_EVIDENCE_ITEMS,
} from "../../recall/orchestrator/think-synthesis.js";
import type { ThinkBenchmarkOptions } from "./cli.js";
import {
  retrievalGoldForCase,
  type ThinkRetrievalFixture,
} from "./retrieval.js";
import {
  alignE2eGoldEvidenceIds,
  estimatedCost,
  normalizedRouteClaims,
  readRecord,
  strictQualityPass,
  stringArray,
} from "./run-helpers.js";
import { scoreThinkRetrieval, scoreThinkSynthesis } from "./score.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
  type ThinkBenchmarkCase,
  type ThinkBenchmarkRow,
} from "./types.js";

export type CommonCaseContext = {
  readonly options: ThinkBenchmarkOptions;
  readonly benchmarkCase: ThinkBenchmarkCase;
  readonly repetition: number;
  readonly runId: string;
  readonly now: () => Date;
  readonly fetchFn: typeof fetch;
  readonly effectiveMaxOutputTokens: number;
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
};

type E2eCaseContext = CommonCaseContext & {
  readonly retrievalFixture: ThinkRetrievalFixture;
  readonly worstPromptTokens: number;
  readonly serviceApiKey: string | undefined;
};

export type ThinkCaseOutcome = {
  readonly row: ThinkBenchmarkRow;
  readonly observedCostUsd: number;
};

export function effectiveRequest(context: CommonCaseContext): {
  readonly request: Record<string, unknown>;
  readonly row: ThinkBenchmarkRow["effectiveRequest"];
  readonly promptCharacters: number;
} {
  const { system, user } = buildThinkPrompt(
    context.benchmarkCase.question,
    context.benchmarkCase.evidence,
  );
  return {
    request: buildThinkChatRequest(context.options.modelId, system, user, {
      maxOutputTokens: context.effectiveMaxOutputTokens,
    }),
    row: {
      model: context.options.modelId,
      max_tokens: context.effectiveMaxOutputTokens,
      temperature: 0.2,
    },
    promptCharacters: system.length + user.length,
  };
}

export async function executeThinkE2eCase(
  context: E2eCaseContext,
): Promise<ThinkCaseOutcome> {
  const request = effectiveRequest(context);
  const started = performance.now();
  const response = await context.fetchFn(`${context.options.serviceUrl}/memory/think`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(context.serviceApiKey
        ? { Authorization: `Bearer ${context.serviceApiKey}` }
        : {}),
    },
    body: JSON.stringify({
      userId: context.options.userId,
      question: context.benchmarkCase.question,
    }),
    signal: AbortSignal.timeout(context.options.timeoutMs),
  });
  const latencyMs = performance.now() - started;
  const data = readRecord(await response.json());
  if (!response.ok) throw new Error(`runir ${response.status}`);
  const evidence = (Array.isArray(data["evidence"]) ? data["evidence"] : [])
    .map((item: unknown) => {
      const row = readRecord(item);
      return {
        id: String(row["id"] ?? ""),
        text: String(row["preview"] ?? ""),
      };
    })
    .filter((item) => item.id.length > 0 && item.text.length > 0)
    .slice(0, THINK_MAX_EVIDENCE_ITEMS);
  const synthesis = parseThinkResponse(JSON.stringify({
    answer: data["answer"] ?? null,
    claims: normalizedRouteClaims(data["claims"]),
    citations: data["citations"] ?? [],
    gaps: data["gaps"] ?? [],
  }), evidence, jsonrepair);
  const retrievalSource = readRecord(data["retrieval"]);
  const derivedRetainedIds = evidence.map((item) => item.id);
  const routeRetainedIds = stringArray(retrievalSource["retainedIds"]);
  const retainedIds = routeRetainedIds.length ? routeRetainedIds : derivedRetainedIds;
  const routeSelectedIds = stringArray(retrievalSource["selectedIds"]);
  const selectedIds = routeSelectedIds.length ? routeSelectedIds : retainedIds;
  const retrievalGold = retrievalGoldForCase(
    context.retrievalFixture,
    context.benchmarkCase.id,
  );
  const retrievalScores = scoreThinkRetrieval(
    retrievalGold,
    selectedIds,
    retainedIds,
  );
  const retrievalStatus = retrievalScores.retainedRecall === null ||
    retrievalScores.retainedRecall === 1
    ? "pass"
    : "fail";
  const routeUsage = readRecord(data["usage"]);
  const usage = {
    promptTokens: typeof routeUsage["promptTokens"] === "number"
      ? routeUsage["promptTokens"]
      : undefined,
    completionTokens: typeof routeUsage["completionTokens"] === "number"
      ? routeUsage["completionTokens"]
      : undefined,
    totalTokens: typeof routeUsage["totalTokens"] === "number"
      ? routeUsage["totalTokens"]
      : undefined,
  };
  const hasObservedUsage = usage.promptTokens !== undefined &&
    usage.completionTokens !== undefined;
  const cost = estimatedCost(
    usage.promptTokens ?? context.worstPromptTokens,
    usage.completionTokens ?? context.effectiveMaxOutputTokens,
    context.inputUsdPer1M,
    context.outputUsdPer1M,
  );
  const scoringCase = alignE2eGoldEvidenceIds(context.benchmarkCase, evidence);
  const quality = scoreThinkSynthesis(scoringCase, synthesis, synthesis.schemaValid);
  return {
    observedCostUsd: cost,
    row: {
      schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
      runId: context.runId,
      timestamp: context.now().toISOString(),
      caseId: context.benchmarkCase.id,
      repetition: context.repetition,
      candidateId: context.options.candidateId,
      candidateLabel: context.options.candidateLabel,
      modelId: typeof data["model"] === "string"
        ? data["model"]
        : context.options.modelId,
      question: context.benchmarkCase.question,
      evidence,
      gold: scoringCase.gold,
      effectiveRequest: request.row,
      responseParserVersion: THINK_RESPONSE_PARSER_VERSION,
      synthesis,
      rawResponseHead: JSON.stringify(data).slice(0, 2_000),
      quality,
      synthesisVerdict: retrievalStatus === "pass"
        ? strictQualityPass(quality) ? "pass" : "fail"
        : "not-scored",
      usage,
      latencyMs,
      retryCount: 0,
      httpStatus: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      estimatedCostUsd: cost,
      billedCostUsd: null,
      costBasis: hasObservedUsage ? "token_usage_estimate" : "reserved_worst_case",
      retrieval: {
        status: retrievalStatus,
        gold: retrievalGold,
        scores: retrievalScores,
        selectedBeforeCap: typeof retrievalSource["selectedBeforeCap"] === "number"
          ? retrievalSource["selectedBeforeCap"]
          : retainedIds.length,
        selectedIds,
        retainedIds,
        evidenceCount: evidence.length,
        cap: THINK_MAX_EVIDENCE_ITEMS,
        synthesisSkipped: retrievalSource["synthesisSkipped"] === true,
        retrievalTraceId: typeof data["retrievalTraceId"] === "string"
          ? data["retrievalTraceId"]
          : undefined,
      },
    },
  };
}
