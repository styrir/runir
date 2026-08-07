import { BENCHMARK_SCHEMA_VERSION } from "../model-benchmark/types.js";
import { THINK_BENCHMARK_SCHEMA_VERSION } from "../think-benchmark/types.js";
import { adaptBenchmarkRun, ReviewAdapterError } from "./benchmark-adapter.js";
import { adaptThinkBenchmarkRun } from "./think-adapter.js";
import type { BenchmarkRunBundle, ReviewRun } from "./types.js";

export type ReviewRunAdapter = {
  sourceSchemaVersion: string;
  adapt: (bundle: BenchmarkRunBundle) => ReviewRun;
};

export const REVIEW_RUN_ADAPTERS: readonly ReviewRunAdapter[] = [
  { sourceSchemaVersion: BENCHMARK_SCHEMA_VERSION, adapt: adaptBenchmarkRun },
  { sourceSchemaVersion: THINK_BENCHMARK_SCHEMA_VERSION, adapt: adaptThinkBenchmarkRun },
];

const ADAPTER_BY_SCHEMA = new Map<string, ReviewRunAdapter>();
for (const adapter of REVIEW_RUN_ADAPTERS) {
  if (ADAPTER_BY_SCHEMA.has(adapter.sourceSchemaVersion)) {
    throw new Error(`Duplicate Review Studio adapter registration: ${adapter.sourceSchemaVersion}`);
  }
  ADAPTER_BY_SCHEMA.set(adapter.sourceSchemaVersion, adapter);
}

function manifestSchema(bundle: BenchmarkRunBundle): unknown {
  if (typeof bundle.manifest !== "object" || bundle.manifest === null || Array.isArray(bundle.manifest)) {
    return undefined;
  }
  return (bundle.manifest as Record<string, unknown>).schemaVersion;
}

/** Dispatches an artifact bundle to the suite-specific producer adapter. */
export function adaptReviewRun(bundle: BenchmarkRunBundle): ReviewRun {
  const schemaVersion = manifestSchema(bundle);
  const adapter = typeof schemaVersion === "string" ? ADAPTER_BY_SCHEMA.get(schemaVersion) : undefined;
  if (adapter) return adapter.adapt(bundle);
  throw new ReviewAdapterError(
    "unsupported_schema",
    `No Review Studio adapter is registered for schema ${String(schemaVersion ?? "(missing)")}`,
  );
}
