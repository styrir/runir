import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

interface MockServer {
  url: string;
  requests: Array<{ url: string; payload: Record<string, unknown> | null }>;
  close: () => Promise<void>;
}

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: Array<{ url: string; payload: Record<string, unknown> | null }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload: Record<string, unknown> | null = null;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch {
          payload = null;
        }
        requests.push({ url: req.url ?? "/", payload });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runCli(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "cli/index.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("runir CLI RC1 hook contract", () => {
  let tmpDir: string;
  let server: MockServer;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "runir-cli-hooks-"));
    server = await startMockServer();
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts capture and session-end payloads with explicit RC1 wire shape", async () => {
    const messagesPath = path.join(tmpDir, "messages.json");
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    writeFileSync(messagesPath, JSON.stringify(messages), "utf8");

    const capture = await runCli(
      ["capture", "--messages", messagesPath, "--session-id", "sess-cli", "--user-id", "brooks"],
      { RUNIR_URL: server.url },
    );

    expect(capture.status).toBe(0);
    expect(server.requests[0]?.url).toBe("/hooks/capture");
    expect(server.requests[0]?.payload).toEqual({
      messages,
      userId: "brooks",
      sessionId: "sess-cli",
    });

    const sessionEnd = await runCli(
      ["session-end", "--messages", messagesPath, "--session-id", "sess-cli", "--user-id", "brooks"],
      { RUNIR_URL: server.url },
    );

    expect(sessionEnd.status).toBe(0);
    expect(server.requests[1]?.url).toBe("/hooks/session-end");
    expect(server.requests[1]?.payload).toEqual({
      messages,
      userId: "brooks",
      sessionId: "sess-cli",
    });
  }, 60000);

  it("fails fast on malformed message input", async () => {
    const invalidMessagesPath = path.join(tmpDir, "invalid-messages.json");
    writeFileSync(invalidMessagesPath, JSON.stringify({ role: "user", content: "not-an-array" }), "utf8");

    const result = await runCli(
      ["capture", "--messages", invalidMessagesPath, "--user-id", "brooks"],
      { RUNIR_URL: server.url },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected array of messages");
    expect(server.requests).toHaveLength(0);
  }, 60000);
});
