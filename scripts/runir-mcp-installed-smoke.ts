#!/usr/bin/env tsx
/**
 * Slice 3 gate: marketplace-installed-style plugin copies list and execute
 * runir_store from their bundled mcp/runir-mcp.mjs — not a source-checkout path.
 *
 * Stages each plugin under a temp home, resolves the path the way .mcp.json does,
 * runs NDJSON initialize / tools/list / tools/call against a stub HTTP store.
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
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

type ClientCase = {
  name: "claude" | "codex";
  sourceDir: string;
  stagedRel: string;
  resolveMjs: (stagedPluginRoot: string) => string;
  assertMcpConfig: (pluginRoot: string) => void;
  clientEnv: (stagedPluginRoot: string) => {
    env: Record<string, string>;
    cwd: string;
  };
};

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
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

async function runMcpSession(opts: {
  mjsPath: string;
  cwd: string;
  envExtra: Record<string, string>;
}): Promise<void> {
  await withStubStore(async (baseUrl, requests) => {
    const child = spawn(process.execPath, [opts.mjsPath], {
      env: {
        ...process.env,
        ...opts.envExtra,
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
            `timeout for ${opts.mjsPath}\nstdout=${stdout}\nstderr=${stderr}`,
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
    resolveMjs: (root) => join(root, "mcp/runir-mcp.mjs"),
    assertMcpConfig: (pluginRoot) => {
      const cfg = JSON.parse(
        readFileSync(join(pluginRoot, ".mcp.json"), "utf8"),
      ) as {
        mcpServers?: { runir?: { command?: string; args?: string[] } };
      };
      const joined = (cfg.mcpServers?.runir?.args ?? []).join(" ");
      if (!joined.includes("${CLAUDE_PLUGIN_ROOT}/mcp/runir-mcp.mjs")) {
        fail(`claude .mcp.json must use CLAUDE_PLUGIN_ROOT; got ${joined}`);
      }
      if (joined.includes(repoRoot)) {
        fail("claude .mcp.json must not embed repo-absolute path");
      }
    },
    clientEnv: (root) => ({
      env: { RUNIR_CLIENT: "claude", CLAUDE_PLUGIN_ROOT: root },
      cwd: root,
    }),
  },
  {
    name: "codex",
    sourceDir: join(repoRoot, "plugins/runir-codex"),
    stagedRel:
      "codex-home/.codex/plugins/cache/runir-local/runir-codex/installed",
    resolveMjs: (root) => join(root, "mcp/runir-mcp.mjs"),
    assertMcpConfig: (pluginRoot) => {
      const cfg = JSON.parse(
        readFileSync(join(pluginRoot, ".mcp.json"), "utf8"),
      ) as {
        mcpServers?: {
          runir?: { command?: string; args?: string[]; cwd?: string };
        };
      };
      const server = cfg.mcpServers?.runir;
      const args = server?.args ?? [];
      if (!args.includes("./mcp/runir-mcp.mjs")) {
        fail(
          `codex .mcp.json must use relative ./mcp/runir-mcp.mjs; got ${JSON.stringify(args)}`,
        );
      }
      if (server?.cwd !== ".") {
        fail(`codex .mcp.json cwd must be "."; got ${server?.cwd}`);
      }
      if (args.some((a) => a.includes(repoRoot))) {
        fail("codex .mcp.json must not embed repo-absolute path");
      }
    },
    clientEnv: (root) => ({
      env: { RUNIR_CLIENT: "codex" },
      cwd: root,
    }),
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

      const mjs = c.resolveMjs(stagedPluginRoot);
      if (!mjs.startsWith(stagedPluginRoot)) {
        fail(`${c.name}: resolved mjs not under staged root: ${mjs}`);
      }
      if (!existsSync(mjs)) {
        fail(`${c.name}: staged mjs missing: ${mjs}`);
      }
      if (mjs === claudeMjs || mjs === codexMjs) {
        fail(`${c.name}: resolved to source-checkout path ${mjs}`);
      }

      c.assertMcpConfig(stagedPluginRoot);
      digests.push(sha256(mjs));

      const { env, cwd } = c.clientEnv(stagedPluginRoot);
      console.log(`→ ${c.name}: node ${mjs}`);
      await runMcpSession({ mjsPath: mjs, cwd, envExtra: env });
      console.log(`  PASS ${c.name}: tools/list + tools/call via staged bundle`);
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
  console.error(err);
  process.exit(1);
});
