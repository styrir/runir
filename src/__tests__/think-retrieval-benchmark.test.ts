import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  THINK_RETRIEVAL_TOP_K,
} from "../recall/orchestrator/think-synthesis.js";
import { validateThinkRetrievalFixture } from "../testing/think-benchmark/index.js";
import { runThinkBenchmark } from "../testing/think-benchmark/run.js";
import { scoreThinkRetrieval } from "../testing/think-benchmark/score.js";
import {
  THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
  type ThinkBenchmarkCase,
} from "../testing/think-benchmark/types.js";

const CORPUS_TEXT = readFileSync(
  join(process.cwd(), "fixtures/think-benchmark/corpus.json"),
  "utf8",
);
const RETRIEVAL_TEXT = readFileSync(
  join(process.cwd(), "fixtures/think-benchmark/retrieval-corpus.json"),
  "utf8",
);
const CASES = JSON.parse(CORPUS_TEXT) as ThinkBenchmarkCase[];

describe("Think retrieval scoring", () => {
  it("reports recall, precision, and relevant ranks separately", () => {
    const scores = scoreThinkRetrieval(
      {
        relevantIds: ["semiote:relevant-a", "semiote:relevant-b"],
        distractorIds: [
          "semiote:distractor-a",
          "semiote:distractor-b",
        ],
      },
      ["distractor-a", "relevant-a", "distractor-b", "relevant-b"],
      ["distractor-a", "relevant-a"],
    );

    expect(scores).toEqual({
      recall: 1,
      precision: 0.5,
      firstRelevantRank: 2,
      meanRelevantRank: 3,
      retainedRecall: 0.5,
      retrievedRelevantIds: ["relevant-a", "relevant-b"],
      retrievedDistractorIds: ["distractor-a", "distractor-b"],
      missingRelevantIds: [],
    });
  });

  it("keeps no-relevant recall and ranks explicitly unscored", () => {
    expect(scoreThinkRetrieval(
      {
        relevantIds: [],
        distractorIds: ["semiote:distractor-a"],
      },
      ["distractor-a"],
      ["distractor-a"],
    )).toMatchObject({
      recall: null,
      precision: 0,
      firstRelevantRank: null,
      meanRelevantRank: null,
      retainedRecall: null,
    });
  });

  it("rejects selected ids outside the frozen attribution partition", () => {
    expect(() => scoreThinkRetrieval(
      {
        relevantIds: ["semiote:relevant-a"],
        distractorIds: ["semiote:distractor-a"],
      },
      ["unknown"],
      [],
    )).toThrow(/outside the frozen retrieval partition/u);
  });
});

describe("Think retrieval fixture", () => {
  it("freezes an attributed corpus larger than the production retrieval window", () => {
    const fixture = validateThinkRetrievalFixture(
      JSON.parse(
        readFileSync(
          join(process.cwd(), "fixtures/think-benchmark/retrieval-corpus.json"),
          "utf8",
        ),
      ) as unknown,
      CASES,
    );

    expect(fixture.memories.length).toBeGreaterThan(THINK_RETRIEVAL_TOP_K);
    expect(fixture.cases.map((item) => item.caseId)).toEqual(
      CASES.map((item) => item.id),
    );
    const seedIds = new Set(fixture.memories.map((item) => item.id));
    for (const benchmarkCase of fixture.cases) {
      expect(new Set([
        ...benchmarkCase.relevantIds,
        ...benchmarkCase.distractorIds,
      ])).toEqual(seedIds);
    }
    expect(fixture.attributionProbe.expected).toEqual({
      recall: 1,
      precision: 0.5,
      firstRelevantRank: 2,
      meanRelevantRank: 3,
      retainedRecall: 0.5,
      retrievedRelevantIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      retrievedDistractorIds: [
        "80000001-0000-4000-8000-000000000001",
        "80000002-0000-4000-8000-000000000002",
      ],
      missingRelevantIds: [],
    });
  });

  it("runs an attributed e2e preflight without fetch or artifact writes", async () => {
    const fetchFn = vi.fn();
    const writeFile = vi.fn();
    const result = await runThinkBenchmark(["--suite", "e2e"], {
      cwd: process.cwd(),
      readFile: (path) => path.endsWith("retrieval-corpus.json")
        ? RETRIEVAL_TEXT
        : CORPUS_TEXT,
      fetchFn,
      writeFile,
      git: () => ({ sha: "a".repeat(40), dirty: false }),
      log: () => undefined,
    });

    expect(result.code).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.preflight?.retrieval).toMatchObject({
      seedCount: 32,
      retrievalWindow: 24,
      synthesisCap: 12,
      metricContractVersion: THINK_RETRIEVAL_METRIC_CONTRACT_VERSION,
      attributionScores: {
        recall: 1,
        precision: 0.5,
        firstRelevantRank: 2,
        meanRelevantRank: 3,
        retainedRecall: 0.5,
      },
    });
    expect(result.preflight?.retrieval.fixtureContentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a seed corpus that does not exceed the retrieval window", () => {
    const fixture = validateThinkRetrievalFixture(
      JSON.parse(RETRIEVAL_TEXT) as unknown,
      CASES,
    );
    const undersized = {
      ...fixture,
      memories: fixture.memories.slice(0, THINK_RETRIEVAL_TOP_K),
    };

    expect(() => validateThinkRetrievalFixture(undersized, CASES))
      .toThrow(/must exceed the retrieval window/u);
  });
});
