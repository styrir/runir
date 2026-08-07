import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { CliOptions } from "./types.js";

const DEFAULT_FIXTURES = "fixtures/model-benchmark/corpus.json";

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    models: ["default"],
    fixturesPath: DEFAULT_FIXTURES,
    repetitions: 1,
    concurrency: 1,
    timeoutMs: 60_000,
    maxOutputTokens: 8192,
    requireCleanGit: false,
    allowArtifactOverwrite: false,
    dryRun: true,
    confirmCost: false,
    smoke: false,
    outRaw: "docs/analysis/raw/model-benchmark-latest.jsonl",
    outReport: "docs/analysis/model-benchmark-latest.md",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value after ${a}`);
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--models":
        opts.models = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--fixtures":
        opts.fixturesPath = next();
        break;
      case "--case-ids":
        opts.caseIds = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (opts.caseIds.length === 0) {
          throw new Error("--case-ids must contain at least one case id");
        }
        break;
      case "--repetitions":
        opts.repetitions = positiveInt(next(), "--repetitions");
        break;
      case "--concurrency":
        opts.concurrency = positiveInt(next(), "--concurrency");
        break;
      case "--timeout-ms":
        opts.timeoutMs = positiveInt(next(), "--timeout-ms");
        break;
      case "--max-output-tokens":
        opts.maxOutputTokens = positiveInt(next(), "--max-output-tokens");
        break;
      case "--condition-id":
        opts.conditionId = conditionId(next());
        break;
      case "--max-total-cost-usd":
        opts.maxTotalCostUsd = positiveNumber(next(), "--max-total-cost-usd");
        break;
      case "--require-clean-git":
        opts.requireCleanGit = true;
        break;
      case "--allow-artifact-overwrite":
        opts.allowArtifactOverwrite = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--confirm-cost":
        opts.confirmCost = true;
        opts.dryRun = false;
        break;
      case "--smoke":
        opts.smoke = true;
        break;
      case "--out-raw":
        opts.outRaw = next();
        break;
      case "--out-report":
        opts.outReport = next();
        break;
      case "--base-url":
        opts.baseUrl = next().replace(/\/+$/, "");
        break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
        throw new Error(`Unexpected argument: ${a}`);
    }
  }
  if (opts.smoke && opts.caseIds) {
    throw new Error("--smoke and --case-ids are mutually exclusive");
  }
  return opts;
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

function positiveNumber(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive finite number`);
  }
  return n;
}

function conditionId(raw: string): string {
  const value = raw.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(
      "--condition-id must be 1-64 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return value;
}

export function resolveFixturesPath(p: string, cwd = process.cwd()): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export const HELP_TEXT = `Rúnir extraction model benchmark

Usage:
  npx tsx scripts/model-benchmark-extraction.ts [options]

Options:
  --models <ids>           Comma-separated candidate ids/model ids, or presets:
                           default|primary = 3.1 Flash-Lite, 3.5 Flash-Lite, Luna low, Grok 4.5 low
                           flash-lite      = 3.1 vs 3.5 Flash-Lite only
                           extended|all    = primary + Luna none + Grok high
                           Requesty Chat candidate: luna-high-requesty
                           direct Responses candidates: luna-low-responses,luna-max
  --fixtures <path>        Gold corpus JSON (default: fixtures/model-benchmark/corpus.json)
  --case-ids <ids>         Comma-separated case ids from the corpus
  --repetitions <n>        Repetitions per candidate/case (default: 1)
  --concurrency <n>        Max in-flight paid requests (default: 1)
  --timeout-ms <n>         Per-request timeout (default: 60000)
  --max-output-tokens <n>  max_tokens/max_output_tokens (default: 8192)
  --condition-id <id>      Stable run condition identity (for example: reference-a)
  --max-total-cost-usd <n> Stop before the next request would cross this runtime cap
  --require-clean-git      Block paid calls unless the worktree is clean
  --allow-artifact-overwrite
                           Permit replacing existing output targets (default: fail closed)
  --dry-run                Default: no network, print preflight disclosure
  --confirm-cost           Required for paid network calls
  --smoke                  Use the 3 smoke cases only (exclusive with --case-ids)
  --out-raw <path>         JSONL + manifest output prefix (.jsonl)
  --out-report <path>      Markdown report path
  --base-url <url>         Override gateway base URL (no credentials)
  --help                   Show help

Configured-gateway runs require REQUESTY_API_KEY or OPENROUTER_API_KEY.
Direct OpenAI Responses candidates require OPENAI_API_KEY.
Inject credentials through the approved secret manager; never put them on the command line.
Never print secret values. CI must not pass --confirm-cost.
`;
