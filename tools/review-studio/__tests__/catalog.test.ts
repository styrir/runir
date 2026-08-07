import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  ReviewCatalog,
  isSafeCatalogId,
  isSafeComparisonKey,
} from "../catalog.js";

const FIXTURE_ROOT = join(process.cwd(), "tools/review-studio/fixtures");

describe("review studio catalog", () => {
  it("rebuilds two compatible hash-stamped synthetic runs without mutating source artifacts", () => {
    const before = ["synthetic-baseline.manifest.json", "synthetic-baseline.jsonl", "synthetic-candidate.manifest.json", "synthetic-candidate.jsonl"]
      .map((name) => [name, readFileSync(join(FIXTURE_ROOT, name), "utf8")] as const);
    const catalog = new ReviewCatalog({ roots: [FIXTURE_ROOT] });

    expect(catalog.snapshot.runs).toHaveLength(2);
    expect(catalog.snapshot.duplicateRunIds).toEqual([]);
    expect(catalog.snapshot.runs.every((record) => record.run.provenance.compatibility === "verified")).toBe(true);
    expect(catalog.snapshot.runs[0]!.run.suiteVersion).toBe(catalog.snapshot.runs[1]!.run.suiteVersion);
    expect(catalog.snapshot.runs.every((record) => record.run.cases.length === 5)).toBe(true);

    const comparison = catalog.compare("catalog-1", "catalog-2");
    expect(comparison.compatibility.status).toBe("compatible");
    expect(comparison.caseDeltas).toHaveLength(5);
    expect(comparison.caseDeltas.some((item) => item.metrics.atomicRecall?.assessment === "improved")).toBe(true);
    expect(comparison.caseDeltas.some((item) => item.metrics.hallucinationRate?.assessment === "regressed")).toBe(true);

    catalog.refresh();
    for (const [name, content] of before) expect(readFileSync(join(FIXTURE_ROOT, name), "utf8"), name).toBe(content);
  });

  it("contains malformed and oversized artifacts, skips symlink escapes, and surfaces duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "runir-review-studio-"));
    const baselineManifest = readFileSync(join(FIXTURE_ROOT, "synthetic-baseline.manifest.json"), "utf8");
    const baselineRows = readFileSync(join(FIXTURE_ROOT, "synthetic-baseline.jsonl"), "utf8");
    writeFileSync(join(root, "first.manifest.json"), baselineManifest);
    writeFileSync(join(root, "first.jsonl"), `${baselineRows}not-json\n`);
    writeFileSync(join(root, "second.manifest.json"), baselineManifest);
    writeFileSync(join(root, "second.jsonl"), baselineRows);
    writeFileSync(join(root, "oversized.manifest.json"), "{".padEnd(2_100, "x"));
    writeFileSync(join(root, "oversized.jsonl"), "{}\n");
    symlinkSync(tmpdir(), join(root, "escape-outside"));

    const catalog = new ReviewCatalog({
      roots: [root],
      limits: { maxManifestBytes: 2_000 },
    });
    const codes = catalog.snapshot.diagnostics.map((item) => item.code);
    expect(codes).toContain("malformed_jsonl");
    expect(codes).toContain("manifest_oversized");
    expect(codes).toContain("symlink_escape_rejected");
    expect(catalog.snapshot.runs).toHaveLength(2);
    expect(catalog.snapshot.duplicateRunIds).toEqual(["synthetic-baseline-2026-08-06"]);
  });

  it("rejects traversal roots before path resolution and keeps route identifiers narrow", () => {
    const catalog = new ReviewCatalog({ roots: [`${FIXTURE_ROOT}/../fixtures`] });
    expect(catalog.snapshot.runs).toEqual([]);
    expect(catalog.snapshot.diagnostics.map((item) => item.code)).toContain("root_traversal_rejected");
    expect(isSafeCatalogId("catalog-1")).toBe(true);
    expect(isSafeCatalogId("../etc")).toBe(false);
    expect(isSafeComparisonKey('["case/with-slash","candidate",1]')).toBe(true);
    expect(isSafeComparisonKey("bad\u0000key")).toBe(false);
  });
});
