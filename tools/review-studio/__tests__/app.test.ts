import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createReviewStudioApp } from "../app.js";

const ROOT = `${process.cwd()}/tools/review-studio/fixtures`;
const ORIGIN = "http://127.0.0.1:7791";

function tokenFromBootstrap(document: string): string {
  const value = document.match(/<meta name="runir-launch-token" content="([^"]+)">/u)?.[1];
  if (!value) throw new Error("bootstrap token missing");
  return value;
}

async function bootstrap(artifactRoots: readonly string[] = [ROOT]) {
  const studio = createReviewStudioApp({ artifactRoots, port: 7791 });
  const page = await studio.app.request(`${ORIGIN}/`, { headers: { Host: "127.0.0.1:7791" } });
  const document = await page.text();
  return { studio, token: tokenFromBootstrap(document), document };
}

function incompatibleFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "runir-review-studio-incompatible-"));
  const baselineManifest = JSON.parse(readFileSync(join(ROOT, "synthetic-baseline.manifest.json"), "utf8")) as Record<string, unknown>;
  const candidateManifest = JSON.parse(readFileSync(join(ROOT, "synthetic-candidate.manifest.json"), "utf8")) as Record<string, unknown>;
  candidateManifest.fixtureContentHash = "e".repeat(64);
  writeFileSync(join(root, "baseline.manifest.json"), JSON.stringify(baselineManifest));
  writeFileSync(join(root, "baseline.jsonl"), readFileSync(join(ROOT, "synthetic-baseline.jsonl")));
  writeFileSync(join(root, "candidate.manifest.json"), JSON.stringify(candidateManifest));
  writeFileSync(join(root, "candidate.jsonl"), readFileSync(join(ROOT, "synthetic-candidate.jsonl")));
  return root;
}

function apiHeaders(token: string): HeadersInit {
  return {
    Host: "127.0.0.1:7791",
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Runir-Launch-Token": token,
  };
}

describe("Review Studio read APIs", () => {
  it("serves the tokenized local shell and never exposes credentials or remote assets", async () => {
    const { studio, token, document } = await bootstrap();
    expect(document).toContain("/assets/review-studio.css");
    expect(document).toContain("/assets/review-studio.js");
    expect(document).not.toContain("RUNIR_API_KEY");
    const asset = await studio.app.request(`${ORIGIN}/assets/review-studio.js`, { headers: apiHeaders(token) });
    const source = await asset.text();
    expect(asset.status).toBe(200);
    expect(source).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/u);
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("requires the launch header for read APIs and exposes summaries, comparisons, cases, raw evidence, and export", async () => {
    const { studio, token } = await bootstrap();
    const denied = await studio.app.request(`${ORIGIN}/api/runs`, { headers: { Host: "127.0.0.1:7791", Origin: ORIGIN } });
    expect(denied.status).toBe(403);

    const list = await studio.app.request(`${ORIGIN}/api/runs`, { headers: apiHeaders(token) });
    const payload = await list.json() as { runs: Array<{ catalogId: string; runId: string }>; diagnostics: unknown[] };
    expect(list.status).toBe(200);
    expect(payload.runs).toHaveLength(2);
    expect(payload.runs.map((run) => run.catalogId)).toEqual(["catalog-1", "catalog-2"]);

    const compare = await studio.app.request(`${ORIGIN}/api/compare?baseline=catalog-1&candidate=catalog-2`, { headers: apiHeaders(token) });
    const comparison = await compare.json() as { compatibility: { status: string }; caseDeltas: Array<{ comparisonKey: string; baseline: Record<string, unknown> | null }> };
    expect(compare.status).toBe(200);
    expect(comparison.compatibility.status).toBe("compatible");
    expect(comparison.caseDeltas).toHaveLength(5);
    expect(comparison.caseDeltas[0]!.baseline).not.toHaveProperty("rawEvidence");

    const key = comparison.caseDeltas[0]!.comparisonKey;
    const caseResponse = await studio.app.request(`${ORIGIN}/api/cases/catalog-1?key=${encodeURIComponent(key)}`, { headers: apiHeaders(token) });
    const casePayload = await caseResponse.json() as { case: { rawEvidence: { row: Record<string, unknown> } } };
    expect(caseResponse.status).toBe(200);
    expect(casePayload.case.rawEvidence.row).toHaveProperty("parse");

    const rawResponse = await studio.app.request(`${ORIGIN}/api/raw/catalog-1?key=${encodeURIComponent(key)}`, { headers: apiHeaders(token) });
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.json()).toHaveProperty("rawEvidence");

    const exportResponse = await studio.app.request(`${ORIGIN}/api/compare/export?baseline=catalog-1&candidate=catalog-2`, { headers: apiHeaders(token) });
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.json()).toHaveProperty("exportSchema", "runir-review-studio-comparison-export/v1");
  });

  it("renders explicit compatibility refusal before the correct incompatible override", async () => {
    const { studio, token } = await bootstrap([incompatibleFixtureRoot()]);
    const refused = await studio.app.request(`${ORIGIN}/api/compare?baseline=catalog-1&candidate=catalog-2`, { headers: apiHeaders(token) });
    const refusalPayload = await refused.json() as { compatibility: { status: string; reasons: string[] } };
    expect(refused.status).toBe(409);
    expect(refusalPayload.compatibility.status).toBe("incompatible");
    expect(refusalPayload.compatibility.reasons).toContain("suiteVersion differs; fixture, prompt, parser, or scoring provenance changed");

    const overridden = await studio.app.request(`${ORIGIN}/api/compare?baseline=catalog-1&candidate=catalog-2&allowIncompatible=true`, { headers: apiHeaders(token) });
    const overridePayload = await overridden.json() as { compatibility: { status: string; pairing: string }; diagnostics: Array<{ code: string }> };
    expect(overridden.status).toBe(200);
    expect(overridePayload.compatibility.status).toBe("incompatible");
    expect(overridePayload.compatibility.pairing).toBe("explicit-override");
    expect(overridePayload.diagnostics.map((item) => item.code)).toContain("explicit_pairing_override");
  });
});
