import { jsonrepair } from "jsonrepair";
import { parseThinkResponse } from "../../recall/orchestrator/think-synthesis.js";
import { resolveLlmBaseUrl } from "../../shared/config.js";
import {
  effectiveRequest,
  type CommonCaseContext,
  type ThinkCaseOutcome,
} from "./run-cases.js";
import {
  estimatedCost,
  readRecord,
  strictQualityPass,
} from "./run-helpers.js";
import { scoreThinkSynthesis } from "./score.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
} from "./types.js";

type SynthesisCaseContext = CommonCaseContext & {
  readonly apiKey: string;
};

export async function executeThinkSynthesisCase(
  context: SynthesisCaseContext,
): Promise<ThinkCaseOutcome> {
  const request = effectiveRequest(context);
  const started = performance.now();
  const response = await context.fetchFn(`${resolveLlmBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.apiKey}`,
    },
    body: JSON.stringify(request.request),
    signal: AbortSignal.timeout(context.options.timeoutMs),
  });
  const latencyMs = performance.now() - started;
  const data = readRecord(await response.json());
  if (!response.ok) throw new Error(`gateway ${response.status}`);
  const choices = Array.isArray(data["choices"]) ? data["choices"] : [];
  const firstChoice = readRecord(choices[0]);
  const message = readRecord(firstChoice["message"]);
  const raw = String(message["content"] ?? "");
  const synthesis = parseThinkResponse(
    raw,
    context.benchmarkCase.evidence,
    jsonrepair,
  );
  const rawUsage = readRecord(data["usage"]);
  const usage = {
    promptTokens: typeof rawUsage["prompt_tokens"] === "number"
      ? rawUsage["prompt_tokens"]
      : undefined,
    completionTokens: typeof rawUsage["completion_tokens"] === "number"
      ? rawUsage["completion_tokens"]
      : undefined,
    totalTokens: typeof rawUsage["total_tokens"] === "number"
      ? rawUsage["total_tokens"]
      : undefined,
  };
  const cost = estimatedCost(
    usage.promptTokens ?? Math.ceil(request.promptCharacters / 4),
    usage.completionTokens ?? context.effectiveMaxOutputTokens,
    context.inputUsdPer1M,
    context.outputUsdPer1M,
  );
  const billedCost = typeof rawUsage["cost"] === "number"
    ? rawUsage["cost"]
    : null;
  const quality = scoreThinkSynthesis(
    context.benchmarkCase,
    synthesis,
    synthesis.schemaValid,
  );
  return {
    observedCostUsd: billedCost ?? cost,
    row: {
      schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
      runId: context.runId,
      timestamp: context.now().toISOString(),
      caseId: context.benchmarkCase.id,
      repetition: context.repetition,
      candidateId: context.options.candidateId,
      candidateLabel: context.options.candidateLabel,
      modelId: context.options.modelId,
      question: context.benchmarkCase.question,
      evidence: context.benchmarkCase.evidence,
      gold: context.benchmarkCase.gold,
      effectiveRequest: request.row,
      responseParserVersion: THINK_RESPONSE_PARSER_VERSION,
      synthesis,
      rawResponseHead: raw.slice(0, 2_000),
      quality,
      synthesisVerdict: strictQualityPass(quality) ? "pass" : "fail",
      usage,
      latencyMs,
      retryCount: 0,
      httpStatus: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      estimatedCostUsd: cost,
      billedCostUsd: billedCost,
      costBasis: billedCost !== null ? "gateway_billed" : "token_usage_estimate",
    },
  };
}
