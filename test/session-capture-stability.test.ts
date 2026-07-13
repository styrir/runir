import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHooksAvailable } from "./helpers/skip-conditions.js";

const STABILITY_LIB = path.join(
  os.homedir(),
  ".claude/hooks/lib/stability.sh"
);
const SKIP = !claudeHooksAvailable("lib/stability.sh");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stability-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runStabilize(
  filePath: string,
  env: Record<string, string> = {}
): number {
  try {
    execSync(`source "${STABILITY_LIB}" && stabilize_file "${filePath}"`, {
      encoding: "utf8",
      shell: "/bin/bash",
      env: { ...process.env, ...env },
      timeout: 10000,
    });
    return 0;
  } catch (e: any) {
    return e.status ?? 1;
  }
}

describe.skipIf(SKIP)("stabilize_file()", () => {
  it("returns 0 quickly when file is already stable", () => {
    const filePath = path.join(tmpDir, "stable.jsonl");
    fs.writeFileSync(filePath, '{"data":"test"}\n');
    const start = Date.now();
    const code = runStabilize(filePath, {
      MAX_RETRIES: "3",
      RETRY_INTERVAL_MS: "50",
    });
    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("returns 0 when file stabilizes after growth", () => {
    const filePath = path.join(tmpDir, "growing.jsonl");
    fs.writeFileSync(filePath, "line1\n");

    // Append 3 lines with delays via a detached child
    const child = spawn(
      "bash",
      [
        "-c",
        `for i in 1 2 3; do sleep 0.05; echo "line$i" >> "${filePath}"; done`,
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();

    const code = runStabilize(filePath, {
      MAX_RETRIES: "10",
      RETRY_INTERVAL_MS: "100",
    });
    expect(code).toBe(0);

    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* done */ }
  });

  it("returns 1 when file never stabilizes", () => {
    const filePath = path.join(tmpDir, "growing-forever.jsonl");
    fs.writeFileSync(filePath, "start\n");

    // Background process keeps appending every 30ms
    const child = spawn(
      "bash",
      [
        "-c",
        `while true; do echo "more" >> "${filePath}"; sleep 0.03; done`,
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();

    const code = runStabilize(filePath, {
      MAX_RETRIES: "3",
      RETRY_INTERVAL_MS: "100",
    });
    expect(code).toBe(1);

    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* done */ }
  });

  it("returns 0 when file does not exist", () => {
    const code = runStabilize(path.join(tmpDir, "nonexistent.jsonl"), {
      MAX_RETRIES: "2",
      RETRY_INTERVAL_MS: "50",
    });
    expect(code).toBe(0);
  });

  it("returns 0 when file is empty (size 0)", () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filePath, "");
    const code = runStabilize(filePath, {
      MAX_RETRIES: "2",
      RETRY_INTERVAL_MS: "50",
    });
    expect(code).toBe(0);
  });
});
