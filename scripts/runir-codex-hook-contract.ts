import { spawn } from "node:child_process";
import { createServer, Socket } from "node:net";
import { cp, mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

type HookName = "CompanionActivation" | "SessionStart/opener" | "UserPromptSubmit/recall" | "Stop/capture";

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
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForTcp(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = new Socket();
        sock.setTimeout(500);
        sock.once("error", reject);
        sock.once("timeout", () => reject(new Error("timeout")));
        sock.connect(port, "127.0.0.1", () => {
          sock.destroy();
          resolve();
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`mock server not reachable on ${port}`);
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
        }, 1000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function waitForRequestCount(requests: CapturedRequest[], count: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (requests.length >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for request #${count}; saw ${requests.length}`);
}

async function runPythonScript(scriptPath: string, input: unknown, env: Record<string, string>, timeoutMs = 8000) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("python3", [scriptPath], {
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
      reject(new Error(`script timed out: ${scriptPath}`));
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
    "# Codex Hook Contract Report",
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
  const markdownPath = resolveMarkdownPath(repoRoot, "hook-contract-report-codex");
  if (!markdownPath) return null;
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, toMarkdown(summary), "utf8");
  return markdownPath;
}

async function main() {
  const repoRoot = process.cwd();
  const pluginSourceRoot = path.join(repoRoot, "plugins/runir-codex");

  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "runir-codex-hook-contract-"));
  const stagedMarketplaceRoot = path.join(tmpHome, "marketplace-root");
  const stagedPluginRoot = path.join(stagedMarketplaceRoot, "plugins/runir-codex");
  const cachedPluginRoot = path.join(tmpHome, ".codex/plugins/cache/runir-local/runir-codex/local");
  await mkdir(path.join(stagedMarketplaceRoot, ".agents/plugins"), { recursive: true });
  await cp(pluginSourceRoot, stagedPluginRoot, {
    recursive: true,
    filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc") && !src.endsWith(".DS_Store"),
  });
  await cp(pluginSourceRoot, cachedPluginRoot, {
    recursive: true,
    filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc") && !src.endsWith(".DS_Store"),
  });
  await writeFile(
    path.join(stagedMarketplaceRoot, ".agents/plugins/marketplace.json"),
    JSON.stringify(
      {
        name: "runir-local",
        plugins: [
          {
            name: "runir-codex",
            source: {
              source: "local",
              path: "./plugins/runir-codex",
            },
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const mockScript = path.join(repoRoot, "plugins/runir-claudecode/hooks/test/mock_runir.py");
  const activateScript = path.join(stagedPluginRoot, "scripts/activate_companion_hooks.py");
  const openerScript = path.join(cachedPluginRoot, "hooks/runir_session_start.py");
  const recallScript = path.join(cachedPluginRoot, "hooks/runir_user_prompt.py");
  const captureScript = path.join(cachedPluginRoot, "hooks/runir_stop_capture.py");
  const transcriptPath = path.join(tmpHome, "codex-transcript.jsonl");
  const transcriptLines = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello from codex user" }],
      },
      timestamp: "2026-04-20T10:00:00Z",
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello from codex assistant" }],
      },
      timestamp: "2026-04-20T10:00:05Z",
    }),
  ];
  await writeFile(transcriptPath, `${transcriptLines.join("\n")}\n`, "utf8");

  const port = await allocatePort();
  const mock = startMockServer(mockScript, port);
  const hooksFile = path.join(tmpHome, ".codex/hooks.json");
  const configFile = path.join(tmpHome, ".codex/config.toml");
  await mkdir(path.dirname(hooksFile), { recursive: true });
  await writeFile(
    hooksFile,
    JSON.stringify(
      {
        hooks: {
          PermissionRequest: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo preserved-permission-request",
                },
              ],
            },
          ],
        },
        state: {
          "legacy-hook-trust-ledger": {
            trusted_hash: "sha256:legacy",
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    await waitForTcp(port);

    const baseEnv = {
      HOME: tmpHome,
      RUNIR_BASE: `http://127.0.0.1:${port}`,
      RUNIR_USER_ID: "contract-user",
      RUNIR_API_KEY: "contract-token",
      RUNIR_CODEX_CLIENT: "codex-contract-test",
      RUNIR_DEBUG: "1",
    };

    const reports: HookReport[] = [];

    // 1) companion activation
    {
      // rerun with argv-style CLI so the real companion script path handling is exercised
      const activate = spawn("python3", [
        activateScript,
        "--scope",
        "user",
        "--marketplace-file",
        path.join(stagedMarketplaceRoot, ".agents/plugins/marketplace.json"),
        "--hooks-file",
        hooksFile,
        "--config-file",
        configFile,
      ], {
        env: { ...process.env, HOME: tmpHome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      activate.stdout.setEncoding("utf8");
      activate.stderr.setEncoding("utf8");
      activate.stdout.on("data", (chunk) => (stdout += chunk));
      activate.stderr.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise<number | null>((resolve) => activate.on("close", resolve));
      const summary = parseJsonSafe(stdout.trim());
      const hooksJson = JSON.parse(await readFile(hooksFile, "utf8"));
      const report: HookReport = {
        hook: "CompanionActivation",
        sentPayload: summary,
        responseShape: hooksJson,
        pass: true,
        checks: [],
        errors: [],
      };

      assertCheck(code === 0, "activation exit code 0", `activation exit code ${code}`, report);
      assertCheck(summary?.hooksFile === hooksFile, "hooks file reported", "activation did not report hooks file", report);
      assertCheck(
        typeof summary?.pluginRoot === "string" && summary.pluginRoot.endsWith("/marketplace-root/plugins/runir-codex"),
        "staged plugin root reported",
        "activation did not report staged plugin root",
        report
      );
      assertCheck(
        JSON.stringify(hooksJson).includes(`${stagedPluginRoot}/hooks/runir_user_prompt.py`),
        "hook commands target staged plugin directory",
        "hook commands do not target staged plugin directory",
        report
      );
      assertCheck(
        hooksJson.state === undefined,
        "unsupported top-level state key removed from hooks.json",
        "hooks.json still contains unsupported top-level state key",
        report
      );
      assertCheck(
        Array.isArray(hooksJson.hooks?.PermissionRequest),
        "existing non-companion PermissionRequest hook preserved",
        "existing non-companion PermissionRequest hook was not preserved",
        report
      );
      assertCheck(
        !JSON.stringify(hooksJson).includes(repoRoot),
        "hook commands avoid repo checkout paths",
        "hook commands still point at repo checkout",
        report
      );
      assertCheck(summary?.configFile === configFile, "config file reported", "activation did not report config file", report);
      assertCheck(
        Array.isArray(summary?.droppedTopLevelKeys) && summary.droppedTopLevelKeys.includes("state"),
        "activation reported dropped unsupported state key",
        "activation did not report dropped unsupported state key",
        report
      );
      assertCheck(stderr.trim() === "", "activation emitted no stderr", `activation stderr: ${stderr.trim()}`, report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    // 2) SessionStart / opener from cached local install copy
    {
      const run = await runPythonScript(openerScript, {
        session_id: "codex-sess-opener",
        cwd: "/tmp/codex-project",
        source: "resume",
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
      assertCheck(sent.bodyJson?.sessionId === "codex-sess-opener", "sessionId forwarded", "sessionId not forwarded", report);
      assertCheck(sent.bodyJson?.path === "/tmp/codex-project", "path forwarded", "path not forwarded", report);
      assertCheck(sent.bodyJson?.resumeReason === "resume", "resumeReason forwarded", "resumeReason not forwarded", report);
      assertCheck(response?.hookSpecificOutput?.hookEventName === "SessionStart", "SessionStart hook output shape", "bad opener output shape", report);
      assertCheck(response?.hookSpecificOutput?.additionalContext === "hello", "additionalContext injected", "missing additionalContext", report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    // 3) UserPromptSubmit / recall from cached local install copy
    {
      const run = await runPythonScript(recallScript, {
        prompt: "What should I do next?",
        session_id: "codex-sess-1",
        cwd: "/tmp/codex-project",
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
      assertCheck(sent.contentType.toLowerCase() === "application/json", "Content-Type application/json", `bad Content-Type: ${sent.contentType}`, report);
      assertCheck(sent.bodyJson?.prompt === "What should I do next?", "prompt forwarded", "prompt not forwarded", report);
      assertCheck(sent.bodyJson?.sessionId === "codex-sess-1", "sessionId forwarded", "sessionId not forwarded", report);
      assertCheck(sent.bodyJson?.path === "/tmp/codex-project", "path forwarded", "path not forwarded", report);
      assertCheck(sent.bodyJson?.client === "codex-contract-test", "client forwarded", "client not forwarded", report);
      assertCheck(response?.hookSpecificOutput?.hookEventName === "UserPromptSubmit", "UserPromptSubmit hook output shape", "bad recall output shape", report);
      assertCheck(response?.hookSpecificOutput?.additionalContext === "hello", "additionalContext injected", "missing additionalContext", report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    // 4) Stop / capture from cached local install copy
    {
      const run = await runPythonScript(captureScript, {
        session_id: "codex-sess-2",
        cwd: "/tmp/codex-project",
        transcript_path: transcriptPath,
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
      assertCheck(sent.contentType.toLowerCase() === "application/json", "Content-Type application/json", `bad Content-Type: ${sent.contentType}`, report);
      assertCheck(Array.isArray(sent.bodyJson?.messages) && sent.bodyJson.messages.length === 2, "messages forwarded", `expected 2 messages, got ${sent.bodyJson?.messages?.length}` , report);
      assertCheck(sent.bodyJson?.sessionId === "codex-sess-2", "sessionId forwarded", "sessionId not forwarded", report);
      assertCheck(sent.bodyJson?.path === "/tmp/codex-project", "path forwarded", "path not forwarded", report);
      assertCheck(sent.bodyJson?.client === "codex-contract-test", "client forwarded", "client not forwarded", report);
      assertCheck(sent.bodyJson?.messages?.[0]?.role === "user", "user role captured", "missing user role in message[0]", report);
      assertCheck(sent.bodyJson?.messages?.[1]?.role === "assistant", "assistant role captured", "missing assistant role in message[1]", report);

      report.pass = report.errors.length === 0;
      reports.push(report);
    }

    const summary: HookSummary = {
      passed: reports.filter((r) => r.pass).length,
      failed: reports.filter((r) => !r.pass).length,
      reports,
      notes: [
        "Mock server response body was {\"prependContext\":\"hello\"}.",
        `Companion hook target directory: ${stagedPluginRoot}`,
        `Installed runtime representation: ${cachedPluginRoot}`,
        "Authorization / Content-Type / Body were captured from plugins/runir-claudecode/hooks/test/mock_runir.py stderr output.",
      ],
    };

    console.log(JSON.stringify(summary, null, 2));
    const markdownPath = await maybeWriteMarkdownReport(repoRoot, summary);
    if (markdownPath) {
      console.error(`markdown report: ${path.relative(repoRoot, markdownPath)}`);
    }
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await mock.stop();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`runir-codex hook contract check failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
