import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { excerptWindow } from "../recall/source-excerpts.js";
import {
  buildDefaultReplayPlan,
  buildDryRunScenarioArtifact,
  buildIsolatedServiceEnv,
  buildViewerHtml,
  compareReplayModes,
  computeSnapshotDelta,
  runTurnByTurnReplayHarness,
} from "../../scripts/turn-by-turn-replay-harness.js";

describe("buildDefaultReplayPlan", () => {
  const plan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z", {
    outputRoot: ".styrir/analysis/replay-harness/test-plan",
  });
  const scenario = plan.scenarios[0]!;

  it("builds a dedicated replay scenario with realistic seed tracks and an extended session", () => {
    expect(plan.outputRoot).toBe(".styrir/analysis/replay-harness/test-plan");
    expect(plan.scenarios).toHaveLength(4);
    expect(scenario.seedTracks).toHaveLength(6);
    expect(scenario.seededMemories.length).toBeGreaterThanOrEqual(12);
    expect(scenario.turns.length).toBeGreaterThanOrEqual(20);
    expect(scenario.turns.length).toBeLessThanOrEqual(32);
    expect(scenario.mode).toBe("full-lifecycle");
    expect(scenario.validationMode).toBe("live-write");
    expect(plan.scenarios[2]?.recallClient).toBe("claude-code");
    expect(plan.scenarios[3]?.preferredClient).toBe("claude-code");
  });

  it("places both new details inside the fact-overlap excerpt window", () => {
    for (const [turnId, detail] of [["turn-28-own-wording-seed", "6321"], ["turn-30-different-phrasing-seed", "7426"]] as const) {
      const action = scenario.turns.find((turn) => turn.id === turnId)?.writeActions[0];
      expect(action?.kind).toBe("capture");
      if (action?.kind !== "capture") continue;
      const messages = action.body.messages as Array<{ content: string }>;
      const facts = action.body.captureFixtureFacts as Array<{ l2: string }>;
      const excerpt = excerptWindow(messages[1]!.content, facts[0]!.l2);
      expect(messages[1]!.content).toContain(detail);
      expect(facts[0]!.l2).not.toContain(detail);
      expect(excerpt.truncated).toBe(true);
      expect(excerpt.text).toContain(detail);
    }
  });

  it("spreads seeded memory over roughly three months and pins core review requirements", () => {
    const createdAt = scenario.seededMemories.map((memory) => new Date(memory.createdAt).getTime());
    const spreadDays = (Math.max(...createdAt) - Math.min(...createdAt)) / (24 * 60 * 60 * 1000);

    expect(spreadDays).toBeGreaterThanOrEqual(70);
    expect(scenario.seedTracks.map((track) => track.id)).toEqual([
      "active-lane",
      "architecture-history",
      "stale-status",
      "semantic-noise",
      "environment-noise",
      "adjacent-lane",
    ]);
    expect(scenario.seededMemories.map((memory) => memory.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HTML review surface"),
        expect.stringContaining("full lifecycle replay"),
        expect.stringContaining("three months"),
      ]),
    );
  });
});

describe("compareReplayModes probe recovery", () => {
  it("excludes read-only probe turns from both headlines and marks their rows not applicable", () => {
    const plan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z");
    const probes = [
      ["turn-24-exact-detail", "RB-4187"],
      ["turn-29-own-wording", "6321"],
      ["turn-31-different-phrasing", "7426"],
    ] as const;
    const byMode = new Map(["off", "shadow", "on"].map((mode) => [mode, plan.scenarios.slice(0, 2).map((scenario) => {
      const artifact = buildDryRunScenarioArtifact(plan, scenario);
      for (const [turnId, detail] of probes) {
        const recall = artifact.perTurnRecall.find((item) => item.turnId === turnId)!;
        recall.injectedContext = scenario.mode === "read-only" || mode === "on" ? detail : null;
      }
      return artifact;
    })] as const));

    const comparison = compareReplayModes(byMode) as any;
    for (const headline of [comparison.headline, comparison.secondary]) {
      expect(headline.detailProbes).toEqual(probes.map(([turnId, detail]) => expect.objectContaining({
        turnId, detail, cases: 1, recoveredBefore: 0, recoveredAfter: 1,
      })));
      expect(headline.exactDetailRecoveredBefore).toBe(0);
      expect(headline.exactDetailRecoveredAfter).toBe(3);
      const readOnlyRows = headline.turns.filter((turn: any) => turn.scenarioId === plan.scenarios[1]!.id && turn.detailProbe);
      expect(readOnlyRows).toHaveLength(3);
      for (const row of readOnlyRows) {
        expect(row.probeStatus).toBe("not applicable (read-only scenario does not write probe captures)");
        expect(row.exactDetailRecoveredBefore).toBeNull();
        expect(row.exactDetailRecoveredAfter).toBeNull();
      }
    }
    expect(comparison.note).toContain("read-only scenario does not write probe captures");
  });
});

describe("buildIsolatedServiceEnv", () => {
  it("does not inherit parent API auth into spawned replay services", () => {
    const originalApiKey = process.env.RUNIR_API_KEY;
    const originalRequireApiKey = process.env.RUNIR_REQUIRE_API_KEY;
    process.env.RUNIR_API_KEY = "developer-local-key";
    process.env.RUNIR_REQUIRE_API_KEY = "1";

    try {
      const plan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z");
      const env = buildIsolatedServiceEnv({
        plan,
        scenario: plan.scenarios[0]!,
        port: 7794,
        namespace: "test_ns",
        database: "test_db",
      });

      expect(env.RUNIR_API_KEY).toBeUndefined();
      expect(env.RUNIR_REQUIRE_API_KEY).toBeUndefined();
      expect(env.RUNIR_TEST_MODE).toBe("1");
      expect(env.SURREAL_NS).toBe("test_ns");
      expect(env.SURREAL_DB).toBe("test_db");
    } finally {
      if (originalApiKey === undefined) delete process.env.RUNIR_API_KEY;
      else process.env.RUNIR_API_KEY = originalApiKey;
      if (originalRequireApiKey === undefined) delete process.env.RUNIR_REQUIRE_API_KEY;
      else process.env.RUNIR_REQUIRE_API_KEY = originalRequireApiKey;
    }
  });
});

describe("buildDryRunScenarioArtifact", () => {
  const plan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z", {
    outputRoot: ".styrir/analysis/replay-harness/test-artifact",
  });
  const artifact = buildDryRunScenarioArtifact(plan, plan.scenarios[0]!);

  it("produces a summary-first artifact with turn timeline and db evolution", () => {
    expect(artifact.runMode).toBe("dry-run");
    expect(artifact.seedOverview.trackCount).toBe(6);
    expect(artifact.summary.totalTurns).toBe(31);
    expect(artifact.turns[0]?.stages[0]?.kind).toBe("recall");
    expect(artifact.turns.some((turn) => turn.stages.some((stage) => stage.kind === "memory-store"))).toBe(true);
    expect(artifact.turns.some((turn) => turn.stages.some((stage) => stage.kind === "capture"))).toBe(true);
    expect(artifact.turns.some((turn) => turn.stages.some((stage) => stage.kind === "session-end"))).toBe(true);
    expect(artifact.dbEvolution.length).toBeGreaterThan(artifact.summary.totalTurns);
    expect(artifact.seedPlan.recencyBuckets).toHaveLength(4);
    expect(artifact.replayScenario.turnCount).toBe(31);
    expect(artifact.perTurnRecall).toHaveLength(31);
    expect(artifact.validationMode).toBe("live-write");
    expect(artifact.summary.selectedSeededCount).toBeGreaterThan(0);
    expect(artifact.perTurnRecall.some((entry) => entry.selected[0]?.provenance !== undefined)).toBe(true);
    expect(artifact.summaryAssertions.every((check) => check.ok)).toBe(true);
    expect(artifact.turnTimeline[0]?.writeKinds.length).toBeGreaterThan(0);
    const statusTurn = artifact.perTurnRecall.find((entry) => entry.turnId === "turn-21-status-continuity");
    expect(statusTurn?.intentLabel).toBe("current_status");
    expect(statusTurn?.retrievalPath).toBe("deterministic");
    expect(statusTurn?.admissibility?.selectionEngine).toBe("continuity_resolved");
    expect(statusTurn?.admissibility?.continuityResolverMode).toBe("strict");
    const latestStateTurn = artifact.perTurnRecall.find((entry) => entry.turnId === "turn-22-latest-state");
    expect(latestStateTurn?.intentLabel).toBe("latest_state");
    expect(latestStateTurn?.retrievalPath).toBe("latest_state");
    expect(latestStateTurn?.latestState).toEqual(expect.objectContaining({
      representativeIds: expect.any(Array),
      droppedSeedIds: expect.any(Array),
    }));
  });
});

describe("computeSnapshotDelta", () => {
  it("reports added and updated ids across replay snapshots", () => {
    const before = {
      capturedAt: "2026-04-17T00:00:00.000Z",
      counts: { semiote: 1, projectState: 1, retrievalTrace: 0, sessionWatermarks: 0, relations: 0, rejectionLog: 0 },
      semioteRows: [{ id: "a", text: "before", title: "A", active: true, updatedAt: "1" }],
      projectStateRows: [{ id: "p", activeTicketIds: ["1"], nextSteps: ["before"], updatedAt: "1" }],
      retrievalTraceRows: [],
      sessionWatermarkRows: [],
      relationRows: [],
      rejectionRows: [],
    };
    const after = {
      ...before,
      capturedAt: "2026-04-17T00:10:00.000Z",
      counts: { semiote: 2, projectState: 1, retrievalTrace: 1, sessionWatermarks: 0, relations: 0, rejectionLog: 0 },
      semioteRows: [
        { id: "a", text: "after", title: "A", active: true, updatedAt: "2" },
        { id: "b", text: "new", title: "B", active: true, updatedAt: "2" },
      ],
      projectStateRows: [{ id: "p", activeTicketIds: ["1"], nextSteps: ["after"], updatedAt: "2" }],
      retrievalTraceRows: [{ id: "trace-1", prompt: "hello", itemIds: [] }],
    };

    const delta = computeSnapshotDelta(before as any, after as any);

    expect(delta.addedIds.semiote).toEqual(["b"]);
    expect(delta.updatedIds.semiote).toEqual(["a"]);
    expect(delta.updatedIds.projectState).toEqual(["p"]);
    expect(delta.addedIds.retrievalTrace).toEqual(["trace-1"]);
  });
});

describe("runTurnByTurnReplayHarness dry-run", () => {
  it("writes machine-readable artifacts and an HTML review surface", async () => {
    const outputRoot = ".styrir/analysis/replay-harness/test-dry-run";
    const report = await runTurnByTurnReplayHarness({ dryRun: true, outputRoot });

    expect(report.mode).toBe("dry-run");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.total).toBe(4);
    expect(report.scenarios[0]?.turnCount).toBe(31);
    expect(report.assets.viewerPath).toBe(path.join(outputRoot, "report.html"));
    expect(report.assets.latestModePath).toBe(".styrir/analysis/replay-harness/latest-dry-run.json");
    expect(fs.existsSync(report.assets.viewerPath)).toBe(true);
    expect(fs.existsSync(report.assets.latestModePath)).toBe(true);

    const html = fs.readFileSync(report.assets.viewerPath, "utf8");
    expect(html).toContain("Rúnir turn-by-turn replay harness");
    expect(html).toContain("Seed overview");
    expect(html).toContain("Turn timeline");
    expect(html).toContain("DB evolution");
    expect(html).toContain("Track navigation");
    expect(html).toContain("Summary assertions");
    expect(html).toContain("Selected provenance");
    expect(html).toContain("Sparse health");

    const scenarioArtifact = JSON.parse(
      fs.readFileSync(path.join(outputRoot, `${report.scenarios[0]!.id}.json`), "utf8"),
    );
    expect(scenarioArtifact.seedOverview.trackCount).toBe(6);
    expect(scenarioArtifact.summary.totalTurns).toBe(31);
    expect(scenarioArtifact.seedPlan.recencyBuckets).toHaveLength(4);
    expect(scenarioArtifact.replayScenario.turnCount).toBe(31);
    expect(scenarioArtifact.perTurnRecall.length).toBe(31);
    expect(scenarioArtifact.summary.selectedSeededCount).toBeGreaterThan(0);
    expect(scenarioArtifact.perTurnRecall.some((entry: { admissibility?: { selectionEngine?: string } | null }) => entry.admissibility?.selectionEngine === "continuity_resolved")).toBe(true);
    expect(scenarioArtifact.perTurnRecall.some((entry: { retrievalPath?: string | null; latestState?: object | null }) => entry.retrievalPath === "latest_state" && Boolean(entry.latestState))).toBe(true);
  });

  it("renders the same report model into the viewer html", () => {
    const plan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z", {
      outputRoot: ".styrir/analysis/replay-harness/test-viewer",
    });
    const artifact = buildDryRunScenarioArtifact(plan, plan.scenarios[0]!);
    const report = {
      capturedAt: "2026-04-17T05:30:38.012Z",
      mode: "dry-run",
      outputRoot: plan.outputRoot,
      assets: {
        viewerPath: path.join(plan.outputRoot, "report.html"),
        latestPath: ".styrir/analysis/replay-harness/latest.json",
        latestModePath: ".styrir/analysis/replay-harness/latest-dry-run.json",
        latestViewerPath: ".styrir/analysis/replay-harness/latest.html",
      },
      scenarios: [{
        id: artifact.scenarioId,
        title: artifact.title,
        artifactPath: path.join(plan.outputRoot, `${artifact.scenarioId}.json`),
        passed: true,
        turnCount: artifact.summary.totalTurns,
        seededMemoryCount: artifact.seedOverview.memoryCount,
        validationMode: artifact.validationMode,
        selectedSeededCount: artifact.summary.selectedSeededCount,
        selectedGeneratedCount: artifact.summary.selectedGeneratedCount,
        failedTurns: [],
      }],
      summary: { total: 1, passed: 1, failed: 0, failedScenarioIds: [] },
    } as const;

    const html = buildViewerHtml(report as any, [artifact]);
    expect(html).toContain("Expandable raw seed artifacts");
    expect(html).toContain("Pre-assistant recall");
    expect(html).toContain("Snapshot timeline");
    expect(html).toContain("Track navigation");
    expect(html).toContain("Turn navigation");
    expect(html).toContain("Ranking / selection");
    expect(html).toContain("Nearest loser");
    expect(html).toContain("Selected provenance");
    expect(html).toContain("Selection engine");
    expect(html).toContain("Latest-state decisions");
  });

  it("supports read-only replay without write-side stages", () => {
    const readOnlyPlan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z", {
      outputRoot: ".styrir/analysis/replay-harness/test-read-only",
      readOnly: true,
    });
    const readOnlyArtifact = buildDryRunScenarioArtifact(readOnlyPlan, readOnlyPlan.scenarios[0]!);

    expect(readOnlyPlan.scenarios[0]?.mode).toBe("read-only");
    expect(readOnlyArtifact.turns.every((turn) => turn.stages.every((stage) => stage.kind === "recall"))).toBe(true);
  });

  it("pins interesting-turn recall expectations against stale and noisy distractors", () => {
    const plan = buildDefaultReplayPlan("2026-04-17T05:30:38.012Z", {
      outputRoot: ".styrir/analysis/replay-harness/test-interesting",
    });
    const artifact = buildDryRunScenarioArtifact(plan, plan.scenarios[0]!);
    const interestingTurn = artifact.turns.find((turn) => turn.turnId === "turn-01-priority");
    const recallStage = interestingTurn?.stages.find((stage) => stage.kind === "recall");

    expect(recallStage?.response?.prependContext).toContain("turn-by-turn replay harness");
    expect(recallStage?.response?.prependContext).not.toContain("markdown-only retro timeline");
  });
});
