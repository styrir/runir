import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { jsonrepair } from "jsonrepair";
import {
  buildThinkChatRequest,
  buildThinkPrompt,
  parseThinkResponse,
  resolveThinkModel,
  THINK_MAX_EVIDENCE_ITEMS,
  THINK_MAX_EVIDENCE_TEXT_CHARS,
  THINK_MAX_OUTPUT_TOKENS,
  THINK_PROMPT_OVERHEAD_CHARS,
} from "../../recall/orchestrator/think-synthesis.js";
import { resolveLlmBaseUrl } from "../../shared/config.js";
import {
  canonicalHash,
  canonicalJson,
  sha256Text,
} from "../model-benchmark/provenance.js";
import { scoreThinkSynthesis } from "./score.js";
import {
  THINK_BENCHMARK_SCHEMA_VERSION,
  THINK_RESPONSE_PARSER_VERSION,
  THINK_SCORING_CONTRACT_VERSION,
  type ThinkBenchmarkCase,
  type ThinkBenchmarkRow,
  type ThinkQualityScores,
  type ThinkRunManifest,
} from "./types.js";

export type ThinkBenchmarkOptions = {
  fixturesPath: string;
  suiteId: "runir-think-synthesis" | "runir-think-e2e";
  serviceUrl: string;
  userId: string;
  modelId: string;
  candidateId: string;
  candidateLabel: string;
  repetitions: number;
  timeoutMs: number;
  maxOutputTokens: number;
  outRaw: string;
  outReport: string;
  dryRun: boolean;
  confirmCost: boolean;
  maxTotalCostUsd: number | null;
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
  allowOverwrite: boolean;
  requireCleanGit: boolean;
  help: boolean;
};

export type ThinkBenchmarkDeps = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  now?: () => Date;
  randomId?: () => string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, value: string) => void;
  fileExists?: (path: string) => boolean;
  git?: () => { sha: string; dirty: boolean };
  log?: (message: string) => void;
};

export type ThinkBenchmarkResult = {
  code: number;
  options: ThinkBenchmarkOptions;
  rows: ThinkBenchmarkRow[];
  manifest?: ThinkRunManifest;
  report?: string;
  error?: string;
};

const DEFAULT_FIXTURES = "fixtures/think-benchmark/corpus.json";
const DEFAULT_RAW = "docs/analysis/raw/think-benchmark-latest.jsonl";
const DEFAULT_REPORT = "docs/analysis/think-benchmark-latest.md";

function usage(): string {
  return `Rúnir Think synthesis benchmark

Default is a zero-network preflight. Paid execution requires every gate:
  --confirm-cost
  --max-total-cost-usd <usd>
  --input-usd-per-1m <usd>
  --output-usd-per-1m <usd>
  a clean Git worktree (unless --allow-dirty)
  OPENROUTER_API_KEY injected into the process (for example by Infisical)

Options:
  --fixtures <path>              Frozen Think corpus
  --suite <synthesis|e2e>        Fixed evidence or local /memory/think
  --service-url <loopback-url>   Local Rúnir URL for the e2e suite
  --user-id <id>                 Explicit e2e tenant identity
  --model <id>                   OpenAI-compatible wire model
  --candidate-id <id>            Stable comparison identity
  --candidate-label <label>      Human label
  --repetitions <n>              Requests per case
  --timeout-ms <n>               Per-request timeout
  --max-output-tokens <n>        Output token ceiling
  --out-raw <path>               JSONL output; manifest is paired automatically
  --out-report <path>            Markdown report
  --confirm-cost                 Enable network execution
  --max-total-cost-usd <usd>     Hard estimated-cost cap
  --input-usd-per-1m <usd>       Price used for the cap
  --output-usd-per-1m <usd>      Price used for the cap
  --allow-overwrite              Replace existing target artifacts
  --allow-dirty                  Permit a dirty source tree
  --help`;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

export function parseThinkBenchmarkArgs(argv: readonly string[]): ThinkBenchmarkOptions {
  const options: ThinkBenchmarkOptions = {
    fixturesPath: DEFAULT_FIXTURES,
    suiteId: "runir-think-synthesis",
    serviceUrl: "http://127.0.0.1:7700",
    userId: "owner",
    modelId: resolveThinkModel(),
    candidateId: "think-model",
    candidateLabel: "Think model",
    repetitions: 1,
    timeoutMs: 30_000,
    maxOutputTokens: 1_200,
    outRaw: DEFAULT_RAW,
    outReport: DEFAULT_REPORT,
    dryRun: true,
    confirmCost: false,
    maxTotalCostUsd: null,
    inputUsdPer1M: null,
    outputUsdPer1M: null,
    allowOverwrite: false,
    requireCleanGit: true,
    help: false,
  };
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--confirm-cost") {
      options.confirmCost = true;
      options.dryRun = false;
    } else if (flag === "--allow-overwrite") options.allowOverwrite = true;
    else if (flag === "--allow-dirty") options.requireCleanGit = false;
    else if (flag === "--fixtures") options.fixturesPath = next(index++, flag);
    else if (flag === "--suite") {
      const value = next(index++, flag);
      if (value !== "synthesis" && value !== "e2e") throw new Error("--suite must be synthesis or e2e");
      options.suiteId = value === "e2e" ? "runir-think-e2e" : "runir-think-synthesis";
    }
    else if (flag === "--service-url") options.serviceUrl = next(index++, flag).replace(/\/+$/u, "");
    else if (flag === "--user-id") options.userId = next(index++, flag);
    else if (flag === "--model") options.modelId = next(index++, flag);
    else if (flag === "--candidate-id") options.candidateId = next(index++, flag);
    else if (flag === "--candidate-label") options.candidateLabel = next(index++, flag);
    else if (flag === "--repetitions") options.repetitions = positiveInteger(next(index++, flag), flag);
    else if (flag === "--timeout-ms") options.timeoutMs = positiveInteger(next(index++, flag), flag);
    else if (flag === "--max-output-tokens") options.maxOutputTokens = positiveInteger(next(index++, flag), flag);
    else if (flag === "--out-raw") options.outRaw = next(index++, flag);
    else if (flag === "--out-report") options.outReport = next(index++, flag);
    else if (flag === "--max-total-cost-usd") options.maxTotalCostUsd = nonNegativeNumber(next(index++, flag), flag);
    else if (flag === "--input-usd-per-1m") options.inputUsdPer1M = nonNegativeNumber(next(index++, flag), flag);
    else if (flag === "--output-usd-per-1m") options.outputUsdPer1M = nonNegativeNumber(next(index++, flag), flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function validateCorpus(value: unknown): ThinkBenchmarkCase[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Think corpus must be a non-empty array");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`case ${index} must be an object`);
    const item = entry as ThinkBenchmarkCase;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id)) throw new Error(`case ${index} has an invalid or duplicate id`);
    ids.add(item.id);
    if (typeof item.question !== "string" || !item.question.trim()) throw new Error(`case ${item.id} needs a question`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0 || item.evidence.length > THINK_MAX_EVIDENCE_ITEMS) {
      throw new Error(`case ${item.id} evidence must contain 1-${THINK_MAX_EVIDENCE_ITEMS} items`);
    }
    if (!item.gold || !Array.isArray(item.gold.supportedClaims) || !Array.isArray(item.gold.forbiddenContains) || !Array.isArray(item.gold.requiredGapContains)) {
      throw new Error(`case ${item.id} has invalid gold`);
    }
    if (typeof item.gold.answerExpected !== "boolean") {
      throw new Error(`case ${item.id} gold.answerExpected must be boolean`);
    }
    const evidenceIds = new Set<string>();
    for (const evidence of item.evidence) {
      if (typeof evidence.id !== "string" || !evidence.id || evidenceIds.has(evidence.id)) {
        throw new Error(`case ${item.id} has an invalid or duplicate evidence id`);
      }
      if (typeof evidence.text !== "string" || !evidence.text.trim()) {
        throw new Error(`case ${item.id} evidence ${evidence.id} needs text`);
      }
      if (evidence.text.length > THINK_MAX_EVIDENCE_TEXT_CHARS) {
        throw new Error(`case ${item.id} evidence ${evidence.id} exceeds the production text bound`);
      }
      evidenceIds.add(evidence.id);
    }
    const claimIds = new Set<string>();
    for (const claim of item.gold.supportedClaims) {
      if (typeof claim.id !== "string" || !claim.id || claimIds.has(claim.id)) {
        throw new Error(`case ${item.id} has an invalid or duplicate gold claim id`);
      }
      if (!Array.isArray(claim.mustContain) || claim.mustContain.length === 0 ||
          claim.mustContain.some((term) => typeof term !== "string" || !term.trim())) {
        throw new Error(`case ${item.id} claim ${claim.id} needs non-empty mustContain terms`);
      }
      if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0 ||
          claim.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
        throw new Error(`case ${item.id} claim ${claim.id} references missing evidence`);
      }
      claimIds.add(claim.id);
    }
    if ([...item.gold.forbiddenContains, ...item.gold.requiredGapContains]
      .some((term) => typeof term !== "string" || !term.trim())) {
      throw new Error(`case ${item.id} trap and gap terms must be non-empty strings`);
    }
    return item;
  });
}

function defaultGit(cwd: string): { sha: string; dirty: boolean } {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return { sha, dirty: status.trim().length > 0 };
}

function estimatedCost(
  promptTokens: number,
  completionTokens: number,
  inputUsdPer1M: number,
  outputUsdPer1M: number,
): number {
  return (promptTokens * inputUsdPer1M + completionTokens * outputUsdPer1M) / 1_000_000;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedBaseUrlIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/u, "")}`;
  } catch {
    return value.replace(/[?#].*$/u, "").replace(/\/$/u, "");
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizedRouteClaims(value: unknown): Array<{ text: string; citations: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.map((claim) => {
    const row = asRecord(claim);
    const citations = Array.isArray(row.citations)
      ? row.citations
        .map((citation) => {
          if (typeof citation === "string") return citation;
          const citationRecord = asRecord(citation);
          return typeof citationRecord.id === "string" ? citationRecord.id : "";
        })
        .filter(Boolean)
      : [];
    return { text: String(row.text ?? ""), citations };
  });
}

function reportFor(manifest: ThinkRunManifest, rows: ThinkBenchmarkRow[]): string {
  const passCount = rows.filter((row) => row.synthesisVerdict === "pass").length;
  const retrievalPasses = rows.filter((row) => row.retrieval?.status === "pass").length;
  return [
    "# Rúnir Think benchmark",
    "",
    `- Run: \`${manifest.runId}\``,
    `- Suite: \`${manifest.suiteId}\``,
    `- Model: \`${manifest.disclosure.modelId}\``,
    `- Rows: ${rows.length}/${manifest.disclosure.plannedRequestCount}`,
    `- Strict passes: ${passCount}/${rows.length}`,
    ...(manifest.suiteId === "runir-think-e2e"
      ? [`- Retrieval passes: ${retrievalPasses}/${rows.length}`]
      : []),
    `- Cumulative billed/estimated/reserved cost: $${manifest.completion.cumulativeCostUsd.toFixed(6)}`,
    `- Cost observation: \`${manifest.disclosure.costObservation}\``,
    `- Fixture hash: \`${manifest.fixtureContentHash}\``,
    `- Prompt hash: \`${manifest.promptTemplateHash}\``,
    "",
    "The Studio keeps answer quality, unsupported claims, citation quality, gaps, latency, tokens, and cost separate; no composite score is invented.",
    "",
  ].join("\n");
}

function strictQualityPass(quality: ThinkQualityScores): boolean {
  return quality.schemaValid &&
    quality.answerCompleteness === 1 &&
    quality.unsupportedClaimRate === 0 &&
    quality.citationValidity === 1 &&
    quality.citationPrecision === 1 &&
    quality.citationCompleteness === 1 &&
    quality.gapAccuracy === 1 &&
    quality.abstentionCorrect === 1 &&
    quality.forbiddenMatches.length === 0;
}

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
    log(usage());
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
    corpus = validateCorpus(JSON.parse(readFile(fixturePath)) as unknown);
  } catch (error) {
    return { code: 3, options, rows: [], error: `Fixture validation failed: ${String(error)}` };
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
    costCapUsd: options.maxTotalCostUsd,
    credentialSource: "process environment (Infisical-compatible; value never logged)",
  };
  log(JSON.stringify(disclosure, null, 2));
  if (options.dryRun) return { code: 0, options, rows: [] };
  if (!options.confirmCost || options.maxTotalCostUsd === null ||
      options.inputUsdPer1M === null || options.outputUsdPer1M === null) {
    return { code: 4, options, rows: [], error: "Paid run refused: confirmation, cap, and input/output prices are all required" };
  }
  if (options.requireCleanGit && git.dirty) {
    return { code: 4, options, rows: [], error: "Paid run refused: Git worktree is dirty" };
  }
  const env = deps.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (options.suiteId === "runir-think-synthesis" && !apiKey) {
    return { code: 4, options, rows: [], error: "Paid run refused: injected OPENROUTER_API_KEY is unavailable" };
  }
  if (options.suiteId === "runir-think-e2e") {
    let service: URL;
    try {
      service = new URL(options.serviceUrl);
    } catch {
      return { code: 4, options, rows: [], error: "E2E run refused: service URL is invalid" };
    }
    if (service.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(service.hostname)) {
      return { code: 4, options, rows: [], error: "E2E run refused: service URL must be loopback HTTP" };
    }
    if (service.username || service.password) {
      return { code: 4, options, rows: [], error: "E2E run refused: service URL must not contain userinfo" };
    }
  }
  const e2eWorstPromptTokensPerRequest = Math.ceil(
    (THINK_MAX_EVIDENCE_ITEMS * THINK_MAX_EVIDENCE_TEXT_CHARS + THINK_PROMPT_OVERHEAD_CHARS) / 4,
  );
  const worstPromptTokens = options.suiteId === "runir-think-e2e"
    ? plannedRequestCount * e2eWorstPromptTokensPerRequest
    : corpus.reduce((sum, item) => {
      const prompt = buildThinkPrompt(item.question, item.evidence);
      return sum + Math.ceil((prompt.system.length + prompt.user.length) / 4);
    }, 0) * options.repetitions;
  const worstCost = estimatedCost(
    worstPromptTokens,
    plannedRequestCount * effectiveMaxOutputTokens,
    options.inputUsdPer1M,
    options.outputUsdPer1M,
  );
  if (worstCost > options.maxTotalCostUsd) {
    return { code: 4, options, rows: [], error: `Paid run refused: worst-case estimate $${worstCost.toFixed(6)} exceeds cap` };
  }
  const rawPath = resolve(cwd, options.outRaw);
  const reportPath = resolve(cwd, options.outReport);
  const manifestPath = rawPath.endsWith(".jsonl")
    ? rawPath.replace(/\.jsonl$/u, ".manifest.json")
    : `${rawPath}.manifest.json`;
  const targets = [rawPath, manifestPath, reportPath];
  if (!options.allowOverwrite && targets.some(fileExists)) {
    return { code: 5, options, rows: [], error: "Artifact target exists; use --allow-overwrite or choose new paths" };
  }

  const now = deps.now ?? (() => new Date());
  const runId = deps.randomId?.() ?? `think-${now().toISOString().replace(/[:.]/gu, "-")}`;
  const rows: ThinkBenchmarkRow[] = [];
  let cumulativeCostUsd = 0;
  let stopReason: ThinkRunManifest["completion"]["stopReason"];
  outer: for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    for (const benchmarkCase of corpus) {
      const { system, user } = buildThinkPrompt(benchmarkCase.question, benchmarkCase.evidence);
      const request = buildThinkChatRequest(options.modelId, system, user, {
        maxOutputTokens: effectiveMaxOutputTokens,
      });
      const started = performance.now();
      try {
        if (options.suiteId === "runir-think-e2e") {
          const serviceApiKey = env.RUNIR_API_KEY?.trim();
          const response = await (deps.fetchFn ?? fetch)(`${options.serviceUrl}/memory/think`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(serviceApiKey ? { Authorization: `Bearer ${serviceApiKey}` } : {}),
            },
            body: JSON.stringify({ userId: options.userId, question: benchmarkCase.question }),
            signal: AbortSignal.timeout(options.timeoutMs),
          });
          const latencyMs = performance.now() - started;
          const data = asRecord(await response.json());
          if (!response.ok) throw new Error(`runir ${response.status}`);
          const evidence = (Array.isArray(data.evidence) ? data.evidence : [])
            .map((item: unknown) => {
              const row = item && typeof item === "object" && !Array.isArray(item)
                ? item as Record<string, unknown>
                : {};
              return { id: String(row.id ?? ""), text: String(row.preview ?? "") };
            })
            .filter((item: { id: string; text: string }) => item.id && item.text)
            .slice(0, THINK_MAX_EVIDENCE_ITEMS);
          const synthesis = parseThinkResponse(JSON.stringify({
            answer: data.answer ?? null,
            claims: normalizedRouteClaims(data.claims),
            citations: data.citations ?? [],
            gaps: data.gaps ?? [],
          }), evidence, jsonrepair);
          const expectedIds = [...new Set(benchmarkCase.gold.supportedClaims.flatMap((claim) => claim.evidenceIds))];
          const retrievalSource = asRecord(data.retrieval);
          const derivedRetainedIds = evidence.map((item) => item.id);
          const retainedIds = stringArray(retrievalSource.retainedIds).length
            ? stringArray(retrievalSource.retainedIds)
            : derivedRetainedIds;
          const selectedIds = stringArray(retrievalSource.selectedIds).length
            ? stringArray(retrievalSource.selectedIds)
            : retainedIds;
          const retrievalStatus = expectedIds.every((id) => retainedIds.includes(id)) ? "pass" : "fail";
          const routeUsage = asRecord(data.usage);
          const usage = {
            promptTokens: typeof routeUsage.promptTokens === "number" ? routeUsage.promptTokens : undefined,
            completionTokens: typeof routeUsage.completionTokens === "number" ? routeUsage.completionTokens : undefined,
            totalTokens: typeof routeUsage.totalTokens === "number" ? routeUsage.totalTokens : undefined,
          };
          const hasObservedUsage = usage.promptTokens !== undefined && usage.completionTokens !== undefined;
          const cost = estimatedCost(
            usage.promptTokens ?? e2eWorstPromptTokensPerRequest,
            usage.completionTokens ?? effectiveMaxOutputTokens,
            options.inputUsdPer1M,
            options.outputUsdPer1M,
          );
          cumulativeCostUsd += cost;
          const quality = scoreThinkSynthesis(benchmarkCase, synthesis, synthesis.schemaValid);
          rows.push({
            schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
            runId,
            timestamp: now().toISOString(),
            caseId: benchmarkCase.id,
            repetition,
            candidateId: options.candidateId,
            candidateLabel: options.candidateLabel,
            modelId: typeof data.model === "string" ? data.model : options.modelId,
            question: benchmarkCase.question,
            evidence,
            gold: benchmarkCase.gold,
            effectiveRequest: request as ThinkBenchmarkRow["effectiveRequest"],
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
              selectedBeforeCap: typeof retrievalSource.selectedBeforeCap === "number"
                ? retrievalSource.selectedBeforeCap
                : retainedIds.length,
              selectedIds,
              retainedIds,
              evidenceCount: evidence.length,
              cap: THINK_MAX_EVIDENCE_ITEMS,
              synthesisSkipped: retrievalSource.synthesisSkipped === true,
              retrievalTraceId: typeof data.retrievalTraceId === "string" ? data.retrievalTraceId : undefined,
            },
          });
          if (cumulativeCostUsd >= options.maxTotalCostUsd) {
            stopReason = "cost_cap";
            break outer;
          }
          continue;
        }
        const response = await (deps.fetchFn ?? fetch)(`${resolveLlmBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey!}` },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        const latencyMs = performance.now() - started;
        const data = await response.json() as Record<string, any>;
        if (!response.ok) throw new Error(`gateway ${response.status}`);
        const raw = String(data?.choices?.[0]?.message?.content ?? "");
        const synthesis = parseThinkResponse(raw, benchmarkCase.evidence, jsonrepair);
        const usage = {
          promptTokens: typeof data?.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : undefined,
          completionTokens: typeof data?.usage?.completion_tokens === "number" ? data.usage.completion_tokens : undefined,
          totalTokens: typeof data?.usage?.total_tokens === "number" ? data.usage.total_tokens : undefined,
        };
        const cost = estimatedCost(
          usage.promptTokens ?? Math.ceil((system.length + user.length) / 4),
          usage.completionTokens ?? effectiveMaxOutputTokens,
          options.inputUsdPer1M,
          options.outputUsdPer1M,
        );
        const billedCost = typeof data?.usage?.cost === "number" ? data.usage.cost : null;
        cumulativeCostUsd += billedCost ?? cost;
        const quality = scoreThinkSynthesis(benchmarkCase, synthesis, synthesis.schemaValid);
        rows.push({
          schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
          runId,
          timestamp: now().toISOString(),
          caseId: benchmarkCase.id,
          repetition,
          candidateId: options.candidateId,
          candidateLabel: options.candidateLabel,
          modelId: options.modelId,
          question: benchmarkCase.question,
          evidence: benchmarkCase.evidence,
          gold: benchmarkCase.gold,
          effectiveRequest: request as ThinkBenchmarkRow["effectiveRequest"],
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
        });
        if (cumulativeCostUsd >= options.maxTotalCostUsd) {
          stopReason = "cost_cap";
          break outer;
        }
      } catch (error) {
        stopReason = String(error).toLowerCase().includes("timeout") ? "timeout" : "runtime_error";
        break outer;
      }
    }
  }
  const completed = rows.length === plannedRequestCount;
  const createdAt = now().toISOString();
  const manifest: ThinkRunManifest = {
    schemaVersion: THINK_BENCHMARK_SCHEMA_VERSION,
    runId,
    suiteId: options.suiteId,
    createdAt,
    git,
    fixtureContentHash,
    promptTemplateHash,
    scoringContractVersion: THINK_SCORING_CONTRACT_VERSION,
    rowCount: rows.length,
    disclosure: {
      candidateId: options.candidateId,
      candidateLabel: options.candidateLabel,
      modelId: options.modelId,
      repetitions: options.repetitions,
      plannedRequestCount,
      dryRun: false,
      synthetic: false,
      maxOutputTokens: effectiveMaxOutputTokens,
      timeoutMs: options.timeoutMs,
      gatewayBaseUrl: normalizedBaseUrlIdentity(
        options.suiteId === "runir-think-e2e" ? options.serviceUrl : resolveLlmBaseUrl(),
      ),
      costObservation: options.suiteId === "runir-think-e2e"
        ? "route_usage_or_reservation"
        : "gateway_or_usage",
    },
    completion: {
      status: completed ? "complete" : "partial",
      plannedRequestCount,
      completedRequestCount: rows.length,
      cumulativeCostUsd,
      ...(stopReason ? { stopReason } : {}),
    },
  };
  const report = reportFor(manifest, rows);
  writeFile(rawPath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFile(reportPath, report);
  return { code: completed ? 0 : 6, options, rows, manifest, report, ...(completed ? {} : { error: `Run stopped: ${stopReason ?? "incomplete"}` }) };
}
