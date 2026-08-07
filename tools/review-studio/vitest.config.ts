import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      "tools/review-studio/__tests__/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}",
      "src/__tests__/review-studio-think-adapter.test.ts",
      "src/__tests__/think-benchmark.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
