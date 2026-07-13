import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runIngestionHarness } from "../../scripts/ingestion-harness.js";

const RUN_LIVE_HARNESS = process.env.RUNIR_LIVE_HARNESS === "1";

describe.skipIf(!RUN_LIVE_HARNESS)("runIngestionHarness live", () => {
  it(
    "executes the isolated service path and emits inspectable live artifacts",
    async () => {
      const outputRoot = ".pipeline/test-ingestion-harness-live";
      fs.rmSync(outputRoot, { recursive: true, force: true });

      const report = await runIngestionHarness({ outputRoot });

      expect(report.mode).toBe("live");
      expect(report.summary.total).toBeGreaterThanOrEqual(5);
      expect(report.summary.failed).toBe(0);
      expect(report.assets.latestModePath).toBe(".pipeline/ingestion-harness/latest-live.json");
      expect(fs.existsSync(path.join(outputRoot, "session-end-basic.json"))).toBe(true);
      expect(fs.existsSync(report.assets.viewerPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(report.assets.latestModePath, "utf8"))).toEqual(
        expect.objectContaining({
          mode: "live",
          outputRoot,
        }),
      );
    },
    120_000,
  );
});
