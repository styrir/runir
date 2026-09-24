import { ECE_BIN_COUNT, WILSON_Z } from "./types.js";

/** Wilson score interval upper bound. n <= 0 returns 1 so an empty sample cannot clear a gate. */
export function wilsonUpper(successes: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 1;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (centre + margin) / denominator;
}

/**
 * Mann-Whitney AUROC. Ties contribute 0.5. Either class empty → null
 * (the ranking is undefined, not 0 or 1).
 */
export function auroc(positive: readonly number[], negative: readonly number[]): number | null {
  if (positive.length === 0 || negative.length === 0) return null;
  let wins = 0;
  for (const left of positive) {
    for (const right of negative) {
      if (left > right) wins += 1;
      else if (left === right) wins += 0.5;
    }
  }
  return wins / (positive.length * negative.length);
}

/**
 * Expected calibration error over 10 equal-width bins on [0, 1].
 * `labels` are 1 for the positive class. Empty input → null.
 * A score of 1 lands in the last bin.
 */
export function expectedCalibrationError(
  scores: readonly number[],
  labels: readonly (0 | 1)[],
  bins = ECE_BIN_COUNT,
): number | null {
  if (scores.length === 0 || scores.length !== labels.length) return null;
  const counts = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, positives: 0 }));
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index]!;
    const label = labels[index]!;
    if (!Number.isFinite(score)) continue;
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(score * bins)));
    const bucket = counts[bin]!;
    bucket.n += 1;
    bucket.confidence += score;
    bucket.positives += label;
  }
  const used = counts.reduce((sum, bucket) => sum + bucket.n, 0);
  if (used === 0) return null;
  let error = 0;
  for (const bucket of counts) {
    if (bucket.n === 0) continue;
    const confidence = bucket.confidence / bucket.n;
    const accuracy = bucket.positives / bucket.n;
    error += (bucket.n / used) * Math.abs(accuracy - confidence);
  }
  return error;
}

/** Linear-rank percentile. `p` is in percent (50, 95). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const weight = rank - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}
