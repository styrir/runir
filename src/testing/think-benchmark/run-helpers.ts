import { execFileSync } from "node:child_process";
import type { ThinkEvidenceItem } from "../../recall/orchestrator/think-synthesis.js";
import type {
  ThinkBenchmarkCase,
  ThinkBenchmarkRow,
  ThinkQualityScores,
  ThinkRunManifest,
} from "./types.js";

export function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function normalizedRouteClaims(value: unknown): Array<{ text: string; citations: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.map((claim) => {
    const row = readRecord(claim);
    const citations = Array.isArray(row.citations)
      ? row.citations.map((citation) => {
        if (typeof citation === "string") return citation;
        const citationRecord = readRecord(citation);
        return typeof citationRecord.id === "string" ? citationRecord.id : "";
      }).filter(Boolean)
      : [];
    return { text: String(row.text ?? ""), citations };
  });
}

function bareSemioteId(value: string): string {
  return value.replace(/^semiote:/u, "");
}

export function alignE2eGoldEvidenceIds(
  benchmarkCase: ThinkBenchmarkCase,
  evidence: ThinkEvidenceItem[],
): ThinkBenchmarkCase {
  const routeSemioteIds = new Map(
    evidence.filter((item) => !item.id.includes(":"))
      .map((item) => [bareSemioteId(item.id), item.id]),
  );
  return {
    ...benchmarkCase,
    gold: {
      ...benchmarkCase.gold,
      supportedClaims: benchmarkCase.gold.supportedClaims.map((claim) => ({
        ...claim,
        evidenceIds: claim.evidenceIds.map((id) => id.startsWith("semiote:")
          ? routeSemioteIds.get(bareSemioteId(id)) ?? id
          : id),
      })),
    },
  };
}

export function defaultGit(cwd: string): { sha: string; dirty: boolean } {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return { sha, dirty: status.trim().length > 0 };
}

export function estimatedCost(
  promptTokens: number,
  completionTokens: number,
  inputUsdPer1M: number,
  outputUsdPer1M: number,
): number {
  return (promptTokens * inputUsdPer1M + completionTokens * outputUsdPer1M) / 1_000_000;
}

export function normalizedBaseUrlIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/u, "")}`;
  } catch {
    return value.replace(/[?#].*$/u, "").replace(/\/$/u, "");
  }
}

export function validateLoopbackService(serviceUrl: string): string | null {
  let service: URL;
  try {
    service = new URL(serviceUrl);
  } catch {
    return "E2E run refused: service URL is invalid";
  }
  if (service.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(service.hostname)) {
    return "E2E run refused: service URL must be loopback HTTP";
  }
  return service.username || service.password
    ? "E2E run refused: service URL must not contain userinfo"
    : null;
}

export function strictQualityPass(quality: ThinkQualityScores): boolean {
  return quality.schemaValid && quality.answerCompleteness === 1 &&
    quality.unsupportedClaimRate === 0 && quality.citationValidity === 1 &&
    quality.citationPrecision === 1 && quality.citationCompleteness === 1 &&
    quality.gapAccuracy === 1 && quality.abstentionCorrect === 1 &&
    quality.forbiddenMatches.length === 0;
}

export function reportFor(manifest: ThinkRunManifest, rows: ThinkBenchmarkRow[]): string {
  const passCount = rows.filter((row) => row.synthesisVerdict === "pass").length;
  const retrievalPasses = rows.filter((row) => row.retrieval?.status === "pass").length;
  const retrievalScores = rows.flatMap((row) => row.retrieval ? [row.retrieval.scores] : []);
  const meanScore = (values: readonly (number | null)[]): string => {
    const scored = values.filter((value): value is number => value !== null);
    return scored.length ? (scored.reduce((sum, value) => sum + value, 0) / scored.length).toFixed(4) : "not scored";
  };
  return [
    "# Rúnir Think benchmark", "",
    `- Run: \`${manifest.runId}\``,
    `- Suite: \`${manifest.suiteId}\``,
    `- Model: \`${manifest.disclosure.modelId}\``,
    `- Rows: ${rows.length}/${manifest.disclosure.plannedRequestCount}`,
    `- Strict passes: ${passCount}/${rows.length}`,
    ...(manifest.suiteId === "runir-think-e2e" ? [
      `- Retrieval passes: ${retrievalPasses}/${rows.length}`,
      `- Retrieval recall: ${meanScore(retrievalScores.map((score) => score.recall))}`,
      `- Retrieval precision: ${meanScore(retrievalScores.map((score) => score.precision))}`,
      `- Retained recall: ${meanScore(retrievalScores.map((score) => score.retainedRecall))}`,
      `- First relevant rank: ${meanScore(retrievalScores.map((score) => score.firstRelevantRank))}`,
      `- Mean relevant rank: ${meanScore(retrievalScores.map((score) => score.meanRelevantRank))}`,
    ] : []),
    `- Cumulative billed/estimated/reserved cost: $${manifest.completion.cumulativeCostUsd.toFixed(6)}`,
    `- Cost observation: \`${manifest.disclosure.costObservation}\``,
    `- Fixture hash: \`${manifest.fixtureContentHash}\``,
    `- Prompt hash: \`${manifest.promptTemplateHash}\``, "",
    "The Studio keeps answer quality, unsupported claims, citation quality, gaps, latency, tokens, and cost separate; no composite score is invented.", "",
  ].join("\n");
}
