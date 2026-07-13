import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ROOT = path.join(process.cwd(), "plugins/runir-claudecode");
const HOOK = path.join(PLUGIN_ROOT, "hooks/runir-session-end.sh");

async function runHook(event: Record<string, unknown>, env: Record<string, string>) {
  const child = spawn("bash", [HOOK], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(JSON.stringify(event));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  return { code, stdout, stderr };
}

function writeTranscript(root: string): string {
  const transcriptPath = path.join(root, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Please remember the session summary." },
      timestamp: "2026-04-21T07:00:00Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "I will persist the important state." }] },
      timestamp: "2026-04-21T07:00:05Z",
    }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return transcriptPath;
}

function installCurlStub(
  root: string,
  opts?: { delaySeconds?: number; statusCode?: string; exitCode?: number },
): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const curlPath = path.join(binDir, "curl");
  const delaySeconds = opts?.delaySeconds ?? 0;
  const statusCode = opts?.statusCode ?? "200";
  const exitCode = opts?.exitCode ?? 0;
  // A nonzero exitCode simulates a genuine curl transport failure (DNS/TLS/connection-
  // refused/timeout): real curl exits nonzero and writes nothing useful to stdout, which is
  // what drives lib/http.sh's `|| status="000"` fallback. Printing statusCode "000" while
  // exiting 0 would NOT exercise that fallback path.
  fs.writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
body_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      body_path="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
sleep ${delaySeconds}
if [[ ${exitCode} -ne 0 ]]; then
  exit ${exitCode}
fi
if [[ -n "$body_path" ]]; then
  printf '{}' > "$body_path"
fi
printf '${statusCode}'
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return binDir;
}

async function waitFor(check: () => boolean, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe("Claude SessionEnd hook logging", () => {
  it("writes an entry log with session id and reason before transcript guards run", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runir-session-end-log-"));
    try {
      const missingTranscript = path.join(tmpRoot, "missing.jsonl");
      const logPath = path.join(tmpRoot, ".claude/state/runir/session-end.log");

      const result = await runHook(
        {
          session_id: "sess-log-001",
          transcript_path: missingTranscript,
          cwd: tmpRoot,
          hook_event_name: "SessionEnd",
          reason: "prompt_input_exit",
        },
        {
          ...process.env,
          HOME: tmpRoot,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          RUNIR_USER_ID: "contract-user",
        } as Record<string, string>,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.existsSync(logPath)).toBe(true);

      await waitFor(() => {
        const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
        return lines.some((line) => line.includes("transcript not found"));
      });

      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toContain("start: run=");
      expect(lines[0]).toContain("session=sess-log-001");
      expect(lines[0]).toContain("reason=prompt_input_exit");
      expect(lines[1]).toContain("handoff: run=");
      expect(lines[1]).toContain("stage=launch_worker");
      expect(lines[2]).toContain("skip:");
      expect(lines[2]).toContain("transcript not found");
      expect(lines[2]).toContain("session=sess-log-001");
      expect(lines[2]).toContain("reason=prompt_input_exit");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);

  it("threads the session-end reason into success logs", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runir-session-end-ok-"));
    try {
      const transcriptPath = writeTranscript(tmpRoot);
      const logPath = path.join(tmpRoot, ".claude/state/runir/session-end.log");
      const stateDir = path.join(tmpRoot, "state");
      const binDir = installCurlStub(tmpRoot);

      const result = await runHook(
        {
          session_id: "sess-log-002",
          transcript_path: transcriptPath,
          cwd: tmpRoot,
          hook_event_name: "SessionEnd",
          reason: "other",
        },
        {
          ...process.env,
          HOME: tmpRoot,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          RUNIR_USER_ID: "contract-user",
          RUNIR_SESSION_END_URL: "http://127.0.0.1:9/hooks/session-end",
          STATE_DIR: stateDir,
          RUNIR_SPARSE_THRESHOLD: "0",
        } as Record<string, string>,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");

      await waitFor(() => {
        if (!fs.existsSync(logPath)) return false;
        return fs.readFileSync(logPath, "utf8").includes("ok: run=");
      });

      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines[0]).toContain("start: run=");
      expect(lines[0]).toContain("session=sess-log-002");
      expect(lines[0]).toContain("reason=other");
      expect(lines.some((line) => line.includes("handoff: run=") && line.includes("stage=launch_worker"))).toBe(true);
      expect(lines.some((line) => line.includes("stage=post_begin"))).toBe(true);
      expect(lines.some((line) => line.includes("stage=post_end"))).toBe(true);
      expect(lines.at(-1)).toContain("ok: run=");
      expect(lines.at(-1)).toContain("session=sess-log-002");
      expect(lines.at(-1)).toContain("reason=other");

      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "session-end-state.json"), "utf8"));
      expect(state.sessions?.["sess-log-002"]?.message_count).toBe(2);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);

  it("keeps logging to completion after the parent hook exits when the HTTP response is delayed", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runir-session-end-delayed-"));
    try {
      const transcriptPath = writeTranscript(tmpRoot);
      const logPath = path.join(tmpRoot, ".claude/state/runir/session-end.log");
      const stateDir = path.join(tmpRoot, "state");
      const binDir = installCurlStub(tmpRoot, { delaySeconds: 2 });

      const result = await runHook(
        {
          session_id: "sess-log-003",
          transcript_path: transcriptPath,
          cwd: tmpRoot,
          hook_event_name: "SessionEnd",
          reason: "prompt_input_exit",
        },
        {
          ...process.env,
          HOME: tmpRoot,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          RUNIR_USER_ID: "contract-user",
          RUNIR_SESSION_END_URL: "http://127.0.0.1:9/hooks/session-end",
          STATE_DIR: stateDir,
          RUNIR_SPARSE_THRESHOLD: "0",
        } as Record<string, string>,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");

      await waitFor(() => {
        if (!fs.existsSync(logPath)) return false;
        return fs.readFileSync(logPath, "utf8").includes("ok: run=");
      });

      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines[0]).toContain("start: run=");
      expect(lines.some((line) => line.includes("handoff: run=") && line.includes("stage=launch_worker"))).toBe(true);
      expect(lines.some((line) => line.includes("stage=post_begin"))).toBe(true);
      expect(lines.some((line) => line.includes("stage=post_end") && line.includes("http=200"))).toBe(true);
      expect(lines.at(-1)).toContain("ok: run=");
      expect(lines.at(-1)).toContain("session=sess-log-003");
      expect(lines.at(-1)).toContain("reason=prompt_input_exit");

      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "session-end-state.json"), "utf8"));
      expect(state.sessions?.["sess-log-003"]?.message_count).toBe(2);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);

  it("logs the error: shape on a non-2xx HTTP response", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runir-session-end-err-"));
    try {
      const transcriptPath = writeTranscript(tmpRoot);
      const logPath = path.join(tmpRoot, ".claude/state/runir/session-end.log");
      const stateDir = path.join(tmpRoot, "state");
      const binDir = installCurlStub(tmpRoot, { statusCode: "500" });

      const result = await runHook(
        {
          session_id: "sess-log-004",
          transcript_path: transcriptPath,
          cwd: tmpRoot,
          hook_event_name: "SessionEnd",
          reason: "other",
        },
        {
          ...process.env,
          HOME: tmpRoot,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          RUNIR_USER_ID: "contract-user",
          RUNIR_SESSION_END_URL: "http://127.0.0.1:9/hooks/session-end",
          STATE_DIR: stateDir,
          RUNIR_SPARSE_THRESHOLD: "0",
        } as Record<string, string>,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");

      await waitFor(() => {
        if (!fs.existsSync(logPath)) return false;
        return fs.readFileSync(logPath, "utf8").includes("error: run=");
      });

      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines.some((line) => line.includes("stage=post_end") && line.includes("http=500"))).toBe(true);
      expect(lines.at(-1)).toContain("error: run=");
      expect(lines.at(-1)).toContain("session=sess-log-004");
      expect(lines.at(-1)).toContain("reason=other");
      expect(lines.at(-1)).toContain("http=500");

      // A non-2xx response never advances the watermark state.
      expect(fs.existsSync(path.join(stateDir, "session-end-state.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);

  it("logs the error: shape on a genuine transport failure (curl exits nonzero, http_code falls back to 000)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runir-session-end-transport-fail-"));
    try {
      const transcriptPath = writeTranscript(tmpRoot);
      const logPath = path.join(tmpRoot, ".claude/state/runir/session-end.log");
      const stateDir = path.join(tmpRoot, "state");
      const binDir = installCurlStub(tmpRoot, { exitCode: 7 });

      const result = await runHook(
        {
          session_id: "sess-log-005",
          transcript_path: transcriptPath,
          cwd: tmpRoot,
          hook_event_name: "SessionEnd",
          reason: "other",
        },
        {
          ...process.env,
          HOME: tmpRoot,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          RUNIR_USER_ID: "contract-user",
          RUNIR_SESSION_END_URL: "http://127.0.0.1:9/hooks/session-end",
          STATE_DIR: stateDir,
          RUNIR_SPARSE_THRESHOLD: "0",
        } as Record<string, string>,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");

      await waitFor(() => {
        if (!fs.existsSync(logPath)) return false;
        return fs.readFileSync(logPath, "utf8").includes("error: run=");
      });

      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      // lib/http.sh's `|| status="000"` fallback fires when curl itself exits nonzero.
      expect(lines.some((line) => line.includes("stage=post_end") && line.includes("http=000"))).toBe(true);
      expect(lines.at(-1)).toContain("error: run=");
      expect(lines.at(-1)).toContain("session=sess-log-005");
      expect(lines.at(-1)).toContain("reason=other");
      expect(lines.at(-1)).toContain("http=000");

      // A transport failure never advances the watermark state.
      expect(fs.existsSync(path.join(stateDir, "session-end-state.json"))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);
});
