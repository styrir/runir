import {
  JUDGE_BENCHMARK_SCHEMA_VERSION,
  JUDGE_TASK_ID,
  type GoldLabel,
  type GoldResolution,
  type JudgeFrame,
  type JudgeLabelsFile,
  type JudgePair,
  type JudgePopulation,
  type JudgeSplit,
  type MemoryRef,
  type SpotCheckVerdict,
} from "./types.js";

const GOLD: readonly GoldLabel[] = ["supersede", "duplicate", "independent"];
export const SPLITS: readonly JudgeSplit[] = ["calibration", "test", "insample", "heldout"];
const POPULATIONS: readonly JudgePopulation[] = ["probability", "challenge", "shadow", "legacy"];
const FRAMES: readonly JudgeFrame[] = ["diverged", "control", "heldout"];
const RESOLUTIONS: readonly GoldResolution[] = [
  "agreed",
  "reconciled",
  "disagreement_defaulted_over",
  "reconciled_content_verified",
  "agreed_repaired",
];
const SPOTS: readonly SpotCheckVerdict[] = ["confirmed", "repaired", "rejected"];

const DATASET_KEYS = new Set([
  "schemaVersion",
  "taskId",
  "datasetId",
  "legacyBinaryGold",
  "pairs",
]);
const PAIR_KEYS = new Set([
  "pairId",
  "oldRef",
  "newRef",
  "stratum",
  "split",
  "origin",
  "population",
  "cosine",
  "gold",
  "frame",
  "legacyBinaryGold",
  "goldHeadline",
  "goldStrict",
]);
const REF_KEYS = new Set(["source", "id", "sha256", "createdAt"]);
const GOLD_KEYS = new Set([
  "label",
  "labelA",
  "labelB",
  "resolution",
  "spotChecked",
  "spotCheckVerdict",
  "positiveReviewed",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,200}$/;
export const DATASET_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TOKEN = /^[a-z0-9][a-z0-9:._-]{0,80}$/;
const SOURCE =
  /^(?:prod|eval):[A-Za-z0-9_][A-Za-z0-9_-]*\/[A-Za-z0-9_][A-Za-z0-9_-]*:semiote$|^archive:[a-z0-9][a-z0-9-]{0,80}$/;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(path, `unknown field ${key}`);
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function requiredString(record: Record<string, unknown>, key: string, path: string, pattern: RegExp): string {
  const value = record[key];
  if (typeof value !== "string" || !pattern.test(value)) fail(`${path}.${key}`, "invalid string");
  return value;
}

function parseRef(value: unknown, path: string): MemoryRef {
  if (!isRecord(value)) fail(path, "must be an object");
  rejectUnknown(value, REF_KEYS, path);
  return {
    source: requiredString(value, "source", path, SOURCE),
    id: requiredString(value, "id", path, ID),
    sha256: requiredString(value, "sha256", path, SHA256),
    createdAt: requiredString(value, "createdAt", path, ISO_DATE),
  };
}

function parseGoldLabel(value: unknown, path: string): GoldLabel {
  return oneOf(value, GOLD, path);
}

function parseNullableGold(value: unknown, path: string): GoldLabel | null {
  if (value === null) return null;
  return parseGoldLabel(value, path);
}

function parsePair(value: unknown, path: string, legacyDataset: boolean): JudgePair {
  if (!isRecord(value)) fail(path, "must be an object");
  rejectUnknown(value, PAIR_KEYS, path);
  const goldRaw = value.gold;
  if (!isRecord(goldRaw)) fail(`${path}.gold`, "must be an object");
  rejectUnknown(goldRaw, GOLD_KEYS, path);
  if (typeof goldRaw.spotChecked !== "boolean") fail(`${path}.gold.spotChecked`, "must be boolean");
  const spot = goldRaw.spotCheckVerdict;
  if (spot !== null && (typeof spot !== "string" || !SPOTS.includes(spot as SpotCheckVerdict))) {
    fail(`${path}.gold.spotCheckVerdict`, "must be null or a spot-check verdict");
  }
  const cosine = value.cosine;
  if (cosine !== null && (typeof cosine !== "number" || !Number.isFinite(cosine) || cosine < -1 || cosine > 1)) {
    fail(`${path}.cosine`, "must be null or a finite cosine in [-1, 1]");
  }
  const pair: JudgePair = {
    pairId: requiredString(value, "pairId", path, ID),
    oldRef: parseRef(value.oldRef, `${path}.oldRef`),
    newRef: parseRef(value.newRef, `${path}.newRef`),
    stratum: requiredString(value, "stratum", path, TOKEN),
    split: oneOf(value.split, SPLITS, `${path}.split`),
    origin: requiredString(value, "origin", path, TOKEN),
    population: oneOf(value.population, POPULATIONS, `${path}.population`),
    cosine,
    gold: {
      label: parseGoldLabel(goldRaw.label, `${path}.gold.label`),
      labelA: parseGoldLabel(goldRaw.labelA, `${path}.gold.labelA`),
      labelB: parseGoldLabel(goldRaw.labelB, `${path}.gold.labelB`),
      resolution: oneOf(goldRaw.resolution, RESOLUTIONS, `${path}.gold.resolution`),
      spotChecked: goldRaw.spotChecked,
      spotCheckVerdict: spot as SpotCheckVerdict | null,
    },
  };
  if (goldRaw.positiveReviewed !== undefined) {
    if (typeof goldRaw.positiveReviewed !== "boolean") fail(`${path}.gold.positiveReviewed`, "must be boolean");
    pair.gold.positiveReviewed = goldRaw.positiveReviewed;
  }
  if (value.frame !== undefined) pair.frame = oneOf(value.frame, FRAMES, `${path}.frame`);
  if (value.legacyBinaryGold !== undefined) {
    if (typeof value.legacyBinaryGold !== "boolean") fail(`${path}.legacyBinaryGold`, "must be boolean");
    pair.legacyBinaryGold = value.legacyBinaryGold;
  }
  if (value.goldHeadline !== undefined) pair.goldHeadline = parseNullableGold(value.goldHeadline, `${path}.goldHeadline`);
  if (value.goldStrict !== undefined) pair.goldStrict = parseNullableGold(value.goldStrict, `${path}.goldStrict`);
  if (legacyDataset) {
    if (!pair.frame) fail(path, "legacy pair is missing frame");
    if (pair.legacyBinaryGold !== true) fail(path, "legacy pair must set legacyBinaryGold true");
    if (pair.goldHeadline === undefined) fail(path, "legacy pair is missing goldHeadline");
    if (pair.goldStrict === undefined) fail(path, "legacy pair is missing goldStrict");
  }
  return pair;
}

/** Rejects unknown keys and any string that is not an id, hash, label, stratum, split, origin, or ISO date. */
export function validateLabels(value: unknown): JudgeLabelsFile {
  if (!isRecord(value)) fail("labels", "must be an object");
  rejectUnknown(value, DATASET_KEYS, "labels");
  if (value.schemaVersion !== JUDGE_BENCHMARK_SCHEMA_VERSION) {
    fail("labels.schemaVersion", `must be ${JUDGE_BENCHMARK_SCHEMA_VERSION}`);
  }
  if (value.taskId !== JUDGE_TASK_ID) fail("labels.taskId", `must be ${JUDGE_TASK_ID}`);
  if (typeof value.legacyBinaryGold !== "boolean") fail("labels.legacyBinaryGold", "must be boolean");
  const datasetId = requiredString(value, "datasetId", "labels", DATASET_ID);
  if (!Array.isArray(value.pairs)) fail("labels.pairs", "must be an array");
  const pairs = value.pairs.map((pair, index) => parsePair(pair, `labels.pairs[${index}]`, value.legacyBinaryGold === true));
  const ids = new Set<string>();
  for (const pair of pairs) {
    if (ids.has(pair.pairId)) fail("labels.pairs", `duplicate pairId ${pair.pairId}`);
    ids.add(pair.pairId);
  }
  return {
    schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
    taskId: JUDGE_TASK_ID,
    datasetId,
    legacyBinaryGold: value.legacyBinaryGold,
    pairs,
  };
}
