import { describe, it, expect } from "vitest";
import {
  analyzeIntent,
  applyCategoryBoost,
  COMPACTION_INTENTS,
  isCompactionIntent,
  PAYLOAD_SHAPED_INTENTS,
  STATUS_CLASS_INTENTS,
} from "../recall/intent/intent-analyzer.js";
import type { SearchHit } from "../domain/memory/types.js";

describe("analyzeIntent", () => {
  it("classifies preference queries", () => {
    expect(analyzeIntent("What are my preferred settings?").label).toBe("preference");
    expect(analyzeIntent("How do I like my coffee?").label).toBe("preference");
    expect(analyzeIntent("What coding style do I use?").label).toBe("preference");
  });

  it("classifies decision queries", () => {
    expect(analyzeIntent("Why did we choose Qdrant?").label).toBe("decision");
    expect(analyzeIntent("What was decided about the API?").label).toBe("decision");
  });

  it("classifies entity queries", () => {
    expect(analyzeIntent("What is the status of ProjectX?").label).toBe("entity");
    expect(analyzeIntent("Tell me about the auth service").label).toBe("entity");
  });

  it("classifies event queries", () => {
    expect(analyzeIntent("What happened yesterday?").label).toBe("event");
    expect(analyzeIntent("When did we deploy v2?").label).toBe("event");
  });

  it("classifies latest-state and exact-lookup queries", () => {
    expect(analyzeIntent("what is the latest state of the auth migration?").label).toBe("latest_state");
    expect(analyzeIntent("exact lookup for capture hook direct write").label).toBe("exact_lookup");
  });

  it("classifies decision-trace and exploratory-topic queries", () => {
    expect(analyzeIntent("give me the decision history for qdrant").label).toBe("decision_trace");
    expect(analyzeIntent("explore the broader recall architecture landscape").label).toBe("exploratory_topic");
  });

  it("classifies replay guidance prompts as architecture instead of fact", () => {
    expect(analyzeIntent("How should we seed realistic historical memory for the replay?").label).toBe("architecture");
    expect(analyzeIntent("What belongs in the HTML review surface?").label).toBe("architecture");
    expect(analyzeIntent("What regression checks should guard this harness from drifting later?").label).toBe("architecture");
    expect(analyzeIntent("What should read-only replay keep versus skip?").label).toBe("architecture");
    expect(analyzeIntent("What exactly do we need to inspect before each assistant turn?").label).toBe("architecture");
    expect(analyzeIntent("What ranking or selection metadata should reviewers see per turn?").label).toBe("architecture");
  });

  it("classifies workflow/posture prompts separately from generic fact", () => {
    expect(analyzeIntent("What's the highest-priority outcome for this replay harness lane?").label).toBe("workflow_posture");
    expect(analyzeIntent("Do we have any blocker for the first end-to-end replay scenario?").label).toBe("workflow_posture");
    expect(analyzeIntent("What's the next step once the runner skeleton exists?").label).toBe("workflow_posture");
    expect(analyzeIntent("Let's write the handoff for whoever reviews the replay artifacts next.").label).toBe("workflow_posture");
  });

  it("classifies opener-ish continuity prompts as session_opener/current_status instead of generic fact", () => {
    expect(analyzeIntent("just starting a new session").label).toBe("session_opener");
    expect(analyzeIntent("starting a new session").label).toBe("session_opener");
    expect(analyzeIntent("catch me up").label).toBe("session_opener");
    expect(analyzeIntent("what are we working on?").label).toBe("current_status");
  });

  it("uses full depth for guidance/reference queries", () => {
    expect(analyzeIntent("What sections should the replay artifact contract expose?").depth).toBe("full");
  });

  it("defaults to fact for unclassified queries", () => {
    expect(analyzeIntent("random question about stuff").label).toBe("fact");
  });

  it("returns session_opener with 0.95 confidence when hint='opener' is passed, regardless of prompt content", () => {
    const intent = analyzeIntent("any prompt at all", { hint: "opener" });
    expect(intent.label).toBe("session_opener");
    expect(intent.confidence).toBe(0.95);
    expect(intent.depth).toBe("l1");
    expect(intent.categories).toEqual(["events", "entities"]);
    // Empty prompt must also route to session_opener via hint (the Claude Code SessionStart case).
    const emptyIntent = analyzeIntent("", { hint: "opener" });
    expect(emptyIntent.label).toBe("session_opener");
    expect(emptyIntent.confidence).toBe(0.95);
  });

  it("maps preference intent to preferences+profile categories", () => {
    const intent = analyzeIntent("What are my preferences?");
    expect(intent.categories).toContain("preferences");
    expect(intent.categories).toContain("profile");
  });

  it("maps decision intent to cases+patterns categories", () => {
    const intent = analyzeIntent("Why did we decide that?");
    expect(intent.categories).toContain("cases");
    expect(intent.categories).toContain("patterns");
  });

  it("returns l0 depth for preference queries", () => {
    const intent = analyzeIntent("What do I prefer?");
    expect(intent.depth).toBe("l0");
  });

  it("returns full depth for non-preference queries", () => {
    const intent = analyzeIntent("What happened last week?");
    expect(intent.depth).toBe("full");
  });
});

describe("applyCategoryBoost", () => {
  it("boosts matching category results by 1.15x", () => {
    const results: SearchHit[] = [
      { id: "1", text: "a", score: 1.0, category: "preferences" },
      { id: "2", text: "b", score: 0.9, category: "cases" },
    ];
    const intent = analyzeIntent("What are my preferences?");
    const boosted = applyCategoryBoost(results, intent);
    // preferences result should be boosted
    const prefsResult = boosted.find((r) => r.id === "1")!;
    expect(prefsResult.score).toBeCloseTo(1.0 * 1.15, 5);
    // non-matching should stay the same
    const casesResult = boosted.find((r) => r.id === "2")!;
    expect(casesResult.score).toBe(0.9);
  });

  it("re-sorts results after boosting", () => {
    const results: SearchHit[] = [
      { id: "1", text: "a", score: 1.0, category: "cases" },
      { id: "2", text: "b", score: 0.95, category: "preferences" },
    ];
    const intent = analyzeIntent("What are my preferences?");
    const boosted = applyCategoryBoost(results, intent);
    // preferences result (0.95 * 1.15 = 1.0925) should now be first
    expect(boosted[0]!.id).toBe("2");
  });

  it("does not modify results when intent is fact (no specific categories)", () => {
    const results: SearchHit[] = [
      { id: "1", text: "a", score: 1.0, category: "preferences" },
      { id: "2", text: "b", score: 0.9, category: "cases" },
    ];
    const intent = analyzeIntent("random stuff");
    const boosted = applyCategoryBoost(results, intent);
    expect(boosted[0]!.score).toBe(1.0);
    expect(boosted[1]!.score).toBe(0.9);
  });

  it("handles results without category gracefully", () => {
    const results: SearchHit[] = [
      { id: "1", text: "a", score: 1.0 },
      { id: "2", text: "b", score: 0.9, category: "preferences" },
    ];
    const intent = analyzeIntent("What are my preferences?");
    const boosted = applyCategoryBoost(results, intent);
    // No category → no boost
    const noCategory = boosted.find((r) => r.id === "1")!;
    expect(noCategory.score).toBe(1.0);
  });
});

describe("OM-2 compaction intents (Rúnir-tfxt.2)", () => {
  it("routes explicit compaction hints regardless of prompt text", () => {
    const pre = analyzeIntent("", { hint: "pre_compaction" });
    expect(pre.label).toBe("pre_compaction");
    expect(pre.depth).toBe("l1");
    expect(pre.confidence).toBe(0.95);

    const post = analyzeIntent("whatever the adapter sends", { hint: "post_compaction_validation" });
    expect(post.label).toBe("post_compaction_validation");
    expect(post.depth).toBe("l0");
    expect(post.confidence).toBe(0.95);
  });

  it("never classifies prose into compaction intents — they are hint-only labels", () => {
    for (const prompt of [
      "compact the context now",
      "pre compaction check please",
      "run the post compaction validation",
      "we are about to compact",
    ]) {
      expect(isCompactionIntent(analyzeIntent(prompt).label)).toBe(false);
    }
  });

  it("drift-guard: canonical membership lists pin the local literals in recall-orchestrator + recall-selection", () => {
    // The orchestrator (compactionHint / isCompactionRecall) and
    // recall-selection (isPayloadShapedLabel) deliberately use LOCAL literal
    // label checks instead of importing these predicates — both modules are
    // vi.mock'ed with explicit export lists in many harnesses, where a new
    // import edge resolves `undefined`. If this pin fails, update those local
    // literals in the same change.
    expect([...COMPACTION_INTENTS]).toEqual(["pre_compaction", "post_compaction_validation"]);
    expect([...PAYLOAD_SHAPED_INTENTS]).toEqual(["session_opener", "pre_compaction", "post_compaction_validation"]);
    expect(STATUS_CLASS_INTENTS).toContain("pre_compaction");
    expect(STATUS_CLASS_INTENTS).toContain("post_compaction_validation");
  });
});
