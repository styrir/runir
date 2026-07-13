import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { exec } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { claudeHooksAvailable } from "./helpers/skip-conditions.js";

const HOOK = path.join(os.homedir(), ".claude/hooks/runir-session-end.sh");
const FIXTURES = path.join(process.cwd(), "test/fixtures/session-capture");
const SKIP = !claudeHooksAvailable("runir-session-end.sh");

interface MockServer {
  url: string;
  getLastPayload: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    let lastPayload: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          lastPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          lastPayload = null;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getLastPayload: () => lastPayload,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function runHookAsync(
  transcriptPath: string,
  sessionId: string,
  env: Record<string, string>
): Promise<void> {
  const stdin = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: process.cwd(),
    hook_event_name: "Stop",
    stop_hook_active: true,
  });
  return new Promise((resolve, reject) => {
    exec(
      `echo '${stdin}' | bash "${HOOK}"`,
      {
        env: { ...process.env, ...env },
        shell: "/bin/bash",
        encoding: "utf8",
        timeout: 30000,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
}

async function waitForPayload(
  getLastPayload: () => Record<string, unknown> | null,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payload = getLastPayload();
    if (payload) return payload;
    await delay(50);
  }
  throw new Error("timed out waiting for session-end hook payload");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("timed out waiting for session-end hook side effect");
}

let tmpDir: string;
let mockServer: MockServer;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runir-hook-e2e-"));
  mockServer = await startMockServer();
});

afterEach(async () => {
  await mockServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function hookEnv(): Record<string, string> {
  return {
    RUNIR_SESSION_END_URL: mockServer.url,
    RUNIR_USER_ID: "test-user",
    STATE_DIR: tmpDir,
    MAX_RETRIES: "1",
    RETRY_INTERVAL_MS: "10",
  };
}

describe.skipIf(SKIP)("session-end hook e2e", () => {
  it("successful capture — basic-conversation.jsonl → POST with 3 messages", async () => {
    const fixture = path.join(FIXTURES, "basic-conversation.jsonl");
    const sessionId = "e2e-test-basic-001";

    await runHookAsync(fixture, sessionId, hookEnv());

    const payload = await waitForPayload(mockServer.getLastPayload);
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.userId).toBe("test-user");
    expect(payload.messages).toHaveLength(3);
    expect(payload.messageOffset).toBe(3);
  });

  it("all-filtered transcript → no POST sent", async () => {
    const fixture = path.join(FIXTURES, "non-message-types.jsonl");
    const sessionId = "e2e-test-filtered-001";

    await runHookAsync(fixture, sessionId, hookEnv());

    expect(mockServer.getLastPayload()).toBeNull();
  });

  it("state file updated after successful capture", async () => {
    const fixture = path.join(FIXTURES, "basic-conversation.jsonl");
    const sessionId = "e2e-test-state-001";
    const env = hookEnv();

    // First run — should post 3 messages
    await runHookAsync(fixture, sessionId, env);

    const payload = await waitForPayload(mockServer.getLastPayload);
    expect(payload.messages).toHaveLength(3);

    // Verify state file was written
    const stateFile = path.join(tmpDir, "session-end-state.json");
    await waitFor(() => fs.existsSync(stateFile));
    expect(fs.existsSync(stateFile)).toBe(true);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const sessionState = state.sessions?.[sessionId];
    expect(sessionState).toBeDefined();
    expect(sessionState.last_line).toBeGreaterThan(0);
    expect(sessionState.message_count).toBe(3);

    // Second run with same transcript — no new messages, no POST
    await runHookAsync(fixture, sessionId, env);

    // State should be unchanged (same message_count)
    const state2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(state2.sessions[sessionId].message_count).toBe(3);
  });
});
