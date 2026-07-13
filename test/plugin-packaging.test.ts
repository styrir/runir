import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLAUDE_PLUGIN_ROOT = path.join(REPO_ROOT, "plugins/runir-claudecode");
const CODEX_PLUGIN_ROOT = path.join(REPO_ROOT, "plugins/runir-codex");
const CLAUDE_MANIFEST = path.join(CLAUDE_PLUGIN_ROOT, ".claude-plugin/plugin.json");
const CLAUDE_MARKETPLACE = path.join(REPO_ROOT, ".claude-plugin/marketplace.json");
const CLAUDE_HOOKS_MANIFEST = path.join(CLAUDE_PLUGIN_ROOT, "hooks/hooks.json");
const CODEX_MANIFEST = path.join(CODEX_PLUGIN_ROOT, ".codex-plugin/plugin.json");
const ACTIVATE_COMPANION = path.join(CODEX_PLUGIN_ROOT, "scripts/activate_companion_hooks.py");
const VERIFY_COMPANION = path.join(CODEX_PLUGIN_ROOT, "scripts/verify_companion_hooks.py");
const EXPORT_SCRIPT = path.join(REPO_ROOT, "scripts/build-plugin-marketplace-archives.py");

function runPython(scriptPath: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function parseJsonFile(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function createExtractedMarketplaceRoot(baseDir: string) {
  const marketplaceRoot = path.join(baseDir, ".codex/.tmp/plugins");
  const pluginRoot = path.join(marketplaceRoot, "plugins/runir-codex");
  const marketplaceFile = path.join(marketplaceRoot, ".agents/plugins/marketplace.json");
  mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  mkdirSync(path.dirname(pluginRoot), { recursive: true });
  cpSync(CODEX_PLUGIN_ROOT, pluginRoot, { recursive: true });
  writeFileSync(
    marketplaceFile,
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

  return { marketplaceRoot, marketplaceFile, pluginRoot };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "runir-plugin-packaging-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("plugin packaging migration surfaces", () => {
  it("ships a native Claude plugin manifest and marketplace with plugin-root hook commands", () => {
    expect(existsSync(CLAUDE_MANIFEST)).toBe(true);
    expect(existsSync(CLAUDE_MARKETPLACE)).toBe(true);
    expect(existsSync(CLAUDE_HOOKS_MANIFEST)).toBe(true);

    const manifest = parseJsonFile(CLAUDE_MANIFEST);
    const marketplace = parseJsonFile(CLAUDE_MARKETPLACE);
    const hooksManifest = parseJsonFile(CLAUDE_HOOKS_MANIFEST);

    expect(manifest.name).toBe("runir-claudecode");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "runir-claudecode",
      source: "./plugins/runir-claudecode",
    });

    const hookCommands = Object.values(hooksManifest.hooks).flatMap((groups) =>
      (groups as Array<{ hooks: Array<{ command: string }> }>).flatMap((group) => group.hooks.map((hook) => hook.command))
    );
    expect(hookCommands).toEqual(
      expect.arrayContaining([
        "${CLAUDE_PLUGIN_ROOT}/hooks/runir-opener.sh",
        "${CLAUDE_PLUGIN_ROOT}/hooks/runir-recall.sh",
        "${CLAUDE_PLUGIN_ROOT}/hooks/runir-capture.sh",
        "${CLAUDE_PLUGIN_ROOT}/hooks/runir-session-end.sh",
      ])
    );
    for (const command of hookCommands) {
      expect(command.includes("~/.claude/hooks")).toBe(false);
    }
  });

  it("activates project-scoped Codex companion hooks safely and idempotently", () => {
    const extracted = createExtractedMarketplaceRoot(tmpDir);
    const projectHooksFile = path.join(tmpDir, ".codex/hooks.json");
    const projectConfigFile = path.join(tmpDir, ".codex/config.toml");
    mkdirSync(path.dirname(projectHooksFile), { recursive: true });
    writeFileSync(
      projectHooksFile,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [{ type: "command", command: "node /some/other/hook.js" }],
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
    writeFileSync(projectConfigFile, "[profile.default]\nmodel = \"gpt-5.4\"\n", "utf8");

    const first = runPython(ACTIVATE_COMPANION, [
      "--scope",
      "project",
      "--marketplace-file",
      extracted.marketplaceFile,
      "--hooks-file",
      projectHooksFile,
      "--config-file",
      projectConfigFile,
    ]);

    expect(first.status).toBe(0);
    const firstSummary = JSON.parse(first.stdout);
    expect(firstSummary.scope).toBe("project");
    expect(firstSummary.pluginName).toBe("runir-codex");
    expect(firstSummary.pluginRoot.endsWith("/.codex/.tmp/plugins/plugins/runir-codex")).toBe(true);
    expect(firstSummary.hooksFile).toBe(projectHooksFile);
    expect(firstSummary.configFile).toBe(projectConfigFile);
    expect(firstSummary.changed).toBe(true);
    expect(firstSummary.droppedTopLevelKeys).toContain("state");

    const firstHooks = parseJsonFile(projectHooksFile);
    expect(firstHooks.state).toBeUndefined();
    const sessionStartGroups = firstHooks.hooks.SessionStart as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const userPromptGroups = firstHooks.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const stopGroups = firstHooks.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    const preToolGroups = firstHooks.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const postToolGroups = firstHooks.hooks.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    expect(sessionStartGroups[0]?.matcher).toBe("startup|resume|clear|compact");
    expect(sessionStartGroups[0]?.hooks[0]?.command).toContain(`${extracted.pluginRoot}/hooks/runir_session_start.py`);
    expect(userPromptGroups[0]?.hooks[0]?.command).toContain(`${extracted.pluginRoot}/hooks/runir_user_prompt.py`);
    expect(stopGroups[0]?.hooks[0]?.command).toContain(`${extracted.pluginRoot}/hooks/runir_stop_capture.py`);
    expect(preToolGroups[0]?.matcher).toBe("Bash|Grep|Glob");
    expect(preToolGroups[0]?.hooks[0]?.command).toContain(`${extracted.pluginRoot}/hooks/gitnexus-hook.cjs`);
    expect(postToolGroups[0]?.matcher).toBe("Bash");
    expect(postToolGroups[0]?.hooks[0]?.command).toContain(`${extracted.pluginRoot}/hooks/gitnexus-hook.cjs`);
    expect(userPromptGroups.some((group) => group.hooks.some((hook) => hook.command.includes("/some/other/hook.js")))).toBe(true);
    expect(readFileSync(projectConfigFile, "utf8")).toContain("hooks = true");

    const second = runPython(ACTIVATE_COMPANION, [
      "--scope",
      "project",
      "--marketplace-file",
      extracted.marketplaceFile,
      "--hooks-file",
      projectHooksFile,
      "--config-file",
      projectConfigFile,
    ]);

    expect(second.status).toBe(0);
    const secondSummary = JSON.parse(second.stdout);
    expect(secondSummary.changed).toBe(false);

    const secondHooks = JSON.stringify(parseJsonFile(projectHooksFile));
    expect(secondHooks.match(/runir_user_prompt\.py/g)?.length).toBe(1);
    expect(secondHooks.match(/runir_session_start\.py/g)?.length).toBe(1);
    expect(secondHooks.match(/runir_stop_capture\.py/g)?.length).toBe(1);
    expect(secondHooks.match(/gitnexus-hook\.cjs/g)?.length).toBe(2);
  }, 30000);

  it("verifies user-scoped Codex companion activation and reports the active mode", () => {
    const extracted = createExtractedMarketplaceRoot(tmpDir);
    const userHooksFile = path.join(tmpDir, "user/.codex/hooks.json");
    const userConfigFile = path.join(tmpDir, "user/.codex/config.toml");

    const activate = runPython(ACTIVATE_COMPANION, [
      "--scope",
      "user",
      "--marketplace-file",
      extracted.marketplaceFile,
      "--hooks-file",
      userHooksFile,
      "--config-file",
      userConfigFile,
    ]);
    expect(activate.status).toBe(0);

    const verify = runPython(VERIFY_COMPANION, [
      "--marketplace-file",
      extracted.marketplaceFile,
      "--project-hooks-file",
      path.join(tmpDir, "project/.codex/hooks.json"),
      "--project-config-file",
      path.join(tmpDir, "project/.codex/config.toml"),
      "--user-hooks-file",
      userHooksFile,
      "--user-config-file",
      userConfigFile,
    ]);

    expect(verify.status).toBe(0);
    const summary = JSON.parse(verify.stdout);
    expect(summary.mode).toBe("user");
    expect(summary.pluginRoot.endsWith("/.codex/.tmp/plugins/plugins/runir-codex")).toBe(true);
    expect(summary.user).toMatchObject({
      hooksFile: userHooksFile,
      hooksInstalled: true,
      hooksEnabled: true,
    });
    expect(summary.project).toMatchObject({
      hooksInstalled: false,
    });
  }, 30000);

  it("does not treat partial or miswired Codex hooks as installed", () => {
    const extracted = createExtractedMarketplaceRoot(tmpDir);
    const projectHooksFile = path.join(tmpDir, "project/.codex/hooks.json");
    const projectConfigFile = path.join(tmpDir, "project/.codex/config.toml");
    mkdirSync(path.dirname(projectHooksFile), { recursive: true });
    writeFileSync(
      projectHooksFile,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `/usr/bin/env python3 "${extracted.pluginRoot}/hooks/runir_user_prompt.py"`,
                  },
                ],
              },
            ],
            SessionStart: [
              {
                matcher: "startup|resume|clear|compact",
                hooks: [
                  {
                    type: "command",
                    command: `/usr/bin/env python3 "${extracted.pluginRoot}/hooks/runir_session_start.py"`,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `/usr/bin/env python3 "${extracted.pluginRoot}/hooks/not_runir_stop_capture.py"`,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: "Bash|Grep|Glob",
                hooks: [
                  {
                    type: "command",
                    command: `/usr/bin/env node "${extracted.pluginRoot}/hooks/gitnexus-hook.cjs"`,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: `/usr/bin/env node "${extracted.pluginRoot}/hooks/not-gitnexus-hook.cjs"`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(projectConfigFile, "# codex_hooks = true\n", "utf8");

    const verify = runPython(VERIFY_COMPANION, [
      "--marketplace-file",
      extracted.marketplaceFile,
      "--project-hooks-file",
      projectHooksFile,
      "--project-config-file",
      projectConfigFile,
      "--user-hooks-file",
      path.join(tmpDir, "user/.codex/hooks.json"),
      "--user-config-file",
      path.join(tmpDir, "user/.codex/config.toml"),
    ]);

    expect(verify.status).toBe(0);
    const summary = JSON.parse(verify.stdout);
    expect(summary.mode).toBe("none");
    expect(summary.project).toMatchObject({
      hooksInstalled: false,
      hooksEnabled: false,
    });
  }, 30000);

  it("builds clean marketplace-root export archives with metadata", () => {
    const outputDir = path.join(tmpDir, "dist/plugins");
    const build = runPython(EXPORT_SCRIPT, ["--output-dir", outputDir]);
    expect(build.status).toBe(0);

    const manifestPath = path.join(outputDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = parseJsonFile(manifestPath);
    expect(Array.isArray(manifest.archives)).toBe(true);
    expect(manifest.archives).toHaveLength(2);

    const archivePaths = manifest.archives.map((entry: { archivePath: string }) => entry.archivePath);
    for (const archivePath of archivePaths) {
      expect(existsSync(archivePath)).toBe(true);
    }

    const listing = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, sys, zipfile",
          "out = {}",
          "for archive in sys.argv[1:]:",
          "    with zipfile.ZipFile(archive) as zf:",
          "        out[archive] = sorted(zf.namelist())",
          "print(json.dumps(out))",
        ].join("\n"),
        ...archivePaths,
      ],
      { encoding: "utf8" }
    );
    expect(listing.status).toBe(0);
    const listings = JSON.parse(listing.stdout) as Record<string, string[]>;

    const claudeArchive = manifest.archives.find((entry: { editor: string }) => entry.editor === "claude");
    const codexArchive = manifest.archives.find((entry: { editor: string }) => entry.editor === "codex");
    expect(claudeArchive).toBeTruthy();
    expect(codexArchive).toBeTruthy();

    expect(listings[claudeArchive.archivePath]).toContain(".claude-plugin/marketplace.json");
    expect(listings[claudeArchive.archivePath]).toContain("plugins/runir-claudecode/.claude-plugin/plugin.json");
    expect(listings[codexArchive.archivePath]).toContain(".agents/plugins/marketplace.json");
    expect(listings[codexArchive.archivePath]).toContain("plugins/runir-codex/.codex-plugin/plugin.json");

    for (const names of Object.values(listings)) {
      expect(names.some((name) => name.includes("__pycache__"))).toBe(false);
      expect(names.some((name) => name.endsWith(".pyc"))).toBe(false);
      expect(names.some((name) => name.endsWith(".DS_Store"))).toBe(false);
    }
  }, 30000);

  it("keeps the Codex manifest honest about plugin-owned components", () => {
    expect(existsSync(CODEX_MANIFEST)).toBe(true);
    const manifest = parseJsonFile(CODEX_MANIFEST);
    expect(manifest.skills).toBe("./skills/");
    expect("hooks" in manifest).toBe(false);
  });
});
