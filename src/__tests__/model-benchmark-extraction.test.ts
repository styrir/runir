import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CANDIDATES,
  EXTENDED_CANDIDATES,
  assertLunaConfigsDistinct,
  buildReasoningParam,
  resolveCandidateMatrix,
} from "../testing/model-benchmark/candidates.js";
import { parseArgs } from "../testing/model-benchmark/cli.js";
import {
  buildEffectiveRequest,
  disallowedParamsFor,
  serializeRequestBody,
  productionCapturePrompt,
  buildUserContent,
} from "../testing/model-benchmark/request.js";
import { parseExtractionResponse } from "../testing/model-benchmark/parse-response.js";
import { percentile, plannedRequestCount, aggregateByCandidate } from "../testing/model-benchmark/metrics.js";
import {
  assertNoSecrets,
  credentialSourceLabel,
  redactSecrets,
  redactString,
} from "../testing/model-benchmark/redact.js";
import { regenerateReportFromRaw, formatPreflightDisclosure } from "../testing/model-benchmark/report.js";
import {
  assertPaidRunAllowed,
  buildDisclosure,
  loadCorpus,
  runBenchmark,
  selectCases,
} from "../testing/model-benchmark/run.js";
import {
  BENCHMARK_SCHEMA_VERSION,
  RESPONSE_PARSER_VERSION,
  type BenchmarkCase,
  type ResultRow,
  type RunManifest,
} from "../testing/model-benchmark/types.js";
import { SCORING_CONTRACT_VERSION } from "../testing/model-benchmark/types.js";
import { fixtureContentHashFor } from "../testing/model-benchmark/provenance.js";
import { scoreExtraction } from "../testing/model-benchmark/score.js";

const ROOT = join(import.meta.dirname, "../..");
const CORPUS = join(ROOT, "fixtures/model-benchmark/corpus.json");

function baseRow(over: Partial<ResultRow> = {}): ResultRow {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: "t1",
    timestamp: "2026-07-23T00:00:00.000Z",
    git: { sha: "abc", dirty: false },
    caseId: "atomic-simple",
    repetition: 1,
    candidateId: "flash-lite-3.1-control",
    candidateLabel: "control",
    modelId: "vertex/gemini-3.1-flash-lite@us",
    gatewayBaseUrl: "https://example.test/v1",
    promptHash: "ph",
    effectiveRequest: {
      modelId: "vertex/gemini-3.1-flash-lite@us",
      temperature: 0,
      max_tokens: 8192,
      notes: [],
    },
    responseParserVersion: RESPONSE_PARSER_VERSION,
    usage: { promptTokens: 100, completionTokens: 50 },
    latencyMs: 100,
    ttftMs: null,
    retryCount: 0,
    parse: {
      classification: "valid",
      schemaValid: true,
      facts: [{ l2: "User prefers Helix as editor" }],
      rawTextHead: "{}",
    },
    quality: {
      schemaValid: true,
      atomicPrecision: 1,
      atomicRecall: 1,
      hallucinationRate: 0,
      omissionRate: 0,
      granularityCompliance: 1,
      evidenceFidelity: null,
      abstentionCorrect: null,
      correctionHandling: null,
      matchedGoldIds: ["prefers-helix"],
      unmatchedExtracted: 0,
      unmatchedGold: 0,
    },
    estimatedCostUsd: 0.001,
    billedCostUsd: null,
    ...over,
  };
}

describe("model-benchmark-extraction — paid-run gate", () => {
  it("1. dry-run is the default and performs zero network calls", async () => {
    const fetchImpl = vi.fn();
    const writes: string[] = [];
    const result = await runBenchmark([], {
      cwd: ROOT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { ...process.env, REQUESTY_API_KEY: undefined, OPENROUTER_API_KEY: undefined },
      writeFile: (p, d) => {
        writes.push(p);
        void d;
      },
      stdout: () => {},
      stderr: () => {},
      gitInfo: () => ({ sha: "testsha", dirty: false }),
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });
    expect(result.code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.disclosure?.dryRun).toBe(true);
    expect(result.rows.every((r) => r.errorClass === "dry_run")).toBe(true);
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  it("2. missing --confirm-cost fails before the first network call on paid path", () => {
    expect(() =>
      assertPaidRunAllowed(
        {
          ...parseArgs([]),
          dryRun: false,
          confirmCost: false,
        },
        {},
      ),
    ).toThrow(/confirm-cost/);
  });

  it("3. missing credentials fail before the first network call", async () => {
    const fetchImpl = vi.fn();
    const result = await runBenchmark(["--confirm-cost", "--smoke"], {
      cwd: ROOT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        PATH: process.env.PATH,
        // explicitly no keys
      },
      writeFile: () => {},
      stdout: () => {},
      stderr: () => {},
      gitInfo: () => ({ sha: "testsha", dirty: false }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.code).toBe(3);
    expect(result.error).toMatch(/missing credentials/i);
  });

  it("CI blocks --confirm-cost even with credentials", async () => {
    const fetchImpl = vi.fn();
    const result = await runBenchmark(["--confirm-cost"], {
      cwd: ROOT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { CI: "true", REQUESTY_API_KEY: "sk-test-secret-value-123456" },
      writeFile: () => {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.code).toBe(3);
    expect(result.error).toMatch(/CI/);
  });
});

describe("model-benchmark-extraction — secrets", () => {
  it("4. secrets never appear in stdout, reports, raw artifacts, or thrown paths", async () => {
    const secret = "sk-secretLEAKVALUE99999";
    const chunks: string[] = [];
    const files = new Map<string, string>();
    const result = await runBenchmark(["--dry-run"], {
      cwd: ROOT,
      env: { REQUESTY_API_KEY: secret },
      writeFile: (p, d) => {
        files.set(p, d);
      },
      stdout: (s) => chunks.push(s),
      stderr: (s) => chunks.push(s),
      gitInfo: () => ({ sha: "x", dirty: false }),
    });
    expect(result.code).toBe(0);
    const blob = chunks.join("\n") + [...files.values()].join("\n") + JSON.stringify(result.rows);
    expect(blob).not.toContain(secret);
    expect(() => assertNoSecrets(blob, [secret])).not.toThrow();
    expect(redactString(`Authorization: Bearer ${secret}`, [secret])).toContain("[REDACTED]");
    expect(redactSecrets({ apiKey: secret, nested: { t: secret } }, [secret])).toEqual({
      apiKey: "[REDACTED]",
      nested: { t: "[REDACTED]" },
    });
  });
});

describe("model-benchmark-extraction — disclosure math", () => {
  it("5. request count and cost disclosure match matrix, fixtures, repetitions", () => {
    const candidates = resolveCandidateMatrix(["default"]);
    const cases = selectCases(loadCorpus(CORPUS), true);
    const opts = parseArgs(["--smoke", "--repetitions", "3"]);
    const disclosure = buildDisclosure({
      candidates,
      cases,
      opts,
      baseUrl: "https://router.example/v1",
      env: {},
    });
    expect(cases).toHaveLength(3);
    expect(disclosure.plannedRequestCount).toBe(
      plannedRequestCount({
        candidateCount: candidates.length,
        caseCount: 3,
        repetitions: 3,
      }),
    );
    expect(disclosure.plannedRequestCount).toBe(candidates.length * 3 * 3);
    expect(disclosure.corpusSize).toBe(3);
    expect(disclosure.maxOutputTokens).toBe(8192);
    expect(disclosure.gatewayBaseUrl).toBe("https://router.example/v1");
    expect(disclosure.credentialSourceLabel).toBe("missing");
    expect(disclosure.costEstimate.estimatedTotalUsd).not.toBeNull();
    expect(disclosure.costEstimate.assumedPromptTokensPerRequest).toBe(7_500);
    expect(disclosure.costEstimate.note).toContain("6,958-token live-smoke mean");
    expect(disclosure.costEstimate.note).not.toContain("Conservative");
    const text = formatPreflightDisclosure(disclosure);
    expect(text).toContain(`plannedRequestCount: ${disclosure.plannedRequestCount}`);
    expect(text).toContain("vertex/gemini-3.1-flash-lite@us");
    expect(text).toContain("vertex/gemini-3.5-flash-lite");
    expect(text).toContain("openai/gpt-5.6-luna");
    expect(text).toContain("xai/grok-4.5");
    expect(candidates).toHaveLength(4);
    expect(candidates.map((c) => c.id)).toEqual([
      "flash-lite-3.1-control",
      "flash-lite-3.5",
      "luna-low",
      "grok-4.5-low",
    ]);
  });
});

describe("model-benchmark-extraction — reasoning configs", () => {
  it("6. Luna low and Luna none serialize as distinct effective configurations", () => {
    const matrix = resolveCandidateMatrix(["luna-low", "luna-none"]);
    expect(matrix).toHaveLength(2);
    assertLunaConfigsDistinct(matrix);
    const low = buildReasoningParam(matrix[0]!);
    const none = buildReasoningParam(matrix[1]!);
    expect(low.param).toEqual({ reasoning_effort: "low" });
    expect(none.param).toEqual({ reasoning_effort: "none" });
    expect(JSON.stringify(low.param)).not.toEqual(JSON.stringify(none.param));

    const lowBody = serializeRequestBody(
      buildEffectiveRequest({ candidate: matrix[0]!, maxOutputTokens: 100 }),
      "sys",
      "user",
    );
    const noneBody = serializeRequestBody(
      buildEffectiveRequest({ candidate: matrix[1]!, maxOutputTokens: 100 }),
      "sys",
      "user",
    );
    expect(lowBody.reasoning_effort).toBe("low");
    expect(noneBody.reasoning_effort).toBe("none");
  });

  it("7. unsupported reasoning configuration fails or is explicitly marked; never silently mislabeled", () => {
    const flash = DEFAULT_CANDIDATES.find((c) => c.id === "flash-lite-3.1-control")!;
    expect(() =>
      buildReasoningParam({ ...flash, reasoning: "low" }),
    ).toThrow(/unsupported/);

    // Synthetic default-only candidate (gateway default unlabeled)
    const defaultOnly = {
      id: "synth-default-only",
      label: "synth",
      modelId: "vendor/synth",
      reasoning: "low" as const,
      reasoningSupport: "default-only" as const,
      jsonMode: "off" as const,
    };
    const built = buildReasoningParam(defaultOnly);
    expect(built.param).toBeUndefined();
    expect(built.effective).toBeUndefined();
    expect(built.notes.some((n) => /default-only/i.test(n))).toBe(true);
    const eff = buildEffectiveRequest({ candidate: defaultOnly, maxOutputTokens: 100 });
    expect(eff.reasoning).toBeUndefined();
    expect(eff.notes.some((n) => /unlabeled|default/i.test(n))).toBe(true);

    // Grok 4.5 low is in the primary matrix
    const grok = DEFAULT_CANDIDATES.find((c) => c.id === "grok-4.5-low")!;
    expect(grok.reasoningSupport).toBe("native");
    expect(grok.reasoning).toBe("low");
    const grokBuilt = buildReasoningParam(grok);
    expect(grokBuilt.param).toEqual({ reasoning_effort: "low" });
    expect(grokBuilt.effective).toBe("low");
  });

  it("8. provider-specific unsupported parameters are not sent", () => {
    const flash = DEFAULT_CANDIDATES.find((c) => c.id === "flash-lite-3.1-control")!;
    const body = serializeRequestBody(
      buildEffectiveRequest({ candidate: flash, maxOutputTokens: 256 }),
      productionCapturePrompt("2026-07-23T00:00:00.000Z"),
      buildUserContent([{ role: "user", content: "hi" }]),
    );
    for (const key of disallowedParamsFor(flash)) {
      expect(body[key]).toBeUndefined();
    }
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();

    const luna = DEFAULT_CANDIDATES.find((c) => c.id === "luna-low")!;
    const lunaBody = serializeRequestBody(
      buildEffectiveRequest({ candidate: luna, maxOutputTokens: 256 }),
      productionCapturePrompt("2026-07-23T00:00:00.000Z"),
      buildUserContent([{ role: "user", content: "hi" }]),
    );
    expect(lunaBody.response_format).toEqual({ type: "json_object" });
    expect(lunaBody.reasoning_effort).toBe("low");
    expect(
      (lunaBody.messages as Array<{ content: string }>)
        .map((message) => message.content)
        .join("\n"),
    ).toMatch(/\bjson\b/);

    const grok = DEFAULT_CANDIDATES.find((c) => c.id === "grok-4.5-low")!;
    const grokBody = serializeRequestBody(
      buildEffectiveRequest({ candidate: grok, maxOutputTokens: 256 }),
      "sys",
      "user",
    );
    expect(grokBody.reasoning_effort).toBe("low");
    expect(grokBody.response_format).toBeUndefined();
  });
});

describe("model-benchmark-extraction — response classification", () => {
  it("9. valid, fenced, prose-prefixed, malformed, and wrong-schema responses are classified correctly", () => {
    const valid = parseExtractionResponse(
      JSON.stringify({
        facts: [
          {
            l2: "User prefers Helix",
            confidence: 0.9,
            source_turn_index: 0,
            category: "preferences",
          },
        ],
      }),
    );
    expect(valid.classification).toBe("valid");
    expect(valid.schemaValid).toBe(true);
    expect(valid.facts).toHaveLength(1);

    const fenced = parseExtractionResponse('```json\n{"facts":[]}\n```');
    expect(fenced.classification).toBe("fenced");
    expect(fenced.schemaValid).toBe(true);

    const prose = parseExtractionResponse('Sure! Here you go:\n{"facts":[]}');
    expect(prose.classification).toBe("prose_prefixed");
    expect(prose.schemaValid).toBe(true);

    const malformed = parseExtractionResponse("this is not json at all {{{");
    expect(malformed.classification).toBe("malformed");
    expect(malformed.schemaValid).toBe(false);

    // jsonrepair can salvage some broken shapes into schema-valid empty facts —
    // that is intentional and must not be labeled schema-invalid after recovery.
    const repaired = parseExtractionResponse("{facts: [");
    expect(repaired.classification).toBe("malformed");
    expect(repaired.schemaValid).toBe(true);
    expect(repaired.facts).toEqual([]);

    const wrong = parseExtractionResponse(JSON.stringify([{ l2: "x" }]));
    expect(wrong.classification).toBe("wrong_schema");
    expect(wrong.schemaValid).toBe(false);

    const empty = parseExtractionResponse("");
    expect(empty.classification).toBe("empty_content");
  });
});

describe("model-benchmark-extraction — metrics", () => {
  it("10. usage and latency aggregation computes percentiles correctly", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBeCloseTo(46, 5);
    expect(percentile([10], 95)).toBe(10);

    const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((latencyMs, i) =>
      baseRow({
        candidateId: "c1",
        candidateLabel: "C1",
        modelId: "m",
        latencyMs,
        usage: { completionTokens: latencyMs },
        quality: {
          ...baseRow().quality,
          atomicPrecision: i % 2 === 0 ? 1 : 0.5,
        },
      }),
    );
    const [agg] = aggregateByCandidate(rows);
    expect(agg!.n).toBe(10);
    expect(agg!.latency.min).toBe(10);
    expect(agg!.latency.max).toBe(100);
    expect(agg!.latency.p50).toBe(55);
    expect(agg!.meanOutputTokens).toBe(55);
  });
});

describe("model-benchmark-extraction — provenance + report", () => {
  it("11. raw JSON/JSONL artifacts contain required provenance", async () => {
    const files = new Map<string, string>();
    const result = await runBenchmark(
      ["--dry-run", "--smoke", "--repetitions", "1", "--out-raw", "tmp-bench.jsonl", "--out-report", "tmp-bench.md"],
      {
        cwd: ROOT,
        writeFile: (p, d) => files.set(p, d),
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "deadbeef", dirty: true }),
        now: () => new Date("2026-07-23T12:00:00.000Z"),
        env: {},
      },
    );
    expect(result.code).toBe(0);
    const jsonl = [...files.entries()].find(([p]) => p.endsWith(".jsonl"))?.[1] ?? "";
    const row = JSON.parse(jsonl.trim().split("\n")[0]!) as ResultRow;
    expect(row.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(row.runId).toBeTruthy();
    expect(row.timestamp).toBeTruthy();
    expect(row.git.sha).toBe("deadbeef");
    expect(row.git.dirty).toBe(true);
    expect(row.caseId).toBeTruthy();
    expect(row.repetition).toBe(1);
    expect(row.candidateId).toBeTruthy();
    expect(row.modelId).toBeTruthy();
    expect(row.gatewayBaseUrl).toBeTruthy();
    expect(row.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.effectiveRequest.max_tokens).toBe(8192);
    expect(row.responseParserVersion).toBe(RESPONSE_PARSER_VERSION);
    expect(row.usage).toBeDefined();
    expect(typeof row.latencyMs).toBe("number");
    expect(row.quality).toBeDefined();
    expect(row.parse).toBeDefined();
    expect(result.manifest?.fixtureContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest?.fixtureContentHash).toBe(fixtureContentHashFor(readFileSync(CORPUS, "utf8")));
    expect(result.manifest?.promptTemplateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest?.scoringContractVersion).toBe(SCORING_CONTRACT_VERSION);
  });

  it("12. Markdown report can be regenerated entirely from the raw artifact", () => {
    const rows = [
      baseRow({ candidateId: "a", latencyMs: 10 }),
      baseRow({ candidateId: "b", candidateLabel: "B", modelId: "m2", latencyMs: 20 }),
    ];
    const manifest: RunManifest = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      runId: "r",
      createdAt: "2026-07-23T00:00:00.000Z",
      git: { sha: "abc", dirty: false },
      disclosure: {
        candidateModelIds: ["m1", "m2"],
        candidates: [
          {
            id: "a",
            label: "A",
            modelId: "m1",
            reasoningSupport: "unsupported",
            effectiveNotes: [],
          },
          {
            id: "b",
            label: "B",
            modelId: "m2",
            reasoningSupport: "native",
            reasoning: "low",
            effectiveNotes: ["native"],
          },
        ],
        corpusSize: 1,
        smokeMode: true,
        repetitions: 1,
        plannedRequestCount: 2,
        gatewayBaseUrl: "https://example.test/v1",
        credentialSourceLabel: "missing",
        maxOutputTokens: 8192,
        timeoutMs: 60000,
        concurrency: 1,
        costEstimate: {
          available: false,
          currency: "USD",
          estimatedTotalUsd: null,
          assumedPromptTokensPerRequest: 7_500,
          assumedCompletionTokensPerRequest: 800,
          maxTotalCostUsd: null,
          note: "n/a",
        },
        requireCleanGit: false,
        allowArtifactOverwrite: false,
        dryRun: true,
        confirmCost: false,
      },
      fixtureContentHash: "fixture-hash",
      promptTemplateHash: "template-hash",
      scoringContractVersion: SCORING_CONTRACT_VERSION,
      promptHash: "ph",
      fixturePath: CORPUS,
      rowCount: 2,
      artifactTargets: {
        rawPath: "/tmp/reference-a.jsonl",
        manifestPath: "/tmp/reference-a.manifest.json",
        reportPath: "/tmp/reference-a.md",
      },
    };
    const report1 = regenerateReportFromRaw(manifest, rows);
    const report2 = regenerateReportFromRaw(manifest, rows);
    expect(report1).toBe(report2);
    expect(report1).toContain("Executive recommendation");
    expect(report1).toContain("Quality");
    expect(report1).toContain("Latency / reliability");
    expect(report1).toContain("Cost");
    expect(report1).toContain("Reproduction");
    expect(report1).toContain("--models 'a,b'");
    expect(report1).toContain("--max-output-tokens 8192");
    expect(report1).toContain("--timeout-ms 60000");
    expect(report1).toContain("--base-url 'https://example.test/v1'");
    expect(report1).toContain("--out-raw '/tmp/reference-a.jsonl'");
    expect(report1).toContain("--out-report '/tmp/reference-a.md'");
    expect(report1).toContain("Required source: abc in a clean worktree");
  });

  it("regenerates a report from the real legacy full-primary artifact", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(ROOT, "docs/analysis/raw/model-benchmark-full-primary.manifest.json"),
        "utf8",
      ),
    ) as RunManifest;
    const rows = readFileSync(
      join(ROOT, "docs/analysis/raw/model-benchmark-full-primary.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ResultRow);

    expect(() => regenerateReportFromRaw(manifest, rows)).not.toThrow();
    const report = regenerateReportFromRaw(manifest, rows);
    expect(report).toContain("Rúnir Extraction Model Benchmark Report");
    expect(report).toContain("Cost note:");
    expect(report).toContain("legacy-unavailable");
  });
});

describe("model-benchmark-extraction — scoring smoke", () => {
  it("scores gold matches and abstention", () => {
    const corpus = loadCorpus(CORPUS);
    const multi = corpus.find((c) => c.id === "multi-claim-split")!;
    const parsed = parseExtractionResponse(
      JSON.stringify({
        facts: [
          { l2: "User prefers terse answers", category: "preferences", confidence: 0.9 },
          { l2: "User likes dark mode", category: "preferences", confidence: 0.9 },
          { l2: "User hates auto-expanding menus", category: "preferences", confidence: 0.9 },
        ],
      }),
    );
    const q = scoreExtraction(parsed, multi);
    expect(q.atomicRecall).toBe(1);
    expect(q.matchedGoldIds).toHaveLength(3);

    const trap = corpus.find((c) => c.id === "fabrication-trap")!;
    const bad = scoreExtraction(
      parseExtractionResponse(
        JSON.stringify({
          facts: [{ l2: "The service uses MongoDB in production", confidence: 0.9 }],
        }),
      ),
      trap,
    );
    expect(bad.abstentionCorrect).toBe(false);
    expect(bad.hallucinationRate).toBe(1);

    const goodAbstain = scoreExtraction(parseExtractionResponse('{"facts":[]}'), trap);
    expect(goodAbstain.abstentionCorrect).toBe(true);
  });

  it("corpus includes smoke trio and broader coverage", () => {
    const all = loadCorpus(CORPUS);
    expect(all.length).toBeGreaterThanOrEqual(12);
    const smoke = selectCases(all, true);
    expect(smoke.map((c) => c.id)).toEqual([
      "atomic-simple",
      "multi-claim-split",
      "fabrication-trap",
    ]);
  });
});

describe("model-benchmark-extraction — paid path with mocked fetch", () => {
  it("records rows from mocked gateway without leaking auth header contents", async () => {
    const secret = "sk-mockKEY000111222333";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      expect(auth).toContain(secret);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  facts: [
                    {
                      l2: "User prefers Helix as their editor for coding work.",
                      confidence: 0.95,
                      source_turn_index: 0,
                      category: "preferences",
                      tier: "durable",
                      tags: ["speaker:user"],
                      l0: "Editor: Helix",
                      l1: "## Preference\nHelix",
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const files = new Map<string, string>();
    const out: string[] = [];
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "luna-low",
        "--repetitions",
        "1",
        "--out-raw",
        "paid.jsonl",
        "--out-report",
        "paid.md",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: secret },
        writeFile: (p, d) => files.set(p, d),
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        gitInfo: () => ({ sha: "paidsha", dirty: false }),
        now: () => new Date("2026-07-23T15:00:00.000Z"),
      },
    );
    expect(result.code).toBe(0);
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.rows.length).toBe(3); // smoke 3 cases × 1 model × 1 rep
    const blob = out.join("\n") + [...files.values()].join("\n");
    expect(blob).not.toContain(secret);
    expect(credentialSourceLabel({ REQUESTY_API_KEY: secret })).toBe("env:REQUESTY_API_KEY");
  });

  it("blocks a publishable paid run on dirty Git before the first network call", async () => {
    const fetchImpl = vi.fn();
    const result = await runBenchmark(
      ["--confirm-cost", "--smoke", "--models", "flash-lite-3.1-control", "--require-clean-git"],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-clean-gate-test" },
        writeFile: () => {},
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "dirtysha", dirty: true }),
      },
    );
    expect(result.code).toBe(3);
    expect(result.error).toMatch(/worktree is dirty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops before the next request crosses the cost cap and preserves partial artifacts", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"facts\":[]}" } }],
          usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const files = new Map<string, string>();
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--condition-id",
        "reference-a",
        "--max-total-cost-usd",
        "0.0095",
        "--max-output-tokens",
        "2048",
        "--require-clean-git",
        "--out-raw",
        "capped.jsonl",
        "--out-report",
        "capped.md",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-cost-cap-test" },
        writeFile: (path, data) => files.set(path, data),
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
        now: () => new Date("2026-08-07T12:00:00.000Z"),
      },
    );

    expect(result.code).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.manifest).toMatchObject({
      conditionId: "reference-a",
      rowCount: 1,
      completion: {
        status: "partial",
        stopReason: "cost_cap",
        plannedRequestCount: 3,
        completedRequestCount: 1,
      },
    });
    expect(result.manifest!.completion!.cumulativeCostUsd).toBeGreaterThan(0);
    expect([...files.keys()].some((path) => path.endsWith("capped.jsonl"))).toBe(true);
    expect([...files.keys()].some((path) => path.endsWith("capped.manifest.json"))).toBe(true);
    expect([...files.keys()].some((path) => path.endsWith("capped.md"))).toBe(true);
    expect(result.report).toContain("Stop reason: `cost_cap`");
  });

  it("uses calibrated fallback cost when successful responses omit usage", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"facts\":[]}" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--max-total-cost-usd",
        "0.014",
        "--max-output-tokens",
        "2048",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-missing-usage-test" },
        writeFile: () => {},
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
      },
    );

    expect(result.code).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.rows[0]!.usage).toEqual({});
    expect(result.rows[0]!.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.manifest?.completion).toMatchObject({
      status: "partial",
      stopReason: "cost_cap",
      completedRequestCount: 1,
    });
  });

  it("preserves the rejected row and partial artifacts on authentication failure", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const files = new Map<string, string>();
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--condition-id",
        "auth-stop-check",
        "--out-raw",
        "auth-stop.jsonl",
        "--out-report",
        "auth-stop.md",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-auth-stop-test" },
        writeFile: (path, data) => files.set(path, data),
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
        now: () => new Date("2026-08-07T12:30:00.000Z"),
      },
    );

    expect(result.code).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ httpStatus: 401, errorClass: "http_401" });
    expect(result.manifest?.completion).toMatchObject({
      status: "partial",
      stopReason: "auth_failure",
      completedRequestCount: 1,
    });
    expect([...files.keys()].some((path) => path.endsWith("auth-stop.jsonl"))).toBe(true);
    expect(result.report).toContain("Stop reason: `auth_failure`");
  });

  it.each([
    {
      label: "network failure",
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
      expectedReason: "network_error",
      expectedErrorClass: "network",
    },
    {
      label: "parameter rejection",
      fetchImpl: vi.fn(async () =>
        new Response('{"error":"unsupported parameter"}', { status: 400 }),
      ),
      expectedReason: "model_rejected",
      expectedErrorClass: "http_400",
    },
    {
      label: "schema-invalid response",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not-json" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
      expectedReason: "schema_invalid",
      expectedErrorClass: "schema_invalid",
    },
  ])("stops and preserves partial artifacts on $label", async ({
    fetchImpl,
    expectedReason,
    expectedErrorClass,
  }) => {
    const files = new Map<string, string>();
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--out-raw",
        "fatal-stop.jsonl",
        "--out-report",
        "fatal-stop.md",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-fatal-stop-test" },
        writeFile: (path, data) => files.set(path, data),
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
      },
    );

    expect(result.code).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.errorClass).toBe(expectedErrorClass);
    expect(result.manifest?.completion).toMatchObject({
      status: "partial",
      stopReason: expectedReason,
      completedRequestCount: 1,
    });
    expect([...files.keys()].some((path) => path.endsWith("fatal-stop.jsonl"))).toBe(true);
  });

  it.each([
    {
      label: "negative billed cost",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 180,
        total_tokens: 1380,
        cost: -1,
      },
      invalidField: "cost",
    },
    {
      label: "negative token counter",
      usage: {
        prompt_tokens: -1,
        completion_tokens: 180,
        total_tokens: 179,
        cost: 0.001,
      },
      invalidField: "prompt_tokens",
    },
  ])("stops safely on $label", async ({ usage, invalidField }) => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"facts\":[]}" } }],
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await runBenchmark(
      ["--confirm-cost", "--smoke", "--models", "flash-lite-3.1-control"],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-invalid-usage-test" },
        writeFile: () => {},
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
      },
    );

    expect(result.code).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.errorClass).toBe("invalid_usage");
    expect(result.manifest?.completion).toMatchObject({
      status: "partial",
      stopReason: "invalid_usage",
      completedRequestCount: 1,
    });
    expect(result.manifest!.completion!.cumulativeCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.error).toContain(invalidField);
  });

  it("refuses existing artifact targets before network and preserves their bytes", async () => {
    const files = new Map<string, string>();
    const fetchImpl = vi.fn();
    const args = [
      "--dry-run",
      "--smoke",
      "--models",
      "flash-lite-3.1-control",
      "--out-raw",
      "immutable-reference.jsonl",
      "--out-report",
      "immutable-reference.md",
    ];
    const deps = {
      cwd: ROOT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
      writeFile: (path: string, data: string) => files.set(path, data),
      fileExists: (path: string) => files.has(path),
      stdout: () => {},
      stderr: () => {},
      gitInfo: () => ({ sha: "cleansha", dirty: false }),
      now: () => new Date("2026-08-07T14:00:00.000Z"),
    };

    const first = await runBenchmark(args, deps);
    expect(first.code).toBe(0);
    const original = new Map(files);

    const second = await runBenchmark(args, deps);
    expect(second.code).toBe(2);
    expect(second.error).toMatch(/refusing to overwrite/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(files).toEqual(original);
  });

  it("stops after a response when a target appears mid-run and never overwrites it", async () => {
    const files = new Map<string, string>();
    const rawPath = join(ROOT, "race-reference.jsonl");
    const sentinel = "immutable-existing-bytes\n";
    const fetchImpl = vi.fn(async () => {
      files.set(rawPath, sentinel);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"facts\":[]}" } }],
          usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--out-raw",
        "race-reference.jsonl",
        "--out-report",
        "race-reference.md",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-race-test" },
        writeFile: (path, data) => files.set(path, data),
        fileExists: (path) => files.has(path),
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
      },
    );

    expect(result.code).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.manifest?.completion).toMatchObject({
      status: "partial",
      stopReason: "artifact_collision",
      completedRequestCount: 1,
    });
    expect(files.get(rawPath)).toBe(sentinel);
    expect(files.has(join(ROOT, "race-reference.manifest.json"))).toBe(false);
    expect(files.has(join(ROOT, "race-reference.md"))).toBe(false);
  });

  it("marks the run partial when the final response itself exceeds the cost cap", async () => {
    const billedCosts = [0.001, 0.001, 0.04];
    const fetchImpl = vi.fn(async () => {
      const cost = billedCosts.shift()!;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"facts\":[]}" } }],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 180,
            total_tokens: 1380,
            cost,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--max-total-cost-usd",
        "0.03",
        "--out-raw",
        "final-over-cap.jsonl",
        "--out-report",
        "final-over-cap.md",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-final-over-cap-test" },
        writeFile: () => {},
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.code).toBe(5);
    expect(result.rows).toHaveLength(3);
    expect(result.manifest?.completion).toMatchObject({
      status: "partial",
      stopReason: "cost_cap",
      completedRequestCount: 3,
      cumulativeCostUsd: 0.042,
    });
  });

  it("rejects duplicate resolved artifact targets before network access", async () => {
    const fetchImpl = vi.fn();
    const result = await runBenchmark(
      [
        "--confirm-cost",
        "--smoke",
        "--models",
        "flash-lite-3.1-control",
        "--out-raw",
        "duplicate-target",
        "--out-report",
        "duplicate-target",
      ],
      {
        cwd: ROOT,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { REQUESTY_API_KEY: "sk-duplicate-target-test" },
        writeFile: () => {},
        stdout: () => {},
        stderr: () => {},
        gitInfo: () => ({ sha: "cleansha", dirty: false }),
      },
    );

    expect(result.code).toBe(2);
    expect(result.error).toMatch(/three distinct paths/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("cli parsing", () => {
  it("parses flags", () => {
    const o = parseArgs([
      "--models",
        "luna-low,flash-lite-3.1-control",
        "--repetitions",
        "3",
        "--confirm-cost",
        "--smoke",
        "--max-output-tokens",
        "4096",
        "--condition-id",
        "reference-a",
        "--max-total-cost-usd",
        "0.63",
        "--require-clean-git",
        "--allow-artifact-overwrite",
      ]);
    expect(o.models).toEqual(["luna-low", "flash-lite-3.1-control"]);
    expect(o.repetitions).toBe(3);
    expect(o.confirmCost).toBe(true);
    expect(o.dryRun).toBe(false);
    expect(o.smoke).toBe(true);
    expect(o.maxOutputTokens).toBe(4096);
    expect(o.conditionId).toBe("reference-a");
    expect(o.maxTotalCostUsd).toBe(0.63);
    expect(o.requireCleanGit).toBe(true);
    expect(o.allowArtifactOverwrite).toBe(true);
  });

  it("rejects malformed condition identities and cost caps", () => {
    expect(() => parseArgs(["--condition-id", "Reference A"])).toThrow(/condition-id/);
    expect(() => parseArgs(["--max-total-cost-usd", "0"])).toThrow(/positive finite/);
  });
});
