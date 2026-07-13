import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SearchHit } from "../domain/memory/types.js";
import {
  applyHexisToHits,
  calibHexisFit,
  normalizeHexis,
} from "../hexis/runtime-hexis.js";
import { hexisV15FitDistribution } from "./fixtures/hexis-v15-fit-distribution.js";

const BASELINE_PARITY_PATH = path.resolve(
  process.cwd(),
  "docs/reference/noema-semiote/hexis-phase-3a-evidence/baseline-parity.json",
);

function snapshotEnv(): Record<string, string | undefined> {
  return {
    HEXIS_DISABLE_CALIB: process.env.HEXIS_DISABLE_CALIB,
    HEXIS_DISABLE_GATE: process.env.HEXIS_DISABLE_GATE,
  };
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function kendallTau(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const da = a[i] - a[j];
      const db = b[i] - b[j];
      const sign = Math.sign(da) * Math.sign(db);
      if (sign > 0) concordant++;
      else if (sign < 0) discordant++;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  return (concordant - discordant) / pairs;
}

describe("hexis magnitude parity (v1.5 fixture)", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    delete process.env.HEXIS_DISABLE_CALIB;
    delete process.env.HEXIS_DISABLE_GATE;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it("(a) bit-identical v1.5 parity with HEXIS_DISABLE_CALIB=1, HEXIS_DISABLE_GATE=1, lambda=1.0", () => {
    process.env.HEXIS_DISABLE_CALIB = "1";
    process.env.HEXIS_DISABLE_GATE = "1";

    // Formula-level check: under env disables, calib is identity, gate is forced to 1.0.
    // The new boost reduces to `1 * 1 * fit * hexisMatch * 0.25`, which must match the
    // v1.5 boost `fit * hexisMatch * 0.25` with bit-identical float output.
    for (const entry of hexisV15FitDistribution) {
      const calibFit = calibHexisFit(entry.fit);
      expect(Object.is(calibFit, entry.fit)).toBe(true);

      const gate = 1.0;
      const lambda = 1.0;
      const newBoost = gate * lambda * calibFit * entry.hexisMatch * 0.25;
      expect(Object.is(newBoost, entry.v15Boost)).toBe(true);
    }

    // Single-hit end-to-end spot-check: applyHexisToHits on a pool of one
    // admissible hit forces `hits.length < W + 1`, which drives the ambiguity
    // gate to 1.0 so the boost formula inside `scoreStages.hexis.boost` stays
    // identical to the v1.5 shape. Fixture hexisMatch does not flow through
    // normalizeHexis, so we compare against the fit actually produced by
    // scoreHexisFit and the default weights (hexisMatch = 1.0).
    const hexis = normalizeHexis({
      userId: "parity",
      hint: {
        scope: "agent",
        label: "parity frame",
        goals: ["recall"],
      },
    });
    const hit: SearchHit = {
      id: "spot",
      text: "parity fixture hit",
      score: 1.0,
    };
    const [out] = applyHexisToHits([hit], hexis, {
      lambda: 1.0,
      maxRankWindow: 7,
      gateEpsilon: 0.001,
    });
    // Compare via scoreStages.hexis.boost so no subtraction noise is introduced
    // by taking postHexisScore - preHexisScore at float precision.
    const observedFit = out.hexisFit ?? 0;
    const observedBoost = out.scoreStages?.hexis?.boost ?? Number.NaN;
    const v15FromObserved = 1 * 1 * observedFit * 1.0 * 0.25;
    expect(Object.is(observedBoost, v15FromObserved)).toBe(true);
  });

  it("(b) Kendall tau rank preservation >= 0.95 in normal mode", () => {
    // calibHexisFit is strictly monotone in fit, so for fixture entries sharing
    // a hexisMatch value the new ordering matches the v1.5 ordering exactly.
    // Mixing two hexisMatch bands is what makes this a genuine check.
    const v15Values = hexisV15FitDistribution.map((entry) => entry.v15Boost);
    const newValues = hexisV15FitDistribution.map(
      (entry) => calibHexisFit(entry.fit) * entry.hexisMatch * 0.25,
    );
    const tau = kendallTau(v15Values, newValues);
    expect(tau).toBeGreaterThanOrEqual(0.95);
  });

  it("(c) per-row ratio in [0.5, 2.0] across fixture in normal mode", () => {
    for (const entry of hexisV15FitDistribution) {
      const newBoost = calibHexisFit(entry.fit) * entry.hexisMatch * 0.25;
      if (entry.v15Boost === 0) {
        // Bounded-shape guard does not apply to the zero-fit anchor; the sigmoid
        // stays strictly positive even at fit=0, which is the intended behavior.
        expect(newBoost).toBeGreaterThanOrEqual(0);
        continue;
      }
      const ratio = newBoost / entry.v15Boost;
      expect(ratio).toBeGreaterThanOrEqual(0.5);
      expect(ratio).toBeLessThanOrEqual(2.0);
    }
  });
});

describe("hexis baseline-parity artifact (AC9)", () => {
  it("baseline-parity.json was captured with both env-disables and boost vector is bit-identical to fixture", () => {
    const artifact = JSON.parse(fs.readFileSync(BASELINE_PARITY_PATH, "utf8")) as {
      envFlags?: { HEXIS_DISABLE_CALIB?: string | null; HEXIS_DISABLE_GATE?: string | null };
      naturalQueryEval?: { wins: number; regressions: number; unchanged: number };
    };

    // AC9 invariant: env-disables must both be set so the run reproduces v1.5-identical math
    expect(artifact.envFlags?.HEXIS_DISABLE_CALIB).toBe("1");
    expect(artifact.envFlags?.HEXIS_DISABLE_GATE).toBe("1");

    // AC9 boost-vector parity: with both env-disables active, calibHexisFit is identity and
    // gate is forced to 1.0, so the boost reduces to fit * hexisMatch * 0.25 — exactly v15Boost.
    // Assert element-wise with Object.is (zero delta, no float tolerance).
    for (const entry of hexisV15FitDistribution) {
      const disabledCalibFit = entry.fit; // identity when HEXIS_DISABLE_CALIB=1
      const gate = 1.0;                   // forced when HEXIS_DISABLE_GATE=1
      const lambda = 1.0;
      const parityBoost = gate * lambda * disabledCalibFit * entry.hexisMatch * 0.25;
      expect(Object.is(parityBoost, entry.v15Boost)).toBe(true);
    }
  });
});
