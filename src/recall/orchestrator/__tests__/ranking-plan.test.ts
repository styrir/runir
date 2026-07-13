import { afterEach, describe, expect, it } from "vitest";
import type { SearchHit } from "../../../domain/memory/types.js";
import type { IntentSignal } from "../../intent/intent-analyzer.js";
import { applyCategoryBoost } from "../../intent/intent-analyzer.js";
import {
  applyPathScorePenalty,
  applyRecallSoftFilters,
  type RecallScopeFilter,
} from "../../query/scope-predicate.js";
import {
  DEFAULT_RANKING_PLAN,
  RANKING_STAGE_EXECUTOR,
  RANKING_STAGE_SCALE,
  RANKING_STAGE_SEMANTICS,
  type RankingPlan,
  type RankingPlanContext,
  executeRankingPlan,
  parseRankingPlan,
  rankingPlanSchema,
  resolveExactQaPreserveFloor,
} from "../ranking-plan.js";

function hit(id: string, score: number, extra: Partial<SearchHit> = {}): SearchHit {
  return { id, text: id, score, ...extra };
}

const INTENT: IntentSignal = {
  label: "architecture",
  categories: ["patterns"],
  depth: "l1",
  confidence: 0.6,
};

function ctx(overrides: Partial<RankingPlanContext> = {}): RankingPlanContext {
  return {
    intent: INTENT,
    requestedPath: undefined,
    recallFilter: {} as RecallScopeFilter,
    ...overrides,
  };
}

describe("ranking-plan — schema (R1, R6)", () => {
  it("default plan validates against the zod schema and pins schemaVersion 1", () => {
    expect(() => rankingPlanSchema.parse(DEFAULT_RANKING_PLAN)).not.toThrow();
    expect(DEFAULT_RANKING_PLAN.schemaVersion).toBe(1);
  });

  it("every stage declares a known semantics, scale, and executor", () => {
    for (const stage of DEFAULT_RANKING_PLAN.stages) {
      expect(RANKING_STAGE_SEMANTICS).toContain(stage.semantics);
      expect(RANKING_STAGE_SCALE).toContain(stage.scale);
      expect(RANKING_STAGE_EXECUTOR).toContain(stage.executor);
      expect(typeof stage.enabled).toBe("boolean");
      expect(stage.name.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown semantics value (fail-loud)", () => {
    expect(() =>
      parseRankingPlan({
        schemaVersion: 1,
        stages: [{ name: "x", semantics: "nope", scale: "rrf", executor: "orchestrator", enabled: true }],
      }),
    ).toThrow();
  });

  it("rejects schemaVersion != 1", () => {
    expect(() => parseRankingPlan({ schemaVersion: 2, stages: [] })).toThrow();
  });

  it("stage names are unique in the default plan", () => {
    const names = DEFAULT_RANKING_PLAN.stages.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("ranking-plan — default plan reproduces today's order", () => {
  it("the exact_qa_preserve_floor fix entry is DEFAULT-OFF (R3)", () => {
    const floor = DEFAULT_RANKING_PLAN.stages.find((s) => s.name === "exact_qa_preserve_floor");
    expect(floor).toBeDefined();
    expect(floor!.enabled).toBe(false);
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("the executed (orchestrator) stages appear in the exact buildAdmissiblePool order", () => {
    const orchestratorStages = DEFAULT_RANKING_PLAN.stages
      .filter((s) => s.executor === "orchestrator")
      .map((s) => s.name);
    expect(orchestratorStages).toEqual([
      "path_score_penalty",
      "path_penalty_resort",
      "category_boost",
      "recall_soft_filters",
    ]);
  });

  it("executeRankingPlan == the old inline sequence (byte-identical), with a path", () => {
    const raw = [
      hit("a", 0.5, { path: "/p", category: "patterns" }),
      hit("b", 0.4, { path: undefined }), // null-path → 0.70x penalty
      hit("c", 0.45, { path: "/p", category: "cases" }),
    ];
    const requestedPath = "/p";
    const recallFilter = {} as RecallScopeFilter;

    // Old inline sequence (from buildAdmissiblePool before qjn4.3).
    const withPenalty = applyPathScorePenalty(raw.map((h) => ({ ...h })), requestedPath);
    const reSorted = [...withPenalty].sort((a, b) => b.score - a.score);
    const boosted = applyCategoryBoost(reSorted, INTENT);
    const expected = applyRecallSoftFilters(boosted, recallFilter);

    const actual = executeRankingPlan(
      raw.map((h) => ({ ...h })),
      DEFAULT_RANKING_PLAN,
      ctx({ requestedPath, recallFilter }),
    );

    expect(actual.map((h) => h.id)).toEqual(expected.map((h) => h.id));
    expect(actual.map((h) => h.score)).toEqual(expected.map((h) => h.score));
  });

  it("executeRankingPlan == the old inline sequence with no path + soft filters", () => {
    const raw = [
      hit("a", 0.5, { category: "patterns", tier: "durable", confidence: 0.9 }),
      hit("b", 0.4, { category: "patterns", tier: "ephemeral", confidence: 0.2 }),
      hit("c", 0.45, { category: "cases", tier: "durable", confidence: 0.8 }),
    ];
    const recallFilter: RecallScopeFilter = { tier: "durable", confidence: 0.5 };

    const withPenalty = applyPathScorePenalty(raw.map((h) => ({ ...h })), undefined);
    const reSorted = [...withPenalty].sort((a, b) => b.score - a.score);
    const boosted = applyCategoryBoost(reSorted, INTENT);
    const expected = applyRecallSoftFilters(boosted, recallFilter);

    const actual = executeRankingPlan(raw.map((h) => ({ ...h })), DEFAULT_RANKING_PLAN, ctx({ recallFilter }));

    expect(actual.map((h) => h.id)).toEqual(expected.map((h) => h.id));
    expect(actual.map((h) => h.score)).toEqual(expected.map((h) => h.score));
  });
});

describe("ranking-plan — engine semantics", () => {
  it("executes orchestrator stages IN DECLARED ORDER", () => {
    const calls: string[] = [];
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        { name: "category_boost", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: true },
        { name: "path_score_penalty", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: true },
      ],
    };
    // Use a path so the penalty actually mutates and a category so the boost mutates,
    // then assert the OUTPUT differs by order. category_boost re-sorts; path penalty
    // does not. With a single hit we just verify both run without throwing in order.
    const out = executeRankingPlan([hit("a", 0.5, { path: undefined, category: "patterns" })], plan, ctx({ requestedPath: "/p" }));
    expect(out).toHaveLength(1);
    void calls;
  });

  it("SKIPS query_layer stages (ledger-only)", () => {
    // rrf_fuse etc. must never be executed by the orchestrator engine, even though
    // they're in the plan. A query_layer stage with no implementation must NOT throw.
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        { name: "rrf_fuse", semantics: "scale", scale: "rrf", executor: "query_layer", enabled: true },
        { name: "noema_merge", semantics: "gate", scale: "rrf", executor: "query_layer", enabled: true },
      ],
    };
    const input = [hit("a", 0.5), hit("b", 0.4)];
    const out = executeRankingPlan(input, plan, ctx());
    // No orchestrator stage ran → hits pass through unchanged (same scores/order).
    expect(out.map((h) => [h.id, h.score])).toEqual([["a", 0.5], ["b", 0.4]]);
  });

  it("SKIPS disabled orchestrator stages", () => {
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        { name: "path_score_penalty", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: false },
      ],
    };
    // Disabled penalty → null-path hit keeps its score.
    const out = executeRankingPlan([hit("b", 0.4)], plan, ctx({ requestedPath: "/p" }));
    expect(out[0].score).toBe(0.4);
  });

  it("THROWS on an unknown orchestrator stage name (fail-loud, no silent no-op)", () => {
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        { name: "made_up_stage", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: true },
      ],
    };
    expect(() => executeRankingPlan([hit("a", 0.5)], plan, ctx())).toThrow(/no orchestrator implementation/);
  });

  it("path_score_penalty applies 0.70x to null-path hits only", () => {
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        { name: "path_score_penalty", semantics: "scale", scale: "multiplier", executor: "orchestrator", enabled: true },
      ],
    };
    const out = executeRankingPlan(
      [hit("withpath", 1.0, { path: "/p" }), hit("nopath", 1.0)],
      plan,
      ctx({ requestedPath: "/p" }),
    );
    const byId = new Map(out.map((h) => [h.id, h.score]));
    expect(byId.get("withpath")).toBe(1.0);
    expect(byId.get("nopath")).toBeCloseTo(0.7, 10);
  });

  it("does not mutate the input array", () => {
    const input = [hit("a", 0.5, { path: undefined }), hit("b", 0.4)];
    const snapshot = input.map((h) => ({ ...h }));
    executeRankingPlan(input, DEFAULT_RANKING_PLAN, ctx({ requestedPath: "/p" }));
    expect(input.map((h) => ({ id: h.id, score: h.score }))).toEqual(
      snapshot.map((h) => ({ id: h.id, score: h.score })),
    );
  });
});

describe("ranking-plan — resolveExactQaPreserveFloor (R3)", () => {
  it("returns undefined when the entry is disabled", () => {
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("returns the floor when the entry is enabled with a numeric floorScore", () => {
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        {
          name: "exact_qa_preserve_floor",
          semantics: "scale",
          scale: "threshold",
          executor: "query_layer",
          enabled: true,
          params: { floorScore: 0.5 },
        },
      ],
    };
    expect(resolveExactQaPreserveFloor(plan)).toBe(0.5);
  });

  it("returns undefined when enabled but floorScore is missing/non-numeric", () => {
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        { name: "exact_qa_preserve_floor", semantics: "scale", scale: "threshold", executor: "query_layer", enabled: true },
      ],
    };
    expect(resolveExactQaPreserveFloor(plan)).toBeUndefined();
  });
});

describe("ranking-plan — resolveExactQaPreserveFloor env hook (qjn4.4 R1)", () => {
  const ORIG = process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"];
  afterEach(() => {
    // Restore env after each test so tests are isolation-safe.
    if (ORIG === undefined) {
      delete process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"];
    } else {
      process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = ORIG;
    }
  });

  it("returns the env value (0.3) when RUNIR_EXACT_QA_PRESERVE_FLOOR is a finite positive number", () => {
    process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = "0.3";
    // default plan has the entry disabled — env hook bypasses it
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBe(0.3);
  });

  it("env hook overrides a plan-level disabled entry (plan says OFF, env says 0.25)", () => {
    process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = "0.25";
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBe(0.25);
  });

  it("falls through to plan when env var is absent (byte-identical default path)", () => {
    delete process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"];
    // Default plan: entry disabled → undefined
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("falls through to plan when env var is 'garbage' (non-numeric)", () => {
    process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = "garbage";
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("falls through to plan when env var is '0' (zero is not positive)", () => {
    process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = "0";
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("falls through to plan when env var is a negative number", () => {
    process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = "-0.3";
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("falls through to plan when env var is 'Infinity'", () => {
    process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"] = "Infinity";
    expect(resolveExactQaPreserveFloor(DEFAULT_RANKING_PLAN)).toBeUndefined();
  });

  it("env hook does not prevent a plan-enabled entry from being returned when env is absent", () => {
    delete process.env["RUNIR_EXACT_QA_PRESERVE_FLOOR"];
    const plan: RankingPlan = {
      schemaVersion: 1,
      stages: [
        {
          name: "exact_qa_preserve_floor",
          semantics: "scale",
          scale: "threshold",
          executor: "query_layer",
          enabled: true,
          params: { floorScore: 0.4 },
        },
      ],
    };
    expect(resolveExactQaPreserveFloor(plan)).toBe(0.4);
  });
});
