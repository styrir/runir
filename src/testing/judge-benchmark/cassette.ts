import { sha256Text } from "../model-benchmark/provenance.js";
import { isRecord } from "./schema.js";
import type { CandidateId, JudgeSignals, PairDirection, TokenUsage } from "./types.js";

/**
 * Stable encoding of sha256(candidateConfigHash, oldText, newText, direction).
 * NUL separators keep distinct texts from aliasing under raw concatenation.
 */
export function cassetteKey(args: {
  candidateConfigHash: string;
  oldText: string;
  newText: string;
  direction: PairDirection;
}): string {
  return sha256Text([args.candidateConfigHash, args.oldText, args.newText, args.direction].join("\0"));
}

export type CassetteTelemetry = {
  latencyMs: number;
  usage: TokenUsage;
  billedCostUsd: number | null;
  estimatedCostUsd: number | null;
  retryCount: number;
};

export type CassetteEntry = {
  key: string;
  candidateId: CandidateId;
  direction: PairDirection;
  signals: JudgeSignals;
  raw: string;
} & CassetteTelemetry;

export class CassetteMissError extends Error {
  readonly key: string;
  readonly candidateId: string;
  constructor(candidateId: string, key: string) {
    super(`cassette miss for ${candidateId} key ${key}`);
    this.name = "CassetteMissError";
    this.key = key;
    this.candidateId = candidateId;
  }
}

export function parseCassette(text: string): Map<string, CassetteEntry> {
  const entries = new Map<string, CassetteEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.key !== "string") continue;
    entries.set(parsed.key, parsed as CassetteEntry);
  }
  return entries;
}

export function lookupCassette(
  entries: ReadonlyMap<string, CassetteEntry>,
  candidateId: string,
  key: string,
): CassetteEntry {
  const hit = entries.get(key);
  if (!hit) throw new CassetteMissError(candidateId, key);
  return hit;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableUsd(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

/** Replay copies this recorded telemetry onto the new row verbatim. */
export function readCassetteTelemetry(entry: CassetteEntry): CassetteTelemetry {
  if (!finiteNumber(entry.latencyMs) || !finiteNumber(entry.retryCount)) {
    throw new Error(`cassette entry ${entry.key} is missing recorded telemetry`);
  }
  if (!nullableUsd(entry.billedCostUsd) || !nullableUsd(entry.estimatedCostUsd)) {
    throw new Error(`cassette entry ${entry.key} is missing recorded telemetry`);
  }
  if (!isRecord(entry.usage)) throw new Error(`cassette entry ${entry.key} is missing recorded telemetry`);
  return {
    latencyMs: entry.latencyMs,
    usage: entry.usage,
    billedCostUsd: entry.billedCostUsd,
    estimatedCostUsd: entry.estimatedCostUsd,
    retryCount: entry.retryCount,
  };
}

export function cassetteLine(entry: CassetteEntry): string {
  return `${JSON.stringify(entry)}\n`;
}
