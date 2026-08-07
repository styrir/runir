import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "tools/review-studio");

describe("Review Studio packaging and dependency boundary", () => {
  it("keeps presentation code away from app, storage, and runtime policy imports", () => {
    const files = ["app.ts", "catalog.ts", "server.ts", "trace-proxy.ts", "trace-view.ts", "stub-server.ts", "ui-assets.ts", "security/index.ts"];
    const forbidden = [
      /from\s+["'][^"']*src\/app\//u,
      /import\s*\(\s*["'][^"']*src\/app\//u,
      /from\s+["'][^"']*src\/storage\//u,
      /import\s*\(\s*["'][^"']*src\/storage\//u,
      /from\s+["'][^"']*src\/(?:shared\/config|domain|runtime|service|config)\//u,
      /import\s*\(\s*["'][^"']*src\/(?:shared\/config|domain|runtime|service|config)\//u,
    ];
    const assertBoundary = (source: string): void => {
      for (const pattern of forbidden) expect(source).not.toMatch(pattern);
    };
    expect(() => assertBoundary('import server from "../../src/app/server.js";')).toThrow();
    expect(() => assertBoundary('import store from "../../src/storage/store.js";')).toThrow();
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const pattern of forbidden) expect(source, `${file} imports ${pattern}`).not.toMatch(pattern);
    }
  });

  it("keeps the tool out of the public Styrir export and exposes a repeatable test lane", () => {
    const denylist = readFileSync(join(process.cwd(), "docs/release/styrir-export-denylist.txt"), "utf8");
    expect(denylist.split(/\r?\n/u)).toContain("prefix:.styrir");
    expect(denylist.split(/\r?\n/u)).toContain("prefix:tools/review-studio");
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["review-studio:test"]).toContain("tools/review-studio/vitest.config.ts");
    expect(readFileSync(join(ROOT, "vitest.config.ts"), "utf8")).toContain("tools/review-studio/__tests__");
  });
});
