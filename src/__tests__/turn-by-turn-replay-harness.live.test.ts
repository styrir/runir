import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runTurnByTurnReplayHarness } from "../../scripts/turn-by-turn-replay-harness.js";

const RUN_LIVE_REPLAY_HARNESS = process.env.RUNIR_LIVE_REPLAY_HARNESS === "1";

describe.skipIf(!RUN_LIVE_REPLAY_HARNESS)("runTurnByTurnReplayHarness live", () => {
  it(
    "executes the isolated replay path and emits inspectable live artifacts",
    async () => {
      const outputRoot = ".pipeline/test-turn-by-turn-replay-live";
      fs.rmSync(outputRoot, { recursive: true, force: true });

      const report = await runTurnByTurnReplayHarness({ outputRoot });

      expect(report.mode).toBe("live");
      expect(report.summary.total).toBe(4);
      expect(report.assets.latestModePath).toBe(".pipeline/turn-by-turn-replay/latest-live.json");
      expect(fs.existsSync(path.join(outputRoot, "dogfooding-replay-seed-only.json"))).toBe(true);
      expect(fs.existsSync(path.join(outputRoot, "dogfooding-replay-core.json"))).toBe(true);
      expect(fs.existsSync(path.join(outputRoot, "dogfooding-replay-client-scoped.json"))).toBe(true);
      expect(fs.existsSync(path.join(outputRoot, "dogfooding-replay-prefer-client.json"))).toBe(true);
      expect(fs.existsSync(report.assets.viewerPath)).toBe(true);
      expect(report.scenarios[0]?.turnCount).toBe(22);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.failedScenarioIds).toEqual([]);
      expect(report.scenarios[0]?.failedTurns).toEqual([]);
      expect(report.scenarios[1]?.failedTurns).toEqual([]);
      expect(report.scenarios[2]?.failedTurns).toEqual([]);
      expect(report.scenarios[3]?.failedTurns).toEqual([]);
      expect(report.scenarios[1]?.selectedGeneratedCount).toBe(0);
      expect(report.scenarios[1]?.selectedSeededCount).toBeGreaterThan(0);
      expect(JSON.parse(fs.readFileSync(report.assets.latestModePath, "utf8"))).toEqual(
        expect.objectContaining({
          mode: "live",
          outputRoot,
        }),
      );
      const coreArtifact = JSON.parse(fs.readFileSync(path.join(outputRoot, "dogfooding-replay-core.json"), "utf8"));
      const boundariesTurn = coreArtifact.perTurnRecall.find((entry: { turnId: string }) => entry.turnId === "turn-07-boundaries");
      expect(boundariesTurn?.admissibility?.contractId).toBeTruthy();
      expect(
        boundariesTurn?.admissibility?.dropped?.some((entry: { decision: string; group: string }) =>
          entry.decision === "barred_group" && entry.group === "current_status",
        ),
      ).toBe(true);
      const clientScopedArtifact = JSON.parse(fs.readFileSync(path.join(outputRoot, "dogfooding-replay-client-scoped.json"), "utf8"));
      const priorityTurn = clientScopedArtifact.perTurnRecall.find((entry: { turnId: string }) => entry.turnId === "turn-01-priority");
      expect(
        priorityTurn?.admissibility?.dropped?.some((entry: { decision: string; group: string; cap: number | null }) =>
          entry.decision === "over_cap" && entry.group === "current_status" && entry.cap === 1,
        ),
      ).toBe(true);
      const statusTurn = coreArtifact.perTurnRecall.find((entry: { turnId: string }) => entry.turnId === "turn-21-status-continuity");
      expect(statusTurn?.intentLabel).toBe("current_status");
      expect(statusTurn?.retrievalPath).toBe("deterministic");
      expect(statusTurn?.admissibility?.contractId).toBe("status_continuity_compatibility");
      expect(statusTurn?.admissibility?.selectionEngine).toBe("continuity_resolved");
      expect(statusTurn?.admissibility?.continuityResolverMode).toMatch(/strict|fallback/);
      const latestStateTurn = coreArtifact.perTurnRecall.find((entry: { turnId: string }) => entry.turnId === "turn-22-latest-state");
      expect(latestStateTurn?.intentLabel).toBe("latest_state");
      expect(latestStateTurn?.retrievalPath).toBe("latest_state");
      expect(latestStateTurn?.latestState?.representativeIds?.length).toBeGreaterThan(0);
      expect(Array.isArray(latestStateTurn?.latestState?.droppedSeedIds)).toBe(true);
    },
    120_000,
  );
});
