import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyRerankScores, formatAtDepth, toToolSearchResults, postProcessRecallResults, applyStaleSignalDemotion, collapseContradictions, applyRecencyPenaltyForStatus } from "../recall/selection/recall-selection";
import { analyzeIntent, type QueryIntent, type IntentSignal } from "../recall/intent/intent-analyzer";
import { parseRankingProfiles } from "../recall/policy/ranking-profile";
import type { SearchHit } from "../domain/memory/types";

// The runir/owner tenant's checked-in ranking profile carries the behavior-frozen
// stale-signal + known-rename values (Rúnir-mmg2). Tests that asserted the old
// hard-coded-constant behavior inject these slices; fresh-tenant tests pass nothing
// (= clean defaults). Integration tests that go end-to-end through
// postProcessRecallResults pass the resolved profile directly via opts.rankingProfile
// (the route resolves once and threads it in) — no module cache to manipulate.
const RUNIR_PROFILE_PATH = resolve(process.cwd(), "config/ranking-profiles.runir.json");
const RUNIR_PROFILE = parseRankingProfiles(
  JSON.parse(readFileSync(RUNIR_PROFILE_PATH, "utf8")),
).get("owner")!;
const RUNIR_STALE_SIGNALS = RUNIR_PROFILE.staleSignals;
const RUNIR_KNOWN_RENAMES = RUNIR_PROFILE.knownRenames;

import {
  STALE_SCHEMA_HIT,
  FRESH_SCHEMA_HIT,
  CONTRADICTION_PAIR,
  NULL_PATH_NOISE_HIT,
  STALE_BENCHMARK_HIT,
  STALE_BENCHMARK_HIT_258,
  SESSION_HANDOFF_HIT,
  ACTIVE_RECENT_WORK_HIT,
  DEPLOY_OPS_HIT,
  SCOUT_BRIEF_HIT,
  ADMIN_PROCESS_HIT,
  ARCHITECTURE_REFERENCE_HIT,
} from "./fixtures/recall-quality-sample-fixture";

function makeHit(id: string, score: number, text = "test"): SearchHit {
  return { id, text, score, createdAt: "2024-01-01", tags: ["tag1"] };
}

function makeIntent(label: QueryIntent, depth: "l0" | "l1" | "full" = "full"): IntentSignal {
  return { categories: [], depth, confidence: 0.8, label };
}

describe("applyRerankScores", () => {
  it("returns original results when scores map is empty", () => {
    const results = [makeHit("a", 0.5)];
    const filtered = applyRerankScores(results, new Map(), 0.2);
    expect(filtered).toEqual(results);
  });

  it("filters results below threshold", () => {
    const scores = new Map([["a", 0.1], ["b", 0.5]]);
    const results = [makeHit("a", 0.9), makeHit("b", 0.8)];
    const filtered = applyRerankScores(results, scores, 0.3);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("b");
  });

  it("replaces scores with reranker scores", () => {
    const scores = new Map([["a", 0.7]]);
    const results = [makeHit("a", 0.5)];
    const filtered = applyRerankScores(results, scores, 0.2);
    expect(filtered[0].score).toBe(0.7);
  });

  it("sorts by reranker score descending", () => {
    const scores = new Map([["a", 0.3], ["b", 0.9], ["c", 0.6]]);
    const results = [makeHit("a", 1), makeHit("b", 0.5), makeHit("c", 0.7)];
    const filtered = applyRerankScores(results, scores, 0.2);
    expect(filtered.map((h) => h.id)).toEqual(["b", "c", "a"]);
  });

  it("excludes results not in scores map", () => {
    const scores = new Map([["a", 0.8]]);
    const results = [makeHit("a", 0.5), makeHit("b", 0.5)];
    const filtered = applyRerankScores(results, scores, 0.2);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });
});

describe("formatAtDepth", () => {
  it("returns abstract for l0", () => {
    expect(formatAtDepth({ l2: "full text here.", l0: "summary" }, "l0")).toBe("summary");
  });

  it("uses first sentence when abstract is missing for l0", () => {
    expect(formatAtDepth({ text: "First sentence. Second one." }, "l0")).toBe("First sentence.");
  });

  it("returns full text for 'full'", () => {
    expect(formatAtDepth({ text: "full text" }, "full")).toBe("full text");
  });

  it("returns abstract + first sentence for l1", () => {
    const result = formatAtDepth({ l2: "Body sentence. More text.", l0: "Abstract" }, "l1");
    expect(result).toContain("Abstract");
    expect(result).toContain("Body sentence.");
  });

  it("returns just abstract when first sentence equals abstract for l1", () => {
    const result = formatAtDepth({ l2: "Same text.", l0: "Same text." }, "l1");
    expect(result).toBe("Same text.");
  });

  it("returns abstract when text body is empty for l1", () => {
    const result = formatAtDepth({ l2: "", l0: "Abstract" }, "l1");
    expect(result).toBe("Abstract");
  });

  it("returns first sentence when abstract is empty for l1", () => {
    const result = formatAtDepth({ l2: "Some sentence. More.", l0: "" }, "l1");
    expect(result).toBe("Some sentence.");
  });

  it("handles CJK sentence endings", () => {
    expect(formatAtDepth({ text: "你好世界。继续" }, "l0")).toBe("你好世界。");
  });

  it("returns full text when no sentence boundary found", () => {
    expect(formatAtDepth({ text: "no punctuation here" }, "l0")).toBe("no punctuation here");
  });
});

describe("toToolSearchResults", () => {
  it("maps and limits results", () => {
    const hits = [makeHit("a", 0.9), makeHit("b", 0.8), makeHit("c", 0.7)];
    const result = toToolSearchResults(hits, 2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      id: "a",
      memory: "test",
      score: 0.9,
      created_at: "2024-01-01",
      updated_at: undefined,
      tags: ["tag1"],
    });
  });
});

// ── MIM-69 Task 5: Intent analyzer expansion ──────────────────────────────

describe("analyzeIntent — expanded query classes (MIM-69)", () => {
  const cases: Array<[string, QueryIntent]> = [
    ["what are we working on in runir", "current_status"],
    ["write arbitration memory pipeline", "architecture"],
    ["test failures vitest mocking", "debugging"],
    ["SurrealDB payload schema SearchHit", "schema"],
    ["MIM-64 MIM-65 decay path recall", "recent_work"],
  ];

  it.each(cases)("classifies %j as %s", (query, expectedIntent) => {
    const result = analyzeIntent(query);
    expect(result.label).toBe(expectedIntent);
  });

  // Regression guard: existing intents still match
  it("still classifies preference queries correctly", () => {
    expect(analyzeIntent("my preferred coding style").label).toBe("preference");
  });

  it("routes decision-history queries to decision_trace", () => {
    expect(analyzeIntent("why did we decide to use SurrealDB").label).toBe("decision_trace");
  });

  it("still classifies event queries correctly", () => {
    expect(analyzeIntent("what happened yesterday with the deployment").label).toBe("event");
  });

  it("falls back to fact for unmatched queries", () => {
    expect(analyzeIntent("random unmatched query xyz").label).toBe("fact");
  });
});

// ── MIM-69 Task 6: postProcessRecallResults ───────────────────────────────

describe("postProcessRecallResults (MIM-69)", () => {
  it("returns selected, renderedText, accessTrackedIds, and dropped", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9, "First sentence of A. More text about A."),
      makeHit("b", 0.7, "First sentence of B. More text about B."),
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["cases"], depth: "l1", confidence: 0.8, label: "current_status" },
      topK: 5,
    });

    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.renderedText.length).toBe(result.selected.length);
    expect(Array.isArray(result.accessTrackedIds)).toBe(true);
    expect(Array.isArray(result.dropped)).toBe(true);
  });

  it("slices to topK", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9),
      makeHit("b", 0.8),
      makeHit("c", 0.7),
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["cases"], depth: "full", confidence: 0.8, label: "fact" },
      topK: 2,
    });

    expect(result.selected.length).toBeLessThanOrEqual(2);
  });

  it("renders at intent depth", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9, "Abstract sentence. Body details that are longer and more detailed."),
    ];

    const resultL1 = postProcessRecallResults(hits, {
      intent: { categories: ["cases"], depth: "l1", confidence: 0.8, label: "schema" },
      topK: 5,
    });

    const resultFull = postProcessRecallResults(hits, {
      intent: { categories: ["cases"], depth: "full", confidence: 0.8, label: "fact" },
      topK: 5,
    });

    // l1 should be shorter than or equal to full
    expect(resultL1.renderedText[0].length).toBeLessThanOrEqual(resultFull.renderedText[0].length);
  });

  it("builds a trace-only preference packet from selected preference hits", () => {
    const hits: SearchHit[] = [
      { ...makeHit("semiote:pref", 0.9, "User prefers Vitest for focused tests."), category: "preferences", path: "/repo" },
      { ...makeHit("semiote:event", 0.8, "The build finished yesterday."), category: "events", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["preferences"], depth: "l0", confidence: 0.9, label: "preference" },
      topK: 5,
      requestedPath: "/repo",
    });

    expect(result.preferencePacket?.generatedFrom).toBe("postProcessRecallResults");
    expect(result.preferencePacket?.trust).toBe("untrusted_retrieved_data");
    expect(result.preferencePacket?.audit.selectedIds).toContain("semiote:pref");
    expect(result.renderedText).toHaveLength(result.selected.length);
  });

  it("does not access-track Noema hits as Semiote rows", () => {
    const result = postProcessRecallResults([
      { ...makeHit("noema:editor", 0.9, "User prefers Vitest for focused tests."), sourceKind: "noema", path: "/repo" },
      { ...makeHit("semiote:support", 0.8, "User prefers focused tests."), sourceKind: "semiote", path: "/repo" },
    ], {
      intent: { categories: ["preferences"], depth: "l0", confidence: 0.9, label: "preference" },
      topK: 5,
      requestedPath: "/repo",
    });

    expect(result.accessTrackedIds).toEqual(["semiote:support"]);
  });

  it("guidance_reference selector prefers architecture/planning and excludes operational noise", () => {
    const hits: SearchHit[] = [
      { ...makeHit("status", 0.95, "Current status: active replay lane."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("arch", 0.74, "Architecture reference: use seeded history and recency buckets."), memoryRole: "architecture_reference", path: "/repo" },
      { ...makeHit("plan", 0.72, "Planning note: replay artifact contract should expose seedPlan and dbEvolution."), memoryRole: "planning_active", path: "/repo" },
      { ...makeHit("noise", 0.94, "Builder Brief housekeeping and environment setup noise."), memoryRole: "operational_noise", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["patterns"], depth: "full", confidence: 0.9, label: "architecture" },
      topK: 3,
      requestedPath: "/repo",
      selectorProfile: "guidance_reference",
    });

    expect(result.selected.map((hit) => hit.id)).toContain("arch");
    expect(result.selected.map((hit) => hit.id)).toContain("plan");
    expect(result.selected.map((hit) => hit.id)).not.toContain("noise");
    expect(result.selected.filter((hit) => hit.memoryRole === "current_status")).toHaveLength(0);
  });

  it("guidance_reference excludes current_status when architecture/session handoff alternatives exist", () => {
    const hits: SearchHit[] = [
      { ...makeHit("status", 0.99, "Current status: keep the replay harness separate."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("arch", 0.78, "Architecture reference: preserve a separate replay lane with its own artifact contract."), memoryRole: "architecture_reference", path: "/repo" },
      { ...makeHit("handoff", 0.76, "Session handoff: reuse ideas from sibling harnesses without merging implementations."), memoryRole: "session_handoff", path: "/repo" },
      { ...makeHit("recent", 0.74, "Recent work: viewer and seed overview sections are already wired."), memoryRole: "recent_work", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["patterns"], depth: "full", confidence: 0.9, label: "architecture" },
      topK: 4,
      requestedPath: "/repo",
      selectorProfile: "guidance_reference",
    });

    const selectedIds = result.selected.map((hit) => hit.id);
    expect(selectedIds).toContain("arch");
    expect(selectedIds).toContain("handoff");
    expect(selectedIds).not.toContain("status");
  });

  it("guidance_reference serializes barred-group admissibility decisions", () => {
    const hits: SearchHit[] = [
      { ...makeHit("status", 0.99, "Current status: keep the replay harness separate."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("arch", 0.78, "Architecture reference: preserve a separate replay lane with its own artifact contract."), memoryRole: "architecture_reference", path: "/repo" },
      { ...makeHit("handoff", 0.76, "Session handoff: reuse ideas from sibling harnesses without merging implementations."), memoryRole: "session_handoff", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["patterns"], depth: "full", confidence: 0.9, label: "architecture" },
      topK: 3,
      requestedPath: "/repo",
      selectorProfile: "guidance_reference",
    });

    expect(result.admissibility?.contractId).toBe("guidance_reference_admissibility");
    expect(result.admissibility?.droppedIds).toContain("status");
    expect(result.admissibility?.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "status",
        decision: "barred_group",
        group: "current_status",
        source: "memoryRole",
      }),
    ]));
    expect(result.admissibility?.selected).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "arch", group: "architecture_reference" }),
      expect.objectContaining({ id: "handoff", group: "session_handoff" }),
    ]));
  });

  it("recent_work selector keeps at least one recent_work/planning/architecture representative", () => {
    const hits: SearchHit[] = [
      { ...makeHit("status", 0.95, "Current status: active replay lane."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("recent", 0.74, "Recent work: replay artifact contract now names summary assertions."), memoryRole: "recent_work", path: "/repo" },
      { ...makeHit("arch", 0.70, "Architecture reference: fix recency correctness before tuning weights."), memoryRole: "architecture_reference", path: "/repo" },
      { ...makeHit("noise", 0.93, "Builder Brief housekeeping and environment setup noise."), memoryRole: "operational_noise", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["events"], depth: "l1", confidence: 0.9, label: "recent_work" },
      topK: 3,
      requestedPath: "/repo",
      selectorProfile: "recent_work",
    });

    expect(result.selected.map((hit) => hit.id)).toContain("recent");
    expect(result.selected.map((hit) => hit.id)).not.toContain("noise");
  });

  it("guidance_reference reserves a primary representative inside the final topK window", () => {
    const hits: SearchHit[] = [
      { ...makeHit("handoff", 0.95, "Session handoff: keep the harness separate."), memoryRole: "session_handoff", path: "/repo" },
      { ...makeHit("recent-a", 0.92, "Recent work: artifact contract progress."), memoryRole: "recent_work", path: "/repo" },
      { ...makeHit("recent-b", 0.91, "Recent work: viewer shell progress."), memoryRole: "recent_work", path: "/repo" },
      { ...makeHit("arch", 0.60, "Architecture reference: seed at least five realistic tracks."), memoryRole: "architecture_reference", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["patterns"], depth: "full", confidence: 0.9, label: "architecture" },
      topK: 3,
      requestedPath: "/repo",
      selectorProfile: "guidance_reference",
    });

    expect(result.selected).toHaveLength(3);
    expect(result.selected.some((hit) => hit.id === "arch")).toBe(true);
  });

  it("workflow_posture selector prefers planning/handoff and supports soft preferred client scope", () => {
    const hits: SearchHit[] = [
      { ...makeHit("mismatch", 0.95, "Recent work from another client."), memoryRole: "recent_work", path: "/repo", client: "cursor" },
      { ...makeHit("handoff", 0.84, "Session handoff: open the HTML report first."), memoryRole: "session_handoff", path: "/repo", client: "claude-code" },
      { ...makeHit("planning", 0.83, "Planning note: prioritize the blocker and next step guidance."), memoryRole: "planning_active", path: "/repo", client: "claude-code" },
      { ...makeHit("untagged", 0.82, "Recent work without client attribution."), memoryRole: "recent_work", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["events"], depth: "full", confidence: 0.9, label: "workflow_posture" },
      topK: 3,
      requestedPath: "/repo",
      preferredClient: "claude-code",
      clientScopeMode: "prefer",
      selectorProfile: "workflow_posture",
      nowMs: Date.parse("2026-04-17T00:00:00.000Z"),
    });

    expect(result.selected.map((hit) => hit.id)).toContain("handoff");
    expect(result.selected.map((hit) => hit.id)).toContain("planning");
    expect(result.selected[0]?.id).not.toBe("mismatch");
  });

  it("workflow_posture records over-cap current_status drops without re-admitting them", () => {
    const hits: SearchHit[] = [
      { ...makeHit("status-a", 0.97, "Current status: replay verification is in progress."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("status-b", 0.96, "Current status: HTML artifact review remains open."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("handoff", 0.84, "Session handoff: open the HTML report first."), memoryRole: "session_handoff", path: "/repo" },
      { ...makeHit("planning", 0.83, "Planning note: prioritize the blocker and next step guidance."), memoryRole: "planning_active", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["events"], depth: "full", confidence: 0.9, label: "workflow_posture" },
      topK: 4,
      requestedPath: "/repo",
      selectorProfile: "workflow_posture",
      nowMs: Date.parse("2026-04-17T00:00:00.000Z"),
    });

    expect(result.selected.filter((hit) => hit.memoryRole === "current_status")).toHaveLength(1);
    expect(result.admissibility?.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^status-/),
        decision: "over_cap",
        group: "current_status",
        cap: 1,
      }),
    ]));
  });

  it("status_continuity audit records the dedicated continuity resolver and mode", () => {
    const hits: SearchHit[] = [
      { ...makeHit("status", 0.98, "Current status: replay verification is in progress."), memoryRole: "current_status", path: "/repo" },
      { ...makeHit("handoff", 0.88, "Session handoff: boundary behavior stayed specialized."), memoryRole: "session_handoff", path: "/repo" },
      { ...makeHit("noise", 0.92, "Builder Brief housekeeping and environment setup noise."), memoryRole: "operational_noise", path: "/repo" },
    ];

    const result = postProcessRecallResults(hits, {
      intent: { categories: ["events"], depth: "full", confidence: 0.9, label: "current_status" },
      topK: 3,
      requestedPath: "/repo",
      selectorProfile: "status_continuity",
    });

    expect(result.admissibility).toEqual(expect.objectContaining({
      contractId: "status_continuity_compatibility",
      selectionEngine: "continuity_resolved",
      compatibilityMode: true,
      continuityResolverMode: "strict",
    }));
    expect(result.admissibility?.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "noise",
        decision: "unsupported_group",
        group: "operational_noise",
      }),
    ]));
  });
});

// ── MIM-69 Task 8: applyStaleSignalDemotion ─────────────────────────────────

describe("applyStaleSignalDemotion (MIM-69)", () => {
  it("schema query: stale payload.data hit at 0.9 demoted below fresh hit at 0.7", () => {
    const hits: SearchHit[] = [
      makeHit("stale", 0.9, "Memory schema fields include payload.data and payload.hash."),
      makeHit("fresh", 0.7, "The memories table uses payload.l2 for narrative text."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("schema"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].id).toBe("fresh");
    expect(demoted[1].score).toBeCloseTo(0.9 * 0.40);
    expect(staleDemotedIds.has("stale")).toBe(true);
    expect(staleDemotedIds.has("fresh")).toBe(false);
  });

  it("debugging query: stale '313 tests passed' hit demoted below fresh hit", () => {
    const hits: SearchHit[] = [
      makeHit("stale-bench", 0.9, "After resolving a test failure, all 313 tests passed."),
      makeHit("fresh", 0.7, "Current vitest run completes successfully with green output."),
    ];
    const { demoted } = applyStaleSignalDemotion(hits, makeIntent("debugging"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].id).toBe("fresh");
  });

  it("event query (not in stale signals): no demotion, scores unchanged", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9, "Memory schema fields include payload.data."),
      makeHit("b", 0.7, "Something else."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("event"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].score).toBeCloseTo(0.9);
    expect(demoted[1].score).toBeCloseTo(0.7);
    expect(staleDemotedIds.size).toBe(0);
  });

  it("stale signal match on non-matching intent → no demotion", () => {
    // payload.data matches schema signals, but intent is 'preference' (no signals)
    const hits: SearchHit[] = [
      makeHit("a", 0.9, "Memory schema fields include payload.data."),
    ];
    const { demoted } = applyStaleSignalDemotion(hits, makeIntent("preference"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].score).toBeCloseTo(0.9);
  });
});

// ── MIM-71: current_status stale-signal demotion ────────────────────────────

describe("applyStaleSignalDemotion — current_status patterns (MIM-71)", () => {
  it("demotes hit mentioning 'Builder Brief' under current_status intent", () => {
    const hits: SearchHit[] = [
      makeHit("stale-brief", 0.9, "The Builder Brief for MIM-71 describes the recall follow-up work."),
      makeHit("fresh-work", 0.7, "Currently implementing hybrid search improvements for recall."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("current_status"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].id).toBe("fresh-work");
    expect(demoted[1].score).toBeCloseTo(0.9 * 0.40);
    expect(staleDemotedIds.has("stale-brief")).toBe(true);
  });

  it("demotes hit mentioning 'kebab-case' / naming convention under current_status intent", () => {
    const hits: SearchHit[] = [
      makeHit("stale-naming", 0.9, "The project uses kebab-case for all file names as a naming convention."),
      makeHit("fresh-work", 0.7, "Working on MIM-71 count/bullets divergence fix."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("current_status"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].id).toBe("fresh-work");
    expect(staleDemotedIds.has("stale-naming")).toBe(true);
  });

  it("demotes hit mentioning 'schema migration' under current_status intent", () => {
    const hits: SearchHit[] = [
      makeHit("stale-schema", 0.85, "The DEFINE FIELD migration added l0 and l1 to the schema migration."),
      makeHit("fresh-work", 0.7, "Deploy completed, testing recall quality now."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("current_status"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].id).toBe("fresh-work");
    expect(staleDemotedIds.has("stale-schema")).toBe(true);
  });

  it("does NOT demote genuinely recent/current work hit under current_status intent", () => {
    const hits: SearchHit[] = [
      makeHit("current-work", 0.9, "Currently working on recall quality improvements and hybrid search."),
      makeHit("also-current", 0.7, "MIM-71 implementation is in progress with live testing."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("current_status"), RUNIR_STALE_SIGNALS);
    // Neither should be demoted — no stale patterns match
    expect(demoted[0].id).toBe("current-work");
    expect(demoted[0].score).toBeCloseTo(0.9);
    expect(demoted[1].score).toBeCloseTo(0.7);
    expect(staleDemotedIds.size).toBe(0);
  });

  it("current_status patterns do NOT fire on other intents", () => {
    const hits: SearchHit[] = [
      makeHit("brief-mention", 0.9, "The Builder Brief outlines project goals."),
    ];
    // Under 'architecture' intent, Builder Brief should NOT be demoted by current_status patterns
    const { demoted } = applyStaleSignalDemotion(hits, makeIntent("architecture"), RUNIR_STALE_SIGNALS);
    expect(demoted[0].score).toBeCloseTo(0.9);
  });
});

// ── Rúnir-yfve: compound rows must survive the first-sentence collapse ───────

describe("collapseContradictions (Rúnir-yfve)", () => {
  const COMPOUND_GOLD =
    "User stated that the payments service in production runs on port 8001. "
    + "User stated that the auth service in production runs on port 8002. "
    + "User stated that the billing service in production runs on port 8003. "
    + "User stated that the search service in production runs on port 8004.";

  it("keeps a gold-bearing multi-fact compound alongside a short same-template neighbor", () => {
    const hits: SearchHit[] = [
      // Short same-template row whose first sentence Jaccard-collides with the compound's
      { id: "neighbor", text: "User stated that the sessions service in production runs on port 8011.", score: 0.9, createdAt: "2026-06-05" },
      { id: "compound", text: COMPOUND_GOLD, score: 0.85, createdAt: "2026-06-01" },
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    // First sentences are answer-distinct claims (different subject + value):
    // judged on the colliding unit, BOTH survive — the old whole-text
    // comparison failed the compactness gate and eliminated the compound.
    expect(result.map((h) => h.id).sort()).toEqual(["compound", "neighbor"]);
  });

  it("fails CLOSED for a compound vs a same-subject short row (never eliminates the compound)", () => {
    const hits: SearchHit[] = [
      // Same subject (payments service), so first sentences are NOT answer-distinct
      { id: "short-same-subject", text: "User stated that the payments service in production runs on port 8001.", score: 0.95, createdAt: "2026-06-05" },
      { id: "compound", text: COMPOUND_GOLD, score: 0.85, createdAt: "2026-06-01" },
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    // The compound carries facts the short row does not — keep both.
    expect(result.map((h) => h.id).sort()).toEqual(["compound", "short-same-subject"]);
  });

  it("still collapses true compact duplicates (existing behavior preserved)", () => {
    const hits: SearchHit[] = [
      { id: "a", text: "The server runs on port 7700. Additional details about config.", score: 0.8, createdAt: "2026-03-01" },
      { id: "b", text: "The server runs on port 7700. More recent information here.", score: 0.85, createdAt: "2026-03-20" },
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    expect(result).toHaveLength(1);
  });
});

// ── MIM-69 Task 9: collapseContradictions ───────────────────────────────────

describe("collapseContradictions (MIM-69)", () => {
  it("two hits with nearly identical first sentences → only one survives", () => {
    const hits: SearchHit[] = [
      { id: "a", text: "The server runs on port 7700. Additional details about config.", score: 0.8, createdAt: "2026-03-01" },
      { id: "b", text: "The server runs on port 7700. More recent information here.", score: 0.85, createdAt: "2026-03-20" },
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    expect(result).toHaveLength(1);
    // The newer/higher-score one wins
    expect(result[0].id).toBe("b");
  });

  it("writeWithArbitration + arbitrateWrite → only newer one survives", () => {
    const hits: SearchHit[] = [
      { id: "old", text: "All memory writes are processed through writeWithArbitration() for dedup.", score: 0.85, createdAt: "2026-03-10" },
      { id: "new", text: "The core write arbitration function is named arbitrateWrite.", score: 0.87, path: "/Users/brooks/Code/runir", createdAt: "2026-03-29" },
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new");
  });

  it("does not drop unrelated memories that only share the renamed symbol", () => {
    const hits: SearchHit[] = [
      { id: "legacy", text: "Earlier revisions called the helper writeWithArbitration().", score: 0.82, createdAt: "2026-03-10" },
      { id: "arch-1", text: "arbitrateWrite checks the recent-write cache before any SurrealDB lookup.", score: 0.95, path: "/Users/brooks/Code/runir", createdAt: "2026-03-29" },
      { id: "arch-2", text: "arbitrateWrite merges similar memories inside the 72 hour window.", score: 0.91, path: "/Users/brooks/Code/runir", createdAt: "2026-03-28" },
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    expect(result.map((hit) => hit.id)).toEqual(["arch-1", "arch-2"]);
  });

  it("two genuinely different hits → both survive", () => {
    const hits: SearchHit[] = [
      makeHit("a", 0.9, "The server runs on port 7700."),
      makeHit("b", 0.8, "SurrealDB stores embeddings as arrays of floats."),
    ];
    const result = collapseContradictions(hits, RUNIR_KNOWN_RENAMES);
    expect(result).toHaveLength(2);
  });
});

// ── MIM-69 Task 12: Quality-aware access tracking exclusions ────────────────

describe("postProcessRecallResults accessTrackedIds exclusions (MIM-69)", () => {
  const P = "/Users/brooks/Code/runir";
  const schemaIntent = makeIntent("schema", "full");

  it("null-path fallback hit in selected but NOT in accessTrackedIds", () => {
    const hits: SearchHit[] = [
      { id: "exact-1", text: "Fresh schema info.", score: 0.9, path: P },
      { id: "null-fallback", text: "Some null-path memory.", score: 0.85 },
    ];
    const result = postProcessRecallResults(hits, { intent: schemaIntent, topK: 5, requestedPath: P });
    const nullInSelected = result.selected.find((h) => h.id === "null-fallback");
    if (nullInSelected) {
      expect(result.accessTrackedIds).not.toContain("null-fallback");
    }
    expect(result.accessTrackedIds).toContain("exact-1");
  });

  it("stale-demoted hit in selected but NOT in accessTrackedIds", () => {
    const hits: SearchHit[] = [
      { id: "stale-1", text: "Memory schema fields include payload.data and payload.hash.", score: 0.95, path: P },
      { id: "fresh-1", text: "The memories table uses payload.l2 for text.", score: 0.7, path: P },
    ];
    const result = postProcessRecallResults(hits, { intent: schemaIntent, topK: 5, requestedPath: P, rankingProfile: RUNIR_PROFILE });
    expect(result.accessTrackedIds).not.toContain("stale-1");
    expect(result.accessTrackedIds).toContain("fresh-1");
  });

  it("exact-path, non-stale hit appears in both selected and accessTrackedIds", () => {
    const hits: SearchHit[] = [
      { id: "good-1", text: "Healthy non-stale memory content.", score: 0.9, path: P },
    ];
    const result = postProcessRecallResults(hits, { intent: schemaIntent, topK: 5, requestedPath: P });
    expect(result.selected.map((h) => h.id)).toContain("good-1");
    expect(result.accessTrackedIds).toContain("good-1");
  });
});

// ── MIM-69 Task 13: Regression fixtures from quality sample ─────────────────

describe("Quality sample regression (MIM-69 Task 13)", () => {
  const P = "/Users/brooks/Code/runir";

  it("stale schema hits rank below fresh schema hits for 'schema' intent", () => {
    const hits: SearchHit[] = [STALE_SCHEMA_HIT, FRESH_SCHEMA_HIT];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("schema", "l1"),
      topK: 5,
      requestedPath: P,
      rankingProfile: RUNIR_PROFILE,
    });
    // Fresh hit should rank first (stale hit is demoted by stale-signal demotion)
    const ids = result.selected.map((h) => h.id);
    expect(ids.indexOf("fresh-schema-1")).toBeLessThan(ids.indexOf("stale-schema-1"));
  });

  it("contradiction pair collapses to only the newer hit", () => {
    const hits: SearchHit[] = [CONTRADICTION_PAIR.old, CONTRADICTION_PAIR.new];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("architecture", "l1"),
      topK: 5,
      requestedPath: P,
      rankingProfile: RUNIR_PROFILE,
    });
    const ids = result.selected.map((h) => h.id);
    expect(ids).toContain("arch-new");
    expect(ids).not.toContain("arch-old");
  });

  it("null-path noise can fill remaining slots when exact-path supply is sparse, without admitting cross-path hits", () => {
    const crossPathHit: SearchHit = {
      id: "cross-path",
      text: "memory from another project",
      score: 0.99,
      path: "/Users/brooks/Code/other-project",
      createdAt: "2026-03-30T00:00:00Z",
    };
    const hits: SearchHit[] = [
      FRESH_SCHEMA_HIT,
      NULL_PATH_NOISE_HIT,
      { ...STALE_BENCHMARK_HIT, path: undefined },
      { ...STALE_BENCHMARK_HIT_258, path: undefined },
      crossPathHit,
    ];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("debugging", "full"),
      topK: 5,
      requestedPath: P,
    });
    const nullPathSelected = result.selected.filter((h) => !h.path);
    expect(nullPathSelected.length).toBeGreaterThanOrEqual(1);
    expect(result.selected.some((h) => h.id === "cross-path")).toBe(false);
  });

  it("stale benchmark hits (313 tests, 258 tests) are demoted for 'debugging' intent", () => {
    // Give all hits a path so path-quota doesn't interfere — we're testing demotion ranking
    const freshHit: SearchHit = {
      id: "fresh-debug",
      text: "Current test suite runs clean with all assertions passing.",
      score: 0.70,
      category: "events",
      path: P,
      createdAt: "2026-03-30T00:00:00Z",
    };
    const bench1 = { ...STALE_BENCHMARK_HIT, path: P };
    const bench2 = { ...STALE_BENCHMARK_HIT_258, path: P };
    const hits: SearchHit[] = [bench1, bench2, freshHit];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("debugging", "full"),
      topK: 5,
      requestedPath: P,
      rankingProfile: RUNIR_PROFILE,
    });
    const ids = result.selected.map((h) => h.id);
    // Fresh hit should rank above both stale benchmark hits after demotion
    expect(ids.indexOf("fresh-debug")).toBeLessThan(ids.indexOf("stale-bench-1"));
    expect(ids.indexOf("fresh-debug")).toBeLessThan(ids.indexOf("stale-bench-2"));
  });

  it("current_status prefers session handoff and active work over deploy/admin/scout artifacts", () => {
    const hits: SearchHit[] = [
      DEPLOY_OPS_HIT,
      SCOUT_BRIEF_HIT,
      ADMIN_PROCESS_HIT,
      SESSION_HANDOFF_HIT,
      ACTIVE_RECENT_WORK_HIT,
    ];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("current_status", "l1"),
      topK: 3,
      requestedPath: P,
    });
    const ids = result.selected.map((h) => h.id);
    expect(ids).toContain("handoff-1");
    expect(ids).toContain("recent-work-1");
    expect(ids).not.toContain("deploy-1");
    expect(ids).not.toContain("scout-1");
    expect(ids).not.toContain("admin-1");
  });

  it("current_status exact-path active work beats null-path operational memory", () => {
    const nullPathDeploy: SearchHit = { ...DEPLOY_OPS_HIT, id: "deploy-null", path: undefined, score: 0.95 };
    const exactPathCurrent: SearchHit = { ...ACTIVE_RECENT_WORK_HIT, id: "recent-work-exact", score: 0.72, path: P };
    const result = postProcessRecallResults([nullPathDeploy, exactPathCurrent], {
      intent: makeIntent("current_status", "l1"),
      topK: 2,
      requestedPath: P,
    });
    expect(result.selected[0]?.id).toBe("recent-work-exact");
  });

  it("current_status only keeps architecture-style memory as fallback behind status memories", () => {
    const hits: SearchHit[] = [
      ARCHITECTURE_REFERENCE_HIT,
      SESSION_HANDOFF_HIT,
      ACTIVE_RECENT_WORK_HIT,
    ];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("current_status", "l1"),
      topK: 2,
      requestedPath: P,
    });
    const ids = result.selected.map((h) => h.id);
    expect(ids).toEqual(["handoff-1", "recent-work-1"]);
    expect(ids).not.toContain("arch-ref-1");
  });

  it("current_status demotes process-heavy continuity memories behind concrete active work", () => {
    const processMemory: SearchHit = {
      id: "process-meta-1",
      text: "Rúnir Read Path Gating: recall should only trigger during session starts, explicit state checks, or context insufficiency. The project_state update flow uses /clear and watermark progression to preserve continuity.",
      score: 0.96,
      memoryRole: "current_status",
      path: P,
      createdAt: "2026-03-30T00:00:00Z",
      updatedAt: "2026-03-30T00:00:00Z",
    };
    const concreteStatus: SearchHit = {
      id: "concrete-status-1",
      text: "Current status: investigating opener quality for the Claude plugin smoke session and tightening continuity ranking.",
      score: 0.76,
      memoryRole: "current_status",
      path: P,
      createdAt: "2026-03-31T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
    };
    const nextStep: SearchHit = {
      id: "next-step-1",
      text: "Session handoff: next step is to route opener-like prompts into deterministic continuity.",
      score: 0.74,
      memoryRole: "session_handoff",
      path: P,
      createdAt: "2026-03-31T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
    };

    const result = postProcessRecallResults([processMemory, concreteStatus, nextStep], {
      intent: makeIntent("current_status", "l1"),
      topK: 2,
      requestedPath: P,
      rankingProfile: RUNIR_PROFILE,
    });

    const ids = result.selected.map((hit) => hit.id);
    expect(ids).toContain("concrete-status-1");
    expect(ids).toContain("next-step-1");
    expect(ids).not.toContain("process-meta-1");
  });

  it("current_status treats read-path/project-state process commentary as noise even when phrased like status", () => {
    const processMemory: SearchHit = {
      id: "process-meta-status-1",
      text: "Current status: recall should trigger during session starts, explicit state checks, or context insufficiency. The project_state update flow uses /clear and watermark progression to preserve continuity.",
      score: 0.96,
      memoryRole: "current_status",
      path: P,
      createdAt: "2026-03-31T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
    };
    const concreteStatus: SearchHit = {
      id: "concrete-status-2",
      text: "Current status: investigating opener quality for the Claude plugin smoke session and tightening continuity ranking.",
      score: 0.76,
      memoryRole: "current_status",
      path: P,
      createdAt: "2026-03-31T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
    };

    const result = postProcessRecallResults([processMemory, concreteStatus], {
      intent: makeIntent("current_status", "l1"),
      topK: 1,
      requestedPath: P,
      rankingProfile: RUNIR_PROFILE,
    });

    expect(result.selected[0]?.id).toBe("concrete-status-2");
  });
});

// ── MIM-71 Phase 4: applyRecencyPenaltyForStatus ────────────────────────────

describe("applyRecencyPenaltyForStatus (MIM-71 Phase 4)", () => {
  const NOW = new Date("2026-03-31T12:00:00Z").getTime();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("old current_status hits are downranked (older than 7 days)", () => {
    const hits: SearchHit[] = [
      { id: "old-hit", text: "Old project status from weeks ago.", score: 0.9, createdAt: "2026-03-10T00:00:00Z" },
      { id: "recent-hit", text: "Current recall improvements in progress.", score: 0.7, createdAt: "2026-03-30T00:00:00Z" },
    ];
    const result = applyRecencyPenaltyForStatus(hits, makeIntent("current_status"));
    // Old hit should be penalized: 0.9 * 0.50 = 0.45, recent hit stays at 0.7
    expect(result[0].id).toBe("recent-hit");
    expect(result[0].score).toBeCloseTo(0.7);
    expect(result[1].id).toBe("old-hit");
    expect(result[1].score).toBeCloseTo(0.9 * 0.50);
  });

  it("non-current_status intents are unaffected", () => {
    const hits: SearchHit[] = [
      { id: "old-arch", text: "Architecture decision from January.", score: 0.9, createdAt: "2026-01-15T00:00:00Z" },
      { id: "recent-arch", text: "Recent architecture note.", score: 0.7, createdAt: "2026-03-30T00:00:00Z" },
    ];
    for (const label of ["architecture", "schema", "debugging", "recent_work", "fact", "preference", "event"] as const) {
      const result = applyRecencyPenaltyForStatus(hits, makeIntent(label));
      // Should return hits unchanged (same reference array)
      expect(result[0].id).toBe("old-arch");
      expect(result[0].score).toBeCloseTo(0.9);
      expect(result[1].id).toBe("recent-arch");
      expect(result[1].score).toBeCloseTo(0.7);
    }
  });

  it("recent current_status hits are NOT penalized (within 7 days)", () => {
    const hits: SearchHit[] = [
      { id: "recent-1", text: "Working on MIM-71 recall quality.", score: 0.9, createdAt: "2026-03-28T00:00:00Z" },
      { id: "recent-2", text: "Deployed MIM-70 fixes today.", score: 0.7, createdAt: "2026-03-31T00:00:00Z" },
    ];
    const result = applyRecencyPenaltyForStatus(hits, makeIntent("current_status"));
    expect(result[0].id).toBe("recent-1");
    expect(result[0].score).toBeCloseTo(0.9);
    expect(result[1].id).toBe("recent-2");
    expect(result[1].score).toBeCloseTo(0.7);
  });

  it("hits with no createdAt are treated as old and penalized for current_status", () => {
    const hits: SearchHit[] = [
      { id: "no-date", text: "Legacy memory with no timestamp.", score: 0.9 },
      { id: "dated", text: "Recent work note.", score: 0.7, createdAt: "2026-03-30T00:00:00Z" },
    ];
    const result = applyRecencyPenaltyForStatus(hits, makeIntent("current_status"));
    expect(result[0].id).toBe("dated");
    expect(result[1].id).toBe("no-date");
    expect(result[1].score).toBeCloseTo(0.9 * 0.50);
  });

  it("integrates correctly in postProcessRecallResults pipeline", () => {
    const P = "/Users/brooks/Code/runir";
    const hits: SearchHit[] = [
      { id: "old-status", text: "Project status from early March.", score: 0.9, path: P, createdAt: "2026-03-10T00:00:00Z" },
      { id: "fresh-status", text: "Currently deploying recall quality fixes.", score: 0.7, path: P, createdAt: "2026-03-30T00:00:00Z" },
    ];
    const result = postProcessRecallResults(hits, {
      intent: makeIntent("current_status", "l1"),
      topK: 5,
      requestedPath: P,
    });
    const ids = result.selected.map((h) => h.id);
    // Fresh hit should rank above old hit due to recency penalty
    expect(ids.indexOf("fresh-status")).toBeLessThan(ids.indexOf("old-status"));
  });
});
