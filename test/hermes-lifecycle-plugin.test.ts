import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface RequestRecord {
  url: string;
  authorization: string;
  payload: Record<string, unknown> | null;
}

function startMockServer(): Promise<{ baseUrl: string; requests: RequestRecord[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const requests: RequestRecord[] = [];
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
        requests.push({
          url: req.url || "/",
          authorization: String(req.headers.authorization || ""),
          payload,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prependContext: "hermes memory" }));
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

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runir Hermes lifecycle plugin", () => {
  it("maps Hermes pre/post LLM hooks to Rúnir recall and capture", async () => {
    const server = await startMockServer();
    servers.push(server);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "runir-hermes-test-"));
    tempDirs.push(stateDir);

    const script = `
import importlib.util, json, pathlib, os
path = pathlib.Path("plugins/runir-hermes/__init__.py").resolve()
spec = importlib.util.spec_from_file_location("runir_hermes_under_test", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
opener = mod._on_session_start(session_id="hermes-sess", cwd="/tmp/hermes-project", model="claude", platform="cli")
pre = mod._pre_llm_call(session_id="hermes-sess", user_message="What now?", cwd="/tmp/hermes-project", is_first_turn=True, model="claude", platform="cli")
post = mod._post_llm_call(session_id="hermes-sess", user_message="What now?", assistant_response="Do this.", cwd="/tmp/hermes-project", model="claude", platform="cli")
dupe = mod._post_llm_call(session_id="hermes-sess", user_message="What now?", assistant_response="Do this.", cwd="/tmp/hermes-project", model="claude", platform="cli")
print(json.dumps({"opener": opener, "pre": pre, "post": post}))
`;

    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", ["-c", script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RUNIR_URL: server.baseUrl,
          RUNIR_USER_ID: "brooks",
          RUNIR_CLIENT: "hermes-test",
          RUNIR_API_KEY: "contract-token",
          RUNIR_DEBUG: "1",
          RUNIR_STATE_DIR: stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      opener: null,
      pre: { context: "hermes memory" },
      post: null,
    });

    expect(server.requests).toHaveLength(3);
    expect(fs.existsSync(path.join(stateDir, "hermes-hook.log"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "hermes-post-llm-seen.json"))).toBe(true);
    expect(server.requests[0]).toMatchObject({
      url: "/hooks/recall",
      authorization: "Bearer contract-token",
      payload: {
        prompt: "",
        userId: "brooks",
        client: "hermes-test",
        sessionKind: "opener",
        sessionId: "hermes-sess",
        path: "/tmp/hermes-project",
      },
    });
    expect(server.requests[1]?.payload).toMatchObject({
      prompt: "What now?",
      userId: "brooks",
      client: "hermes-test",
      sessionId: "hermes-sess",
      path: "/tmp/hermes-project",
    });
    expect(server.requests[2]).toMatchObject({
      url: "/hooks/capture",
      authorization: "Bearer contract-token",
      payload: {
        userId: "brooks",
        client: "hermes-test",
        sessionId: "hermes-sess",
        path: "/tmp/hermes-project",
        messages: [
          { role: "user", content: "What now?" },
          { role: "assistant", content: "Do this." },
        ],
      },
    });
  });
});
