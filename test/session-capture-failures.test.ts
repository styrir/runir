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
  getRequestCount: () => number;
  getLastPayload: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}

function startMockServer(
  opts: { statusCode?: number; hangMs?: number } = {}
): Promise<MockServer> {
  return new Promise((resolve) => {
    let lastPayload: Record<string, unknown> | null = null;
    let requestCount = 0;

    const server = http.createServer((req, res) => {
      requestCount++;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          lastPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          lastPayload = null;
        }

        if (opts.hangMs) {
          // Simulate timeout: wait then destroy the socket
          setTimeout(() => {
            req.socket.destroy();
          }, opts.hangMs);
          return;
        }

        const code = opts.statusCode ?? 200;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: code === 200 }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getRequestCount: () => requestCount,
        getLastPayload: () => lastPayload,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function runHook(
  stdinObj: Record<string, unknown>,
  env: Record<string, string>,
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string }> {
  const stdin = JSON.stringify(stdinObj);
  return new Promise((resolve, reject) => {
    exec(
      `echo '${stdin}' | bash "${HOOK}"`,
      {
        env: { ...process.env, ...env },
        shell: "/bin/bash",
        encoding: "utf8",
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
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

let tmpDir: string;
let mockServer: MockServer;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runir-fail-e2e-"));
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

describe.skipIf(SKIP)("session-end hook failure modes", () => {
  it("missing transcript_path in stdin → exits 0, no POST", async () => {
    const stdin = {
      session_id: "fail-test-001",
      cwd: process.cwd(),
      hook_event_name: "Stop",
    };

    await runHook(stdin, hookEnv());

    expect(mockServer.getRequestCount()).toBe(0);
  });

  it("transcript_path pointing to non-existent file → exits 0, no POST", async () => {
    const stdin = {
      session_id: "fail-test-002",
      transcript_path: "/tmp/does-not-exist-xyz-runir-test.jsonl",
      cwd: process.cwd(),
      hook_event_name: "Stop",
    };

    await runHook(stdin, hookEnv());

    expect(mockServer.getRequestCount()).toBe(0);
  });

  it("empty transcript file → exits 0, no POST", async () => {
    const emptyFile = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(emptyFile, "");

    const stdin = {
      session_id: "fail-test-003",
      transcript_path: emptyFile,
      cwd: process.cwd(),
      hook_event_name: "Stop",
    };

    await runHook(stdin, hookEnv());

    expect(mockServer.getRequestCount()).toBe(0);
  });

  it("server returns 500 → exits 0, state NOT updated", async () => {
    await mockServer.close();
    mockServer = await startMockServer({ statusCode: 500 });

    const fixture = path.join(FIXTURES, "basic-conversation.jsonl");
    const sessionId = "fail-test-004";
    const env = {
      RUNIR_SESSION_END_URL: mockServer.url,
      RUNIR_USER_ID: "test-user",
      STATE_DIR: tmpDir,
      MAX_RETRIES: "1",
      RETRY_INTERVAL_MS: "10",
    };

    const stdin = {
      session_id: sessionId,
      transcript_path: fixture,
      cwd: process.cwd(),
      hook_event_name: "Stop",
      stop_hook_active: true,
    };

    await runHook(stdin, env);

    // State file should not exist or session should have no entry
    const stateFile = path.join(tmpDir, "session-end-state.json");
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const sessionState = state.sessions?.[sessionId];
      // If session entry exists at all, message_count should be 0 (initial)
      if (sessionState) {
        expect(sessionState.message_count).toBe(0);
      }
    }
    // If no state file, that's also correct — state not updated
  });

  it("server times out → exits 0", { timeout: 30000 }, async () => {
    await mockServer.close();
    // Mock server accepts but hangs for 3s then kills connection
    mockServer = await startMockServer({ hangMs: 3000 });

    const fixture = path.join(FIXTURES, "basic-conversation.jsonl");
    const env = {
      RUNIR_SESSION_END_URL: mockServer.url,
      RUNIR_USER_ID: "test-user",
      STATE_DIR: tmpDir,
      MAX_RETRIES: "1",
      RETRY_INTERVAL_MS: "10",
    };

    const stdin = {
      session_id: "fail-test-005",
      transcript_path: fixture,
      cwd: process.cwd(),
      hook_event_name: "Stop",
      stop_hook_active: true,
    };

    // Hook uses --max-time 15, but mock kills socket at 3s
    await runHook(stdin, env);

    // If we get here, hook exited 0 — that's the assertion
  });

  it("all messages filtered → exits 0, no POST", async () => {
    const fixture = path.join(FIXTURES, "non-message-types.jsonl");
    const stdin = {
      session_id: "fail-test-006",
      transcript_path: fixture,
      cwd: process.cwd(),
      hook_event_name: "Stop",
      stop_hook_active: true,
    };

    await runHook(stdin, hookEnv());

    expect(mockServer.getRequestCount()).toBe(0);
  });

  it("hook stdout is empty — no context injection", async () => {
    const fixture = path.join(FIXTURES, "basic-conversation.jsonl");
    const stdin = {
      session_id: "fail-test-007",
      transcript_path: fixture,
      cwd: process.cwd(),
      hook_event_name: "Stop",
      stop_hook_active: true,
    };

    const { stdout } = await runHook(stdin, hookEnv());

    expect(stdout).toBe("");
  });

  it("stop_hook_active: true in stdin is ignored — hook still runs normally", async () => {
    const fixture = path.join(FIXTURES, "basic-conversation.jsonl");
    const stdin = {
      session_id: "fail-test-008",
      transcript_path: fixture,
      cwd: process.cwd(),
      hook_event_name: "Stop",
      stop_hook_active: true,
    };

    await runHook(stdin, hookEnv());

    const payload = await waitForPayload(mockServer.getLastPayload);
    expect(payload.sessionId).toBe("fail-test-008");
    expect(payload.userId).toBe("test-user");
    expect(payload.messages).toHaveLength(3);
  });
});
