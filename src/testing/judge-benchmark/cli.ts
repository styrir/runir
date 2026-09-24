import { SPLITS } from "./schema.js";
import type { JudgeSplit } from "./types.js";

export type JudgeBenchmarkOptions = {
  command: "run" | "calibrate" | "score" | "hydrate" | "help";
  datasetId: string;
  candidateId: string;
  probe: "none" | "order-swap";
  confirmCost: boolean;
  dryRun: boolean;
  replayOnly: boolean;
  maxTotalCostUsd: number | null;
  allowOverwrite: boolean;
  requireCleanGit: boolean;
  unlockTest: boolean;
  split: JudgeSplit | null;
  concurrency: number;
  labelsPath: string | null;
  textsPath: string | null;
  cassettePath: string | null;
  rowsPath: string | null;
  thresholdsPath: string | null;
  thresholdsOut: string | null;
  outRaw: string | null;
  outReport: string | null;
  help: boolean;
};

export function judgeBenchmarkUsage(): string {
  return `Rúnir judge benchmark

Default run is a zero-network preflight. Paid execution requires:
  --confirm-cost
  --max-total-cost-usd <usd>
  a clean Git worktree (unless --allow-dirty)
  REQUESTY_API_KEY in the environment (the value is never logged)

Commands:
  run        Score a candidate against a dataset
  calibrate  Fit the retire threshold on the calibration split
  score      Score a rows file, re-applying a thresholds file
  hydrate    Rebuild the text snapshot from SurrealDB by exact id

Options:
  --dataset <id>                 fixtures/judge-benchmark/<id>.labels.json
  --candidate <id>               judge-v2 | judge-v3 | jev-noul-v1 | jev-choice-v1 | jev-noul-v2 | jev-noul-v3
  --probe order-swap             Re-ask gold-supersede pairs with OLD and NEW swapped
  --split <split>                calibration | test | insample | heldout. Omit to exclude test rows.
  --confirm-cost                 Enable network execution
  --max-total-cost-usd <usd>     Hard cap. Each call reserves worst-case cost, including retries.
  --replay-only                  Re-score from the cassette; miss fails loudly
  --unlock-test                  Required, with a thresholds file, for --split test
  --thresholds <path>            Frozen thresholds.json
  --thresholds-out <path>        Where calibrate writes thresholds.json
  --rows <path>                  Raw JSONL to calibrate or score
  --labels <path>                Labels file override
  --texts <path>                 Text snapshot override
  --cassette <path>              Cassette override
  --concurrency <n>              Default 1 (Requesty returns 429s under concurrency)
  --out-raw <path>               JSONL output; the manifest is paired automatically
  --out-report <path>            Markdown report
  --allow-overwrite              Replace existing artifacts
  --allow-dirty                  Permit a dirty source tree for a paid run
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

export function parseJudgeBenchmarkArgs(argv: readonly string[]): JudgeBenchmarkOptions {
  const options: JudgeBenchmarkOptions = {
    command: "help",
    datasetId: "",
    candidateId: "",
    probe: "none",
    confirmCost: false,
    dryRun: true,
    replayOnly: false,
    maxTotalCostUsd: null,
    allowOverwrite: false,
    requireCleanGit: true,
    unlockTest: false,
    split: null,
    concurrency: 1,
    labelsPath: null,
    textsPath: null,
    cassettePath: null,
    rowsPath: null,
    thresholdsPath: null,
    thresholdsOut: null,
    outRaw: null,
    outReport: null,
    help: false,
  };
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--confirm-cost") {
      options.confirmCost = true;
      options.dryRun = false;
    } else if (flag === "--replay-only") options.replayOnly = true;
    else if (flag === "--allow-overwrite") options.allowOverwrite = true;
    else if (flag === "--allow-dirty") options.requireCleanGit = false;
    else if (flag === "--unlock-test") options.unlockTest = true;
    else if (flag === "--dataset") options.datasetId = next(index++, flag);
    else if (flag === "--candidate") options.candidateId = next(index++, flag);
    else if (flag === "--probe") {
      const value = next(index++, flag);
      if (value !== "order-swap") throw new Error("--probe must be order-swap");
      options.probe = "order-swap";
    } else if (flag === "--split") {
      const value = next(index++, flag);
      if (!(SPLITS as readonly string[]).includes(value)) throw new Error("--split must be calibration, test, insample, or heldout");
      options.split = value as JudgeSplit;
    } else if (flag === "--concurrency") options.concurrency = positiveInteger(next(index++, flag), flag);
    else if (flag === "--max-total-cost-usd") options.maxTotalCostUsd = nonNegativeNumber(next(index++, flag), flag);
    else if (flag === "--labels") options.labelsPath = next(index++, flag);
    else if (flag === "--texts") options.textsPath = next(index++, flag);
    else if (flag === "--cassette") options.cassettePath = next(index++, flag);
    else if (flag === "--rows") options.rowsPath = next(index++, flag);
    else if (flag === "--thresholds") options.thresholdsPath = next(index++, flag);
    else if (flag === "--thresholds-out") options.thresholdsOut = next(index++, flag);
    else if (flag === "--out-raw") options.outRaw = next(index++, flag);
    else if (flag === "--out-report") options.outReport = next(index++, flag);
    else if (flag.startsWith("--")) throw new Error(`Unknown option: ${flag}`);
    else positional.push(flag);
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);
  const command = positional[0];
  if (!command || options.help) {
    options.command = "help";
    options.help = true;
    return options;
  }
  if (command !== "run" && command !== "calibrate" && command !== "score" && command !== "hydrate") {
    throw new Error(`Unknown command: ${command}`);
  }
  options.command = command;
  return options;
}
