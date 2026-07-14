#!/usr/bin/env tsx
/**
 * Slice 3 gate: marketplace-installed-style plugin copies list and execute
 * runir_store from their bundled mcp/runir-mcp.mjs — not a source-checkout path.
 *
 * Stages each plugin under a temp root, reads that copy's `.mcp.json`, resolves
 * command/args/cwd the way the host would, and launches that derived invocation
 * against a stub HTTP store (NDJSON MCP traffic).
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

type McpServerConfig = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type ClientCase = {
  name: "claude" | "codex";
  sourceDir: string;
  stagedRel: string;
  /** Extra tokens for ${VAR} expansion in args (e.g. CLAUDE_PLUGIN_ROOT). */
  pathTokens: (stagedPluginRoot: string) => Record<string, string>;
  /** Optional post-checks on plugin manifest (Codex mcpServers pointer). */
  assertManifest?: (pluginRoot: string) => void;
};

class SmokeError extends Error {}

function fail(msg: string): never {
  throw new SmokeError(msg);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function line(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

function parseNdjson(raw: string): unknown[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function expandTokens(value: string, tokens: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    if (!(name in tokens)) {
      fail(`unresolved config token \${${name}} in ${JSON.stringify(value)}`);
    }
    return tokens[name]!;
  });
}

function loadRunirMcpConfig(pluginRoot: string): McpServerConfig {
  const cfgPath = join(pluginRoot, ".mcp.json");
  if (!existsSync(cfgPath)) fail(`missing .mcp.json under ${pluginRoot}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
    mcpServers?: Record<string, McpServerConfig>;
  };
  const server = cfg.mcpServers?.runir;
  if (!server) fail(`${cfgPath}: missing mcpServers.runir`);
  return server;
}

/** Derive spawn plan from staged plugin's .mcp.json only. */
function deriveInvocation(
  pluginRoot: string,
  tokens: Record<string, string>,
): { command: string; args: string[]; cwd: string; env: Record<string, string>; mjsPath: string } {
  const server = loadRunirMcpConfig(pluginRoot);
  if (server.command !== "node") {
    fail(`expected command "node", got ${JSON.stringify(server.command)}`);
  }
  const args = (server.args ?? []).map((a) => expandTokens(a, tokens));
  if (args.length !== 1) {
    fail(`expected single script arg, got ${JSON.stringify(args)}`);
  }
  const scriptArg = args[0]!;
  if (scriptArg.includes(repoRoot)) {
    fail(`.mcp.json resolved to repo-absolute path: ${scriptArg}`);
  }
  const cwd =
    !server.cwd || server.cwd === "."
      ? pluginRoot
      : isAbsolute(server.cwd)
        ? server.cwd
        : resolve(pluginRoot, server.cwd);
  const mjsPath = isAbsolute(scriptArg) ? scriptArg : resolve(cwd, scriptArg);
  if (!mjsPath.startsWith(pluginRoot)) {
    fail(`resolved mjs not under staged plugin root: ${mjsPath}`);
  }
  if (!existsSync(mjsPath)) {
    fail(`staged mjs missing: ${mjsPath}`);
  }
  return {
    command: server.command,
    args,
    cwd,
    env: { ...(server.env ?? {}) },
    mjsPath,
  };
}

async function withStubStore(
  run: (baseUrl: string, requests: unknown[]) => Promise<void>,
): Promise<void> {
  const requests: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({
        url: req.url,
        method: req.method,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          id: "installed-smoke-1",
          outcome: "create",
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.close();
  }
}

async function runDerivedMcp(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  await withStubStore(async (baseUrl, requests) => {
    // Host would run: command + args with cwd. We always use process.execPath
    // for "node" so the smoke is hermetic across PATH differences.
    const argv0 = opts.command === "node" ? process.execPath : opts.command;
    const child = spawn(argv0, opts.args, {
      env: {
        ...process.env,
        ...opts.env,
        RUNIR_BASE: baseUrl,
        RUNIR_API_KEY: "installed-smoke-key",
        RUNIR_USER_ID: "installed-smoke-user",
        RUNIR_ENV_FILE: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });

    child.stdin.write(
      line({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    child.stdin.write(
      line({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    child.stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    child.stdin.write(
      line({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "runir_store",
          arguments: { text: "Installed smoke: remember this fact" },
        },
      }),
    );

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `timeout for ${opts.args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`,
          ),
        );
      }, 8000);
      const check = () => {
        try {
          if (parseNdjson(stdout).length >= 3) {
            clearTimeout(t);
            resolve();
          }
        } catch {
          /* partial line */
        }
      };
      child.stdout.on("data", check);
      check();
    });

    child.stdin.end();
    child.kill();

    if (stdout.includes("Content-Length")) {
      fail("stdout still uses Content-Length framing");
    }
    const msgs = parseNdjson(stdout) as Array<{
      id?: number;
      result?: {
        tools?: Array<{ name: string }>;
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
    }>;
    const list = msgs.find((m) => m.id === 2);
    const names = list?.result?.tools?.map((t) => t.name) ?? [];
    if (!names.includes("runir_store")) {
      fail(`tools/list missing runir_store: ${JSON.stringify(names)}`);
    }
    const call = msgs.find((m) => m.id === 3);
    if (call?.result?.isError) {
      fail(`tools/call error: ${JSON.stringify(call)}`);
    }
    const text = call?.result?.content?.[0]?.text ?? "";
    if (!text.includes("Remembered (new): installed-smoke-1")) {
      fail(`unexpected store result: ${text}`);
    }
    if (requests.length !== 1) {
      fail(`expected 1 HTTP store, got ${requests.length}`);
    }
    const body = (requests[0] as { body?: Record<string, unknown> }).body;
    if (body?.scope !== "user" || typeof body?.text !== "string") {
      fail(`bad store body: ${JSON.stringify(body)}`);
    }
  });
}

const cases: ClientCase[] = [
  {
    name: "claude",
    sourceDir: join(repoRoot, "plugins/runir-claudecode"),
    stagedRel:
      "claude-home/.claude/plugins/cache/runir-local/runir-claudecode/installed",
    pathTokens: (root) => ({ CLAUDE_PLUGIN_ROOT: root }),
  },
  {
    name: "codex",
    sourceDir: join(repoRoot, "plugins/runir-codex"),
    stagedRel:
      "codex-home/.codex/plugins/cache/runir-local/runir-codex/installed",
    pathTokens: () => ({}),
    assertManifest: (pluginRoot) => {
      const manifest = JSON.parse(
        readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
      ) as { mcpServers?: string };
      if (manifest.mcpServers !== "./.mcp.json") {
        fail(
          `codex plugin.json mcpServers must be "./.mcp.json"; got ${JSON.stringify(manifest.mcpServers)}`,
        );
      }
    },
  },
];

async function main(): Promise<void> {
  const claudeMjs = join(repoRoot, "plugins/runir-claudecode/mcp/runir-mcp.mjs");
  const codexMjs = join(repoRoot, "plugins/runir-codex/mcp/runir-mcp.mjs");
  if (!existsSync(claudeMjs) || !existsSync(codexMjs)) {
    fail("missing bundled mcp artifacts — run npm run build:runir-mcp");
  }
  const sourceHash = sha256(claudeMjs);
  if (sourceHash !== sha256(codexMjs)) {
    fail("source package mjs files are not byte-identical");
  }

  const tmp = mkdtempSync(join(tmpdir(), "runir-mcp-installed-"));
  console.log(`staging under ${tmp}`);

  try {
    const digests: string[] = [];
    for (const c of cases) {
      const stagedPluginRoot = join(tmp, c.stagedRel);
      cpSync(c.sourceDir, stagedPluginRoot, {
        recursive: true,
        filter: (src) =>
          !src.includes("__pycache__") &&
          !src.endsWith(".pyc") &&
          !src.endsWith(".DS_Store"),
      });

      c.assertManifest?.(stagedPluginRoot);
      const inv = deriveInvocation(stagedPluginRoot, c.pathTokens(stagedPluginRoot));
      if (inv.mjsPath === claudeMjs || inv.mjsPath === codexMjs) {
        fail(`${c.name}: resolved to source-checkout path ${inv.mjsPath}`);
      }
      digests.push(sha256(inv.mjsPath));

      console.log(
        `→ ${c.name}: ${inv.command} ${inv.args.join(" ")} (cwd=${inv.cwd})`,
      );
      await runDerivedMcp({
        command: inv.command,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env,
      });
      console.log(`  PASS ${c.name}: config-derived tools/list + tools/call`);
    }

    if (new Set(digests).size !== 1) {
      fail(`staged mjs digests diverged: ${digests.join(", ")}`);
    }
    if (digests[0] !== sourceHash) {
      fail("staged digests do not match source package artifacts");
    }

    console.log("\nrunir-mcp-installed-smoke: OK");
    console.log(`sha256 ${sourceHash}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof SmokeError ? `FAIL: ${err.message}` : err);
  process.exit(1);
});
