import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runThinkBenchmark } from "../../../src/testing/think-benchmark/run.js";
import { createReviewStudioApp } from "../app.js";

const ORIGIN = "http://127.0.0.1:7793";
const CAPTURE_ROOT = join(process.cwd(), "tools/review-studio/fixtures");
const CORPUS = readFileSync(join(process.cwd(), "fixtures/think-benchmark/corpus.json"), "utf8");

function tokenFromBootstrap(document: string): string {
  const value = document.match(/<meta name="runir-launch-token" content="([^"]+)">/u)?.[1];
  if (!value) throw new Error("bootstrap token missing");
  return value;
}

function headers(token: string): HeadersInit {
  return {
    Host: "127.0.0.1:7793",
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Runir-Launch-Token": token,
  };
}

async function createThinkArtifacts(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "runir-think-studio-"));
  const fetchFn = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          answer: "A bounded claim.",
          claims: [{ text: "A bounded claim.", citations: [] }],
          gaps: [],
        }),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  for (const name of ["baseline", "candidate"]) {
    const result = await runThinkBenchmark([
      "--confirm-cost",
      "--max-total-cost-usd", "1",
      "--input-usd-per-1m", "0",
      "--output-usd-per-1m", "0",
      "--out-raw", `${name}.jsonl`,
      "--out-report", `${name}.md`,
    ], {
      cwd: root,
      readFile: () => CORPUS,
      fetchFn,
      env: { OPENROUTER_API_KEY: "infisical-injected" },
      git: () => ({ sha: "a".repeat(40), dirty: false }),
      randomId: () => `think-${name}`,
      now: () => new Date("2026-08-07T12:00:00.000Z"),
      fileExists: () => false,
      log: () => undefined,
    });
    expect(result.code).toBe(0);
  }
  return root;
}

describe("Review Studio Think integration", () => {
  it("catalogs, compares, and opens claim-addressable Think evidence as a first-class suite", async () => {
    const root = await createThinkArtifacts();
    const studio = createReviewStudioApp({ artifactRoots: [root], port: 7793 });
    const page = await studio.app.request(`${ORIGIN}/`, { headers: { Host: "127.0.0.1:7793" } });
    const token = tokenFromBootstrap(await page.text());
    const list = await studio.app.request(`${ORIGIN}/api/runs`, { headers: headers(token) });
    const payload = await list.json() as {
      runs: Array<{
        catalogId: string;
        suiteId: string;
        suiteLabel: string;
        casePresentation: string;
        metricDefinitions: Array<{ id: string }>;
      }>;
    };
    expect(payload.runs).toHaveLength(2);
    expect(payload.runs.every((run) => run.suiteId === "runir-think-synthesis")).toBe(true);
    expect(payload.runs[0]).toMatchObject({
      suiteLabel: "Think fixed-evidence synthesis",
      casePresentation: "think-synthesis",
    });
    expect(payload.runs[0]!.metricDefinitions.map((metric) => metric.id)).toContain("unsupportedClaimRate");

    const compare = await studio.app.request(
      `${ORIGIN}/api/compare?baseline=${payload.runs[0]!.catalogId}&candidate=${payload.runs[1]!.catalogId}`,
      { headers: headers(token) },
    );
    const comparison = await compare.json() as { caseDeltas: Array<{ comparisonKey: string }> };
    expect(compare.status).toBe(200);
    const caseResponse = await studio.app.request(
      `${ORIGIN}/api/cases/${payload.runs[0]!.catalogId}?key=${encodeURIComponent(comparison.caseDeltas[0]!.comparisonKey)}`,
      { headers: headers(token) },
    );
    const casePayload = await caseResponse.json() as {
      case: { detail: { kind: string; claims: unknown[]; evidence: unknown[] } };
    };
    expect(casePayload.case.detail.kind).toBe("think-synthesis");
    expect(casePayload.case.detail.claims).toHaveLength(1);
    expect(casePayload.case.detail.evidence.length).toBeGreaterThan(0);
  });

  it("refuses Capture-versus-Think even when the broad incompatible override is requested", async () => {
    const root = await createThinkArtifacts();
    const studio = createReviewStudioApp({ artifactRoots: [CAPTURE_ROOT, root], port: 7793 });
    const page = await studio.app.request(`${ORIGIN}/`, { headers: { Host: "127.0.0.1:7793" } });
    const token = tokenFromBootstrap(await page.text());
    const list = await studio.app.request(`${ORIGIN}/api/runs`, { headers: headers(token) });
    const payload = await list.json() as { runs: Array<{ catalogId: string; suiteId: string }> };
    const capture = payload.runs.find((run) => run.suiteId === "runir-model-benchmark")!;
    const think = payload.runs.find((run) => run.suiteId === "runir-think-synthesis")!;
    const response = await studio.app.request(
      `${ORIGIN}/api/compare?baseline=${capture.catalogId}&candidate=${think.catalogId}&allowIncompatible=true`,
      { headers: headers(token) },
    );
    expect(response.status).toBe(409);
  });
});
