import { resolveThinkModel } from "../../recall/orchestrator/think-synthesis.js";

export type ThinkBenchmarkOptions = {
  fixturesPath: string;
  retrievalFixturesPath: string;
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

const DEFAULT_FIXTURES = "fixtures/think-benchmark/corpus.json";
const DEFAULT_RETRIEVAL_FIXTURES = "fixtures/think-benchmark/retrieval-corpus.json";
const DEFAULT_RAW = ".styrir/analysis/raw/think-benchmark-latest.jsonl";
const DEFAULT_REPORT = ".styrir/analysis/reports/think-benchmark-latest.md";

export function thinkBenchmarkUsage(): string {
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
  --retrieval-fixtures <path>    Frozen e2e seed and retrieval gold
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
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

export function parseThinkBenchmarkArgs(argv: readonly string[]): ThinkBenchmarkOptions {
  const options: ThinkBenchmarkOptions = {
    fixturesPath: DEFAULT_FIXTURES,
    retrievalFixturesPath: DEFAULT_RETRIEVAL_FIXTURES,
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
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
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
    else if (flag === "--retrieval-fixtures") options.retrievalFixturesPath = next(index++, flag);
    else if (flag === "--suite") {
      const value = next(index++, flag);
      if (value !== "synthesis" && value !== "e2e") {
        throw new Error("--suite must be synthesis or e2e");
      }
      options.suiteId = value === "e2e" ? "runir-think-e2e" : "runir-think-synthesis";
    } else if (flag === "--service-url") options.serviceUrl = next(index++, flag).replace(/\/+$/u, "");
    else if (flag === "--user-id") options.userId = next(index++, flag);
    else if (flag === "--model") options.modelId = next(index++, flag);
    else if (flag === "--candidate-id") options.candidateId = next(index++, flag);
    else if (flag === "--candidate-label") options.candidateLabel = next(index++, flag);
    else if (flag === "--repetitions") options.repetitions = positiveInteger(next(index++, flag), flag);
    else if (flag === "--timeout-ms") options.timeoutMs = positiveInteger(next(index++, flag), flag);
    else if (flag === "--max-output-tokens") options.maxOutputTokens = positiveInteger(next(index++, flag), flag);
    else if (flag === "--out-raw") options.outRaw = next(index++, flag);
    else if (flag === "--out-report") options.outReport = next(index++, flag);
    else if (flag === "--max-total-cost-usd") {
      options.maxTotalCostUsd = nonNegativeNumber(next(index++, flag), flag);
    } else if (flag === "--input-usd-per-1m") {
      options.inputUsdPer1M = nonNegativeNumber(next(index++, flag), flag);
    } else if (flag === "--output-usd-per-1m") {
      options.outputUsdPer1M = nonNegativeNumber(next(index++, flag), flag);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}
