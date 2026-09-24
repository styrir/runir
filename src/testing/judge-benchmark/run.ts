import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { candidateById, isCandidateId, type FrozenCandidate } from "./candidates.js";
import { readThresholds, sealThresholds, fitRetireThreshold } from "./calibrate.js";
import { CassetteMissError } from "./cassette.js";
import { parseJudgeBenchmarkArgs, judgeBenchmarkUsage, type JudgeBenchmarkOptions } from "./cli.js";
import {
  createSurrealTextClient,
  fixtureContentHash,
  hydrateLabels,
  loadDataset,
  parseLabelsJson,
  parseSnapshot,
  serializeSnapshot,
  textSnapshotHash,
} from "./dataset.js";
import { executeCalls, type ExecuteDeps, type JudgeFactory } from "./execute.js";
import { cassettePathFor, labelsPathFor, ledgerPath, manifestPathFor, rawPathFor, reportPathFor, textsPathFor, thresholdsPathFor } from "./paths.js";
import { buildPreflight, formatPreflightLine } from "./preflight.js";
import { renderJudgeReport } from "./report.js";
import { rescoreRow, scoreJudgeRows, type ScoreMode } from "./score.js";
import { guardTestSplit, unlockLedgerLine, type TestGuardResult } from "./test-lock.js";
import {
  JUDGE_BENCHMARK_SCHEMA_VERSION,
  JUDGE_SCORING_CONTRACT_VERSION,
  JUDGE_TASK_ID,
  type JudgeBenchmarkRow,
  type JudgeCommandResult,
  type JudgeLabelsFile,
  type JudgeRunManifest,
  type LoadedPair,
  type PreflightDisclosure,
  type SnapshotLine,
  type ThresholdsFile,
} from "./types.js";

export type JudgeRunDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
  appendFile?: (path: string, data: string) => void;
  fileExists?: (path: string) => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  git?: () => { sha: string; dirty: boolean };
  judgeFor?: JudgeFactory;
  randomId?: () => string;
};

type CommandCtx = {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log: (line: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  appendFile: (path: string, data: string) => void;
  fileExists: (path: string) => boolean;
  abs: (path: string) => string;
  git: () => { sha: string; dirty: boolean };
  deps: JudgeRunDeps;
  options: JudgeBenchmarkOptions;
  dataset: JudgeLabelsFile;
  candidate: FrozenCandidate;
  loaded: LoadedPair[];
  snapshot: ReadonlyMap<string, SnapshotLine> | null;
};

function gitInfo(cwd: string): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

function readRows(text: string): JudgeBenchmarkRow[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as JudgeBenchmarkRow);
}

function scoreRowMatchesDataset(
  row: JudgeBenchmarkRow,
  datasetId: string,
  thresholds: ThresholdsFile | null,
): boolean {
  if (row.datasetId !== datasetId) return false;
  if (thresholds !== null && row.datasetId !== thresholds.datasetId) return false;
  return true;
}

function scoreModeFor(dataset: JudgeLabelsFile, split: string | null, rows: readonly JudgeBenchmarkRow[]): ScoreMode {
  if (dataset.legacyBinaryGold) return "legacy";
  if (split === "test" && rows.some((row) => row.population === "probability")) return "gated";
  return "descriptive";
}

function manifestDisclosure(disclosure: PreflightDisclosure): JudgeRunManifest["disclosure"] {
  const {
    schemaVersion: _schemaVersion,
    command: _command,
    datasetId: _datasetId,
    git: _git,
    fixtureContentHash: _fixtureContentHash,
    textSnapshotHash: _textSnapshotHash,
    networkCalls: _networkCalls,
    testRowsExcluded: _testRowsExcluded,
    testSplitNote: _testSplitNote,
    ...rest
  } = disclosure;
  return rest;
}

function appendUnlock(ctx: CommandCtx, guard: TestGuardResult): void {
  if (!guard.ok || guard.access !== "unlocked") return;
  ctx.appendFile(ctx.abs(ledgerPath()), unlockLedgerLine({
    at: ctx.now().toISOString(),
    datasetId: ctx.dataset.datasetId,
    candidateId: ctx.candidate.id,
    candidateConfigHash: ctx.candidate.candidateConfigHash,
    thresholds: guard.thresholds,
  }));
}

function selectSplit<T>(
  items: readonly T[],
  splitOf: (item: T) => string,
  access: "exclude-test" | "named-split" | "unlocked",
  split: string | null,
  note: string,
): { selected: T[]; excludedTestRows: number; note: string } {
  if (access === "exclude-test") {
    const excludedTestRows = items.filter((item) => splitOf(item) === "test").length;
    return {
      selected: items.filter((item) => splitOf(item) !== "test"),
      excludedTestRows,
      note: `${note} Excluded test rows: ${excludedTestRows}.`,
    };
  }
  return {
    selected: split ? items.filter((item) => splitOf(item) === split) : [...items],
    excludedTestRows: 0,
    note,
  };
}

export async function runJudgeBenchmark(
  argv: readonly string[],
  deps: JudgeRunDeps = {},
): Promise<JudgeCommandResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let options: JudgeBenchmarkOptions;
  try {
    options = parseJudgeBenchmarkArgs(argv);
  } catch (error) {
    return { code: 2, error: error instanceof Error ? error.message : String(error) };
  }
  if (options.help || options.command === "help") {
    log(judgeBenchmarkUsage());
    return { code: 0 };
  }
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile = deps.writeFile ?? ((path: string, data: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, "utf8");
  });
  const appendFile = deps.appendFile ?? ((path: string, data: string) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, data, "utf8");
  });
  const fileExists = deps.fileExists ?? existsSync;
  const abs = (path: string) => resolve(cwd, path);
  let gitSnapshot: { sha: string; dirty: boolean } | undefined;
  const git = (): { sha: string; dirty: boolean } => {
    if (!gitSnapshot) gitSnapshot = deps.git?.() ?? gitInfo(cwd);
    return gitSnapshot;
  };

  if (!options.datasetId) return { code: 2, error: "--dataset is required" };
  const needsCandidate = options.command !== "hydrate";
  if (needsCandidate && !options.candidateId) return { code: 2, error: "--candidate is required" };
  if (needsCandidate && !isCandidateId(options.candidateId)) {
    return { code: 2, error: `Unknown judge-benchmark candidate: ${options.candidateId}` };
  }
  const candidate = needsCandidate ? candidateById(options.candidateId) : null;

  let dataset: JudgeLabelsFile;
  try {
    dataset = parseLabelsJson(readFile(abs(options.labelsPath ?? labelsPathFor(options.datasetId))));
  } catch (error) {
    return { code: 3, error: `Labels validation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (dataset.datasetId !== options.datasetId) {
    return { code: 3, error: `Labels datasetId ${dataset.datasetId} does not match --dataset ${options.datasetId}` };
  }
  const textsPath = abs(options.textsPath ?? textsPathFor(dataset.datasetId));
  const snapshotText = fileExists(textsPath) ? readFile(textsPath) : null;
  let snapshot: Map<string, SnapshotLine> | null = null;
  let loaded: LoadedPair[];
  try {
    snapshot = snapshotText === null ? null : parseSnapshot(snapshotText);
    loaded = loadDataset(dataset, snapshot);
  } catch (error) {
    return { code: 3, error: `Snapshot validation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (options.command === "hydrate") return hydrate(dataset, textsPath, snapshot, writeFile, log, deps);
  if (!candidate) return { code: 2, error: "--candidate is required" };
  const ctx: CommandCtx = {
    env,
    now,
    log,
    readFile,
    writeFile,
    appendFile,
    fileExists,
    abs,
    git,
    deps,
    options,
    dataset,
    candidate,
    loaded,
    snapshot,
  };
  if (options.command === "calibrate") return calibrate(ctx);
  if (options.command === "score") return score(ctx);
  return runCommand(ctx);
}

function hydrate(
  dataset: JudgeLabelsFile,
  textsPath: string,
  snapshot: ReadonlyMap<string, SnapshotLine> | null,
  writeFile: (path: string, data: string) => void,
  log: (line: string) => void,
  deps: JudgeRunDeps,
): Promise<JudgeCommandResult> {
  const existing = snapshot ?? new Map();
  const client = deps.fetchImpl
    ? createSurrealTextClient({ fetchImpl: deps.fetchImpl })
    : createSurrealTextClient();
  return hydrateLabels({
    dataset,
    existing,
    readText: (source, id) => client.read(source, id),
  }).then((result) => {
    writeFile(textsPath, serializeSnapshot(result.lines));
    log(JSON.stringify({
      datasetId: dataset.datasetId,
      wrote: result.lines.length,
      drift: result.drift,
      missing: result.missing,
      unhydratable: result.unhydratable,
    }, null, 2));
    const drift = result.drift.length + result.missing.length + result.unhydratable.length;
    return { code: drift ? 3 : 0 };
  }).catch((error: unknown) => ({
    code: 3,
    error: `Hydrate failed: ${error instanceof Error ? error.message : String(error)}`,
  }));
}

function readSealedThresholds(ctx: CommandCtx): { thresholds: ThresholdsFile | null } | { error: JudgeCommandResult } {
  const { options, candidate } = ctx;
  if (!options.thresholdsPath) return { thresholds: null };
  const path = ctx.abs(options.thresholdsPath);
  if (!ctx.fileExists(path)) {
    return { error: { code: 4, error: `${options.command} refused: thresholds file does not exist` } };
  }
  try {
    const thresholds = readThresholds(JSON.parse(ctx.readFile(path)) as unknown);
    if (thresholds.candidateId !== candidate.id || thresholds.candidateConfigHash !== candidate.candidateConfigHash) {
      return { error: { code: 3, error: "thresholds file does not match this candidate config" } };
    }
    return { thresholds };
  } catch (error) {
    return {
      error: { code: 3, error: `Thresholds invalid: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}

function calibrate(ctx: CommandCtx): JudgeCommandResult {
  const { options, dataset, candidate } = ctx;
  const guard = guardTestSplit({
    command: "calibrate",
    split: options.split,
    unlockTest: options.unlockTest,
    thresholds: null,
    datasetId: dataset.datasetId,
    candidateId: candidate.id,
    candidateConfigHash: candidate.candidateConfigHash,
  });
  if (!guard.ok) return { code: 2, error: guard.message };
  if (options.split !== "calibration") {
    return { code: 2, error: "calibrate requires --split calibration" };
  }
  if (!options.rowsPath) return { code: 2, error: "calibrate requires --rows" };
  let rows: JudgeBenchmarkRow[];
  try {
    rows = readRows(ctx.readFile(ctx.abs(options.rowsPath))).filter((row) =>
      row.split === "calibration" && row.candidateId === candidate.id && row.population === "probability",
    );
  } catch (error) {
    return { code: 3, error: `Rows unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  // The sealed thresholds claim this dataset and candidate config; rows from
  // another dataset or an older config of the same candidate must not feed them.
  const foreign = rows.find(
    (row) => row.datasetId !== dataset.datasetId || row.candidateConfigHash !== candidate.candidateConfigHash,
  );
  if (foreign) {
    return {
      code: 3,
      error: `calibration row ${foreign.pairId} is from dataset ${foreign.datasetId} / config ${foreign.candidateConfigHash}, not ${dataset.datasetId} / ${candidate.candidateConfigHash}`,
    };
  }
  if (rows.length === 0) return { code: 3, error: "no probability-sample calibration rows for this candidate" };
  const fit = fitRetireThreshold({ rows, candidate });
  const sealed = sealThresholds({ datasetId: dataset.datasetId, candidate, split: "calibration", fit });
  const target = ctx.abs(options.thresholdsOut ?? thresholdsPathFor(dataset.datasetId, candidate.id));
  if (!options.allowOverwrite && ctx.fileExists(target)) {
    return { code: 5, error: "Thresholds target exists; use --allow-overwrite or choose a new path" };
  }
  ctx.writeFile(target, `${JSON.stringify(sealed, null, 2)}\n`);
  ctx.log(JSON.stringify({ thresholds: target, ...fit }, null, 2));
  return { code: 0 };
}

function score(ctx: CommandCtx): JudgeCommandResult {
  const { options, dataset, candidate } = ctx;
  const prepared = readSealedThresholds(ctx);
  if ("error" in prepared) return prepared.error;
  const thresholds = prepared.thresholds;
  const guard = guardTestSplit({
    command: "score",
    split: options.split,
    unlockTest: options.unlockTest,
    thresholds,
    datasetId: dataset.datasetId,
    candidateId: candidate.id,
    candidateConfigHash: candidate.candidateConfigHash,
  });
  if (!guard.ok) return { code: 4, error: guard.message };
  if (!options.rowsPath) return { code: 2, error: "score requires --rows" };
  let rows: JudgeBenchmarkRow[];
  try {
    rows = readRows(ctx.readFile(ctx.abs(options.rowsPath)));
  } catch (error) {
    return { code: 3, error: `Rows unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const threshold = thresholds?.threshold ?? candidate.defaultThreshold;
  const selection = selectSplit(
    rows.filter((row) => row.candidateId === candidate.id),
    (row) => row.split,
    guard.access,
    options.split,
    guard.note,
  );
  const mismatch = selection.selected.find((row) => !scoreRowMatchesDataset(row, dataset.datasetId, thresholds));
  if (mismatch) {
    const shown = typeof mismatch.datasetId === "string" && mismatch.datasetId.length > 0
      ? mismatch.datasetId
      : "missing";
    const required = thresholds
      ? `--dataset ${dataset.datasetId} and thresholds datasetId ${thresholds.datasetId}`
      : `--dataset ${dataset.datasetId}`;
    return { code: 4, error: `score refused: row ${mismatch.pairId} datasetId ${shown} must equal ${required}` };
  }
  appendUnlock(ctx, guard);
  const filtered = selection.selected.map((row) => rescoreRow(row, candidate, threshold));
  const report = renderJudgeReport({
    datasetId: dataset.datasetId,
    candidateId: candidate.id,
    manifest: null,
    score: scoreJudgeRows(filtered, scoreModeFor(dataset, options.split, filtered)),
    rows: filtered,
    note: selection.note,
  });
  if (options.outReport) ctx.writeFile(ctx.abs(options.outReport), report);
  ctx.log(selection.note);
  ctx.log(report);
  return { code: 0, report };
}

async function runCommand(ctx: CommandCtx): Promise<JudgeCommandResult> {
  const { options, dataset, candidate, loaded } = ctx;
  let thresholds: ThresholdsFile | null = null;
  if (options.split === "test") {
    const prepared = readSealedThresholds(ctx);
    if ("error" in prepared) return prepared.error;
    thresholds = prepared.thresholds;
  }
  const guard = guardTestSplit({
    command: "run",
    split: options.split,
    unlockTest: options.unlockTest,
    thresholds,
    datasetId: dataset.datasetId,
    candidateId: candidate.id,
    candidateConfigHash: candidate.candidateConfigHash,
  });
  if (!guard.ok) return { code: 4, error: guard.message };
  appendUnlock(ctx, guard);
  const selection = selectSplit(loaded, (item) => item.pair.split, guard.access, options.split, guard.note);
  const git = ctx.git();
  const runThreshold = thresholds?.threshold ?? candidate.defaultThreshold;
  const snapshotLines = ctx.snapshot ? [...ctx.snapshot.values()] : [];
  const disclosure = buildPreflight({
    datasetId: dataset.datasetId,
    candidate,
    pairs: selection.selected,
    probe: options.probe,
    concurrency: options.concurrency,
    maxTotalCostUsd: options.maxTotalCostUsd,
    git,
    fixtureContentHash: fixtureContentHash(dataset),
    textSnapshotHash: textSnapshotHash(snapshotLines),
    dryRun: options.replayOnly ? false : options.dryRun,
    replayOnly: options.replayOnly,
    testRowsExcluded: selection.excludedTestRows,
    testSplitNote: selection.note,
  });
  ctx.log(formatPreflightLine(disclosure));
  ctx.log(JSON.stringify(disclosure, null, 2));
  if (!options.confirmCost && !options.replayOnly) {
    return { code: 0, disclosure };
  }
  if (!options.replayOnly) {
    if (options.maxTotalCostUsd === null) {
      return { code: 4, error: "Paid run refused: --max-total-cost-usd is required" };
    }
    if (options.requireCleanGit && git.dirty) {
      return { code: 4, error: "Paid run refused: Git worktree is dirty" };
    }
    const apiKey = ctx.env.REQUESTY_API_KEY?.trim();
    if (!apiKey) return { code: 4, error: "Paid run refused: REQUESTY_API_KEY is unavailable" };
    if (disclosure.estimatedCostUsdUpper > options.maxTotalCostUsd) {
      return {
        code: 4,
        error: `Paid run refused: estimate $${disclosure.estimatedCostUsdUpper.toFixed(6)} exceeds cap`,
      };
    }
  }
  const runId = ctx.deps.randomId?.() ?? `judge-${ctx.now().toISOString().replace(/[:.]/gu, "-")}`;
  const rawPath = ctx.abs(options.outRaw ?? rawPathFor(runId));
  const reportPath = ctx.abs(options.outReport ?? reportPathFor(runId));
  const manifestPath = manifestPathFor(rawPath);
  if (!options.allowOverwrite && [rawPath, manifestPath, reportPath].some(ctx.fileExists)) {
    return { code: 5, error: "Artifact target exists; use --allow-overwrite or choose new paths" };
  }
  const cassettePath = ctx.abs(options.cassettePath ?? cassettePathFor(candidate.id));
  const cassetteText = ctx.fileExists(cassettePath) ? ctx.readFile(cassettePath) : "";
  if (!options.replayOnly && ctx.deps.appendFile === undefined) mkdirSync(dirname(cassettePath), { recursive: true });
  const executeDeps: ExecuteDeps = {
    fetchImpl: ctx.deps.fetchImpl ?? globalThis.fetch.bind(globalThis),
    sleep: ctx.deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    now: ctx.now,
    ...(ctx.deps.judgeFor ? { judgeFor: ctx.deps.judgeFor } : {}),
    apiKey: ctx.env.REQUESTY_API_KEY?.trim() ?? "",
    cassetteText,
    appendCassette: options.replayOnly
      ? () => undefined
      : (line) => {
          if (ctx.deps.appendFile) ctx.deps.appendFile(cassettePath, line);
          else appendFileSync(cassettePath, line);
        },
  };
  try {
    const executed = await executeCalls({
      pairs: selection.selected,
      candidate,
      probe: options.probe === "order-swap",
      threshold: runThreshold,
      runId,
      datasetId: dataset.datasetId,
      concurrency: options.concurrency,
      maxTotalCostUsd: options.replayOnly ? null : options.maxTotalCostUsd,
      replayOnly: options.replayOnly,
      deps: executeDeps,
    });
    const completedRequests = executed.rows.length;
    const manifest: JudgeRunManifest = {
      schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
      scoringContractVersion: JUDGE_SCORING_CONTRACT_VERSION,
      taskId: JUDGE_TASK_ID,
      runId,
      createdAt: ctx.now().toISOString(),
      datasetId: dataset.datasetId,
      candidateId: candidate.id,
      git,
      fixtureContentHash: disclosure.fixtureContentHash,
      textSnapshotHash: disclosure.textSnapshotHash,
      candidateConfigHashes: [candidate.candidateConfigHash],
      split: options.split,
      probe: options.probe,
      replayOnly: options.replayOnly,
      threshold: runThreshold,
      thresholdSource: thresholds?.thresholdSource ?? "candidate_default",
      rowCount: executed.rows.length,
      disclosure: manifestDisclosure(disclosure),
      completion: {
        status: executed.stopReason || completedRequests < disclosure.plannedRequestCount ? "partial" : "complete",
        plannedRequestCount: disclosure.plannedRequestCount,
        completedRequestCount: completedRequests,
        cumulativeCostUsd: executed.cumulativeCostUsd,
        ...(executed.stopReason ? { stopReason: executed.stopReason } : {}),
      },
    };
    const scoreReport = scoreJudgeRows(executed.rows, scoreModeFor(dataset, options.split, executed.rows));
    const report = renderJudgeReport({
      datasetId: dataset.datasetId,
      candidateId: candidate.id,
      manifest,
      score: scoreReport,
      rows: executed.rows,
      note: selection.note,
    });
    ctx.writeFile(rawPath, executed.rows.map((row) => JSON.stringify(row)).join("\n") + (executed.rows.length ? "\n" : ""));
    ctx.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    ctx.writeFile(reportPath, report);
    ctx.log(report);
    if (executed.stopReason === "runtime_error") {
      return { code: 1, error: `${candidate.id}: every provider call failed`, report };
    }
    return { code: executed.stopReason ? 1 : 0, report };
  } catch (error) {
    if (error instanceof CassetteMissError) {
      return { code: 6, error: error.message };
    }
    return { code: 1, error: error instanceof Error ? error.message : String(error) };
  }
}
