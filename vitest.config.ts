import { defineConfig } from "vitest/config";

/**
 * Product-repo vitest profile (written by export-styrir-tree.sh).
 * Excludes suites that import forge-only scripts/, harness/, or lab docs artifacts.
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./test/vitest.setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}",
      "test/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Live / optional lanes
      "src/__tests__/ingestion-harness.live.test.ts",
      "src/__tests__/turn-by-turn-replay-harness.live.test.ts",
      "src/__tests__/recall-integration.test.ts",
      "test/integration/containerized-deps.test.ts",
      "test/integration/ryw-overlay-recall.test.ts",
      // Lab-coupled: scripts / harness / lab docs
      "src/__tests__/seed-and-verify.test.ts",
      "src/__tests__/turn-by-turn-replay-harness.test.ts",
      "src/__tests__/ingestion-harness.test.ts",
      "src/__tests__/recall-quality-audit.test.ts",
      "src/__tests__/migration-mim71.test.ts",
      "src/__tests__/migration-mim64.test.ts",
      "src/__tests__/migrate-user-ids.test.ts",
      "src/__tests__/local-session-recall-sim.test.ts",
      "src/__tests__/staleness-oracle.test.ts",
      "src/__tests__/hexis-harness-outcome.test.ts",
      "src/__tests__/hexis-magnitude-parity.test.ts",
      "src/__tests__/session-coverage-check.test.ts",
      "src/__tests__/noema-promotion-embedding.test.ts",
      "src/__tests__/verify-corpus-fence.test.ts",
      "src/__tests__/cross-scenario-bleed-e2e.test.ts",
      "src/__tests__/extract-raw-source-text.test.ts",
      "src/__tests__/extraction-selectivity.test.ts",
      "src/__tests__/memory-query-splitwindow.test.ts",
      "src/__tests__/ranking-profile.test.ts",
      "src/__tests__/session-opener.test.ts",
      "src/__tests__/test-seed.test.ts",
      "src/__tests__/transcript-derived-fixtures.test.ts",
      "src/storage/writes/__tests__/dedup-property.test.ts",
      "src/storage/writes/__tests__/h435-1-unit-b-blind-view.test.ts",
      "src/testing/**",
      // Unsupported clients / packaging surfaces not in product export
      "test/openclaw-plugin-hooks.test.ts",
      "test/plugin-packaging.test.ts",
      "test/hermes-lifecycle-plugin.test.ts",
      "test/harness-adapter.test.ts",
      // Python / g004 lab under test/
      "test/**/*.py",
      "test/g004_*.py",
    ],
  },
});
