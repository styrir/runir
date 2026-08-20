import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const tempDirs: string[] = [];
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): JsonRecord {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Expected JSON object");
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Expected string array");
  return value;
}

function cleanupFixture(repo: string): { readonly workspace: string; readonly oldIds: readonly string[] } {
  const workspace = path.join(repo, ".styrir");
  const oldIds = ["runs/old-run", "logs/old-log", "cache/old-cache", "tmp/old-tmp"];
  for (const id of oldIds) {
    const file = path.join(workspace, id);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "credential-canary-fixture");
    utimesSync(file, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
  }
  const fresh = path.join(workspace, "runs/fresh-run");
  mkdirSync(path.dirname(fresh), { recursive: true });
  writeFileSync(fresh, "fresh");
  utimesSync(fresh, new Date("2026-08-19T00:00:00.000Z"), new Date("2026-08-19T00:00:00.000Z"));
  return { workspace, oldIds };
}

async function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await exec(command, [...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    const status = typeof failure.code === "number" ? failure.code : 1;
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    return { status, stdout, stderr };
  }
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function gitRepo(): Promise<string> {
  const repo = tempDir("runir-workspace-repo-");
  await run("git", ["init", "--quiet", repo]);
  await run("git", ["-C", repo, "config", "user.name", "Test User"]);
  await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await run("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://credential-canary@example.invalid/private.git",
  ]);
  return repo;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workspace CLI", () => {
  it("resolves canonical paths and a repository id as JSON", async () => {
    const repo = await gitRepo();
    const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "resolve", "--repo", repo, "--json"], {
      RUNIR_API_KEY: "credential-canary-environment",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("credential-canary");
    expect(result.stderr).not.toContain("credential-canary");
    const workspace = parseRecord(result.stdout);
    const repository = isRecord(workspace.repository) ? workspace.repository : {};
    const user = isRecord(workspace.user) ? workspace.user : {};
    const repositoryUser = isRecord(workspace.repositoryUser) ? workspace.repositoryUser : {};
    const managed = isRecord(workspace.managed) ? workspace.managed : {};
    const canonicalRepo = realpathSync(repo);
    expect(repository).toMatchObject({
      root: canonicalRepo,
      pathFallback: false,
      origin: "example.invalid/private",
    });
    expect(repository.repositoryId).toMatch(/^[0-9a-f]{64}$/);
    expect(workspace.workspaceRoot).toBe(path.join(canonicalRepo, ".styrir"));
    expect(managed).toEqual({
      cache: path.join(canonicalRepo, ".styrir", "cache"),
      logs: path.join(canonicalRepo, ".styrir", "logs"),
      runs: path.join(canonicalRepo, ".styrir", "runs"),
      tmp: path.join(canonicalRepo, ".styrir", "tmp"),
    });
    expect(user.config).toEqual(expect.any(String));
    for (const field of ["data", "state", "cache", "runtime"]) expect(repositoryUser[field]).toEqual(expect.any(String));
  });

  it("gives an absolute workspace-root flag precedence over its environment", async () => {
    const repo = await gitRepo();
    const workspaceRoot = tempDir("runir-workspace-override-");
    const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "resolve", "--repo", repo, "--workspace-root", workspaceRoot, "--json"], {
      STYRIR_WORKSPACE_ROOT: tempDir("runir-workspace-env-") + "/not-selected",
    });

    expect(result.status).toBe(0);
    expect(parseRecord(result.stdout).workspaceRoot).toBe(workspaceRoot);
  });

  it("rejects a missing repository without creating workspace artifacts", async () => {
    const parent = tempDir("runir-workspace-missing-");
    const missingRepo = path.join(parent, "missing-repo");
    const workspaceRoot = path.join(parent, "workspace");
    const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "resolve", "--repo", missingRepo, "--workspace-root", workspaceRoot, "--json"]);

    expect(result.status).not.toBe(0);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("documents resolve and override precedence in help", async () => {
    const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "--help"]);

    expect(result.status).toBe(0);
    for (const token of ["resolve", "--workspace-root", "STYRIR_WORKSPACE_ROOT", "XDG"]) {
      expect(`${result.stdout}\n${result.stderr}`).toContain(token);
    }
  });

  it("plans cleanup by default without mutating candidates", async () => {
    const repo = await gitRepo();
    const fixture = cleanupFixture(repo);
    const result = await run(process.execPath, [
      "--import", "tsx/esm", "cli/index.ts", "workspace", "cleanup",
      "--repo", repo, "--now", "2026-08-20T00:00:00.000Z", "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("credential-canary");
    const output = parseRecord(result.stdout);
    expect(output.mode).toBe("dry-run");
    expect(isRecord(output.policies)).toBe(true);
    expect(stringArray(output.candidates).sort()).toEqual([...fixture.oldIds].sort());
    expect(existsSync(path.join(fixture.workspace, "runs/old-run"))).toBe(true);
  });

  it("applies the planned candidate IDs", async () => {
    const repo = await gitRepo();
    const fixture = cleanupFixture(repo);
    const result = await run(process.execPath, [
      "--import", "tsx/esm", "cli/index.ts", "workspace", "cleanup",
      "--repo", repo, "--now", "2026-08-20T00:00:00.000Z", "--apply", "--json",
    ]);

    expect(result.status).toBe(0);
    const output = parseRecord(result.stdout);
    expect(output.mode).toBe("apply");
    expect(stringArray(output.candidates).sort()).toEqual([...fixture.oldIds].sort());
    for (const id of fixture.oldIds) expect(existsSync(path.join(fixture.workspace, id))).toBe(false);
    expect(existsSync(path.join(fixture.workspace, "runs/fresh-run"))).toBe(true);
  });

  it("honors the exact cleanup clock and retention policies", async () => {
    const repo = await gitRepo();
    const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "cleanup", "--repo", repo, "--json", "--now", "2026-08-20T00:00:00.000Z", "--runs-days", "30", "--logs-days", "14", "--cache-days", "7", "--tmp-days", "1"]);

    expect(result.status).toBe(0);
    const output = parseRecord(result.stdout);
    expect(output.now).toBe("2026-08-20T00:00:00.000Z");
    expect(output.policies).toEqual({ runs: 30, logs: 14, cache: 7, tmp: 1 });
  });

  it("rejects invalid cleanup retention and timestamps", async () => {
    const repo = await gitRepo();
    for (const option of [
      ["--runs-days", ""],
      ["--runs-days", "-1"],
      ["--logs-days", "1.5"],
      ["--cache-days", "nope"],
      ["--now", "not-a-timestamp"],
    ]) {
      const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "cleanup", "--repo", repo, ...option]);
      expect(result.status).not.toBe(0);
    }
  });

  it("documents cleanup controls and never prints credential canaries", async () => {
    const result = await run(process.execPath, ["--import", "tsx/esm", "cli/index.ts", "workspace", "cleanup", "--help"]);
    expect(result.status).toBe(0);
    const text = `${result.stdout}\n${result.stderr}`;
    for (const token of ["cleanup", "--apply", "runs-days", "logs-days", "cache-days", "tmp-days"]) expect(text).toContain(token);
    expect(text).not.toContain("credential-canary");
  });
});
