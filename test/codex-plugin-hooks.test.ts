import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const USER_PROMPT_HOOK = path.join(process.cwd(), "plugins/runir-codex/hooks/runir_user_prompt.py");
const SESSION_START_HOOK = path.join(process.cwd(), "plugins/runir-codex/hooks/runir_session_start.py");
const STOP_HOOK = path.join(process.cwd(), "plugins/runir-codex/hooks/runir_stop_capture.py");

interface MockServer {
  baseUrl: string;
  requests: Array<{ url: string; payload: Record<string, unknown> | null }>;
  close: () => Promise<void>;
}

function startMockServer(
  handler: (req: http.IncomingMessage, body: string) => Record<string, unknown>
): Promise<MockServer> {
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
        const response = handler(req, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
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

function runPythonAsync(
  scriptPath: string,
  stdin: Record<string, unknown>,
  env: Record<string, string> = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath], {
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

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "runir-codex-plugin-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("runir-codex plugin hooks", () => {
  it("injects session opener context from /hooks/recall on SessionStart", async () => {
    const server = await startMockServer(() => ({ prependContext: "session opener" }));
    try {
      const result = await runPythonAsync(
        SESSION_START_HOOK,
        {
          session_id: "sess-opener",
          cwd: process.cwd(),
          source: "resume",
        },
        {
          RUNIR_BASE: server.baseUrl,
          RUNIR_USER_ID: "brooks",
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.url).toBe("/hooks/recall");
      expect(server.requests[0]?.payload).toMatchObject({
        prompt: "",
        userId: "brooks",
        client: "codex",
        sessionKind: "opener",
        sessionId: "sess-opener",
        resumeReason: "resume",
      });
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "session opener",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("injects additionalContext from /hooks/recall", async () => {
    const server = await startMockServer(() => ({ prependContext: "remember this" }));
    try {
      const result = await runPythonAsync(
        USER_PROMPT_HOOK,
        {
          prompt: "What should I do next?",
          session_id: "sess-1",
          cwd: process.cwd(),
        },
        {
          RUNIR_BASE: server.baseUrl,
          RUNIR_USER_ID: "brooks",
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.url).toBe("/hooks/recall");
      expect(server.requests[0]?.payload).toMatchObject({
        prompt: "What should I do next?",
        userId: "brooks",
        client: "codex",
        sessionId: "sess-1",
      });
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "remember this",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("posts recent transcript messages to /hooks/capture", async () => {
    const transcriptPath = path.join(tmpHome, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi there" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const server = await startMockServer(() => ({ ok: true }));
    try {
      const result = await runPythonAsync(
        STOP_HOOK,
        {
          session_id: "sess-2",
          cwd: process.cwd(),
          transcript_path: transcriptPath,
          last_assistant_message: null,
        },
        {
          RUNIR_BASE: server.baseUrl,
          RUNIR_USER_ID: "brooks",
        }
      );

      expect(result.status).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.url).toBe("/hooks/capture");
      expect(server.requests[0]?.payload).toMatchObject({
        userId: "brooks",
        client: "codex",
        sessionId: "sess-2",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("skips Codex-injected instruction payloads during capture", async () => {
    const transcriptPath = path.join(tmpHome, "transcript-injected.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /tmp/repo\n\n<INSTRUCTIONS>..." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<skill>\n<name>ralplan</name>\n..." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Please fix the Codex capture hook." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect the hook." }],
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const server = await startMockServer(() => ({ ok: true }));
    try {
      const result = await runPythonAsync(
        STOP_HOOK,
        {
          session_id: "sess-injected",
          cwd: process.cwd(),
          transcript_path: transcriptPath,
        },
        {
          RUNIR_BASE: server.baseUrl,
          RUNIR_USER_ID: "brooks",
        }
      );

      expect(result.status).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.payload).toMatchObject({
        messages: [
          { role: "user", content: "Please fix the Codex capture hook." },
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
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: `message-${index + 1}` }],
        },
      })
    );
    writeFileSync(transcriptPath, rows.join("\n") + "\n", "utf8");

    const server = await startMockServer(() => ({ ok: true }));
    try {
      const result = await runPythonAsync(
        STOP_HOOK,
        {
          session_id: "sess-backlog",
          cwd: process.cwd(),
          transcript_path: transcriptPath,
        },
        {
          RUNIR_BASE: server.baseUrl,
          RUNIR_USER_ID: "brooks",
          RUNIR_CAPTURE_BOOTSTRAP_MESSAGES: "4",
        }
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
