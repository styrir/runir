import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["tools/review-studio/__tests__/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
