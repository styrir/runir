import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ThinkSynthesis } from "../recall/orchestrator/think-synthesis.js";
import { runThinkBenchmark } from "../testing/think-benchmark/run.js";
import { scoreThinkSynthesis } from "../testing/think-benchmark/score.js";
import type { ThinkBenchmarkCase } from "../testing/think-benchmark/types.js";

const CASE: ThinkBenchmarkCase = {
  id: "one",
  description: "one",
  question: "Which database?",
  evidence: [{ id: "semiote:database", text: "Rúnir uses SurrealDB." }],
  gold: {
    answerExpected: true,
    supportedClaims: [{
      id: "database",
      mustContain: ["SurrealDB"],
      evidenceIds: ["semiote:database"],
    }],
    forbiddenContains: ["PostgreSQL"],
    requiredGapContains: [],
  },
};

function synthesis(claimText: string): ThinkSynthesis {
  return {
    answer: claimText,
    claims: [{
      text: claimText,
      citations: [{ id: "semiote:database", index: 0 }],
      droppedCitations: [],
    }],
    citations: [{ id: "semiote:database", index: 0 }],
    gaps: [],
    droppedCitations: [],
    schemaValid: true,
    parseClassification: "valid",
  };
}

describe("Think deterministic scoring", () => {
  it("gives a fully supported claim a strict pass vector", () => {
    expect(scoreThinkSynthesis(CASE, synthesis("Rúnir uses SurrealDB."), true)).toMatchObject({
      answerCompleteness: 1,
      unsupportedClaimRate: 0,
      citationValidity: 1,
      citationPrecision: 1,
      citationCompleteness: 1,
      gapAccuracy: 1,
      abstentionCorrect: 1,
    });
  });

  it("detects an arbitrary invented claim even when it avoids forbidden phrases", () => {
    expect(scoreThinkSynthesis(CASE, synthesis("The moon is made of cheese."), true).unsupportedClaimRate).toBe(1);
  });

  it("rejects merged shotgun claims and scans claim text for forbidden traps", () => {
    const multiCase: ThinkBenchmarkCase = {
      ...CASE,
      evidence: [
        { id: "semiote:database", text: "Rúnir uses SurrealDB." },
        { id: "semiote:port", text: "Rúnir uses port 7700." },
      ],
      gold: {
        answerExpected: true,
        supportedClaims: [
          CASE.gold.supportedClaims[0]!,
          { id: "port", mustContain: ["7700"], evidenceIds: ["semiote:port"] },
        ],
        forbiddenContains: ["PostgreSQL"],
        requiredGapContains: [],
      },
    };
    const merged: ThinkSynthesis = {
      answer: "Rúnir uses SurrealDB on 7700.",
      claims: [{
        text: "Rúnir uses SurrealDB and PostgreSQL on 7700.",
        citations: [
          { id: "semiote:database", index: 0 },
          { id: "semiote:port", index: 1 },
        ],
        droppedCitations: [],
      }],
      citations: [
        { id: "semiote:database", index: 0 },
        { id: "semiote:port", index: 1 },
      ],
      gaps: [],
      droppedCitations: [],
      schemaValid: true,
      parseClassification: "valid",
    };
    const quality = scoreThinkSynthesis(multiCase, merged, true);
    expect(quality.unsupportedClaimRate).toBe(1);
    expect(quality.answerCompleteness).toBe(0);
    expect(quality.forbiddenMatches).toEqual(["PostgreSQL"]);
  });
});

describe("Think benchmark runner", () => {
  const fixtureText = readFileSync(join(process.cwd(), "fixtures/think-benchmark/corpus.json"), "utf8");
  const corpus = JSON.parse(fixtureText) as ThinkBenchmarkCase[];

  it("defaults to a zero-network preflight", async () => {
    const fetchFn = vi.fn();
    const result = await runThinkBenchmark([], {
      cwd: process.cwd(),
      readFile: () => fixtureText,
      fetchFn,
      git: () => ({ sha: "a".repeat(40), dirty: false }),
      log: () => undefined,
    });
    expect(result.code).toBe(0);
    expect(result.options.dryRun).toBe(true);
    expect(result.rows).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("runs canned responses through the production prompt, request, parser, scorer, and artifacts", async () => {
    const writes = new Map<string, string>();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            answer: "A supported-looking canned answer.",
            claims: [{ text: "A supported-looking canned answer.", citations: [] }],
            gaps: [],
          }),
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await runThinkBenchmark([
      "--confirm-cost",
      "--max-total-cost-usd", "1",
      "--input-usd-per-1m", "0",
      "--output-usd-per-1m", "0",
      "--out-raw", "out/think.jsonl",
      "--out-report", "out/think.md",
    ], {
      cwd: "/tmp/runir-think-test",
      readFile: () => fixtureText,
      fetchFn,
      env: { OPENROUTER_API_KEY: "infisical-injected" },
      git: () => ({ sha: "b".repeat(40), dirty: false }),
      randomId: () => "think-canned",
      now: () => new Date("2026-08-07T12:00:00.000Z"),
      fileExists: () => false,
      writeFile: (path, value) => writes.set(path, value),
      log: () => undefined,
    });
    expect(result.code).toBe(0);
    expect(result.rows).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(result.rows.every((row) => row.effectiveRequest.reasoning === undefined)).toBe(true);
    expect(result.manifest?.suiteId).toBe("runir-think-synthesis");
    expect([...writes.keys()].some((path) => path.endsWith(".manifest.json"))).toBe(true);
    expect([...writes.keys()].some((path) => path.endsWith(".jsonl"))).toBe(true);
    expect([...writes.keys()].some((path) => path.endsWith(".md"))).toBe(true);
  });

  it("refuses an existing artifact target before any paid request", async () => {
    const fetchFn = vi.fn();
    const result = await runThinkBenchmark([
      "--confirm-cost",
      "--max-total-cost-usd", "1",
      "--input-usd-per-1m", "0",
      "--output-usd-per-1m", "0",
    ], {
      cwd: "/tmp/runir-think-collision-test",
      readFile: () => fixtureText,
      fetchFn,
      env: { OPENROUTER_API_KEY: "infisical-injected" },
      git: () => ({ sha: "b".repeat(40), dirty: false }),
      fileExists: () => true,
      log: () => undefined,
    });
    expect(result.code).toBe(5);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects gold evidence references that are not present in the frozen case", async () => {
    const invalidCorpus = JSON.stringify([{
      ...CASE,
      gold: {
        ...CASE.gold,
        supportedClaims: [{
          ...CASE.gold.supportedClaims[0],
          evidenceIds: ["semiote:missing"],
        }],
      },
    }]);
    const result = await runThinkBenchmark([], {
      cwd: process.cwd(),
      readFile: () => invalidCorpus,
      git: () => ({ sha: "b".repeat(40), dirty: false }),
      log: () => undefined,
    });
    expect(result.code).toBe(3);
    expect(result.error).toContain("references missing evidence");
  });

  it("runs the e2e suite through a loopback /memory/think contract without requiring a model key in the runner", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { question: string };
      const benchmarkCase = corpus.find((item) => item.question === request.question)!;
      const claims = benchmarkCase.gold.supportedClaims.map((claim) => ({
        text: claim.mustContain.join(" "),
        citations: claim.evidenceIds.map((id, index) => ({ id, index })),
      }));
      const answer = benchmarkCase.gold.answerExpected ? claims.map((claim) => claim.text).join(". ") : null;
      const retainedIds = [...new Set(
        benchmarkCase.gold.supportedClaims.flatMap((claim) => claim.evidenceIds),
      )];
      return new Response(JSON.stringify({
        answer,
        claims,
        citations: retainedIds.map((id, index) => ({ id, index })),
        gaps: benchmarkCase.gold.requiredGapContains,
        evidence: retainedIds.map((id) => ({
          id,
          preview: benchmarkCase.evidence.find((item) => item.id === id)?.text ?? "evidence",
        })),
        evidenceCount: retainedIds.length,
        retrievalTraceId: "trace-e2e",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        retrieval: {
          selectedBeforeCap: retainedIds.length,
          selectedIds: retainedIds,
          retainedIds,
          cap: 12,
          synthesisSkipped: !benchmarkCase.gold.answerExpected && retainedIds.length === 0,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await runThinkBenchmark([
      "--suite", "e2e",
      "--service-url", "http://127.0.0.1:7700",
      "--confirm-cost",
      "--max-total-cost-usd", "1",
      "--input-usd-per-1m", "0",
      "--output-usd-per-1m", "0",
      "--out-raw", "out/e2e.jsonl",
      "--out-report", "out/e2e.md",
    ], {
      cwd: "/tmp/runir-think-e2e-test",
      readFile: () => fixtureText,
      fetchFn,
      env: {},
      git: () => ({ sha: "c".repeat(40), dirty: false }),
      randomId: () => "think-e2e-canned",
      now: () => new Date("2026-08-07T12:00:00.000Z"),
      fileExists: () => false,
      writeFile: () => undefined,
      log: () => undefined,
    });
    expect(result.code).toBe(0);
    expect(result.manifest?.suiteId).toBe("runir-think-e2e");
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((row) => row.retrieval?.cap === 12)).toBe(true);
    expect(result.rows.every((row) =>
      row.quality.citationValidity === 1 &&
      row.quality.unsupportedClaimRate === 0)).toBe(true);
    expect(result.rows.every((row) => row.costBasis === "token_usage_estimate")).toBe(true);
  });
});
