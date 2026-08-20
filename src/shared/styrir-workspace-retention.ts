import {
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validateAbsoluteOverride } from "./styrir-workspace-paths.js";

export type ManagedStyrirClass = "runs" | "logs" | "cache" | "tmp";
export const MANAGED_STYRIR_CLASSES: readonly ManagedStyrirClass[] = [
  "runs",
  "logs",
  "cache",
  "tmp",
];

export type RetentionPolicy = Record<ManagedStyrirClass, number>;
export type RetentionOverrides = Partial<
  Record<ManagedStyrirClass, number | string>
>;

export const DEFAULT_STYRIR_RETENTION_DAYS: RetentionPolicy = {
  runs: 30,
  logs: 14,
  cache: 7,
  tmp: 1,
};

export type RetentionNode = {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
};

export type RootSnapshot = {
  readonly path: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
};

export type RetentionCandidate = {
  readonly id: string;
  readonly managedClass: ManagedStyrirClass;
  readonly entryName: string;
  readonly nodes: readonly RetentionNode[];
};

export type RetentionReason =
  | "invalid_timestamp"
  | "newer_than_cutoff"
  | "read_error"
  | "symlink"
  | "unsupported_type";

export type RetentionRecord = {
  readonly id: string;
  readonly reason: RetentionReason;
};

export type RetentionPlan = {
  readonly schemaVersion: "styrir-retention-plan/v1";
  readonly workspace: RootSnapshot | null;
  readonly classRoots: Readonly<Partial<Record<ManagedStyrirClass, RootSnapshot>>>;
  readonly evaluatedAt: string;
  readonly policies: RetentionPolicy;
  readonly candidates: readonly RetentionCandidate[];
  readonly retained: readonly RetentionRecord[];
};

const DAY_MS = 86_400_000;
const RETENTION_ENV: Record<ManagedStyrirClass, string> = {
  runs: "STYRIR_RETENTION_RUNS_DAYS",
  logs: "STYRIR_RETENTION_LOGS_DAYS",
  cache: "STYRIR_RETENTION_CACHE_DAYS",
  tmp: "STYRIR_RETENTION_TMP_DAYS",
};

function days(name: string, value: number | string): number {
  if (typeof value === "string" && !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${name} retention must be a non-negative integer`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} retention must be a non-negative integer`);
  }
  return parsed;
}

export function resolveRetentionPolicy(
  overrides: RetentionOverrides = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): RetentionPolicy {
  const value = (managedClass: ManagedStyrirClass): number => {
    const override = overrides[managedClass];
    const environment = env[RETENTION_ENV[managedClass]];
    const selected = override ?? environment ??
      DEFAULT_STYRIR_RETENTION_DAYS[managedClass];
    return days(managedClass, selected);
  };
  return {
    runs: value("runs"),
    logs: value("logs"),
    cache: value("cache"),
    tmp: value("tmp"),
  };
}

function snapshot(path: string, realPath: string, stats: Stats): RootSnapshot {
  return { path, realPath, dev: stats.dev, ino: stats.ino };
}

async function existingRoot(path: string): Promise<RootSnapshot | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`managed root is a symlink: ${path}`);
  if (!stats.isDirectory()) throw new Error(`managed root must be a directory: ${path}`);
  return snapshot(path, await realpath(path), stats);
}

type InspectedTree = {
  readonly nodes: readonly RetentionNode[];
  readonly reason?: RetentionReason;
};

const REASON_PRIORITY: Record<RetentionReason, number> = {
  newer_than_cutoff: 1,
  invalid_timestamp: 2,
  unsupported_type: 3,
  read_error: 4,
  symlink: 5,
};

function strongerReason(
  left: RetentionReason | undefined,
  right: RetentionReason | undefined,
): RetentionReason | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return REASON_PRIORITY[right] > REASON_PRIORITY[left] ? right : left;
}

async function inspectTree(
  classRoot: string,
  relativePath: string,
  cutoffMs: number,
): Promise<InspectedTree> {
  const absolutePath = join(classRoot, relativePath);
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    return { nodes: [], reason: "read_error" };
  }
  if (stats.isSymbolicLink()) return { nodes: [], reason: "symlink" };
  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  if (kind === null) return { nodes: [], reason: "unsupported_type" };
  const ownReason: RetentionReason | undefined = !Number.isFinite(stats.mtimeMs)
    ? "invalid_timestamp"
    : stats.mtimeMs >= cutoffMs ? "newer_than_cutoff" : undefined;
  const node: RetentionNode = {
    relativePath,
    kind,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
  };
  if (kind === "file") return { nodes: [node], reason: ownReason };
  let children: string[];
  try {
    children = (await readdir(absolutePath)).sort();
  } catch {
    return { nodes: [node], reason: "read_error" };
  }
  const nodes: RetentionNode[] = [node];
  let reason: RetentionReason | undefined = ownReason;
  for (const child of children) {
    const inspected = await inspectTree(classRoot, join(relativePath, child), cutoffMs);
    nodes.push(...inspected.nodes);
    reason = strongerReason(reason, inspected.reason);
  }
  return { nodes, reason };
}

function validNow(now: Date): number {
  const value = now.getTime();
  if (!Number.isFinite(value)) throw new Error("retention now must be a valid timestamp");
  return value;
}

export async function planWorkspaceRetention(
  workspaceRoot: string,
  policy: RetentionPolicy,
  now: Date,
): Promise<RetentionPlan> {
  const rootPath = validateAbsoluteOverride("workspace root", workspaceRoot);
  const nowMs = validNow(now);
  const workspace = await existingRoot(rootPath);
  if (workspace === null) {
    return {
      schemaVersion: "styrir-retention-plan/v1",
      workspace: null,
      classRoots: {},
      evaluatedAt: now.toISOString(),
      policies: policy,
      candidates: [],
      retained: [],
    };
  }
  const classRoots: Partial<Record<ManagedStyrirClass, RootSnapshot>> = {};
  const candidates: RetentionCandidate[] = [];
  const retained: RetentionRecord[] = [];
  for (const managedClass of MANAGED_STYRIR_CLASSES) {
    const classRoot = await existingRoot(join(rootPath, managedClass));
    if (classRoot === null) continue;
    if (dirname(classRoot.realPath) !== workspace.realPath ||
        basename(classRoot.realPath) !== managedClass) {
      throw new Error(`managed root escapes workspace: ${managedClass}`);
    }
    classRoots[managedClass] = classRoot;
    const cutoffMs = nowMs - policy[managedClass] * DAY_MS;
    for (const entryName of (await readdir(classRoot.path)).sort()) {
      const id = `${managedClass}/${entryName}`;
      const inspected = await inspectTree(classRoot.path, entryName, cutoffMs);
      if (inspected.reason) retained.push({ id, reason: inspected.reason });
      else candidates.push({ id, managedClass, entryName, nodes: inspected.nodes });
    }
  }
  return {
    schemaVersion: "styrir-retention-plan/v1",
    workspace,
    classRoots,
    evaluatedAt: now.toISOString(),
    policies: policy,
    candidates,
    retained,
  };
}
