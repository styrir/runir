import type { ThinkBenchmarkOptions } from "./cli.js";
import {
  THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
  type ThinkBenchmarkRow,
  type ThinkRetrievalScores,
  type ThinkRunManifest,
} from "./types.js";

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

export type ThinkRetrievalPreflight = {
  retrieval: {
    seedCount: number;
    retrievalWindow: number;
    synthesisCap: number;
    fixtureContentHash: string;
    metricContractVersion: typeof THINK_RETRIEVAL_METRIC_CONTRACT_VERSION;
    attributionScores: ThinkRetrievalScores;
  };
};

export type ThinkBenchmarkResult = {
  code: number;
  options: ThinkBenchmarkOptions;
  rows: ThinkBenchmarkRow[];
  manifest?: ThinkRunManifest;
  report?: string;
  preflight?: ThinkRetrievalPreflight;
  error?: string;
};
