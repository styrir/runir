import { describe, it, expect } from "vitest";
import {
  buildWarmedProjectState,
  isStatusLikeSignal,
  classifySignalType,
  selectWarmingCandidates,
  type WarmingFact,
} from "../capture/continuity/project-state-warming.js";

describe("isStatusLikeSignal", () => {
  it("matches active/in-progress signals", () => {
    expect(isStatusLikeSignal("currently working on the auth migration")).toBe(true);
    expect(isStatusLikeSignal("debugging the recall pipeline")).toBe(true);
    expect(isStatusLikeSignal("implementing watermark logic")).toBe(true);
  });

  it("matches progress/completion signals", () => {
    expect(isStatusLikeSignal("completed the write arbitration refactor")).toBe(true);
    expect(isStatusLikeSignal("shipped v1 of the capture hook")).toBe(true);
    expect(isStatusLikeSignal("merged the BM25 index change")).toBe(true);
  });

  it("matches decision signals", () => {
    expect(isStatusLikeSignal("switched to Nomic embeddings")).toBe(true);
    expect(isStatusLikeSignal("decided to use SurrealDB for FTS")).toBe(true);
  });

  it("matches next-step signals", () => {
    expect(isStatusLikeSignal("next step is to add entity extraction")).toBe(true);
    expect(isStatusLikeSignal("plan to add reranker support")).toBe(true);
  });

  it("rejects non-status text", () => {
    expect(isStatusLikeSignal("SurrealDB supports vector search")).toBe(false);
    expect(isStatusLikeSignal("the user's name is Brooks")).toBe(false);
    expect(isStatusLikeSignal("Hono is an HTTP framework")).toBe(false);
  });
});

describe("classifySignalType", () => {
  it("classifies active signals as focus", () => {
    expect(classifySignalType("working on the capture hook")).toBe("focus");
    expect(classifySignalType("debugging the recall pipeline")).toBe("focus");
  });

  it("classifies completion signals as progress", () => {
    expect(classifySignalType("completed the migration")).toBe("progress");
    expect(classifySignalType("shipped the feature")).toBe("progress");
  });

  it("classifies decision signals as focus", () => {
    expect(classifySignalType("switched to Nomic")).toBe("focus");
  });

  it("classifies next-step signals as focus", () => {
    expect(classifySignalType("next step is testing")).toBe("focus");
  });
});

describe("selectWarmingCandidates", () => {
  const baseFact: WarmingFact = {
    text: "",
    category: "events",
    confidence: 0.85,
    outcome: "create",
    timestamp: "2026-04-12T10:00:00Z",
  };

  it("returns null when no facts qualify", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "the user's name is Brooks", confidence: 0.9 },
    ];
    expect(selectWarmingCandidates(facts)).toBeNull();
  });

  it("returns null when confidence is too low", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "working on capture", confidence: 0.5 },
    ];
    expect(selectWarmingCandidates(facts)).toBeNull();
  });

  it("returns null when category is wrong", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "working on capture", category: "profile" },
    ];
    expect(selectWarmingCandidates(facts)).toBeNull();
  });

  it("returns null when outcome is skip", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "working on capture", outcome: "skip" },
    ];
    expect(selectWarmingCandidates(facts)).toBeNull();
  });

  it("selects focus and progress from separate pools", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "working on the recall guard", timestamp: "2026-04-12T10:00:00Z" },
      { ...baseFact, text: "completed the watermark module", timestamp: "2026-04-12T10:05:00Z" },
    ];
    const result = selectWarmingCandidates(facts);
    expect(result).not.toBeNull();
    expect(result!.currentFocus).toBe("working on the recall guard");
    expect(result!.latestProgress).toBe("completed the watermark module");
  });

  it("prefers more recent facts (recency-first)", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "working on task A", timestamp: "2026-04-12T08:00:00Z" },
      { ...baseFact, text: "working on task B", timestamp: "2026-04-12T12:00:00Z" },
    ];
    const result = selectWarmingCandidates(facts);
    expect(result!.currentFocus).toBe("working on task B");
  });

  it("uses confidence as tiebreaker when timestamps match", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "working on task A", confidence: 0.80 },
      { ...baseFact, text: "working on task B", confidence: 0.95 },
    ];
    const result = selectWarmingCandidates(facts);
    expect(result!.currentFocus).toBe("working on task B");
  });

  it("allows supersede outcome", () => {
    const facts: WarmingFact[] = [
      { ...baseFact, text: "switched to new approach", outcome: "supersede" },
    ];
    const result = selectWarmingCandidates(facts);
    expect(result).not.toBeNull();
  });
});

describe("buildWarmedProjectState", () => {
  const baseFact: WarmingFact = {
    text: "working on the recall guard",
    category: "events",
    confidence: 0.9,
    outcome: "create",
    timestamp: "2026-04-12T10:00:00Z",
    order: 0,
  };

  it("preserves richer existing fields when only warming focus/progress", () => {
    const existing = {
      id: "ps-1",
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      currentFocus: "existing focus",
      activeTicketIds: ["MIM-100"],
      latestProgress: "existing progress",
      blockers: ["waiting on CI"],
      nextSteps: ["finish tests"],
      directives: [
        { kind: "verification" as const, polarity: "verify" as const, status: "open" as const, text: "CI is green", source: "explicit" as const, confidence: 0.9, evidence: "verify CI" },
      ],
      updatedAt: "2026-04-12T09:00:00Z",
      sourceSessionId: "sess-old",
      supportingMemoryIds: ["m-1"],
      confidence: 0.8,
      version: 1,
    };

    const result = buildWarmedProjectState({
      existing,
      facts: [baseFact],
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      sessionId: "sess-new",
    });

    expect(result).not.toBeNull();
    expect(result!.currentFocus).toBe("working on the recall guard");
    expect(result!.projectKey).toBe("project:runir");
    expect(result!.latestProgress).toBe("existing progress");
    expect(result!.activeTicketIds).toEqual(["MIM-100"]);
    expect(result!.blockers).toEqual(["waiting on CI"]);
    expect(result!.nextSteps).toEqual(["finish tests"]);
    expect(result!.directives).toEqual(existing.directives);
    expect(result!.supportingMemoryIds).toEqual(["m-1"]);
  });

  it("returns null when existing project_state is newer than the warming facts", () => {
    const existing = {
      id: "ps-2",
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      currentFocus: "newer focus",
      activeTicketIds: [],
      latestProgress: "newer progress",
      blockers: [],
      nextSteps: [],
      updatedAt: "2026-04-12T12:00:00Z",
      sourceSessionId: "sess-newer",
      supportingMemoryIds: [],
      confidence: 0.9,
      version: 2,
    };

    const result = buildWarmedProjectState({
      existing,
      facts: [baseFact],
      userId: "user-1",
      projectKey: "project:runir",
      path: "/repo",
      sessionId: "sess-older",
    });

    expect(result).toBeNull();
  });
});
