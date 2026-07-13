import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/verify-corpus-fence.py");

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function createFixtureRepo(): { repoDir: string; filePath: string } {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "runir-fence-"));
  mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  const filePath = path.join(repoDir, "scripts", "seed-and-verify.ts");
  writeFileSync(filePath, `async function main() {\n  return true;\n}\n\nconst memories = [\n  // === CORPUS FIXTURES — 3a.3 additions ===\n  // === END CORPUS FIXTURES ===\n];\n\nconst checks = [\n  {\n    // === VERIFIER EXPECTATION — 3a.4 additions ===\n    // === END VERIFIER EXPECTATION ===\n  },\n];\n`);

  run("git", ["init", "-b", "main"], repoDir);
  run("git", ["config", "user.email", "test@example.com"], repoDir);
  run("git", ["config", "user.name", "Verifier Test"], repoDir);
  run("git", ["add", "scripts/seed-and-verify.ts"], repoDir);
  run("git", ["commit", "-m", "base"], repoDir);

  return { repoDir, filePath };
}

function expectFenceResult(repoDir: string, expectedExitCode: 0 | 1): string {
  try {
    return run("python3", [SCRIPT_PATH, "HEAD", "scripts/seed-and-verify.ts"], repoDir);
  } catch (error: any) {
    if (expectedExitCode === 1) {
      return String(error.stdout ?? error.message ?? "");
    }
    throw error;
  }
}

describe("verify-corpus-fence.py", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("accepts additions inside the allowed fences", () => {
    const { repoDir, filePath } = createFixtureRepo();
    dirs.push(repoDir);

    const updated = readFileSync(filePath, "utf8")
      .replace("// === END CORPUS FIXTURES ===", '  { id: "fixture" },\n  // === END CORPUS FIXTURES ===')
      .replace("// === END VERIFIER EXPECTATION ===", '    name: "seed-plan-check",\n    // === END VERIFIER EXPECTATION ===');
    writeFileSync(filePath, updated);

    expect(expectFenceResult(repoDir, 0)).toContain("PASS");
  }, 60000);

  it("rejects additions outside the allowed fences", () => {
    const { repoDir, filePath } = createFixtureRepo();
    dirs.push(repoDir);

    const updated = readFileSync(filePath, "utf8").replace(
      "const memories = [",
      'const unexpectedVerifierHelper = true;\nconst memories = [',
    );
    writeFileSync(filePath, updated);

    expect(expectFenceResult(repoDir, 1)).toContain("FAIL: addition outside fence");
  }, 60000);
});
