import { join } from "node:path";
import {
  resolveUserRoots,
  validateAbsoluteOverride,
  type StyrirRootOverrides,
  type UserRootInput,
  type UserRoots,
} from "./styrir-workspace-paths.js";
import {
  resolveRepositoryIdentity,
  type RepositoryIdentity,
} from "./styrir-workspace-repository.js";

export const STYRIR_WORKSPACE_SCHEMA_VERSION = "styrir-workspace/v1";

export type ManagedStyrirRoots = {
  readonly runs: string;
  readonly logs: string;
  readonly cache: string;
  readonly tmp: string;
};

export type RepositoryUserRoots = Omit<UserRoots, "config">;

export type ResolveStyrirPathsInput = UserRootInput & {
  readonly repoStart?: string;
};

export type StyrirPaths = {
  readonly schemaVersion: typeof STYRIR_WORKSPACE_SCHEMA_VERSION;
  readonly repository: RepositoryIdentity;
  readonly workspaceRoot: string;
  readonly managed: ManagedStyrirRoots;
  readonly user: UserRoots;
  readonly repositoryUser: RepositoryUserRoots;
};

function repositoryStart(
  input: ResolveStyrirPathsInput,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = input.repoStart ??
    env["STYRIR_REPO_ROOT"] ??
    process.cwd();
  return validateAbsoluteOverride("repository root", value);
}

function workspaceRoot(
  repository: RepositoryIdentity,
  overrides: StyrirRootOverrides,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = overrides.workspaceRoot ?? env["STYRIR_WORKSPACE_ROOT"];
  return value === undefined
    ? join(repository.root, ".styrir")
    : validateAbsoluteOverride("workspace root", value);
}

export async function resolveStyrirPaths(
  input: ResolveStyrirPathsInput = {},
): Promise<StyrirPaths> {
  const env = input.env ?? process.env;
  const overrides = input.overrides ?? {};
  const repository = await resolveRepositoryIdentity(repositoryStart(input, env));
  const user = resolveUserRoots({ ...input, env, overrides });
  const root = workspaceRoot(repository, overrides, env);
  const repositorySuffix = join("repositories", repository.repositoryId);
  return {
    schemaVersion: STYRIR_WORKSPACE_SCHEMA_VERSION,
    repository,
    workspaceRoot: root,
    managed: {
      runs: join(root, "runs"),
      logs: join(root, "logs"),
      cache: join(root, "cache"),
      tmp: join(root, "tmp"),
    },
    user,
    repositoryUser: {
      data: join(user.data, repositorySuffix),
      state: join(user.state, repositorySuffix),
      cache: join(user.cache, repositorySuffix),
      runtime: join(user.runtime, repositorySuffix),
    },
  };
}

export {
  resolveUserRoots,
  validateAbsoluteOverride,
  type StyrirPlatform,
  type StyrirRootOverrides,
  type UserRootInput,
  type UserRoots,
} from "./styrir-workspace-paths.js";

export {
  computeRepositoryId,
  normalizeGitOrigin,
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RepositoryIdentityDeps,
} from "./styrir-workspace-repository.js";

export {
  DEFAULT_STYRIR_RETENTION_DAYS,
  MANAGED_STYRIR_CLASSES,
  planWorkspaceRetention,
  resolveRetentionPolicy,
  type ManagedStyrirClass,
  type RetentionCandidate,
  type RetentionNode,
  type RetentionOverrides,
  type RetentionPlan,
  type RetentionPolicy,
  type RetentionReason,
  type RetentionRecord,
  type RootSnapshot,
} from "./styrir-workspace-retention.js";

export {
  applyWorkspaceRetention,
  type ApplyRetentionRecord,
  type RetentionApplyResult,
  type RetentionDeleteDeps,
} from "./styrir-workspace-delete.js";

export {
  checkStyrirAdoption,
  STYRIR_REQUIRED_EXPORT_DENY_RULES,
  STYRIR_REQUIRED_IGNORE_RULES,
  type AdoptionCheck,
  type AdoptionCheckId,
  type AdoptionReport,
} from "./styrir-workspace-adoption.js";
