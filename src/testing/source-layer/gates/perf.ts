import type { GateResult } from "../types.js";

export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Number(sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(3)) : null;
  return { p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99) };
}

export function perfGate(id: string, samples: number[], p95TargetMs?: number, extra: Record<string, number> = {}): GateResult {
  const stats = percentiles(samples);
  return { id, family: "perf", status: stats.p95Ms != null && (p95TargetMs === undefined || stats.p95Ms < p95TargetMs) ? "pass" : "fail",
    counts: { samples: samples.length }, metrics: { ...stats, ...(p95TargetMs === undefined ? {} : { targetMs: p95TargetMs }), ...extra } };
}
