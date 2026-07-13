import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHooksAvailable } from "./helpers/skip-conditions.js";

const STATE_LIB = path.join(os.homedir(), ".claude/hooks/lib/state.sh");
const SKIP = !claudeHooksAvailable("lib/state.sh");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runir-state-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runBash(cmd: string): string {
  return execSync(`source "${STATE_LIB}" && ${cmd}`, {
    env: { ...process.env, STATE_DIR: tmpDir },
    shell: "/bin/bash",
    encoding: "utf8",
    timeout: 10000,
  });
}

function parseState(output: string) {
  const lastLine = parseInt(output.match(/last_line=(\d+)/)?.[1] ?? "0");
  const messageCount = parseInt(
    output.match(/message_count=(\d+)/)?.[1] ?? "0"
  );
  return { lastLine, messageCount };
}

describe.skipIf(SKIP)("state.sh", () => {
  it("reads correct values from existing state file", () => {
    runBash('write_state "sess1" 42 15');
    const state = parseState(runBash('read_state "sess1"'));
    expect(state.lastLine).toBe(42);
    expect(state.messageCount).toBe(15);
  });

  it("returns zeros when state file is missing", () => {
    const state = parseState(runBash('read_state "sess1"'));
    expect(state.lastLine).toBe(0);
    expect(state.messageCount).toBe(0);
  });

  it("returns zeros when state file contains invalid JSON", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "session-end-state.json"), "not json");
    const state = parseState(runBash('read_state "sess1"'));
    expect(state.lastLine).toBe(0);
    expect(state.messageCount).toBe(0);
  });

  it("returns zeros when session not in state file", () => {
    runBash('write_state "other-sess" 10 5');
    const state = parseState(runBash('read_state "sess1"'));
    expect(state.lastLine).toBe(0);
    expect(state.messageCount).toBe(0);
  });

  it("write_state creates and updates correctly", () => {
    runBash('write_state "sess1" 10 5');
    runBash('write_state "sess1" 20 8');
    const state = parseState(runBash('read_state "sess1"'));
    expect(state.lastLine).toBe(20);
    expect(state.messageCount).toBe(8);
  });

  it("prune_old_sessions removes old entries, keeps recent ones", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const stateData = {
      sessions: {
        "old-sess": {
          last_line: 100,
          message_count: 50,
          updated_at: eightDaysAgo,
        },
        "recent-sess": {
          last_line: 30,
          message_count: 10,
          updated_at: now,
        },
      },
    };

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "session-end-state.json"),
      JSON.stringify(stateData, null, 2)
    );

    runBash("prune_old_sessions");

    const oldState = parseState(runBash('read_state "old-sess"'));
    expect(oldState.lastLine).toBe(0);
    expect(oldState.messageCount).toBe(0);

    const recentState = parseState(runBash('read_state "recent-sess"'));
    expect(recentState.lastLine).toBe(30);
    expect(recentState.messageCount).toBe(10);
  });

  it("multiple sessions are independent", () => {
    runBash('write_state "sess-a" 10 5');
    runBash('write_state "sess-b" 20 8');
    runBash('write_state "sess-a" 15 6');

    const stateA = parseState(runBash('read_state "sess-a"'));
    expect(stateA.lastLine).toBe(15);
    expect(stateA.messageCount).toBe(6);

    const stateB = parseState(runBash('read_state "sess-b"'));
    expect(stateB.lastLine).toBe(20);
    expect(stateB.messageCount).toBe(8);
  });
});
