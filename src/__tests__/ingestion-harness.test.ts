import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIngestionHarnessPlan, runIngestionHarness } from "../../scripts/ingestion-harness.js";
import { loadCommittedTranscriptFixtureBundle } from "../testing/transcript-derived-fixtures.js";

describe("buildIngestionHarnessPlan", () => {
  const plan = buildIngestionHarnessPlan("2026-04-16T14:33:33.000Z", {
    outputRoot: ".pipeline/test-ingestion-harness",
  });

  it("builds a fixture-driven harness plan distinct from seed-and-verify", () => {
    expect(plan.outputRoot).toBe(".pipeline/test-ingestion-harness");
    expect(plan.scenarios.length).toBeGreaterThanOrEqual(5);
    expect(new Set(plan.scenarios.map((scenario) => scenario.route))).toEqual(
      new Set(["/hooks/capture", "/hooks/session-end"]),
    );
    expect(new Set(plan.scenarios.map((scenario) => scenario.family))).toEqual(
      new Set(["capture", "session-end", "failure-mode"]),
    );
  });

  it("keeps every scenario stage-aware with explicit wire payloads and assertions", () => {
    for (const scenario of plan.scenarios) {
      expect(scenario.edgeExtraction.mode).toBe("wire-passthrough");
      expect(Array.isArray(scenario.edgeExtraction.extractedMessages)).toBe(true);
      expect(typeof scenario.wirePayload.userId).toBe("string");
      expect(typeof scenario.assertions.responseStatus).toBe("number");
      expect(typeof scenario.assertions.responseBodyIncludes).toBe("object");
    }
  });

  it("pins content assertions for the inspectable capture and session-end scenarios", () => {
    const capture = plan.scenarios.find((scenario) => scenario.id === "capture-basic-create");
    const sessionEnd = plan.scenarios.find((scenario) => scenario.id === "session-end-basic");

    expect(capture?.assertions.semiotePayloadContains).toEqual(
      expect.objectContaining({
        memoryRole: "recent_work",
        writeSource: "capture",
      }),
    );
    // Session-end is extraction-free (Rúnir-sq3s): the scenario pins the
    // zero-LLM response contract instead of extraction side effects.
    expect(sessionEnd?.assertions.responseBodyIncludes).toEqual(
      expect.objectContaining({
        skipped: false,
        rawTurnsRecorded: 2,
        extraction: "disabled",
      }),
    );
    expect(sessionEnd?.assertions.semioteWrites).toBe(0);
    expect(sessionEnd?.assertions.projectStateExists).toBe(false);
  });

  it("loads transcript-derived scenario families from the committed sanitized fixture bundle", () => {
    const bundle = loadCommittedTranscriptFixtureBundle();
    expect(bundle).not.toBeNull();
    const transcriptScenarioIds = bundle!.scenarios.map((scenario) => scenario.id);
    expect(transcriptScenarioIds.length).toBeGreaterThanOrEqual(3);
    expect(plan.scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining(transcriptScenarioIds));
    const transcriptScenario = plan.scenarios.find((scenario) => scenario.id === "session-end-transcript-derived-summary");
    expect(transcriptScenario?.sourceInput.producer).toBe("sanitized-transcript");
    expect(transcriptScenario?.edgeExtraction.extractedMessages.length).toBeGreaterThanOrEqual(4);
    expect(transcriptScenario?.edgeExtraction.droppedItems.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runIngestionHarness dry-run", () => {
  it("writes a report and dry-run artifacts without needing a live service", async () => {
    const outputRoot = ".pipeline/test-ingestion-harness-dry-run";
    const report = await runIngestionHarness({ dryRun: true, outputRoot });

    expect(report.mode).toBe("dry-run");
    expect(report.summary.total).toBeGreaterThanOrEqual(5);
    expect(report.summary.failed).toBe(0);
    expect(report.scenarios.every((scenario) => scenario.artifactPath.endsWith(".json"))).toBe(true);
    expect(report.assets.viewerPath).toBe(path.join(outputRoot, "report.html"));
    expect(report.assets.latestModePath).toBe(".pipeline/ingestion-harness/latest-dry-run.json");
    expect(fs.existsSync(report.assets.viewerPath)).toBe(true);
    expect(fs.existsSync(report.assets.latestModePath)).toBe(true);
    expect(fs.readFileSync(report.assets.viewerPath, "utf8")).toContain("Rúnir ingestion harness");
  });
});
