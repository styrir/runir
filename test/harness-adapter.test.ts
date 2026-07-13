import { describe, expect, it } from "vitest";
import {
  toMemoryDelta,
  toOpenerArtifact,
  toRetrievalSet,
  toTraceBundle,
  type HarnessIngestionScenarioResult,
  type HarnessReplayTurnRow,
  type ShimMappingContext,
} from "../src/testing/harness-adapter.js";

const ctx: ShimMappingContext = {
  scope: "user",
  nowIso: "2026-05-15T00:00:00.000Z",
  sourceTurn: "t-1",
  idPrefix: "scn-1",
};

function ingestion(
  overrides: Partial<HarnessIngestionScenarioResult> = {},
): HarnessIngestionScenarioResult {
  return {
    scenarioId: "scn-1",
    title: "Test",
    serverResponse: { status: 200, json: {} },
    ...overrides,
  };
}

describe("toMemoryDelta", () => {
  it("emits a single skipped entry when the server reported skipped:true", () => {
    const delta = toMemoryDelta(
      ingestion({
        serverResponse: {
          status: 200,
          json: { skipped: true, reason: "noise" },
        },
      }),
      ctx,
    );
    expect(delta.skipped).toHaveLength(1);
    expect(delta.skipped[0]!.reason).toBe("noise");
    expect(delta.added).toEqual([]);
  });

  it("prefers explicit units[] when present and routes to the correct bucket", () => {
    const delta = toMemoryDelta(
      ingestion({
        serverResponse: {
          status: 200,
          json: {
            units: [
              { id: "m1", outcome: "create", content: "added one", confidence: 0.9 },
              { id: "m2", outcome: "merge-update", content: "updated one" },
              { id: "m3", outcome: "supersede", content: "superseded one" },
              { id: "m4", outcome: "skip", content: "skipped one", confidence: 0.5 },
            ],
          },
        },
      }),
      ctx,
    );
    expect(delta.added.map((u) => u.id)).toEqual(["m1"]);
    expect(delta.updated.map((u) => u.id)).toEqual(["m2"]);
    expect(delta.superseded.map((u) => u.id)).toEqual(["m3"]);
    expect(delta.skipped[0]!.candidate?.id).toBe("m4");
  });

  it("falls back to outcomes counts + runtimeFacts when units[] is absent", () => {
    const delta = toMemoryDelta(
      ingestion({
        serverResponse: {
          status: 200,
          json: { outcomes: { create: 2, "merge-update": 1 } },
        },
        runtimeFacts: [
          { l2: "fact one", confidence: 0.9, category: "events" },
          { l2: "fact two" },
          { l2: "merged fact" },
        ],
      }),
      ctx,
    );
    expect(delta.added).toHaveLength(2);
    expect(delta.added[0]!.content).toBe("fact one");
    expect(delta.added[0]!.confidence).toBe(0.9);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0]!.content).toBe("merged fact");
  });

  it("clamps confidence to [0, 1]", () => {
    const delta = toMemoryDelta(
      ingestion({
        serverResponse: {
          status: 200,
          json: {
            units: [
              { id: "high", outcome: "create", content: "x", confidence: 5 },
              { id: "low", outcome: "create", content: "y", confidence: -2 },
            ],
          },
        },
      }),
      ctx,
    );
    expect(delta.added[0]!.confidence).toBe(1);
    expect(delta.added[1]!.confidence).toBe(0);
  });

  it("emits no entries when outcomes are zero and no units provided", () => {
    const delta = toMemoryDelta(
      ingestion({
        serverResponse: {
          status: 200,
          json: { outcomes: { create: 0 } },
        },
      }),
      ctx,
    );
    expect(delta.added).toEqual([]);
    expect(delta.updated).toEqual([]);
  });
});

describe("toRetrievalSet", () => {
  it("maps row.selected into candidates with rank and score", () => {
    const row: HarnessReplayTurnRow = {
      turnId: "t-1",
      prompt: "hello?",
      count: 2,
      selected: [
        { id: "m1", title: "alpha", rank: 1, score: 0.9 },
        { id: "m2", title: "beta", rank: 2, score: 0.7 },
      ],
      retrievalMs: 42,
    };
    const set = toRetrievalSet(row, ctx);
    expect(set.query).toBe("hello?");
    expect(set.retrieval_ms).toBe(42);
    expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]!.unit.id).toBe("m1");
    expect(set.candidates[0]!.score).toBe(0.9);
    expect(set.candidates[0]!.rank).toBe(1);
  });

  it("filters out entries missing an id", () => {
    const row: HarnessReplayTurnRow = {
      turnId: "t-1",
      prompt: "?",
      count: 1,
      selected: [
        { id: "", title: "skipped", rank: 1, score: 0.5 },
        { id: "m1", title: "kept", rank: 2, score: 0.3 },
      ],
    };
    const set = toRetrievalSet(row, ctx);
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0]!.unit.id).toBe("m1");
  });

  it("derives a synthetic rank when the input rank is missing or zero", () => {
    const row: HarnessReplayTurnRow = {
      turnId: "t-1",
      prompt: "?",
      count: 2,
      selected: [
        { id: "m1", title: "a", rank: null, score: null },
        { id: "m2", title: "b", rank: 0, score: 0.1 },
      ],
    };
    const set = toRetrievalSet(row, ctx);
    expect(set.candidates[0]!.rank).toBe(1);
    expect(set.candidates[1]!.rank).toBe(2);
  });

  it("clamps negative retrievalMs to zero", () => {
    const set = toRetrievalSet(
      {
        turnId: "t-1",
        prompt: "?",
        count: 0,
        selected: [],
        retrievalMs: -10,
      },
      ctx,
    );
    expect(set.retrieval_ms).toBe(0);
  });
});

describe("toOpenerArtifact", () => {
  it("returns an empty memories_used array when no ctx is provided", () => {
    const out = toOpenerArtifact(
      {
        turnId: "t-1",
        prompt: "topic?",
        count: 1,
        injectedContext: "INJECT",
        selected: [{ id: "m1", title: "x", rank: 1, score: 0.5 }],
      },
      "session",
    );
    expect(out.memories_used).toEqual([]);
    expect(out.prepend_text).toBe("INJECT");
    expect(out.kind).toBe("session");
  });

  it("populates memories_used when ctx is provided", () => {
    const out = toOpenerArtifact(
      {
        turnId: "t-1",
        prompt: "topic?",
        count: 1,
        injectedContext: null,
        selected: [{ id: "m1", title: "x", rank: 1, score: 0.5 }],
      },
      "turn",
      ctx,
    );
    expect(out.memories_used).toHaveLength(1);
    expect(out.memories_used[0]!.id).toBe("m1");
    expect(out.prepend_text).toBe("");
  });
});

describe("toTraceBundle", () => {
  it("assembles deltas, retrievals, openers, and answers", () => {
    const bundle = toTraceBundle({
      transcript: [],
      ingestionResults: [
        ingestion({
          serverResponse: {
            status: 200,
            json: {
              units: [{ id: "m1", outcome: "create", content: "x" }],
            },
          },
        }),
      ],
      replayRows: [
        {
          turnId: "t-1",
          prompt: "?",
          count: 1,
          selected: [{ id: "m1", title: "x", rank: 1, score: 0.5 }],
        },
      ],
      answers: [],
      ctx,
      sessionOpenerRow: {
        turnId: "t-0",
        prompt: "session opener",
        count: 0,
        selected: [],
        injectedContext: "SESSION",
      },
    });
    expect(bundle.status).toBe("ok");
    expect(bundle.deltas).toHaveLength(1);
    expect(bundle.retrievals).toHaveLength(1);
    expect(bundle.openers).toHaveLength(2);
    expect(bundle.openers[0]!.kind).toBe("session");
    expect(bundle.openers[1]!.kind).toBe("turn");
  });

  it("honors an explicit status override", () => {
    const bundle = toTraceBundle({
      transcript: [],
      ingestionResults: [],
      replayRows: [],
      answers: [],
      ctx,
      status: "partial",
      traceStoreRefs: ["ref-1"],
    });
    expect(bundle.status).toBe("partial");
    expect(bundle.trace_store_refs).toEqual(["ref-1"]);
  });
});
