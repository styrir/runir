import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { resolveLlmBaseUrl } from "../../shared/config.js";
import {
  assertGeminiConfigsDistinct,
  assertLunaConfigsDistinct,
  resolveCandidateMatrix,
} from "./candidates.js";
import { HELP_TEXT, parseArgs, resolveFixturesPath } from "./cli.js";
import {
  cumulativeCostUsd,
  estimateCostUsd,
  plannedRequestCount,
} from "./metrics.js";
import { parseExtractionResponse } from "./parse-response.js";
import { credentialSourceLabel, redactSecrets, resolveApiKey, assertNoSecrets } from "./redact.js";
import { formatPreflightDisclosure, regenerateReportFromRaw } from "./report.js";
import {
  buildEffectiveRequest,
  buildUserContent,
  productionCapturePrompt,
  promptHashFor,
  serializeRequestBody,
} from "./request.js";
import { fixtureContentHashFor, promptTemplateHashFor } from "./provenance.js";
import { scoreExtraction } from "./score.js";
import {
  BENCHMARK_SCHEMA_VERSION,
  RESPONSE_PARSER_VERSION,
  SCORING_CONTRACT_VERSION,
  type BenchmarkCase,
  type Candidate,
  type CliOptions,
  type PreflightDisclosure,
  type ResultRow,
  type RunArtifactTargets,
  type RunCompletion,
  type RunManifest,
  type UsageCounters,
} from "./types.js";

export type FetchLike = typeof fetch;

export type RunDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  gitInfo?: () => { sha: string; dirty: boolean };
  writeFile?: (path: string, data: string) => void;
  writeFileExclusive?: (path: string, data: string) => boolean;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
};

const SMOKE_CASE_IDS = ["atomic-simple", "multi-claim-split", "fabrication-trap"] as const;
export const COST_CALIBRATION_PROMPT_TOKENS = 7_500;
export const COST_CALIBRATION_COMPLETION_TOKENS = 800;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

type BenchmarkRunResult = {
  code: number;
  disclosure?: PreflightDisclosure;
  rows: ResultRow[];
  manifest?: RunManifest;
  report?: string;
  error?: string;
};

function requestCostUsd(
  candidate: Candidate,
  completionTokens: number,
): number | null {
  if (!candidate.pricePer1M) return null;
  return estimateCostUsd({
    promptTokens: COST_CALIBRATION_PROMPT_TOKENS,
    completionTokens,
    price: {
      input: candidate.pricePer1M.input,
      output: candidate.pricePer1M.output,
    },
  });
}

function calibratedPlanningCostUsd(
  candidate: Candidate,
  maxOutputTokens: number,
): number | null {
  return requestCostUsd(
    candidate,
    Math.min(COST_CALIBRATION_COMPLETION_TOKENS, maxOutputTokens) +
      (candidate.reasoningBudgetTokens ?? 0),
  );
}

function capReserveCostUsd(candidate: Candidate, maxOutputTokens: number): number | null {
  return requestCostUsd(
    candidate,
    maxOutputTokens + (candidate.reasoningBudgetTokens ?? 0),
  );
}

type RawUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  cost?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
  prompt_tokens_details?: { cached_tokens?: unknown };
  input_tokens?: unknown;
  output_tokens?: unknown;
  output_tokens_details?: { reasoning_tokens?: unknown };
  input_tokens_details?: { cached_tokens?: unknown };
};

function normalizeUsage(raw: RawUsage | undefined): {
  usage: UsageCounters;
  billedCostUsd: number | null;
  invalidField?: string;
} {
  const promptTokens = raw?.prompt_tokens ?? raw?.input_tokens;
  const completionTokens = raw?.completion_tokens ?? raw?.output_tokens;
  const reasoningTokens =
    raw?.completion_tokens_details?.reasoning_tokens ??
    raw?.output_tokens_details?.reasoning_tokens;
  const cachedPromptTokens =
    raw?.prompt_tokens_details?.cached_tokens ??
    raw?.input_tokens_details?.cached_tokens;
  const counters: Array<[string, unknown]> = [
    [
      raw?.prompt_tokens !== undefined ? "prompt_tokens" : "input_tokens",
      promptTokens,
    ],
    [
      raw?.completion_tokens !== undefined ? "completion_tokens" : "output_tokens",
      completionTokens,
    ],
    ["total_tokens", raw?.total_tokens],
    [
      raw?.completion_tokens_details?.reasoning_tokens !== undefined
        ? "completion_tokens_details.reasoning_tokens"
        : "output_tokens_details.reasoning_tokens",
      reasoningTokens,
    ],
    [
      raw?.prompt_tokens_details?.cached_tokens !== undefined
        ? "prompt_tokens_details.cached_tokens"
        : "input_tokens_details.cached_tokens",
      cachedPromptTokens,
    ],
  ];
  const invalidCounter = counters.find(
    ([, value]) =>
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        !Number.isInteger(value)),
  );
  const cost = raw?.cost;
  const invalidCost =
    cost !== undefined &&
    (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0);
  const counter = (value: unknown): number | undefined =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
      ? value
      : undefined;
  return {
    usage: {
      promptTokens: counter(promptTokens),
      completionTokens: counter(completionTokens),
      totalTokens: counter(raw?.total_tokens),
      reasoningTokens: counter(reasoningTokens),
      cachedPromptTokens: counter(cachedPromptTokens),
    },
    billedCostUsd:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    ...(invalidCounter
      ? { invalidField: invalidCounter[0] }
      : invalidCost
        ? { invalidField: "cost" }
        : {}),
  };
}

function candidateBaseUrl(
  candidate: Candidate,
  configuredBaseUrl: string,
  env: NodeJS.ProcessEnv,
): string {
  if (candidate.endpoint !== "openai_direct") return configuredBaseUrl;
  const configured = env.OPENAI_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || DEFAULT_OPENAI_BASE_URL;
}

function candidateCredential(candidate: Candidate, env: NodeJS.ProcessEnv): string | undefined {
  if (candidate.endpoint === "openai_direct") {
    const key = env.OPENAI_API_KEY?.trim();
    return key || undefined;
  }
  return resolveApiKey(env);
}

function candidateCredentialSourceLabel(
  candidate: Candidate,
  env: NodeJS.ProcessEnv,
): string {
  if (candidate.endpoint === "openai_direct") {
    return env.OPENAI_API_KEY?.trim() ? "env:OPENAI_API_KEY" : "missing:OPENAI_API_KEY";
  }
  return credentialSourceLabel(env);
}

function candidateRequestPath(candidate: Candidate): "/chat/completions" | "/responses" {
  return candidate.apiStyle === "responses" ? "/responses" : "/chat/completions";
}

function responseOutputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  const textParts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === "output_text" && typeof typed.text === "string") {
        textParts.push(typed.text);
      }
    }
  }
  return textParts.join("");
}

export function loadCorpus(path: string, readFile: (p: string) => string = readFileSync.bind(null) as (p: string) => string): BenchmarkCase[] {
  const raw = readFile(path);
  const parsed = JSON.parse(raw) as { cases?: BenchmarkCase[] } | BenchmarkCase[];
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`No cases in corpus: ${path}`);
  }
  return cases;
}

export function selectCases(
  all: BenchmarkCase[],
  smoke: boolean,
  caseIds?: string[],
): BenchmarkCase[] {
  if (caseIds) {
    if (new Set(caseIds).size !== caseIds.length) {
      throw new Error("--case-ids must not contain duplicates");
    }
    return caseIds.map((id) => {
      const benchCase = all.find((candidate) => candidate.id === id);
      if (!benchCase) throw new Error(`Selected case missing from corpus: ${id}`);
      return benchCase;
    });
  }
  if (!smoke) return all;
  const picked = SMOKE_CASE_IDS.map((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`Smoke case missing from corpus: ${id}`);
    return c;
  });
  return picked;
}

function defaultGitInfo(cwd: string): { sha: string; dirty: boolean } {
  try {
    const sha = execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
    const dirty =
      execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

export function buildDisclosure(args: {
  candidates: Candidate[];
  cases: BenchmarkCase[];
  opts: CliOptions;
  baseUrl: string;
  env: NodeJS.ProcessEnv;
}): PreflightDisclosure {
  const { candidates, cases, opts, baseUrl, env } = args;
  const requestCount = plannedRequestCount({
    candidateCount: candidates.length,
    caseCount: cases.length,
    repetitions: opts.repetitions,
  });

  const assumedCompletionTokens = Math.min(
    COST_CALIBRATION_COMPLETION_TOKENS,
    opts.maxOutputTokens,
  );
  const credentialLabels = [
    ...new Set(candidates.map((candidate) => candidateCredentialSourceLabel(candidate, env))),
  ];
  let estimatedTotal: number | null = null;
  let costNote = "Gateway price discovery unavailable; using dated public list-price orientation only.";
  if (candidates.length > 0 && candidates.every((candidate) => candidate.pricePer1M)) {
    const requestsPerCandidate = cases.length * opts.repetitions;
    estimatedTotal = candidates.reduce(
      (sum, candidate) =>
        sum + (calibratedPlanningCostUsd(candidate, opts.maxOutputTokens) ?? 0) * requestsPerCandidate,
      0,
    );
    costNote =
      `Calibrated planning estimate assumes ${COST_CALIBRATION_PROMPT_TOKENS} input + ` +
      `${assumedCompletionTokens} output tokens/request at each candidate's dated list-price table. ` +
      "The input assumption is rounded above the 6,958-token live-smoke mean. " +
      "This is not a guaranteed ceiling; runtime enforcement prefers gateway-billed cost, then token-estimated cost.";
    if (candidates.some((candidate) => candidate.reasoningBudgetTokens !== undefined)) {
      costNote +=
        " For gateway-mapped reasoning candidates, the full declared reasoning budget is added " +
        "to planning cost and to the per-request runtime reserve as output tokens.";
    }
  }

  return {
    candidateModelIds: candidates.map((c) => c.modelId),
    candidates: candidates.map((c) => {
      const eff = buildEffectiveRequest({
        candidate: c,
        maxOutputTokens: opts.maxOutputTokens,
      });
      return {
        id: c.id,
        label: c.label,
        modelId: c.modelId,
        reasoning: c.reasoning,
        reasoningSupport: c.reasoningSupport,
        reasoningBudgetTokens: c.reasoningBudgetTokens,
        apiStyle: c.apiStyle ?? "chat_completions",
        endpoint: c.endpoint ?? "configured",
        endpointBaseUrl: candidateBaseUrl(c, baseUrl, env),
        credentialSourceLabel: candidateCredentialSourceLabel(c, env),
        effectiveNotes: eff.notes,
      };
    }),
    corpusSize: cases.length,
    caseIds: cases.map((benchCase) => benchCase.id),
    smokeMode: opts.smoke,
    repetitions: opts.repetitions,
    plannedRequestCount: requestCount,
    gatewayBaseUrl: baseUrl,
    credentialSourceLabel: credentialLabels.join(", "),
    maxOutputTokens: opts.maxOutputTokens,
    timeoutMs: opts.timeoutMs,
    concurrency: opts.concurrency,
    conditionId: opts.conditionId,
    requireCleanGit: opts.requireCleanGit,
    allowArtifactOverwrite: opts.allowArtifactOverwrite,
    costEstimate: {
      available: estimatedTotal !== null,
      currency: "USD",
      estimatedTotalUsd: estimatedTotal,
      assumedPromptTokensPerRequest: COST_CALIBRATION_PROMPT_TOKENS,
      assumedCompletionTokensPerRequest: assumedCompletionTokens,
      maxTotalCostUsd: opts.maxTotalCostUsd ?? null,
      note: costNote,
    },
    dryRun: opts.dryRun,
    confirmCost: opts.confirmCost,
  };
}

/**
 * Paid-run gate: must fail before any network call when dry-run, missing confirm, or missing credentials.
 */
export function assertPaidRunAllowed(
  opts: CliOptions,
  env: NodeJS.ProcessEnv,
  candidates?: Candidate[],
): void {
  if (opts.dryRun || !opts.confirmCost) {
    throw new Error(
      "Paid run blocked: pass --confirm-cost (and not only --dry-run) after human approval. Default is dry-run with zero network calls.",
    );
  }
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    throw new Error("Paid run blocked: CI must never execute --confirm-cost model benchmarks.");
  }
  const missingCredentialSources = candidates
    ? [
        ...new Set(
          candidates
            .filter((candidate) => !candidateCredential(candidate, env))
            .map((candidate) =>
              candidate.endpoint === "openai_direct"
                ? "OPENAI_API_KEY"
                : "REQUESTY_API_KEY or OPENROUTER_API_KEY",
            ),
        ),
      ]
    : resolveApiKey(env)
      ? []
      : ["REQUESTY_API_KEY or OPENROUTER_API_KEY"];
  if (missingCredentialSources.length > 0) {
    throw new Error(
      `Paid run blocked: missing credentials from Infisical-injected source(s): ${missingCredentialSources.join(", ")}. No network call made.`,
    );
  }
}

export async function runBenchmark(
  argv: string[],
  deps: RunDeps = {},
): Promise<BenchmarkRunResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile =
    deps.writeFile ??
    ((p: string, data: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data, "utf8");
    });
  const fileExists =
    deps.fileExists ??
    (deps.writeFile ? (() => false) : existsSync);
  const writeFileExclusive =
    deps.writeFileExclusive ??
    (deps.writeFile
      ? ((path: string, data: string) => {
          if (fileExists(path)) return false;
          writeFile(path, data);
          return true;
        })
      : ((path: string, data: string) => {
          mkdirSync(dirname(path), { recursive: true });
          try {
            writeFileSync(path, data, { encoding: "utf8", flag: "wx" });
            return true;
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "EEXIST"
            ) {
              return false;
            }
            throw error;
          }
        }));
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const gitInfo = deps.gitInfo ?? (() => defaultGitInfo(cwd));

  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return { code: 2, rows: [], error: msg };
  }

  if (opts.help) {
    stdout(HELP_TEXT);
    return { code: 0, rows: [] };
  }

  const artifactTargets = resolveArtifactTargets(opts, cwd);
  const targetPaths = Object.values(artifactTargets);
  if (new Set(targetPaths).size !== targetPaths.length) {
    const msg =
      "Artifact targets must resolve to three distinct paths; refusing to run before network access.";
    stderr(msg);
    return { code: 2, rows: [], error: msg };
  }
  if (!opts.allowArtifactOverwrite) {
    const existingTargets = existingArtifactTargets(artifactTargets, fileExists);
    if (existingTargets.length > 0) {
      const msg =
        `Artifact target already exists; refusing to overwrite: ${existingTargets.join(", ")}. ` +
        "Choose fresh --out-raw/--out-report paths, or explicitly pass --allow-artifact-overwrite.";
      stderr(msg);
      return { code: 2, rows: [], error: msg };
    }
  }

  const baseUrl = opts.baseUrl ?? (env.RUNIR_LLM_BASE_URL
    ? env.RUNIR_LLM_BASE_URL.trim().replace(/\/+$/, "")
    : resolveLlmBaseUrl());

  let candidates: Candidate[];
  try {
    candidates = resolveCandidateMatrix(opts.models);
    assertLunaConfigsDistinct(candidates);
    assertGeminiConfigsDistinct(candidates);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return { code: 2, rows: [], error: msg };
  }

  const fixturesPath = resolveFixturesPath(opts.fixturesPath, cwd);
  let cases: BenchmarkCase[];
  let fixtureContent: string;
  try {
    // Hash the complete fixture artifact, not only the selected smoke subset.
    // Smoke/full mode is already represented separately in the run config.
    fixtureContent = readFile(fixturesPath);
    cases = selectCases(
      loadCorpus(fixturesPath, () => fixtureContent),
      opts.smoke,
      opts.caseIds,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return { code: 2, rows: [], error: msg };
  }

  const disclosure = buildDisclosure({ candidates, cases, opts, baseUrl, env });
  const fixtureContentHash = fixtureContentHashFor(fixtureContent);
  const promptTemplateHash = promptTemplateHashFor();
  const knownSecrets = candidates
    .map((candidate) => candidateCredential(candidate, env))
    .filter((value): value is string => Boolean(value));
  const disclosureText = formatPreflightDisclosure(disclosure);
  assertNoSecrets(disclosureText, knownSecrets);
  stdout(disclosureText);

  // Dry-run path: zero network
  if (opts.dryRun || !opts.confirmCost) {
    if (!opts.dryRun && !opts.confirmCost) {
      stderr("Refusing paid calls without --confirm-cost. Staying in dry-run.");
    }
    const git = gitInfo();
    const runId = `dry-${now().toISOString().replace(/[:.]/g, "-")}`;
    const sessionTs = now().toISOString();
    const prompt = productionCapturePrompt(sessionTs);
    const pHash = promptHashFor(prompt);
    const rows: ResultRow[] = [];

    // Emit synthetic dry-run provenance rows without calling the network
    for (const candidate of candidates) {
      const requestBaseUrl = candidateBaseUrl(candidate, baseUrl, env);
      const eff = buildEffectiveRequest({
        candidate,
        maxOutputTokens: opts.maxOutputTokens,
      });
      // Touch serialize to ensure body builds
      serializeRequestBody(eff, prompt, buildUserContent(cases[0]!.messages), candidate.extraRequestFields);
      for (const benchCase of cases) {
        for (let rep = 1; rep <= opts.repetitions; rep++) {
          rows.push({
            schemaVersion: BENCHMARK_SCHEMA_VERSION,
            runId,
            timestamp: now().toISOString(),
            git,
            caseId: benchCase.id,
            repetition: rep,
            candidateId: candidate.id,
            candidateLabel: candidate.label,
            modelId: candidate.modelId,
            gatewayBaseUrl: requestBaseUrl,
            promptHash: pHash,
            effectiveRequest: eff,
            responseParserVersion: RESPONSE_PARSER_VERSION,
            usage: {},
            latencyMs: 0,
            ttftMs: null,
            retryCount: 0,
            parse: {
              classification: "empty_content",
              schemaValid: false,
              facts: [],
              rawTextHead: "",
              parseError: "dry-run: no response",
            },
            quality: scoreExtraction(
              {
                classification: "empty_content",
                schemaValid: false,
                facts: [],
                rawTextHead: "",
              },
              benchCase,
            ),
            estimatedCostUsd: null,
            billedCostUsd: null,
            errorClass: "dry_run",
          });
        }
      }
    }

    const safeRows = redactSecrets(rows, knownSecrets);
    const manifest: RunManifest = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      runId,
      createdAt: now().toISOString(),
      git,
      conditionId: opts.conditionId,
      completion: {
        status: "complete",
        plannedRequestCount: disclosure.plannedRequestCount,
        completedRequestCount: safeRows.length,
        cumulativeCostUsd: 0,
      },
      artifactTargets,
      disclosure: redactSecrets(disclosure, knownSecrets),
      fixtureContentHash,
      promptTemplateHash,
      scoringContractVersion: SCORING_CONTRACT_VERSION,
      promptHash: pHash,
      fixturePath: fixturesPath,
      rowCount: safeRows.length,
    };
    const report = regenerateReportFromRaw(manifest, safeRows);
    try {
      writeArtifacts(
        opts,
        manifest,
        safeRows,
        report,
        writeFile,
        writeFileExclusive,
        fileExists,
        cwd,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stderr(msg);
      return { code: 6, disclosure, rows: safeRows, manifest, report, error: msg };
    }
    stdout(
      `Dry-run complete: plannedRequestCount=${disclosure.plannedRequestCount} rows=${safeRows.length} (zero network calls).`,
    );
    return { code: 0, disclosure, rows: safeRows, manifest, report };
  }

  // Paid path
  try {
    assertPaidRunAllowed(opts, env, candidates);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return { code: 3, disclosure, rows: [], error: msg };
  }

  const git = gitInfo();
  if (opts.requireCleanGit && git.dirty) {
    const msg =
      "Paid run blocked: --require-clean-git was set and the Git worktree is dirty. No network call made.";
    stderr(msg);
    return { code: 3, disclosure, rows: [], error: msg };
  }
  if (
    opts.maxTotalCostUsd !== undefined &&
    candidates.some((candidate) => capReserveCostUsd(candidate, opts.maxOutputTokens) === null)
  ) {
    const msg =
      "Paid run blocked: --max-total-cost-usd cannot be enforced because at least one candidate lacks price orientation. No network call made.";
    stderr(msg);
    return { code: 3, disclosure, rows: [], error: msg };
  }

  const runCreatedAt = now().toISOString();
  const runId = `paid-${runCreatedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const rows: ResultRow[] = [];
  const finishPaidRun = (args: {
    code: number;
    status: RunCompletion["status"];
    stopReason?: RunCompletion["stopReason"];
    error?: string;
  }): BenchmarkRunResult => {
    const safeRows = redactSecrets(rows, knownSecrets);
    const completion: RunCompletion = {
      status: args.status,
      plannedRequestCount: disclosure.plannedRequestCount,
      completedRequestCount: safeRows.length,
      cumulativeCostUsd: cumulativeCostUsd(safeRows),
      ...(args.stopReason ? { stopReason: args.stopReason } : {}),
    };
    const manifest: RunManifest = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      runId,
      createdAt: runCreatedAt,
      git,
      conditionId: opts.conditionId,
      completion,
      artifactTargets,
      disclosure: redactSecrets(disclosure, knownSecrets),
      fixtureContentHash,
      promptTemplateHash,
      scoringContractVersion: SCORING_CONTRACT_VERSION,
      promptHash: promptHashFor(productionCapturePrompt(runCreatedAt)),
      fixturePath: fixturesPath,
      rowCount: safeRows.length,
    };
    const report = regenerateReportFromRaw(manifest, safeRows);
    assertNoSecrets(report, knownSecrets);
    try {
      writeArtifacts(
        opts,
        manifest,
        safeRows,
        report,
        writeFile,
        writeFileExclusive,
        fileExists,
        cwd,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stderr(msg);
      return {
        code: 6,
        disclosure,
        rows: safeRows,
        manifest,
        report,
        error: msg,
      };
    }
    return {
      code: args.code,
      disclosure,
      rows: safeRows,
      manifest,
      report,
      ...(args.error ? { error: args.error } : {}),
    };
  };

  // Rotate candidate order per case
  const candidateOrder = [...candidates];

  for (const benchCase of cases) {
    // rotate
    candidateOrder.push(candidateOrder.shift()!);
    const sessionTs = benchCase.sessionTimestamp ?? now().toISOString();
    const prompt = productionCapturePrompt(sessionTs);
    const pHash = promptHashFor(prompt);
    const userContent = buildUserContent(benchCase.messages);

    for (const candidate of candidateOrder) {
      const eff = buildEffectiveRequest({
        candidate,
        maxOutputTokens: opts.maxOutputTokens,
      });
      const requestBaseUrl = candidateBaseUrl(candidate, baseUrl, env);
      const requestPath = candidateRequestPath(candidate);
      const apiKey = candidateCredential(candidate, env)!;
      for (let rep = 1; rep <= opts.repetitions; rep++) {
        const nextRequestEstimate = capReserveCostUsd(
          candidate,
          opts.maxOutputTokens,
        );
        const spent = cumulativeCostUsd(rows);
        if (
          opts.maxTotalCostUsd !== undefined &&
          nextRequestEstimate !== null &&
          spent + nextRequestEstimate > opts.maxTotalCostUsd
        ) {
          const msg =
            `Cost cap stop before request ${rows.length + 1}: cumulative billed/estimated ` +
            `$${spent.toFixed(6)} + reserved next-request ceiling ` +
            `$${nextRequestEstimate.toFixed(6)} would exceed ` +
            `--max-total-cost-usd $${opts.maxTotalCostUsd.toFixed(6)}.`;
          stderr(msg);
          const result = finishPaidRun({
            code: 5,
            status: "partial",
            stopReason: "cost_cap",
            error: msg,
          });
          stdout(
            `Paid run stopped safely: rows=${result.rows.length} cumulativeCostUsd=${result.manifest!.completion!.cumulativeCostUsd.toFixed(6)}`,
          );
          return result;
        }

        const body = serializeRequestBody(eff, prompt, userContent, candidate.extraRequestFields);
        const started = Date.now();
        let httpStatus: number | undefined;
        let errorClass: string | undefined;
        let requestId: string | undefined;
        let usage: UsageCounters = {};
        let rawContent = "";
        let billedCostUsd: number | null = null;
        let fatalStop:
          | {
              reason: Exclude<RunCompletion["stopReason"], "cost_cap" | undefined>;
              message: string;
            }
          | undefined;

        try {
          const res = await fetchImpl(`${requestBaseUrl}${requestPath}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(opts.timeoutMs),
          });
          httpStatus = res.status;
          requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined;
          if (!res.ok) {
            errorClass = `http_${res.status}`;
            const errText = await res.text().catch(() => "");
            rawContent = errText.slice(0, 500);
            // Stop on auth / unsupported model
            if (res.status === 401 || res.status === 403) {
              fatalStop = {
                reason: "auth_failure",
                message: `Authentication failed (${res.status}). Stopping paid run.`,
              };
            } else if (res.status === 404 || res.status === 400 || res.status === 422) {
              fatalStop = {
                reason: "model_rejected",
                message: `Model/parameter rejected for ${candidate.modelId} (${res.status}): ${errText.slice(0, 200)}`,
              };
            } else {
              fatalStop = {
                reason: "http_error",
                message: `Gateway HTTP ${res.status} for ${candidate.modelId}. Stopping paid run.`,
              };
            }
          } else {
            const data = (await res.json()) as Record<string, unknown> & {
              choices?: Array<{ message?: { content?: unknown } }>;
              usage?: RawUsage;
              status?: unknown;
              id?: unknown;
              error?: { message?: unknown } | null;
            };
            if (candidate.apiStyle === "responses") {
              rawContent = responseOutputText(data);
              if (!requestId && typeof data.id === "string") requestId = data.id;
              if (data.status !== undefined && data.status !== "completed") {
                errorClass = `response_${String(data.status)}`;
                const upstreamMessage =
                  data.error &&
                  typeof data.error === "object" &&
                  typeof data.error.message === "string"
                    ? `: ${data.error.message.slice(0, 200)}`
                    : "";
                fatalStop = {
                  reason: "http_error",
                  message:
                    `Responses API returned status ${String(data.status)} for ` +
                    `${candidate.modelId}${upstreamMessage}. Stopping paid run.`,
                };
              }
            } else {
              const content = data.choices?.[0]?.message?.content;
              rawContent = typeof content === "string" ? content : "";
            }
            const normalizedUsage = normalizeUsage(data.usage);
            usage = normalizedUsage.usage;
            billedCostUsd = normalizedUsage.billedCostUsd;
            if (normalizedUsage.invalidField) {
              errorClass = "invalid_usage";
              fatalStop = {
                reason: "invalid_usage",
                message:
                  `Gateway returned invalid usage field ${normalizedUsage.invalidField} ` +
                  `for ${candidate.modelId}. Stopping paid run.`,
              };
            }
          }
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          if (name === "TimeoutError" || name === "AbortError") {
            errorClass = "timeout";
            fatalStop = {
              reason: "timeout",
              message: `Request timed out for ${candidate.modelId}. Stopping paid run.`,
            };
          } else {
            errorClass = "network";
            rawContent = err instanceof Error ? err.message : String(err);
            fatalStop = {
              reason: "network_error",
              message: `Network failure for ${candidate.modelId}. Stopping paid run.`,
            };
          }
        }

        const latencyMs = Date.now() - started;
        const parsed = parseExtractionResponse(rawContent);
        const quality = scoreExtraction(parsed, benchCase);
        const usageEstimatedCostUsd = estimateCostUsd({
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          price: candidate.pricePer1M
            ? { input: candidate.pricePer1M.input, output: candidate.pricePer1M.output }
            : undefined,
        });
        const estimatedCostUsd =
          usageEstimatedCostUsd ??
          calibratedPlanningCostUsd(candidate, opts.maxOutputTokens);
        if (!fatalStop && !parsed.schemaValid) {
          errorClass = "schema_invalid";
          fatalStop = {
            reason: "schema_invalid",
            message: `Schema-invalid response from ${candidate.modelId}. Stopping paid run.`,
          };
        }

        rows.push({
          schemaVersion: BENCHMARK_SCHEMA_VERSION,
          runId,
          timestamp: now().toISOString(),
          git,
          caseId: benchCase.id,
          repetition: rep,
          candidateId: candidate.id,
          candidateLabel: candidate.label,
          modelId: candidate.modelId,
          gatewayBaseUrl: requestBaseUrl,
          promptHash: pHash,
          effectiveRequest: eff,
          responseParserVersion: RESPONSE_PARSER_VERSION,
          usage,
          latencyMs,
          ttftMs: null,
          httpStatus,
          retryCount: 0,
          errorClass,
          requestId,
          parse: {
            ...parsed,
            // never store full secrets; head only
            rawTextHead: parsed.rawTextHead,
          },
          quality,
          estimatedCostUsd,
          billedCostUsd,
        });

        const spentAfterResponse = cumulativeCostUsd(rows);
        if (
          opts.maxTotalCostUsd !== undefined &&
          spentAfterResponse > opts.maxTotalCostUsd
        ) {
          const msg =
            `Cost cap exceeded by the completed response: cumulative billed/estimated ` +
            `$${spentAfterResponse.toFixed(6)} is above --max-total-cost-usd ` +
            `$${opts.maxTotalCostUsd.toFixed(6)}. No further requests will be sent.`;
          stderr(msg);
          return finishPaidRun({
            code: 5,
            status: "partial",
            stopReason: "cost_cap",
            error: msg,
          });
        }

        if (!opts.allowArtifactOverwrite) {
          const collided = existingArtifactTargets(artifactTargets, fileExists);
          if (collided.length > 0) {
            const msg =
              `Artifact target appeared during the paid run; stopping before another request: ` +
              `${collided.join(", ")}. Existing bytes will not be overwritten.`;
            stderr(msg);
            return finishPaidRun({
              code: 6,
              status: "partial",
              stopReason: "artifact_collision",
              error: msg,
            });
          }
        }

        if (fatalStop) {
          stderr(fatalStop.message);
          const result = finishPaidRun({
            code: 4,
            status: "partial",
            stopReason: fatalStop.reason,
            error: fatalStop.message,
          });
          stdout(`Paid run stopped after preserving partial artifacts: rows=${result.rows.length}`);
          return result;
        }
      }
    }
  }

  const result = finishPaidRun({ code: 0, status: "complete" });
  stdout(
    `Paid run complete: rows=${result.rows.length} cumulativeCostUsd=${result.manifest!.completion!.cumulativeCostUsd.toFixed(6)}`,
  );
  return result;
}

function writeArtifacts(
  opts: CliOptions,
  manifest: RunManifest,
  rows: ResultRow[],
  report: string,
  writeFile: (path: string, data: string) => void,
  writeFileExclusive: (path: string, data: string) => boolean,
  fileExists: (path: string) => boolean,
  cwd: string,
): void {
  const { rawPath, reportPath, manifestPath } =
    manifest.artifactTargets ?? resolveArtifactTargets(opts, cwd);
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const writes: Array<[string, string]> = [
    [rawPath, jsonl],
    [manifestPath, JSON.stringify(manifest, null, 2) + "\n"],
    [reportPath, report],
  ];
  if (opts.allowArtifactOverwrite) {
    for (const [path, data] of writes) writeFile(path, data);
    return;
  }
  const existing = existingArtifactTargets({ rawPath, manifestPath, reportPath }, fileExists);
  if (existing.length > 0) {
    throw new Error(
      `Artifact collision at final write; existing bytes were not overwritten: ${existing.join(", ")}`,
    );
  }
  for (const [path, data] of writes) {
    if (!writeFileExclusive(path, data)) {
      throw new Error(
        `Artifact collision at exclusive write; existing bytes were not overwritten: ${path}`,
      );
    }
  }
}

function resolveArtifactTargets(opts: CliOptions, cwd: string): RunArtifactTargets {
  const rawPath = opts.outRaw.startsWith("/") ? opts.outRaw : join(cwd, opts.outRaw);
  const reportPath = opts.outReport.startsWith("/") ? opts.outReport : join(cwd, opts.outReport);
  const manifestPath = rawPath.endsWith(".jsonl")
    ? rawPath.replace(/\.jsonl$/, ".manifest.json")
    : `${rawPath}.manifest.json`;
  return { rawPath, manifestPath, reportPath };
}

function existingArtifactTargets(
  targets: RunArtifactTargets,
  fileExists: (path: string) => boolean,
): string[] {
  return Object.values(targets).filter((path) => fileExists(path));
}

export { parseArgs, HELP_TEXT };
