import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeRepositoryId,
  normalizeGitOrigin,
  resolveRepositoryIdentity,
  resolveStyrirPaths,
  resolveUserRoots,
  validateAbsoluteOverride,
} from "../shared/styrir-workspace.js";

const disposableRoots: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a record");
  }
  return Object.fromEntries(Object.entries(value));
}

function disposableRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "runir-styrir-resolver-"));
  disposableRoots.push(root);
  return root;
}

function gitRepository(remote?: string): string {
  const repo = join(disposableRoot(), "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  if (remote) {
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  }
  return repo;
}

afterEach(() => {
  for (const root of disposableRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Styrir user-scoped roots", () => {
  it("resolves Linux XDG and macOS native defaults deterministically", () => {
    const linux = resolveUserRoots({
      env: {},
      homeDir: "/home/operator",
      platform: "linux",
      tempDir: "/tmp",
      uid: 501,
    });
    expect(linux).toEqual({
      cache: "/home/operator/.cache/styrir",
      config: "/home/operator/.config/styrir",
      data: "/home/operator/.local/share/styrir",
      runtime: "/tmp/styrir-501",
      state: "/home/operator/.local/state/styrir",
    });

    const mac = resolveUserRoots({
      env: {},
      homeDir: "/Users/operator",
      platform: "darwin",
      tempDir: "/private/tmp",
      uid: 501,
    });
    expect(mac).toEqual({
      cache: "/Users/operator/Library/Caches/Styrir",
      config: "/Users/operator/Library/Application Support/Styrir/config",
      data: "/Users/operator/Library/Application Support/Styrir/data",
      runtime: "/private/tmp/Styrir",
      state: "/Users/operator/Library/Application Support/Styrir/state",
    });
  });

  it("applies API then Styrir then XDG precedence", () => {
    const roots = resolveUserRoots({
      env: {
        STYRIR_CACHE_ROOT: "/env/cache",
        STYRIR_DATA_ROOT: "/env/data",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_RUNTIME_DIR: "/xdg/runtime",
        XDG_STATE_HOME: "/xdg/state",
      },
      homeDir: "/Users/operator",
      overrides: {
        cacheRoot: "/api/cache",
      },
      platform: "darwin",
      tempDir: "/private/tmp",
      uid: 501,
    });
    expect(roots).toEqual({
      cache: "/api/cache",
      config: "/xdg/config/styrir",
      data: "/env/data",
      runtime: "/xdg/runtime/styrir",
      state: "/xdg/state/styrir",
    });
  });

  it.each([
    ["relative", "relative/path"],
    ["traversal", "/safe/../escape"],
    ["dot segment", "/safe/./child"],
    ["NUL", "/safe/\0child"],
  ])("rejects an invalid %s override", (_label, value) => {
    expect(() => validateAbsoluteOverride("workspace root", value))
      .toThrow(/workspace root/u);
  });
});

describe("Styrir repository identity", () => {
  it("normalizes equivalent Git origins without credentials", () => {
    const expected = "github.com/Org/Runir";
    expect(normalizeGitOrigin(
      "https://token-secret@GitHub.com/Org/Runir.git?auth=secret#fragment",
      "/repo",
    )).toBe(expected);
    expect(normalizeGitOrigin("git@github.com:Org/Runir.git", "/repo"))
      .toBe(expected);
    expect(normalizeGitOrigin("ssh://git@github.com/Org/Runir.git", "/repo"))
      .toBe(expected);
  });

  it("produces stable full hashes and avoids path collisions", () => {
    const origin = "github.com/Org/Runir";
    const first = computeRepositoryId("/work/alpha/service", origin);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeRepositoryId("/work/alpha/service", origin)).toBe(first);
    expect(computeRepositoryId("/other/alpha/service", origin)).not.toBe(first);
    expect(computeRepositoryId(
      "/work/alpha/service",
      "github.com/Org/Other",
    ))
      .not.toBe(first);
  });

  it("canonicalizes Git subdirectories and symlink aliases", async () => {
    const repo = gitRepository("https://credential-canary@github.com/Org/Runir.git");
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const alias = join(disposableRoot(), "repo-alias");
    symlinkSync(repo, alias, "dir");

    const direct = record(await resolveRepositoryIdentity(nested));
    const aliased = record(await resolveRepositoryIdentity(join(alias, "src")));

    expect(direct["root"]).toBe(realpathSync(repo));
    expect(aliased["repositoryId"]).toBe(direct["repositoryId"]);
    expect(direct["origin"]).toBe("github.com/Org/Runir");
    expect(JSON.stringify(direct)).not.toContain("credential-canary");
    expect(direct["pathFallback"]).toBe(false);
  });

  it("uses a marked path fallback without origin", async () => {
    const repo = gitRepository();
    const identity = record(await resolveRepositoryIdentity(repo));
    expect(identity["root"]).toBe(realpathSync(repo));
    expect(identity["origin"]).toBeNull();
    expect(identity["pathFallback"]).toBe(true);
    expect(identity["repositoryId"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects missing roots and regular files", async () => {
    const root = disposableRoot();
    const file = join(root, "file.txt");
    writeFileSync(file, "not a repository");
    await expect(resolveRepositoryIdentity(join(root, "missing")))
      .rejects.toThrow(/repository/u);
    await expect(resolveRepositoryIdentity(file))
      .rejects.toThrow(/directory/u);
  });
});

describe("Styrir workspace composition", () => {
  it("resolves repository and user paths without creating them", async () => {
    const repo = gitRepository("git@github.com:Org/Runir.git");
    const paths = record(await resolveStyrirPaths({
      env: {},
      homeDir: "/home/operator",
      platform: "linux",
      repoStart: repo,
      tempDir: "/tmp",
      uid: 501,
    }));

    const repository = record(paths["repository"]);
    const repositoryUser = record(paths["repositoryUser"]);
    const user = record(paths["user"]);
    expect(repository["root"]).toBe(realpathSync(repo));
    expect(paths["workspaceRoot"]).toBe(join(realpathSync(repo), ".styrir"));
    expect(paths["managed"]).toEqual({
      cache: join(realpathSync(repo), ".styrir", "cache"),
      logs: join(realpathSync(repo), ".styrir", "logs"),
      runs: join(realpathSync(repo), ".styrir", "runs"),
      tmp: join(realpathSync(repo), ".styrir", "tmp"),
    });
    expect(repositoryUser["data"]).toBe(
      `/home/operator/.local/share/styrir/repositories/${repository["repositoryId"]}`,
    );
    expect(user["config"]).toBe("/home/operator/.config/styrir");
  });
});
