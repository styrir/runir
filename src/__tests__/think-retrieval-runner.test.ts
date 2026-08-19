import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  retrievalGoldForCase,
  validateThinkRetrievalFixture,
} from "../testing/think-benchmark/retrieval.js";
import { runThinkBenchmark } from "../testing/think-benchmark/run.js";
import type { ThinkBenchmarkCase } from "../testing/think-benchmark/types.js";

const CORPUS_TEXT = readFileSync(
  join(process.cwd(), "fixtures/think-benchmark/corpus.json"),
  "utf8",
);
const RETRIEVAL_TEXT = readFileSync(
  join(process.cwd(), "fixtures/think-benchmark/retrieval-corpus.json"),
  "utf8",
);
const CASES = JSON.parse(CORPUS_TEXT) as ThinkBenchmarkCase[];
const RETRIEVAL_FIXTURE = validateThinkRetrievalFixture(
  JSON.parse(RETRIEVAL_TEXT) as unknown,
  CASES,
);
const MEMORY_TEXT = new Map(
  RETRIEVAL_FIXTURE.memories.map((memory) => [
    memory.id.replace(/^semiote:/u, ""),
    memory.text,
  ]),
);

describe("Think distractor-scale e2e runner", () => {
  it("reports retrieval recall, precision, and ranks separately from synthesis", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { question: string };
      const benchmarkCase = CASES.find((item) => item.question === request.question);
      if (!benchmarkCase) throw new Error("unknown benchmark question");
      const gold = retrievalGoldForCase(RETRIEVAL_FIXTURE, benchmarkCase.id);
      const relevantIds = gold.relevantIds.map((id) => id.replace(/^semiote:/u, ""));
      const distractorIds = gold.distractorIds.map((id) => id.replace(/^semiote:/u, ""));
      const selectedIds = [...relevantIds, ...distractorIds].slice(
        0,
        RETRIEVAL_FIXTURE.retrievalWindow,
      );
      const retainedIds = selectedIds.slice(0, RETRIEVAL_FIXTURE.synthesisCap);
      const claims = benchmarkCase.gold.supportedClaims.map((claim) => ({
        text: claim.mustContain.join(" "),
        citations: claim.evidenceIds.map((id) => id.replace(/^semiote:/u, "")),
      }));
      const answer = benchmarkCase.gold.answerExpected
        ? claims.map((claim) => claim.text).join(". ")
        : null;

      return new Response(JSON.stringify({
        answer,
        claims,
        citations: relevantIds.map((id, index) => ({ id, index })),
        gaps: benchmarkCase.gold.requiredGapContains,
        evidence: retainedIds.map((id) => ({
          id,
          preview: MEMORY_TEXT.get(id),
        })),
        retrievalTraceId: `trace-${benchmarkCase.id}`,
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        retrieval: {
          selectedBeforeCap: selectedIds.length,
          selectedIds,
          retainedIds,
          cap: RETRIEVAL_FIXTURE.synthesisCap,
          synthesisSkipped: false,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await runThinkBenchmark([
      "--suite", "e2e",
      "--confirm-cost",
      "--max-total-cost-usd", "1",
      "--input-usd-per-1m", "0",
      "--output-usd-per-1m", "0",
      "--out-raw", "out/e2e.jsonl",
      "--out-report", "out/e2e.md",
    ], {
      cwd: "/tmp/runir-think-distractor-test",
      readFile: (path) => path.endsWith("retrieval-corpus.json")
        ? RETRIEVAL_TEXT
        : CORPUS_TEXT,
      fetchFn,
      env: {},
      git: () => ({ sha: "c".repeat(40), dirty: false }),
      randomId: () => "think-e2e-distractor",
      now: () => new Date("2026-08-19T12:00:00.000Z"),
      fileExists: () => false,
      writeFile: () => undefined,
      log: () => undefined,
    });

    expect(result.code).toBe(0);
    expect(result.rows).toHaveLength(CASES.length);
    expect(result.rows[0]?.retrieval?.scores).toMatchObject({
      recall: 1,
      precision: 2 / 24,
      firstRelevantRank: 1,
      meanRelevantRank: 1.5,
      retainedRecall: 1,
    });
    expect(result.rows.find((row) => row.caseId === "honest-no-answer")?.retrieval?.scores)
      .toMatchObject({
        recall: null,
        precision: 0,
        firstRelevantRank: null,
        meanRelevantRank: null,
        retainedRecall: null,
      });
  });
});
