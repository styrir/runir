// vk-2998: local env files stay out of git, and the tracked template carries
// no credentials.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

// The committed .gitignore files are judged in a scratch repository, so a
// clone's .git/info/exclude or the user's global excludes cannot hide a
// regression in them.
const GITIGNORES = [".gitignore", "plugins/runir-pi/.gitignore"];
let scratch = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "runir-gitignore-"));
  execFileSync("git", ["init", "-q"], { cwd: scratch });
  for (const file of GITIGNORES) {
    mkdirSync(join(scratch, dirname(file)), { recursive: true });
    copyFileSync(join(root, file), join(scratch, file));
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** git check-ignore by pattern alone (--no-index), with global excludes off. */
function ignored(path: string): boolean {
  try {
    execFileSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-q", path], {
      cwd: scratch,
      stdio: "ignore",
    });
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
    "plugins/runir-pi/test/.env.bak-2026-11-09",
    "plugins/runir-pi/test/runir-memory-bundle.mjs",
  ])("ignores %s", (path) => {
    expect(ignored(path)).toBe(true);
  });

  it.each([".env.example", "plugins/runir-pi/.env.example"])("does not ignore %s", (path) => {
    expect(ignored(path)).toBe(false);
  });
});

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /(?:_KEY|_SECRET|_PASS|_PASSWORD|_TOKEN)$/;
/** Switches whose names end like a secret but which hold a flag, and the values they may show. */
const SWITCHES: Record<string, RegExp> = { RUNIR_REQUIRE_API_KEY: /^[01]$/ };

/**
 * Secret-bearing variables given a value, in live or commented-out lines.
 * Each line is parsed by Node's dotenv parser (the one behind --env-file),
 * so spacing around `=`, an `export` prefix, quotes and trailing comments are
 * read the way the service would read them.
 */
function secretsWithValues(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const uncommented = line.replace(/^\s*#\s?/, "");
    for (const [name, value] of Object.entries(parseEnv(uncommented))) {
      // Prose in a comment ("... unless RUNIR_REQUIRE_API_KEY=1 or") parses to a
      // name with spaces; only real variable names count.
      if (!VARIABLE_NAME.test(name) || !SECRET_NAME.test(name) || value === "") continue;
      if (SWITCHES[name]?.test(value)) continue;
      found.push(name);
    }
  }
  return found;
}

describe("secretsWithValues", () => {
  it.each([
    "SURREAL_PASS=off",
    "RUNIR_API_KEY = synthetic",
    "RUNIR_API_KEY= synthetic",
    "export RUNIR_API_KEY=synthetic",
    "RUNIR_API_KEY='synthetic' # note",
    "# NOMIC_API_KEY=synthetic",
    "RUNIR_REQUIRE_API_KEY=yes-please",
  ])("flags %j", (line) => {
    expect(secretsWithValues(line)).toHaveLength(1);
  });

  it.each([
    "RUNIR_API_KEY=",
    'RUNIR_API_KEY=""',
    "RUNIR_API_KEY=   # set me",
    "# MAINTENANCE_SECRET=          # required for POST /hooks/maintenance",
    "RUNIR_REQUIRE_API_KEY=1",
    "# RUNIR_REQUIRE_API_KEY=0",
    "# unauthenticated requests unless RUNIR_REQUIRE_API_KEY=1 or",
    "PORT=7700",
  ])("allows %j", (line) => {
    expect(secretsWithValues(line)).toEqual([]);
  });
});

describe(".env.example", () => {
  const text = readFileSync(join(root, ".env.example"), "utf8");

  it("gives no secret-bearing variable a value", () => {
    expect(secretsWithValues(text)).toEqual([]);
  });

  it("contains no home-directory paths", () => {
    expect(text.split(/\r?\n/).filter((line) => /\/(Users|home)\/[^/\s<]+/.test(line))).toEqual([]);
  });
});
