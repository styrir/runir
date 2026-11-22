// vk-2998: local env files stay out of git, and the tracked template carries
// no credentials.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

/** git check-ignore by pattern alone (--no-index), so tracked files are judged too. */
function ignored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

describe(".gitignore keeps env files local", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production.local",
    ".env.bak-2026-11-09",
    ".env.backup",
    "plugins/runir-pi/.env",
    "plugins/runir-pi/.env.local",
    "plugins/runir-pi/test/runir-memory-bundle.mjs",
  ])("ignores %s", (path) => {
    expect(ignored(path)).toBe(true);
  });

  it("tracks .env.example", () => {
    expect(ignored(".env.example")).toBe(false);
  });
});

describe(".env.example", () => {
  const lines = readFileSync(join(root, ".env.example"), "utf8").split(/\r?\n/);

  it("gives no secret-bearing variable a value", () => {
    const secretLike = /^#?\s*([A-Z0-9_]*(?:_KEY|_SECRET|_PASS|_PASSWORD|_TOKEN))=([^#\s]*)/;
    // Switches such as RUNIR_REQUIRE_API_KEY=1 end in _KEY but hold no secret.
    const flag = /^(?:0|1|true|false|on|off)$/;
    const withValues = lines
      .map((line) => secretLike.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null && m[2] !== "" && !flag.test(m[2]))
      .map((m) => m[1]);
    expect(withValues).toEqual([]);
  });

  it("contains no home-directory paths", () => {
    expect(lines.filter((line) => /\/(Users|home)\/[^/\s<]+/.test(line))).toEqual([]);
  });
});
