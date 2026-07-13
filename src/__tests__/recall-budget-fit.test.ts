/**
 * OM-1 (Rúnir-tfxt.1): budget-aware projection tests.
 *
 * Covers the four contract points of the budget fit:
 *   1. NO-BUDGET IDENTITY — absent/undefined/malformed budgetTokens produce
 *      output byte-identical (JSON.stringify) to the pre-OM-1 pipeline, and
 *      never throw (the attribution-replay gate, enforced at the unit seam).
 *   2. BUDGET RESPECTED — the wrapped injection stays under the ceiling for
 *      several budgets, including tiny ones (possibly by emptying the payload;
 *      budget is a ceiling, not a target).
 *   3. DEPTH-DEGRADATION ORDERING — verbose renderings degrade uniformly
 *      (full → l1 → l0) before ANY item is dropped; the drop phase cuts the
 *      lowest-value tail so the kept set is a prefix of the ranked selection.
 *   4. DETERMINISM — identical inputs give identical outputs.
 */
import { describe, it, expect } from "vitest";
import {
  fitSelectionToBudget,
  formatAtDepth,
  formatRecallInjectionFromRendered,
  postProcessRecallResults,
  resolveBudgetTokens,
} from "../recall/selection/recall-selection";
import { approximateTokens } from "../recall/policy/preference-packet";
import type { IntentSignal, QueryIntent, RecallDepth } from "../recall/intent/intent-analyzer";
import type { SearchHit } from "../domain/memory/types";

function makeIntent(label: QueryIntent = "fact", depth: RecallDepth = "full"): IntentSignal {
  return { categories: [], depth, confidence: 0.8, label };
}

/**
 * A hit whose l0/l1/full renderings differ meaningfully in length. First
 * sentences are deliberately dissimilar (distinct subjects/vocabulary) so
 * collapseContradictions' Jaccard dedup never collapses the fixture.
 */
function makeHit(id: string, score: number, first: string, abstract: string): SearchHit {
  return {
    id,
    score,
    text: `${first} ${`Extended rationale recorded for ${id} covering alternatives weighed and rejected during review. `.repeat(4)}`,
    l0: abstract,
    l1: `${abstract}\n${first}`,
    createdAt: "2026-06-01T00:00:00.000Z",
    tags: [],
  };
}

const HITS: SearchHit[] = [
  makeHit("hit-a", 0.9, "The payments gateway in production listens on port 8001 behind the mesh.", "Payments gateway: port 8001."),
  makeHit("hit-b", 0.8, "Redis caching was disabled after the March outage investigation concluded.", "Redis caching: disabled."),
  makeHit("hit-c", 0.7, "The frontend build migrated from webpack to vite during spring cleanup.", "Frontend build: vite."),
];

function wrappedTokensAt(hits: SearchHit[], depth: RecallDepth): number {
  const lines = hits.map((h) =>
    formatAtDepth({ text: h.text, l2: h.text, l0: h.l0, l1: h.l1 }, h.exactQaCandidate ? "full" : depth),
  );
  const wrapped = formatRecallInjectionFromRendered(lines);
  return wrapped ? approximateTokens(wrapped) : 0;
}

describe("resolveBudgetTokens — malformed-input guard", () => {
  it("accepts finite positive numbers, flooring fractions", () => {
    expect(resolveBudgetTokens(512)).toBe(512);
    expect(resolveBudgetTokens(1)).toBe(1);
    expect(resolveBudgetTokens(99.9)).toBe(99);
  });

  it("rejects everything else as undefined without throwing", () => {
    const malformed: unknown[] = [
      undefined, null, 0, -1, -0.5, 0.4, NaN, Infinity, -Infinity,
      "512", "", true, false, {}, [], [512], () => 512, Symbol("x"), 10n as unknown,
    ];
    for (const value of malformed) {
      expect(() => resolveBudgetTokens(value)).not.toThrow();
      expect(resolveBudgetTokens(value)).toBeUndefined();
    }
  });
});

describe("fitSelectionToBudget — ceiling + degradation ladder", () => {
  const fullTokens = wrappedTokensAt(HITS, "full");
  const l1Tokens = wrappedTokensAt(HITS, "l1");
  const l0Tokens = wrappedTokensAt(HITS, "l0");

  it("fixture sanity: depths are strictly ordered in cost", () => {
    expect(fullTokens).toBeGreaterThan(l1Tokens);
    expect(l1Tokens).toBeGreaterThan(l0Tokens);
    expect(l0Tokens).toBeGreaterThan(0);
  });

  it("budget >= full cost: keeps today's rendering exactly, no degradation", () => {
    const fit = fitSelectionToBudget(HITS, "full", fullTokens);
    expect(fit.selected.map((h) => h.id)).toEqual(["hit-a", "hit-b", "hit-c"]);
    expect(fit.renderedText).toEqual(HITS.map((h) => formatAtDepth({ text: h.text, l2: h.text, l0: h.l0, l1: h.l1 }, "full")));
    expect(fit.budgetFit).toEqual({
      budgetTokens: fullTokens,
      approximateTokens: fullTokens,
      depth: "full",
      degraded: false,
      droppedIds: [],
    });
  });

  it("budget between l1 and full: degrades all items to l1 before dropping any", () => {
    const fit = fitSelectionToBudget(HITS, "full", fullTokens - 1);
    expect(fit.selected).toHaveLength(3);
    expect(fit.budgetFit.depth).toBe("l1");
    expect(fit.budgetFit.degraded).toBe(true);
    expect(fit.budgetFit.droppedIds).toEqual([]);
    expect(fit.budgetFit.approximateTokens).toBeLessThanOrEqual(fullTokens - 1);
  });

  it("budget between l0 and l1: degrades all items to l0, still no drops", () => {
    const fit = fitSelectionToBudget(HITS, "full", l1Tokens - 1);
    expect(fit.selected).toHaveLength(3);
    expect(fit.budgetFit.depth).toBe("l0");
    expect(fit.budgetFit.droppedIds).toEqual([]);
    expect(fit.budgetFit.approximateTokens).toBeLessThanOrEqual(l1Tokens - 1);
  });

  it("budget below the all-l0 cost: drops the LOWEST-value tail, keeps a ranked prefix", () => {
    const fit = fitSelectionToBudget(HITS, "full", l0Tokens - 1);
    expect(fit.selected.length).toBeLessThan(3);
    expect(fit.selected.length).toBeGreaterThan(0);
    // Prefix property: survivors are the highest-value items in original order.
    expect(fit.selected.map((h) => h.id)).toEqual(HITS.slice(0, fit.selected.length).map((h) => h.id));
    expect(fit.budgetFit.droppedIds).toEqual(HITS.slice(fit.selected.length).map((h) => h.id));
    expect(fit.budgetFit.approximateTokens).toBeLessThanOrEqual(l0Tokens - 1);
  });

  it("tiny budget: empties the payload rather than exceeding the ceiling", () => {
    const fit = fitSelectionToBudget(HITS, "full", 1);
    expect(fit.selected).toEqual([]);
    expect(fit.renderedText).toEqual([]);
    expect(fit.budgetFit.approximateTokens).toBe(0);
    expect(fit.budgetFit.droppedIds).toEqual(["hit-a", "hit-b", "hit-c"]);
  });

  it("respects the ceiling across a sweep of budgets", () => {
    for (const budget of [1, 10, 25, 40, l0Tokens, l1Tokens, fullTokens, fullTokens + 100]) {
      const fit = fitSelectionToBudget(HITS, "full", budget);
      expect(fit.budgetFit.approximateTokens).toBeLessThanOrEqual(budget);
      const rewrapped = formatRecallInjectionFromRendered(fit.renderedText);
      expect(rewrapped ? approximateTokens(rewrapped) : 0).toBeLessThanOrEqual(budget);
    }
  });

  it("ladder starts at the intent depth (l0 intent never renders deeper)", () => {
    const fit = fitSelectionToBudget(HITS, "l0", 10_000);
    expect(fit.budgetFit.depth).toBe("l0");
    expect(fit.budgetFit.degraded).toBe(false);
  });

  it("exact-QA hits always render full; only the drop phase can shrink them", () => {
    const exactQa: SearchHit = {
      ...makeHit("hit-qa", 0.95, "The staging database snapshot rotates every four hours at minute twelve.", "Staging snapshot: 4h cadence."),
      exactQaCandidate: true,
    };
    const fit = fitSelectionToBudget([exactQa, ...HITS], "full", l1Tokens);
    const qaIndex = fit.selected.findIndex((h) => h.id === "hit-qa");
    if (qaIndex >= 0) {
      expect(fit.renderedText[qaIndex]).toBe(exactQa.text);
    } else {
      expect(fit.budgetFit.droppedIds).toContain("hit-qa");
    }
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    for (const budget of [1, 30, l0Tokens, l1Tokens, fullTokens]) {
      const first = fitSelectionToBudget(HITS, "full", budget);
      const second = fitSelectionToBudget(HITS, "full", budget);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });
});

describe("postProcessRecallResults — budget integration + no-budget identity", () => {
  // nowMs pinned: status-class selector profiles fold recency into scores via
  // Date.now() when unset, which would make byte-identity comparisons flaky.
  const FIXED_NOW_MS = Date.parse("2026-06-15T00:00:00.000Z");
  const baseOpts = { intent: makeIntent(), topK: 3, nowMs: FIXED_NOW_MS };

  it("NO-BUDGET IDENTITY: absent, undefined, and malformed budgets are byte-identical to baseline", () => {
    const baseline = postProcessRecallResults(HITS, baseOpts);
    const candidates: Array<Record<string, unknown>> = [
      {},
      { budgetTokens: undefined },
      { budgetTokens: 0 },
      { budgetTokens: -50 },
      { budgetTokens: NaN },
      { budgetTokens: Infinity },
      { budgetTokens: "512" },
      { budgetTokens: null },
      { budgetTokens: {} },
      { budgetTokens: true },
    ];
    for (const extra of candidates) {
      const result = postProcessRecallResults(HITS, { ...baseOpts, ...extra } as typeof baseOpts);
      expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
      expect(result).toEqual(baseline);
      expect("budgetFit" in result).toBe(false);
    }
  });

  it("malformed budgets never throw", () => {
    for (const bad of [NaN, -1, 0, Infinity, "x", null, [], {}]) {
      expect(() =>
        postProcessRecallResults(HITS, { ...baseOpts, budgetTokens: bad as unknown as number }),
      ).not.toThrow();
    }
  });

  it("generous budget: same selection/rendering as baseline, plus the audit", () => {
    const baseline = postProcessRecallResults(HITS, baseOpts);
    const result = postProcessRecallResults(HITS, { ...baseOpts, budgetTokens: 100_000 });
    expect(result.selected).toEqual(baseline.selected);
    expect(result.renderedText).toEqual(baseline.renderedText);
    expect(result.accessTrackedIds).toEqual(baseline.accessTrackedIds);
    expect(result.budgetFit).toBeDefined();
    expect(result.budgetFit!.degraded).toBe(false);
    expect(result.budgetFit!.droppedIds).toEqual([]);
  });

  it("tight budget: degrades rendering without changing which items rank first", () => {
    const baseline = postProcessRecallResults(HITS, baseOpts);
    const baselineTokens = approximateTokens(formatRecallInjectionFromRendered(baseline.renderedText) ?? "");
    const result = postProcessRecallResults(HITS, { ...baseOpts, budgetTokens: baselineTokens - 1 });
    // Ranking untouched: fitted selection is a prefix of the baseline selection.
    expect(result.selected.map((h) => h.id)).toEqual(
      baseline.selected.slice(0, result.selected.length).map((h) => h.id),
    );
    expect(result.budgetFit).toBeDefined();
    expect(result.budgetFit!.approximateTokens).toBeLessThanOrEqual(baselineTokens - 1);
  });

  it("tiny budget: empty payload, empty access tracking, all baseline items dropped", () => {
    const baseline = postProcessRecallResults(HITS, baseOpts);
    const result = postProcessRecallResults(HITS, { ...baseOpts, budgetTokens: 1 });
    expect(result.selected).toEqual([]);
    expect(result.renderedText).toEqual([]);
    expect(result.accessTrackedIds).toEqual([]);
    expect(result.budgetFit!.droppedIds).toEqual(baseline.selected.map((h) => h.id));
    // Dropped items flow into `dropped`, not the payload.
    for (const hit of baseline.selected) {
      expect(result.dropped.map((d) => d.id)).toContain(hit.id);
    }
  });

  it("session_opener intent: budget is ignored (fit never applies to the retired opener)", () => {
    const openerOpts = { intent: makeIntent("session_opener"), topK: 3, nowMs: FIXED_NOW_MS };
    const baseline = postProcessRecallResults(HITS, openerOpts);
    const result = postProcessRecallResults(HITS, { ...openerOpts, budgetTokens: 5 });
    expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
    expect("budgetFit" in result).toBe(false);
  });

  it("compaction intents: the line fit never applies (payload-shaped; OM-2 fit runs downstream instead)", () => {
    for (const label of ["pre_compaction", "post_compaction_validation"] as const) {
      const opts = { intent: makeIntent(label), topK: 3, nowMs: FIXED_NOW_MS };
      const baseline = postProcessRecallResults(HITS, opts);
      const result = postProcessRecallResults(HITS, { ...opts, budgetTokens: 5 });
      expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
      expect("budgetFit" in result).toBe(false);
    }
  });

  it("determinism at the pipeline level", () => {
    const a = postProcessRecallResults(HITS, { ...baseOpts, budgetTokens: 60 });
    const b = postProcessRecallResults(HITS, { ...baseOpts, budgetTokens: 60 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
