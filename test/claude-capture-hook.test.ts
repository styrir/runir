import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CAPTURE_HOOK = path.join(process.cwd(), "plugins/runir-claudecode/hooks/runir_capture.py");

interface MockServer {
  baseUrl: string;
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
        const body = Buffer.concat(chunks).toString("utf8");
        let payload: Record<string, unknown> | null = null;
        try {
          payload = body ? JSON.parse(body) : null;
        } catch {
          payload = null;
        }
        requests.push({ url: req.url || "/", payload });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runPython(
  stdin: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [CAPTURE_HOOK], {
      env: { ...process.env, HOME: tmpHome, ...env },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.write(JSON.stringify(stdin));
    child.stdin.end();
  });
}

function claudeMessage(role: "user" | "assistant", content: string): string {
  return JSON.stringify({
    type: role,
    message: {
      role,
      content: role === "user" ? content : [{ type: "text", text: content }],
    },
  });
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "runir-claude-capture-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("runir Claude Code capture hook", () => {
  it("skips injected instruction payloads during capture", async () => {
    const transcriptPath = path.join(tmpHome, "transcript-injected.jsonl");
    writeFileSync(
      transcriptPath,
      [
        claudeMessage("user", "# AGENTS.md instructions for /tmp/repo\n\n<INSTRUCTIONS>..."),
        claudeMessage("user", "<skill>\n<name>ralplan</name>\n..."),
        claudeMessage("user", "Please fix the Claude capture hook."),
        claudeMessage("assistant", "I will inspect the hook."),
      ].join("\n") + "\n",
      "utf8",
    );

    const server = await startMockServer();
    try {
      const result = await runPython(
        {
          session_id: "claude-injected",
          cwd: process.cwd(),
          transcript_path: transcriptPath,
        },
        {
          RUNIR_CAPTURE_URL: `${server.baseUrl}/hooks/capture`,
          RUNIR_USER_ID: "brooks",
        },
      );

      expect(result.status).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.payload).toMatchObject({
        messages: [
          { role: "user", content: "Please fix the Claude capture hook." },
          { role: "assistant", content: "I will inspect the hook." },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("bounds first-run backlog capture so watermark can advance", async () => {
    const transcriptPath = path.join(tmpHome, "transcript-backlog.jsonl");
    const rows = Array.from({ length: 12 }, (_, index) =>
      claudeMessage(index % 2 === 0 ? "user" : "assistant", `message-${index + 1}`),
    );
    writeFileSync(transcriptPath, rows.join("\n") + "\n", "utf8");

    const server = await startMockServer();
    try {
      const result = await runPython(
        {
          session_id: "claude-backlog",
          cwd: process.cwd(),
          transcript_path: transcriptPath,
        },
        {
          RUNIR_CAPTURE_URL: `${server.baseUrl}/hooks/capture`,
          RUNIR_USER_ID: "brooks",
          RUNIR_CAPTURE_BOOTSTRAP_MESSAGES: "4",
        },
      );

      expect(result.status).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.payload).toMatchObject({
        messages: [
          { role: "user", content: "message-9" },
          { role: "assistant", content: "message-10" },
          { role: "user", content: "message-11" },
          { role: "assistant", content: "message-12" },
        ],
      });
    } finally {
      await server.close();
    }
  });
});
