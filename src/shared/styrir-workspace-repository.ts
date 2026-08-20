import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type RepositoryIdentity = {
  readonly root: string;
  readonly repositoryId: string;
  readonly origin: string | null;
  readonly pathFallback: boolean;
};

export type RepositoryIdentityDeps = {
  readonly runGit?: (
    cwd: string,
    args: readonly string[],
  ) => Promise<string | undefined>;
  readonly canonicalize?: (path: string) => Promise<string>;
};

const SCP_ORIGIN = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u;

function trimGitSuffix(path: string): string {
  return path
    .replace(/[?#].*$/u, "")
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "");
}

function normalizedHost(hostname: string, port: string): string {
  const host = hostname.toLowerCase();
  return port ? `${host}:${port}` : host;
}

function localOrigin(raw: string, canonicalRoot: string): string | undefined {
  const path = raw.startsWith("file:")
    ? decodeURIComponent(new URL(raw).pathname)
    : raw;
  if (!isAbsolute(path) && !path.startsWith(".")) return undefined;
  return `file:${resolve(canonicalRoot, path)}`;
}

export function normalizeGitOrigin(
  raw: string,
  canonicalRoot: string,
): string | undefined {
  const value = raw.trim();
  if (!value || value.includes("\0")) return undefined;
  const local = localOrigin(value, canonicalRoot);
  if (local) return local;

  const scp = value.includes("://") ? null : SCP_ORIGIN.exec(value);
  if (scp) {
    const host = scp[1]?.toLowerCase();
    const path = scp[2] === undefined ? "" : trimGitSuffix(scp[2]);
    return host && path ? `${host}/${path}` : undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return `file:${resolve(canonicalRoot, decodeURIComponent(url.pathname))}`;
    }
    if (!["git:", "http:", "https:", "ssh:"].includes(url.protocol)) {
      return undefined;
    }
    const host = normalizedHost(url.hostname, url.port);
    const path = trimGitSuffix(url.pathname);
    return host && path ? `${host}/${path}` : undefined;
  } catch {
    return undefined;
  }
}

export function computeRepositoryId(
  canonicalRoot: string,
  normalizedOrigin?: string,
): string {
  const origin = normalizedOrigin ?? "path-only";
  return createHash("sha256")
    .update(`styrir-repository-v1\0root=${canonicalRoot}\0origin=${origin}`)
    .digest("hex");
}

function defaultRunGit(
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  return new Promise((complete) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout) => complete(error ? undefined : stdout.trim() || undefined),
    );
  });
}

async function canonicalDirectory(
  path: string,
  canonicalize: (value: string) => Promise<string>,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await canonicalize(path);
  } catch {
    throw new Error(`repository path does not exist: ${path}`);
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`repository path must be a directory: ${path}`);
  }
  return canonical;
}

export async function resolveRepositoryIdentity(
  startPath: string,
  deps: RepositoryIdentityDeps = {},
): Promise<RepositoryIdentity> {
  const runGit = deps.runGit ?? defaultRunGit;
  const canonicalize = deps.canonicalize ?? realpath;
  const start = await canonicalDirectory(startPath, canonicalize);
  const discoveredRoot = await runGit(start, ["rev-parse", "--show-toplevel"]);
  const root = await canonicalDirectory(discoveredRoot ?? start, canonicalize);
  const rawOrigin = await runGit(root, ["config", "--get", "remote.origin.url"]);
  const origin = rawOrigin === undefined
    ? undefined
    : normalizeGitOrigin(rawOrigin, root);
  return {
    root,
    repositoryId: computeRepositoryId(root, origin),
    origin: origin ?? null,
    pathFallback: origin === undefined,
  };
}
