import {
  lstat,
  realpath,
  rmdir as fsRmdir,
  unlink as fsUnlink,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type {
  RetentionCandidate,
  RetentionNode,
  RetentionPlan,
  RootSnapshot,
} from "./styrir-workspace-retention.js";

export type ApplyRetentionRecord = {
  readonly id: string;
  readonly reason: string;
};

export type RetentionApplyResult = {
  readonly plannedCandidateIds: readonly string[];
  readonly deletedCandidateIds: readonly string[];
  readonly retained: readonly ApplyRetentionRecord[];
  readonly errors: readonly ApplyRetentionRecord[];
};

export type RetentionDeleteDeps = {
  readonly unlink?: (path: string) => Promise<void>;
  readonly rmdir?: (path: string) => Promise<void>;
};

async function rootMatches(snapshot: RootSnapshot): Promise<boolean> {
  try {
    const stats = await lstat(snapshot.path);
    return stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      stats.dev === snapshot.dev &&
      stats.ino === snapshot.ino &&
      await realpath(snapshot.path) === snapshot.realPath;
  } catch {
    return false;
  }
}

function kindMatches(node: RetentionNode, isFile: boolean, isDirectory: boolean): boolean {
  return node.kind === "file" ? isFile : isDirectory;
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." &&
    !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}

async function nodeMatches(
  classRoot: RootSnapshot,
  node: RetentionNode,
  compareMtime: boolean,
): Promise<boolean> {
  const absolutePath = join(classRoot.path, node.relativePath);
  if (!contained(classRoot.path, absolutePath)) return false;
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink() ||
        !kindMatches(node, stats.isFile(), stats.isDirectory()) ||
        stats.dev !== node.dev ||
        stats.ino !== node.ino ||
        (compareMtime && stats.mtimeMs !== node.mtimeMs)) {
      return false;
    }
    const parentRelative = dirname(node.relativePath);
    const expectedParent = parentRelative === "."
      ? classRoot.realPath
      : join(classRoot.realPath, parentRelative);
    return await realpath(dirname(absolutePath)) === expectedParent;
  } catch {
    return false;
  }
}

async function candidateMatches(
  classRoot: RootSnapshot,
  candidate: RetentionCandidate,
): Promise<boolean> {
  for (const node of candidate.nodes) {
    if (!await nodeMatches(classRoot, node, true)) return false;
  }
  return true;
}

function removalOrder(nodes: readonly RetentionNode[]): RetentionNode[] {
  return [...nodes].sort((left, right) => {
    const depth = right.relativePath.split(sep).length -
      left.relativePath.split(sep).length;
    if (depth !== 0) return depth;
    if (left.kind === right.kind) {
      return right.relativePath.localeCompare(left.relativePath);
    }
    return left.kind === "file" ? -1 : 1;
  });
}

async function removeCandidate(
  classRoot: RootSnapshot,
  candidate: RetentionCandidate,
  deps: Required<RetentionDeleteDeps>,
): Promise<string | null> {
  for (const node of removalOrder(candidate.nodes)) {
    if (!await nodeMatches(classRoot, node, false)) return "changed_since_plan";
    const path = join(classRoot.path, node.relativePath);
    try {
      if (node.kind === "file") await deps.unlink(path);
      else await deps.rmdir(path);
    } catch {
      return "delete_failed";
    }
  }
  return null;
}

export async function applyWorkspaceRetention(
  plan: RetentionPlan,
  inputDeps: RetentionDeleteDeps = {},
): Promise<RetentionApplyResult> {
  const deps: Required<RetentionDeleteDeps> = {
    unlink: inputDeps.unlink ?? fsUnlink,
    rmdir: inputDeps.rmdir ?? fsRmdir,
  };
  const plannedCandidateIds = plan.candidates.map((candidate) => candidate.id);
  const deletedCandidateIds: string[] = [];
  const retained: ApplyRetentionRecord[] = [...plan.retained];
  const errors: ApplyRetentionRecord[] = [];
  if (plan.workspace === null) {
    return { plannedCandidateIds, deletedCandidateIds, retained, errors };
  }
  if (!await rootMatches(plan.workspace)) {
    retained.push(...plan.candidates.map((candidate) => ({
      id: candidate.id,
      reason: "root_changed",
    })));
    return { plannedCandidateIds, deletedCandidateIds, retained, errors };
  }
  for (const candidate of plan.candidates) {
    const classRoot = plan.classRoots[candidate.managedClass];
    if (classRoot === undefined || !await rootMatches(classRoot) ||
        dirname(classRoot.realPath) !== plan.workspace.realPath) {
      retained.push({ id: candidate.id, reason: "root_changed" });
      continue;
    }
    if (!await candidateMatches(classRoot, candidate)) {
      retained.push({ id: candidate.id, reason: "changed_since_plan" });
      continue;
    }
    const error = await removeCandidate(classRoot, candidate, deps);
    if (error === null) deletedCandidateIds.push(candidate.id);
    else if (error === "changed_since_plan") {
      retained.push({ id: candidate.id, reason: error });
    } else errors.push({ id: candidate.id, reason: "delete_failed" });
  }
  return { plannedCandidateIds, deletedCandidateIds, retained, errors };
}
