import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

type HookName = string;

type HookRun = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type CapturedRequest = {
  authorization: string;
  contentType: string;
  bodyRaw: string;
  bodyJson: any;
};

type HookReport = {
  hook: HookName;
  sentPayload: any;
  responseShape: any;
  pass: boolean;
  checks: string[];
  errors: string[];
};

type HookSummary = {
  passed: number;
  failed: number;
  reports: HookReport[];
  notes: string[];
};

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to allocate ephemeral port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = createServer();
        sock.once("error", reject);
        sock.listen(port, "127.0.0.1", () => {
          sock.close(() => resolve());
        });
      });
      // If we can bind, server isn't up yet.
      await new Promise((r) => setTimeout(r, 40));
    } catch {
      // bind failed -> port in use -> server likely up
      return;
    }
  }
  throw new Error(`mock server did not start on port ${port} within ${timeoutMs}ms`);
}

function startMockServer(mockScript: string, port: number) {
  const proc = spawn("python3", [mockScript, String(port)], {
    env: {
      ...process.env,
      MOCK_STATUS: "200",
      MOCK_BODY: '{"prependContext":"hello"}',
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let pendingAuth = "";
  let pendingContentType = "";
  const requests: CapturedRequest[] = [];

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("Authorization:")) {
        pendingAuth = line.slice("Authorization:".length).trim();
      } else if (line.startsWith("Content-Type:")) {
        pendingContentType = line.slice("Content-Type:".length).trim();
      } else if (line.startsWith("Body:")) {
        const bodyRaw = line.slice("Body:".length).trim();
        let bodyJson: any = null;
        try {
          bodyJson = JSON.parse(bodyRaw);
        } catch {
          bodyJson = null;
        }
        requests.push({
          authorization: pendingAuth,
          contentType: pendingContentType,
          bodyRaw,
          bodyJson,
        });
        pendingAuth = "";
        pendingContentType = "";
      }
    }
  });

  return {
    proc,
    requests,
    async stop() {
      if (proc.killed) return;
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
          resolve();
        }, 1200);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function waitForRequestCount(requests: CapturedRequest[], count: number, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (requests.length >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for request #${count}; saw ${requests.length}`);
}

async function runHook(hookPath: string, input: unknown, env: Record<string, string>, timeoutMs = 8000): Promise<HookRun> {
  return await new Promise<HookRun>((resolve, reject) => {
    const child = spawn("bash", [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hook timed out: ${hookPath}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function assertCheck(condition: boolean, okLabel: string, errLabel: string, report: HookReport) {
  if (condition) report.checks.push(okLabel);
  else report.errors.push(errLabel);
}

function parseJsonSafe(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readArg(prefix: string): string | null {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveMarkdownPath(repoRoot: string, stem: string): string | null {
  const explicitPath = readArg("--markdown-out=");
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.join(repoRoot, explicitPath);
  }

  if (!hasFlag("--markdown")) return null;

  const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
  return path.join(repoRoot, "docs/testing", `${stem}-${timestamp}.md`);
}

function renderJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function toMarkdown(summary: HookSummary): string {
  const lines: string[] = [
    "# ClaudeCode Hook Contract Report",
    "",
    `- generatedAt: ${new Date().toISOString()}`,
    `- passed: ${summary.passed}`,
    `- failed: ${summary.failed}`,
    "",
    "## Notes",
    ...summary.notes.map((note) => `- ${note}`),
    "",
    "## Hook checks",
    "",
  ];

  for (const report of summary.reports) {
    lines.push(`### ${report.hook} — ${report.pass ? "✅ PASS" : "❌ FAIL"}`);
    lines.push("");
    lines.push("#### Checks");
    for (const check of report.checks) lines.push(`- ✅ ${check}`);
    if (report.errors.length > 0) {
      lines.push("#### Errors");
      for (const err of report.errors) lines.push(`- ❌ ${err}`);
    }
    lines.push("");
    lines.push("#### Sent payload");
    lines.push("```json");
    lines.push(renderJson(report.sentPayload));
    lines.push("```");
    lines.push("");
    lines.push("#### Response shape");
    lines.push("```json");
    lines.push(renderJson(report.responseShape));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

async function maybeWriteMarkdownReport(repoRoot: string, summary: HookSummary): Promise<string | null> {
  const markdownPath = resolveMarkdownPath(repoRoot, "hook-contract-report-claudecode");
  if (!markdownPath) return null;
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, toMarkdown(summary), "utf8");
  return markdownPath;
}

async function main() {
  const repoRoot = process.cwd();
  const pluginSourceRoot = path.join(repoRoot, "plugins/runir-claudecode");

  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "runir-claude-hook-contract-"));
  const installedPluginRoot = path.join(tmpHome, "installed/runir-claudecode");
  const tmpStateDir = path.join(tmpHome, ".claude/state/runir");
  await mkdir(tmpStateDir, { recursive: true });
  await cp(pluginSourceRoot, installedPluginRoot, {
    recursive: true,
    filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc") && !src.endsWith(".DS_Store"),
  });

  const mockScript = path.join(installedPluginRoot, "hooks/test/mock_runir.py");

  const transcriptPath = path.join(tmpHome, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "User says hello" },
      timestamp: "2026-04-20T10:00:00Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Assistant says hi" }] },
      timestamp: "2026-04-20T10:00:05Z",
    }),
  ];
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");

  const openerHook = path.join(installedPluginRoot, "hooks/runir-opener.sh");
  const recallHook = path.join(installedPluginRoot, "hooks/runir-recall.sh");
  const captureHook = path.join(installedPluginRoot, "hooks/runir-capture.sh");
  const sessionEndHook = path.join(installedPluginRoot, "hooks/runir-session-end.sh");
  const hookManifest = JSON.parse(await readFile(path.join(installedPluginRoot, "hooks/hooks.json"), "utf8"));
  const hookCommands = Object.values<any>(hookManifest.hooks ?? {}).flatMap((groups: any[]) =>
    groups.flatMap((group) => (group?.hooks ?? []).map((hook: any) => hook.command))
  );

  const port = await allocatePort();
  const mock = startMockServer(mockScript, port);
  try {
    await waitForPort(port);

    const baseEnv = {
      HOME: tmpHome,
      RUNIR_USER_ID: "contract-user",
      RUNIR_API_KEY: "contract-token",
      RUNIR_CLIENT: "claudecode-contract-test",
      RUNIR_DEBUG: "1",
      RUNIR_RECALL_URL: `http://127.0.0.1:${port}/hooks/recall`,
      RUNIR_OPENER_URL: `http://127.0.0.1:${port}/hooks/recall`,
      RUNIR_CAPTURE_URL: `http://127.0.0.1:${port}/hooks/capture`,
      RUNIR_SESSION_END_URL: `http://127.0.0.1:${port}/hooks/session-end`,
      RUNIR_RECALL_TIMEOUT: "5",
      RUNIR_OPENER_TIMEOUT: "5",
      RUNIR_CAPTURE_TIMEOUT: "5",
      RUNIR_SESSION_END_TIMEOUT: "5",
      STATE_DIR: tmpStateDir,
      CLAUDE_PLUGIN_ROOT: installedPluginRoot,
    };

    const reports: HookReport[] = [];

    // 1) opener
    {
      const run = await runHook(openerHook, {
        session_id: "sess-contract-1",
        transcript_path: transcriptPath,
        cwd: "/tmp/contract-project",
        source: "startup",
      }, baseEnv);
      await waitForRequestCount(mock.requests, 1);
      const sent = mock.requests[0]!;
      const response = parseJsonSafe(run.stdout.trim());

      const report: HookReport = {
        hook: "SessionStart/opener",
        sentPayload: sent.bodyJson,
        responseShape: response,
        pass: true,
        checks: [],
        errors: [],
      };

      assertCheck(run.code === 0, "exit code 0", `non-zero exit code: ${run.code}`, report);
      assertCheck(sent.authorization === "Bearer contract-token", "Authorization bearer present", `bad Authorization: ${sent.authorization}`, report);
      assertCheck(sent.contentType.toLowerCase() === "application/json", "Content-Type application/json", `bad Content-Type: ${sent.contentType}`, report);
      assertCheck(sent.bodyJson?.sessionKind === "opener", "sessionKind opener", "missing/invalid sessionKind", report);
      assertCheck(sent.bodyJson?.sessionId === "sess-contract-1", "sessionId included", "missing sessionId", report);
      assertCheck(sent.bodyJson?.path === "/tmp/contract-project", "path included", "missing path", report);
      assertCheck(response?.hookSpecificOutput?.hookEventName === "SessionStart", "SessionStart hook output shape", "bad SessionStart hook output", report);
      assertCheck(response?.hookSpecificOutput?.additionalContext === "hello", "additionalContext injected", "missing additionalContext from opener", report);
      assertCheck(
        hookCommands.includes("${CLAUDE_PLUGIN_ROOT}/hooks/runir-opener.sh"),
        "hook manifest uses CLAUDE_PLUGIN_ROOT",
        "hook manifest does not use CLAUDE_PLUGIN_ROOT for opener",
        report
      );

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    // 2) recall
    {
      const run = await runHook(recallHook, {
        prompt: "What should I do next?",
        session_id: "sess-contract-1",
        transcript_path: transcriptPath,
        cwd: "/tmp/contract-project",
      }, baseEnv);
      await waitForRequestCount(mock.requests, 2);
      const sent = mock.requests[1]!;
      const response = parseJsonSafe(run.stdout.trim());

      const report: HookReport = {
        hook: "UserPromptSubmit/recall",
        sentPayload: sent.bodyJson,
        responseShape: response,
        pass: true,
        checks: [],
        errors: [],
      };

      assertCheck(run.code === 0, "exit code 0", `non-zero exit code: ${run.code}`, report);
      assertCheck(sent.authorization === "Bearer contract-token", "Authorization bearer present", `bad Authorization: ${sent.authorization}`, report);
      assertCheck(sent.bodyJson?.prompt === "What should I do next?", "prompt forwarded", "prompt not forwarded", report);
      assertCheck(sent.bodyJson?.sessionId === "sess-contract-1", "sessionId forwarded", "sessionId not forwarded", report);
      assertCheck(sent.bodyJson?.path === "/tmp/contract-project", "path forwarded", `path not forwarded correctly: ${sent.bodyJson?.path}`, report);
      assertCheck(response?.hookSpecificOutput?.hookEventName === "UserPromptSubmit", "UserPromptSubmit hook output shape", "bad UserPromptSubmit hook output", report);
      assertCheck(response?.hookSpecificOutput?.additionalContext === "hello", "additionalContext injected", "missing additionalContext from recall", report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    // 3) capture (fire-and-forget)
    {
      const run = await runHook(captureHook, {
        session_id: "sess-contract-2",
        transcript_path: transcriptPath,
        cwd: "/tmp/contract-project",
        hook_event_name: "Stop",
        stop_hook_active: true,
        last_assistant_message: null,
      }, baseEnv);
      await waitForRequestCount(mock.requests, 3);
      const sent = mock.requests[2]!;

      const report: HookReport = {
        hook: "Stop/capture",
        sentPayload: sent.bodyJson,
        responseShape: { stdout: run.stdout.trim() },
        pass: true,
        checks: [],
        errors: [],
      };

      assertCheck(run.code === 0, "exit code 0", `non-zero exit code: ${run.code}`, report);
      assertCheck(run.stdout.trim() === "", "no hook output (expected)", `unexpected stdout: ${run.stdout.trim()}`, report);
      assertCheck(sent.authorization === "Bearer contract-token", "Authorization bearer present", `bad Authorization: ${sent.authorization}`, report);
      assertCheck(Array.isArray(sent.bodyJson?.messages) && sent.bodyJson.messages.length === 2, "incremental messages captured", "capture did not send 2 messages", report);
      assertCheck(sent.bodyJson?.sessionId === "sess-contract-2", "sessionId included", "missing sessionId", report);
      assertCheck(sent.bodyJson?.path === "/tmp/contract-project", "path included", "missing path", report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    // 4) session-end (fire-and-forget)
    const sessionEndCases = [
      { sessionId: "sess-contract-3", reason: "resume" },
      { sessionId: "sess-contract-4", reason: "prompt_input_exit" },
    ];
    for (const [index, sessionEndCase] of sessionEndCases.entries()) {
      const run = await runHook(sessionEndHook, {
        session_id: sessionEndCase.sessionId,
        transcript_path: transcriptPath,
        cwd: "/tmp/contract-project",
        hook_event_name: "SessionEnd",
        reason: sessionEndCase.reason,
      }, baseEnv);
      await waitForRequestCount(mock.requests, 4 + index);
      const sent = mock.requests[3 + index]!;

      const report: HookReport = {
        hook: `SessionEnd/session-end (${sessionEndCase.reason})`,
        sentPayload: sent.bodyJson,
        responseShape: { stdout: run.stdout.trim() },
        pass: true,
        checks: [],
        errors: [],
      };

      assertCheck(run.code === 0, "exit code 0", `non-zero exit code: ${run.code}`, report);
      assertCheck(run.stdout.trim() === "", "no hook output (expected)", `unexpected stdout: ${run.stdout.trim()}`, report);
      assertCheck(sent.authorization === "Bearer contract-token", "Authorization bearer present", `bad Authorization: ${sent.authorization}`, report);
      assertCheck(Array.isArray(sent.bodyJson?.messages) && sent.bodyJson.messages.length === 2, "messages included", "session-end did not send messages", report);
      assertCheck(typeof sent.bodyJson?.messageOffset === "number" && sent.bodyJson.messageOffset === 2, "messageOffset included", `bad messageOffset: ${sent.bodyJson?.messageOffset}`, report);
      assertCheck(sent.bodyJson?.terminationReason === sessionEndCase.reason, "terminationReason included", `bad terminationReason: ${sent.bodyJson?.terminationReason}`, report);
      assertCheck(sent.bodyJson?.sessionId === sessionEndCase.sessionId, "sessionId included", "missing sessionId", report);
      assertCheck(sent.bodyJson?.path === "/tmp/contract-project", "path included", "missing path", report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    const summary: HookSummary = {
      passed: reports.filter((r) => r.pass).length,
      failed: reports.filter((r) => !r.pass).length,
      reports,
      notes: [
        "Mock server response body was {\"prependContext\":\"hello\"}.",
        `Installed runtime representation: ${installedPluginRoot}`,
        "Authorization / Content-Type / Body were captured from plugins/runir-claudecode/hooks/test/mock_runir.py stderr output.",
      ],
    };

    const jsonOut = JSON.stringify(summary, null, 2);
    console.log(jsonOut);

    const markdownPath = await maybeWriteMarkdownReport(repoRoot, summary);
    if (markdownPath) {
      console.error(`markdown report: ${path.relative(repoRoot, markdownPath)}`);
    }

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await mock.stop();
    await rm(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error(`runir-claudecode hook contract check failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
