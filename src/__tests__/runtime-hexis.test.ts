import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyHexisToHits,
  buildHexisScopeKey,
  calibHexisFit,
  computeAmbiguityGate,
  normalizeHexis,
  scoreHexisFit,
} from "../hexis/runtime-hexis.js";
import type { SearchHit } from "../domain/memory/types.js";

describe("runtime-hexis", () => {
  it("builds a deterministic scope key from session context", () => {
    const scopeKey = buildHexisScopeKey({ userId: "u1", sessionId: "sess-1" }, "session");
    expect(scopeKey).toBe("u1::session::sess-1");
  });

  it("normalizes Hexis with defaults and deterministic id", () => {
    const hexis = normalizeHexis({
      userId: "u1",
      sessionId: "sess-1",
      hint: {
        label: "debugging frame",
        goals: ["stabilize recall"],
      },
    });
    expect(hexis.scope).toBe("session");
    expect(hexis.label).toBe("debugging frame");
    expect(hexis.goals).toEqual(["stabilize recall"]);
    expect(hexis.id).toMatch(/^[a-f0-9]{24}$/);
    expect(hexis.relevanceWeights.hexisMatch).toBe(1);
  });

  it("resolves a single active frame by hint override then session > project > agent precedence", () => {
    const hinted = normalizeHexis({
      userId: "u1",
      sessionId: "sess-1",
      projectId: "proj-1",
      agentId: "agent-1",
      hint: {
        scope: "agent",
        label: "agent frame",
      },
    });
    const sessionScoped = normalizeHexis({
      userId: "u1",
      sessionId: "sess-1",
      projectId: "proj-1",
      agentId: "agent-1",
    });
    const projectScoped = normalizeHexis({
      userId: "u1",
      projectId: "proj-1",
      agentId: "agent-1",
    });
    const agentScoped = normalizeHexis({
      userId: "u1",
      agentId: "agent-1",
    });

    expect(hinted.scope).toBe("agent");
    expect(sessionScoped.scope).toBe("session");
    expect(projectScoped.scope).toBe("project");
    expect(agentScoped.scope).toBe("agent");
  });

  it("scores a higher fit when text and role match Hexis signals", () => {
    const hexis = normalizeHexis({
      userId: "u1",
      path: "/tmp/runir.ts",
      hint: {
        scope: "project",
        label: "semiote maintenance",
        goals: ["stabilize noema promotion"],
        topicBias: { semiote: 1, noema: 0.8 },
        memoryRoleWeights: { architecture_reference: 1 },
      },
    });

    const strong = scoreHexisFit({
      text: "Semiote maintenance should stabilize noema promotion.",
      category: "patterns",
      memoryRole: "architecture_reference",
      path: "/tmp/runir.ts",
    }, hexis);
    const weak = scoreHexisFit({
      text: "A generic note about unrelated preferences.",
      category: "preferences",
      memoryRole: "operational_noise",
      path: "/tmp/other.ts",
    }, hexis);

    expect(strong.fit).toBeGreaterThan(weak.fit);
    expect(strong.explanation.length).toBeGreaterThan(0);
  });

  it("applies Hexis fit as a visible score boost on hits", () => {
    const hexis = normalizeHexis({
      userId: "u1",
      hint: {
        label: "semiote direct-write",
        goals: ["capture hook"],
        topicBias: { semiote: 1 },
      },
    });

    const [hit] = applyHexisToHits([{
      id: "mem-1",
      text: "The capture hook writes semiote records directly.",
      score: 0.5,
      memoryRole: "current_status",
    }], hexis);

    expect(hit.hexisId).toBe(hexis.id);
    expect(hit.hexisVersion).toBe(hexis.version);
    expect(hit.hexisFit).toBeGreaterThan(0);
    expect(hit.score).toBeGreaterThan(0.5);
    expect(hit.scoreStages?.hexis?.fit).toBe(hit.hexisFit);
  });

  it("limits Hexis boosts to the configured reorder window", () => {
    const hexis = normalizeHexis({
      userId: "u1",
      hint: {
        label: "capture frame",
        goals: ["capture hook"],
        topicBias: { capture: 1 },
      },
    });

    const hits = [
      { id: "m1", text: "generic note 1", score: 1 },
      { id: "m2", text: "generic note 2", score: 0.9 },
      { id: "m3", text: "generic note 3", score: 0.8 },
      { id: "m4", text: "generic note 4", score: 0.7 },
      { id: "m5", text: "generic note 5", score: 0.6 },
      { id: "m6", text: "capture hook specifics", score: 0.5, memoryRole: "current_status" as const },
    ];

    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 5, scoreEpsilon: 0, gateEpsilon: 0.001 });
    expect(result[5]?.score).toBe(0.5);
    expect(result[5]?.hexisFit).toBeUndefined();
  });
});

function makeHit(id: string, score: number, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    text: `text-${id}`,
    score,
    ...overrides,
  };
}

describe("calibHexisFit", () => {
  afterEach(() => {
    delete process.env.HEXIS_DISABLE_CALIB;
  });

  it("calib(0) ≤ 0.05", () => {
    expect(calibHexisFit(0)).toBeLessThanOrEqual(0.05);
  });

  it("calib(0.25) ∈ [0.15, 0.30]", () => {
    const v = calibHexisFit(0.25);
    expect(v).toBeGreaterThanOrEqual(0.15);
    expect(v).toBeLessThanOrEqual(0.30);
  });

  it("calib(0.50) ∈ [0.45, 0.55]", () => {
    const v = calibHexisFit(0.5);
    expect(v).toBeGreaterThanOrEqual(0.45);
    expect(v).toBeLessThanOrEqual(0.55);
  });

  it("calib(0.75) ∈ [0.70, 0.85]", () => {
    const v = calibHexisFit(0.75);
    expect(v).toBeGreaterThanOrEqual(0.70);
    expect(v).toBeLessThanOrEqual(0.85);
  });

  it("calib(1.0) ≥ 0.95", () => {
    expect(calibHexisFit(1.0)).toBeGreaterThanOrEqual(0.95);
  });

  it("is monotone non-decreasing across N=1000 pairs", { timeout: 15_000 }, () => {
    let prev = calibHexisFit(0);
    for (let i = 1; i <= 1000; i++) {
      const x = i / 1000;
      const curr = calibHexisFit(x);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });

  it("clamps inputs below 0 and above 1", () => {
    expect(calibHexisFit(-0.5)).toBe(calibHexisFit(0));
    expect(calibHexisFit(1.5)).toBe(calibHexisFit(1));
  });

  it("HEXIS_DISABLE_CALIB=1 returns identity", () => {
    process.env.HEXIS_DISABLE_CALIB = "1";
    expect(calibHexisFit(0)).toBe(0);
    expect(calibHexisFit(0.37)).toBe(0.37);
    expect(calibHexisFit(1)).toBe(1);
  });
});

describe("computeAmbiguityGate", () => {
  afterEach(() => {
    delete process.env.HEXIS_DISABLE_GATE;
  });

  const W = 7;
  const eps = 0.001;
  const buildHits = (scores: number[]) => scores.map((s, i) => makeHit(`h${i}`, s));

  it("returns 1.0 when gap=0 at boundary", () => {
    const scores = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4];
    expect(computeAmbiguityGate(buildHits(scores), W, eps)).toBe(1.0);
  });

  it("returns 0.0 when gap ≥ 4*eps", () => {
    const scores = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4 - 4 * eps];
    expect(computeAmbiguityGate(buildHits(scores), W, eps)).toBe(0.0);
  });

  it("returns interior ratio between eps and 4*eps (linear decay)", () => {
    const scores = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4 - 2 * eps];
    const v = computeAmbiguityGate(buildHits(scores), W, eps);
    expect(v).toBeCloseTo((4 * eps - 2 * eps) / (3 * eps), 10);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it("returns ~0.5 at the midpoint of the interior band", () => {
    const gap = 2.5 * eps;
    const scores = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4 - gap];
    const v = computeAmbiguityGate(buildHits(scores), W, eps);
    expect(v).toBeGreaterThan(0.5 - 0.01);
    expect(v).toBeLessThan(0.5 + 0.01);
  });

  it("returns 1.0 when fewer than W+1 hits", () => {
    expect(computeAmbiguityGate(buildHits([1, 0.9, 0.8]), W, eps)).toBe(1.0);
  });

  it("returns 0.0 when empty", () => {
    expect(computeAmbiguityGate([], W, eps)).toBe(0.0);
  });

  it("HEXIS_DISABLE_GATE=1 forces 1.0 even on wide gap", () => {
    process.env.HEXIS_DISABLE_GATE = "1";
    const scores = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.0];
    expect(computeAmbiguityGate(buildHits(scores), W, eps)).toBe(1.0);
  });
});

describe("applyHexisToHits env-gate parity and bypass modes", () => {
  beforeEach(() => {
    delete process.env.HEXIS_DISABLE_CALIB;
    delete process.env.HEXIS_DISABLE_GATE;
  });

  const buildSignalHexis = () => normalizeHexis({
    userId: "u1",
    hint: {
      label: "capture frame",
      goals: ["capture hook"],
      topicBias: { capture: 1 },
    },
  });

  const buildHits = (): SearchHit[] => [
    { id: "m1", text: "capture hook details", score: 1.0 },
    { id: "m2", text: "generic note 2", score: 0.9 },
    { id: "m3", text: "generic note 3", score: 0.8 },
    { id: "m4", text: "generic note 4", score: 0.7 },
    { id: "m5", text: "generic note 5", score: 0.6 },
    { id: "m6", text: "capture hook specifics", score: 0.5 },
    { id: "m7", text: "generic note 7", score: 0.4 },
    { id: "m8", text: "generic note 8", score: 0.3995 },
  ];

  it("emits audit scalars for every hit with hexisMode=0 in the normal path", () => {
    const hexis = buildSignalHexis();
    const hits = buildHits();
    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 7, gateEpsilon: 0.001 });
    for (const hit of result) {
      expect(typeof hit.preHexisScore).toBe("number");
      expect(typeof hit.postHexisScore).toBe("number");
      expect(typeof hit.poolRank).toBe("number");
      expect(typeof hit.boundaryGap).toBe("number");
      expect(typeof hit.gateValue).toBe("number");
      expect(typeof hit.hexisMode).toBe("number");
    }
    expect(result.some((h) => h.hexisMode === 0)).toBe(true);
  });

  it("sets hexisMode=5 and omits scoreStages.hexis when hexis has no signal", () => {
    const empty = normalizeHexis({ userId: "u1", hint: { label: "empty frame" } });
    const hits = buildHits();
    const result = applyHexisToHits(hits, empty, { maxRankWindow: 7 });
    for (const hit of result) {
      expect(hit.hexisMode).toBe(5);
      expect(hit.gateValue).toBe(0);
      expect(hit.postHexisScore).toBe(hit.preHexisScore);
      expect(hit.scoreStages?.hexis).toBeUndefined();
    }
  });

  it("sets hexisMode=2 and omits scoreStages.hexis when gate computes to 0", () => {
    const hexis = buildSignalHexis();
    const hits: SearchHit[] = [
      { id: "m1", text: "capture hook details", score: 1.0 },
      { id: "m2", text: "generic note 2", score: 0.9 },
      { id: "m3", text: "generic note 3", score: 0.8 },
      { id: "m4", text: "generic note 4", score: 0.7 },
      { id: "m5", text: "generic note 5", score: 0.6 },
      { id: "m6", text: "capture hook specifics", score: 0.5 },
      { id: "m7", text: "generic note 7", score: 0.4 },
      { id: "m8", text: "generic note 8", score: 0.0 },
    ];
    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 7, gateEpsilon: 0.001 });
    for (const hit of result) {
      expect(hit.hexisMode).toBe(2);
      expect(hit.gateValue).toBe(0);
      expect(hit.postHexisScore).toBe(hit.preHexisScore);
      expect(hit.scoreStages?.hexis).toBeUndefined();
    }
  });

  it("HEXIS_DISABLE_GATE=1 yields hexisMode=3, gateValue=1, boost applied", () => {
    process.env.HEXIS_DISABLE_GATE = "1";
    const hexis = buildSignalHexis();
    const hits = buildHits();
    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 7, gateEpsilon: 0.001 });
    const admissibleBoosted = result.find((h) => h.scoreStages?.hexis);
    expect(admissibleBoosted?.hexisMode).toBe(3);
    expect(admissibleBoosted?.gateValue).toBe(1);
    expect(admissibleBoosted?.postHexisScore).toBeGreaterThan(admissibleBoosted!.preHexisScore!);
  });

  it("HEXIS_DISABLE_CALIB=1 yields hexisMode=4 and uses identity fit in the boost", () => {
    process.env.HEXIS_DISABLE_CALIB = "1";
    const hexis = buildSignalHexis();
    const hits = buildHits();
    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 7, gateEpsilon: 0.001 });
    const admissibleBoosted = result.find((h) => h.scoreStages?.hexis);
    expect(admissibleBoosted?.hexisMode).toBe(4);
    const fit = admissibleBoosted?.hexisFit ?? 0;
    const hexisMatch = hexis.relevanceWeights.hexisMatch;
    const expected = 1.0 * 1.0 * fit * hexisMatch * 0.25;
    expect(admissibleBoosted?.scoreStages?.hexis?.boost).toBeCloseTo(expected, 12);
  });

  it("admissibility blocks (scope/role/authority) zero the fit before calibration", () => {
    const hexis = normalizeHexis({
      userId: "u1",
      hint: {
        label: "blocked frame",
        goals: ["stabilize recall"],
        topicBias: { semiote: 1 },
        admissibility: {
          allowedScopes: ["session"],
          allowedMemoryRoles: ["architecture_reference"],
          minAuthority: 0.5,
        },
      },
    });

    const scopeBlocked = scoreHexisFit({ text: "semiote", scope: "agent" }, hexis);
    const roleBlocked = scoreHexisFit({ text: "semiote", memoryRole: "operational_noise" }, hexis);
    const authBlocked = scoreHexisFit({ text: "semiote", authorityScore: 0.1 }, hexis);

    expect(scopeBlocked.fit).toBe(0);
    expect(roleBlocked.fit).toBe(0);
    expect(authBlocked.fit).toBe(0);
    expect(calibHexisFit(scopeBlocked.fit)).toBeLessThanOrEqual(0.05);
  });

  it("non-admissible hits (outside window) preserve preHexisScore and receive gate metadata", () => {
    const hexis = buildSignalHexis();
    const hits: SearchHit[] = [];
    for (let i = 0; i < 10; i++) {
      hits.push({ id: `m${i}`, text: `note ${i}`, score: 1 - i * 0.05 });
    }
    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 7, scoreEpsilon: 0, gateEpsilon: 0.001 });
    const outside = result.find((h) => h.id === "m9");
    expect(outside?.postHexisScore).toBe(outside?.preHexisScore);
    expect(outside?.scoreStages?.hexis).toBeUndefined();
    expect(typeof outside?.gateValue).toBe("number");
  });

  it("combined HEXIS_DISABLE_CALIB=1 and HEXIS_DISABLE_GATE=1 with lambda=1 reproduces v1.5 boost exactly", () => {
    process.env.HEXIS_DISABLE_CALIB = "1";
    process.env.HEXIS_DISABLE_GATE = "1";
    const hexis = buildSignalHexis();
    const hits = buildHits();
    const result = applyHexisToHits(hits, hexis, { maxRankWindow: 7, lambda: 1.0, gateEpsilon: 0.001 });
    for (const hit of result) {
      if (hit.scoreStages?.hexis) {
        const fit = hit.hexisFit ?? 0;
        const hexisMatch = hexis.relevanceWeights.hexisMatch;
        const v15Boost = fit * hexisMatch * 0.25;
        expect(hit.scoreStages.hexis.boost).toBe(v15Boost);
        expect(hit.postHexisScore).toBe(hit.preHexisScore! + v15Boost);
      }
    }
  });
});
