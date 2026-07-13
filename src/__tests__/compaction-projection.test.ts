/**
 * OM-2 (Rúnir-tfxt.2): compaction-render projection unit contract.
 *
 * Locks:
 *   1. RENDERER — honest `compaction_projection:` root + `phase:` line; the
 *      post_validation profile is the recite-back trim (no env, no
 *      evidence_titles); warnings always render.
 *   2. FIT — budget is a hard ceiling measured on the WRAPPED injection;
 *      drop-only and prefix-only over the ranked hits; honest empty (null
 *      payload) when even the projectState-only render exceeds the ceiling.
 *   3. NO-BUDGET IDENTITY — absent/invalid budgets never change the payload
 *      and never emit an audit (mirrors the OM-1 contract).
 *   4. DETERMINISM — identical inputs give identical outputs.
 */
import { describe, it, expect } from "vitest";
import {
  fitCompactionProjectionToBudget,
  formatCompactionProjectionInjection,
  renderCompactionProjectionYaml,
} from "../recall/continuity/compaction-projection.js";
import { approximateTokens } from "../recall/policy/preference-packet.js";
import type { ProjectStateRecord } from "../domain/memory/lifecycle.js";
import type { SearchHit, SessionOpenerPayload } from "../domain/memory/types.js";

const PROJECT_STATE: ProjectStateRecord = {
  id: "ps-1",
  userId: "owner",
  projectKey: "proj-1",
  path: "/tmp/proj",
  currentFocus: "Finish the exporter operability follow-up",
  activeTicketIds: [],
  latestProgress: "Exporter re-point landed and live-verified",
  blockers: [],
  nextSteps: ["Wire the CLI runner"],
  updatedAt: "2026-07-01T00:00:00Z",
  supportingMemoryIds: [],
  confidence: 0.9,
  version: 1,
};

const HITS: SearchHit[] = [
  { id: "hit-1", text: "Current status: exporter stage logging verified end to end", score: 0.9, memoryRole: "current_status" },
  { id: "hit-2", text: "Recent work: tenant-scoped export swept 84 stale files cleanly", score: 0.7, memoryRole: "recent_work" },
  { id: "hit-3", text: "Handoff: resume from the batched mention-count follow-up next session", score: 0.5, memoryRole: "session_handoff" },
];

function buildPayload(): SessionOpenerPayload {
  const fit = fitCompactionProjectionToBudget({
    projectState: PROJECT_STATE,
    hits: HITS,
    requestedPath: "/tmp/proj",
    profile: "pre",
    intentDepth: "l1",
  });
  expect(fit.payload).not.toBeNull();
  return fit.payload!;
}

describe("renderCompactionProjectionYaml — profiles", () => {
  it("renders the honest root key and phase line, never the opener root", () => {
    const payload = buildPayload();
    const pre = renderCompactionProjectionYaml(payload, "pre");
    const post = renderCompactionProjectionYaml(payload, "post_validation");
    expect(pre.startsWith("compaction_projection:")).toBe(true);
    expect(pre).toContain("  phase: pre");
    expect(post).toContain("  phase: post_validation");
    expect(pre).not.toContain("session_opener:");
    expect(post).not.toContain("session_opener:");
  });

  it("post_validation profile is the recite-back trim: no env, no evidence_titles", () => {
    const payload = buildPayload();
    const pre = renderCompactionProjectionYaml(payload, "pre");
    const post = renderCompactionProjectionYaml(payload, "post_validation");
    expect(pre).toContain("  env:");
    expect(pre).toContain("  evidence_titles:");
    expect(post).not.toContain("  env:");
    expect(post).not.toContain("  evidence_titles:");
    // The recite-back core survives the trim.
    for (const section of ["  focus:", "  state:", "  next:", "  directives:", "  status:"]) {
      expect(post).toContain(section);
    }
  });

  it("warnings render on both profiles (honesty signals are never trimmed)", () => {
    const payload = { ...buildPayload(), warnings: ["path_fallback_used" as const] };
    expect(renderCompactionProjectionYaml(payload, "pre")).toContain("  warnings:");
    expect(renderCompactionProjectionYaml(payload, "post_validation")).toContain("  warnings:");
  });

  it("wraps in the untrusted-data envelope", () => {
    const wrapped = formatCompactionProjectionInjection(buildPayload(), "pre");
    expect(wrapped.startsWith("<relevant-memories>")).toBe(true);
    expect(wrapped).toContain("[UNTRUSTED DATA");
    expect(wrapped.endsWith("</relevant-memories>")).toBe(true);
  });
});

describe("fitCompactionProjectionToBudget — ceiling + prefix drops", () => {
  const baseParams = {
    projectState: PROJECT_STATE,
    hits: HITS,
    requestedPath: "/tmp/proj",
    profile: "pre" as const,
    intentDepth: "l1" as const,
  };

  it("no budget: payload built, all hits kept, no audit", () => {
    const fit = fitCompactionProjectionToBudget(baseParams);
    expect(fit.payload).not.toBeNull();
    expect(fit.keptHits.map((h) => h.id)).toEqual(["hit-1", "hit-2", "hit-3"]);
    expect(fit.prependContext).toBeTruthy();
    expect(fit.budgetFit).toBeUndefined();
  });

  it("generous budget: unchanged projection, audit reports the real wrapped size", () => {
    const noBudget = fitCompactionProjectionToBudget(baseParams);
    const fit = fitCompactionProjectionToBudget({ ...baseParams, budgetTokens: 100_000 });
    expect(fit.prependContext).toBe(noBudget.prependContext);
    expect(fit.keptHits.map((h) => h.id)).toEqual(noBudget.keptHits.map((h) => h.id));
    expect(fit.budgetFit).toMatchObject({
      budgetTokens: 100_000,
      approximateTokens: approximateTokens(fit.prependContext!),
      depth: "l1",
      degraded: false,
      droppedIds: [],
    });
  });

  it("tight budget: drops the ranked tail prefix-only until the WRAPPED injection fits", () => {
    const full = fitCompactionProjectionToBudget(baseParams);
    const fullTokens = approximateTokens(full.prependContext!);
    const fit = fitCompactionProjectionToBudget({ ...baseParams, budgetTokens: fullTokens - 1 });
    expect(fit.budgetFit).toBeDefined();
    expect(fit.budgetFit!.degraded).toBe(true);
    expect(fit.budgetFit!.droppedIds.length).toBeGreaterThan(0);
    // Prefix-only: kept set is always the head of the ranked hits.
    expect(fit.keptHits.map((h) => h.id)).toEqual(
      HITS.slice(0, fit.keptHits.length).map((h) => h.id),
    );
    // The dropped tail accounts for everything not kept, in ranked order.
    expect([...fit.keptHits, ...fit.budgetFit!.droppedIds.map((id) => HITS.find((h) => h.id === id)!)]
      .map((h) => h.id)).toEqual(HITS.map((h) => h.id));
    // Hard ceiling on what the client receives.
    expect(approximateTokens(fit.prependContext!)).toBeLessThanOrEqual(fullTokens - 1);
    expect(fit.budgetFit!.approximateTokens).toBe(approximateTokens(fit.prependContext!));
  });

  it("impossible budget: honest empty — null payload, all hits dropped, nothing rendered", () => {
    const fit = fitCompactionProjectionToBudget({ ...baseParams, budgetTokens: 1 });
    expect(fit.payload).toBeNull();
    expect(fit.prependContext).toBeNull();
    expect(fit.keptHits).toEqual([]);
    expect(fit.budgetFit).toMatchObject({
      budgetTokens: 1,
      approximateTokens: 0,
      degraded: true,
      droppedIds: ["hit-1", "hit-2", "hit-3"],
    });
  });

  it("NO-BUDGET IDENTITY: invalid budgets behave exactly like an absent budget", () => {
    const baseline = fitCompactionProjectionToBudget(baseParams);
    for (const budgetTokens of [NaN, Infinity, -5, 0, 0.4, "512", null, {}, [128]]) {
      const fit = fitCompactionProjectionToBudget({ ...baseParams, budgetTokens });
      expect(JSON.stringify(fit)).toBe(JSON.stringify(baseline));
      expect(fit.budgetFit).toBeUndefined();
    }
  });

  it("nothing to project: null payload; a valid budget still emits an honest zero audit", () => {
    const empty = fitCompactionProjectionToBudget({
      projectState: null,
      hits: [],
      profile: "post_validation",
      intentDepth: "l0",
    });
    expect(empty.payload).toBeNull();
    expect(empty.prependContext).toBeNull();
    expect(empty.budgetFit).toBeUndefined();

    const emptyWithBudget = fitCompactionProjectionToBudget({
      projectState: null,
      hits: [],
      profile: "post_validation",
      intentDepth: "l0",
      budgetTokens: 200,
    });
    expect(emptyWithBudget.payload).toBeNull();
    expect(emptyWithBudget.budgetFit).toMatchObject({
      budgetTokens: 200,
      approximateTokens: 0,
      degraded: false,
      droppedIds: [],
    });
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    const a = fitCompactionProjectionToBudget({ ...baseParams, budgetTokens: 90 });
    const b = fitCompactionProjectionToBudget({ ...baseParams, budgetTokens: 90 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
