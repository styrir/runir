import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyHexisToHits,
  hasHexisSignal,
  normalizeHexis,
} from "../hexis/runtime-hexis.js";
import type { SearchHit } from "../domain/memory/types.js";

const SIX_SCALAR_FIELDS = [
  "preHexisScore",
  "postHexisScore",
  "poolRank",
  "boundaryGap",
  "gateValue",
  "hexisMode",
] as const;

function makeHexis() {
  return normalizeHexis({
    userId: "u1",
    hint: {
      label: "bypass taxonomy frame",
      goals: ["recall stabilization"],
      topicBias: { recall: 1 },
    },
  });
}

function makeHits(n: number, baseScore = 1.0, gap = 0.1): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `hit-${i}`,
    text: i === 0 ? "recall stabilization note" : `generic note ${i}`,
    score: baseScore - i * gap,
  }));
}

function assertSixScalars(hits: SearchHit[]) {
  for (const hit of hits) {
    for (const field of SIX_SCALAR_FIELDS) {
      expect(typeof hit[field], `${field} must be a number on hit ${hit.id}`)
        .toBe("number");
    }
  }
}

// All string fields that existed on SearchHit before Phase 3a.
const PRE_3A_STRING_FIELDS = new Set([
  "id", "text", "createdAt", "updatedAt", "scope", "sessionId",
  "continuitySubjectKey", "hexisId", "validAt", "invalidAt",
  "staleSince", "contradictedBy", "supersededById", "lineageRootId",
  "inactiveReason", "l0", "l1", "path",
]);

function assertNoNewStringFields(_before: SearchHit[], after: SearchHit[]) {
  for (const hit of after) {
    for (const [k, v] of Object.entries(hit)) {
      if (typeof v === "string" && !PRE_3A_STRING_FIELDS.has(k)) {
        throw new Error(`New string field introduced post-3a: ${k} on hit ${hit.id}`);
      }
    }
  }
}

describe("hexis bypass taxonomy", () => {
  beforeEach(() => {
    delete process.env.HEXIS_DISABLE_GATE;
    delete process.env.HEXIS_DISABLE_CALIB;
  });

  afterEach(() => {
    delete process.env.HEXIS_DISABLE_GATE;
    delete process.env.HEXIS_DISABLE_CALIB;
  });

  describe("mode 0 — normal (gate>0, signal present, no env disable)", () => {
    it("emits all six scalar audit fields on every hit", () => {
      const hexis = makeHexis();
      // gap = 0.001 per rank step → well within gate open range for W=7
      const hits = makeHits(10, 1.0, 0.001);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertSixScalars(result);
    });

    it("gateValue is in (0, 1] for admissible window hits", () => {
      const hexis = makeHexis();
      // small gap keeps gate open
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const admissible = result.filter((h) => h.hexisMode === 0);
      expect(admissible.length).toBeGreaterThan(0);
      for (const hit of admissible) {
        expect(hit.gateValue).toBeGreaterThan(0);
        expect(hit.gateValue).toBeLessThanOrEqual(1);
      }
    });

    it("postHexisScore = preHexisScore + boost (boost > 0 for matching hit)", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const boosted = result.find((h) => h.hexisMode === 0 && h.id === "hit-0");
      expect(boosted).toBeDefined();
      expect(boosted!.postHexisScore).toBeGreaterThan(boosted!.preHexisScore!);
    });

    it("scoreStages.hexis is present on mode-0 hits", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode0 = result.filter((h) => h.hexisMode === 0);
      expect(mode0.length).toBeGreaterThan(0);
      for (const hit of mode0) {
        expect(hit.scoreStages?.hexis).toBeDefined();
      }
    });

    it("hexisMode is a number", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      for (const hit of result) {
        expect(typeof hit.hexisMode).toBe("number");
      }
    });

    it("introduces no new string fields beyond pre-3a schema", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertNoNewStringFields(hits, result);
    });
  });

  describe("mode 1 — lane-bypass (laneLambda=0)", () => {
    it("emits all six scalar audit fields on every hit", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      assertSixScalars(result);
    });

    it("hexisMode is 1 on every hit", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      for (const hit of result) {
        expect(hit.hexisMode).toBe(1);
      }
    });

    it("postHexisScore equals preHexisScore on every hit (no boost)", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      for (const hit of result) {
        expect(hit.postHexisScore).toBe(hit.preHexisScore);
      }
    });

    it("gateValue is 0 on every hit", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      for (const hit of result) {
        expect(hit.gateValue).toBe(0);
      }
    });

    it("laneLambda is 0 on every hit (seventh audit scalar)", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      for (const hit of result) {
        expect(hit.laneLambda).toBe(0);
      }
    });

    it("scoreStages.hexis is omitted on every hit", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      for (const hit of result) {
        expect(hit.scoreStages?.hexis).toBeUndefined();
      }
    });

    it("introduces no new string fields", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      assertNoNewStringFields(hits, result);
    });
  });

  describe("mode 2 — gate-closed (gap ≥ 4·eps)", () => {
    it("emits all six scalar audit fields on every hit", () => {
      const hexis = makeHexis();
      // gap = 0.01 per step, eps = 0.001 → gap[W-1→W] = 0.01 >> 4*0.001 = 0.004
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertSixScalars(result);
    });

    it("gateValue is 0 on admissible window hits", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode2 = result.filter((h) => h.hexisMode === 2);
      expect(mode2.length).toBeGreaterThan(0);
      for (const hit of mode2) {
        expect(hit.gateValue).toBe(0);
      }
    });

    it("postHexisScore equals preHexisScore (no boost)", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode2 = result.filter((h) => h.hexisMode === 2);
      expect(mode2.length).toBeGreaterThan(0);
      for (const hit of mode2) {
        expect(hit.postHexisScore).toBe(hit.preHexisScore);
      }
    });

    it("scoreStages.hexis is omitted on mode-2 hits", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode2 = result.filter((h) => h.hexisMode === 2);
      expect(mode2.length).toBeGreaterThan(0);
      for (const hit of mode2) {
        expect(hit.scoreStages?.hexis).toBeUndefined();
      }
    });

    it("introduces no new string fields", () => {
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertNoNewStringFields(hits, result);
    });
  });

  describe("mode 3 — HEXIS_DISABLE_GATE=1", () => {
    it("emits all six scalar audit fields on every hit", () => {
      process.env.HEXIS_DISABLE_GATE = "1";
      const hexis = makeHexis();
      // use large gap that would normally close the gate
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertSixScalars(result);
    });

    it("gateValue is 1 (env-forced) on admissible hits", () => {
      process.env.HEXIS_DISABLE_GATE = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode3 = result.filter((h) => h.hexisMode === 3);
      expect(mode3.length).toBeGreaterThan(0);
      for (const hit of mode3) {
        expect(hit.gateValue).toBe(1);
      }
    });

    it("postHexisScore > preHexisScore for matching hits (boost applied with gate=1)", () => {
      process.env.HEXIS_DISABLE_GATE = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode3Matching = result.find((h) => h.hexisMode === 3 && h.id === "hit-0");
      expect(mode3Matching).toBeDefined();
      expect(mode3Matching!.postHexisScore).toBeGreaterThan(mode3Matching!.preHexisScore!);
    });

    it("scoreStages.hexis is present on mode-3 hits", () => {
      process.env.HEXIS_DISABLE_GATE = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode3 = result.filter((h) => h.hexisMode === 3);
      expect(mode3.length).toBeGreaterThan(0);
      for (const hit of mode3) {
        expect(hit.scoreStages?.hexis).toBeDefined();
      }
    });

    it("introduces no new string fields", () => {
      process.env.HEXIS_DISABLE_GATE = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.01);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertNoNewStringFields(hits, result);
    });
  });

  describe("mode 4 — HEXIS_DISABLE_CALIB=1", () => {
    it("emits all six scalar audit fields on every hit", () => {
      process.env.HEXIS_DISABLE_CALIB = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertSixScalars(result);
    });

    it("gateValue is in (0, 1] for admissible hits", () => {
      process.env.HEXIS_DISABLE_CALIB = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode4 = result.filter((h) => h.hexisMode === 4);
      expect(mode4.length).toBeGreaterThan(0);
      for (const hit of mode4) {
        expect(hit.gateValue).toBeGreaterThan(0);
        expect(hit.gateValue).toBeLessThanOrEqual(1);
      }
    });

    it("postHexisScore > preHexisScore for matching hits (calib=identity, boost still applied)", () => {
      process.env.HEXIS_DISABLE_CALIB = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode4Matching = result.find((h) => h.hexisMode === 4 && h.id === "hit-0");
      expect(mode4Matching).toBeDefined();
      expect(mode4Matching!.postHexisScore).toBeGreaterThan(mode4Matching!.preHexisScore!);
    });

    it("scoreStages.hexis is present on mode-4 hits", () => {
      process.env.HEXIS_DISABLE_CALIB = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      const mode4 = result.filter((h) => h.hexisMode === 4);
      expect(mode4.length).toBeGreaterThan(0);
      for (const hit of mode4) {
        expect(hit.scoreStages?.hexis).toBeDefined();
      }
    });

    it("introduces no new string fields", () => {
      process.env.HEXIS_DISABLE_CALIB = "1";
      const hexis = makeHexis();
      const hits = makeHits(10, 1.0, 0.0005);
      const result = applyHexisToHits(hits, hexis, { gateEpsilon: 0.001 });
      assertNoNewStringFields(hits, result);
    });
  });

  describe("mode 5 — no signal (hexis null or hasHexisSignal=false)", () => {
    it("emits all six scalar audit fields when hexis is null", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      assertSixScalars(result);
    });

    it("emits all six scalar audit fields when hasHexisSignal is false", () => {
      const emptyHexis = normalizeHexis({ userId: "u1" });
      expect(hasHexisSignal(emptyHexis)).toBe(false);
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, emptyHexis);
      assertSixScalars(result);
    });

    it("gateValue is 0 on all hits", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      for (const hit of result) {
        expect(hit.gateValue).toBe(0);
      }
    });

    it("postHexisScore equals preHexisScore (no boost)", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      for (const hit of result) {
        expect(hit.postHexisScore).toBe(hit.preHexisScore);
      }
    });

    it("hexisMode is 5 on all hits", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      for (const hit of result) {
        expect(hit.hexisMode).toBe(5);
      }
    });

    it("scoreStages.hexis is omitted", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      for (const hit of result) {
        expect(hit.scoreStages?.hexis).toBeUndefined();
      }
    });

    it("boundaryGap is 0", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      for (const hit of result) {
        expect(hit.boundaryGap).toBe(0);
      }
    });

    it("introduces no new string fields", () => {
      const hits = makeHits(5);
      const result = applyHexisToHits(hits, null);
      assertNoNewStringFields(hits, result);
    });
  });

  describe("cross-mode schema stability", () => {
    it("all six scalar fields are present across all six modes in a single run each", () => {
      const hexis = makeHexis();

      // Mode 5: null hexis
      const nullResult = applyHexisToHits(makeHits(5), null);
      assertSixScalars(nullResult);

      // Mode 1: lane-bypass
      const mode1Result = applyHexisToHits(makeHits(10, 1.0, 0.0005), hexis, { laneLambda: 0, gateEpsilon: 0.001 });
      assertSixScalars(mode1Result);

      // Mode 2: gate closed
      const mode2Result = applyHexisToHits(makeHits(10, 1.0, 0.01), hexis, { gateEpsilon: 0.001 });
      assertSixScalars(mode2Result);

      // Mode 0: normal
      const mode0Result = applyHexisToHits(makeHits(10, 1.0, 0.0005), hexis, { gateEpsilon: 0.001 });
      assertSixScalars(mode0Result);

      // Mode 3: gate env-disabled
      process.env.HEXIS_DISABLE_GATE = "1";
      const mode3Result = applyHexisToHits(makeHits(10, 1.0, 0.01), hexis, { gateEpsilon: 0.001 });
      delete process.env.HEXIS_DISABLE_GATE;
      assertSixScalars(mode3Result);

      // Mode 4: calib env-disabled
      process.env.HEXIS_DISABLE_CALIB = "1";
      const mode4Result = applyHexisToHits(makeHits(10, 1.0, 0.0005), hexis, { gateEpsilon: 0.001 });
      delete process.env.HEXIS_DISABLE_CALIB;
      assertSixScalars(mode4Result);
    });

    it("hexisMode is typeof number across all six modes", () => {
      const hexis = makeHexis();

      const allResults = [
        applyHexisToHits(makeHits(5), null),
        applyHexisToHits(makeHits(10, 1.0, 0.0005), hexis, { laneLambda: 0, gateEpsilon: 0.001 }),
        applyHexisToHits(makeHits(10, 1.0, 0.01), hexis, { gateEpsilon: 0.001 }),
        applyHexisToHits(makeHits(10, 1.0, 0.0005), hexis, { gateEpsilon: 0.001 }),
      ];

      process.env.HEXIS_DISABLE_GATE = "1";
      allResults.push(applyHexisToHits(makeHits(10, 1.0, 0.01), hexis, { gateEpsilon: 0.001 }));
      delete process.env.HEXIS_DISABLE_GATE;

      process.env.HEXIS_DISABLE_CALIB = "1";
      allResults.push(applyHexisToHits(makeHits(10, 1.0, 0.0005), hexis, { gateEpsilon: 0.001 }));
      delete process.env.HEXIS_DISABLE_CALIB;

      for (const result of allResults) {
        for (const hit of result) {
          expect(typeof hit.hexisMode).toBe("number");
        }
      }
    });
  });
});
