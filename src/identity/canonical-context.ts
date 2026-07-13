import { createHash } from "node:crypto";
import type { MemoryScope } from "../domain/memory/types.js";

export type ContextScopeKind = "session" | "project" | "agent";
export type DerivationSource =
  | "sessionId"
  | "projectId"
  | "gitRemote"
  | "gitRoot"
  | "path"
  | "agentId"
  | "taskId"
  | "default"
  | "absent";
export type ProjectIdentityMarker = "explicit" | "git" | "path-fallback" | "absent";

export interface CanonicalContextInput {
  userId: string;
  sessionId?: string;
  path?: string;
  projectId?: string;
  gitRemoteUrl?: string;
  gitRepoRoot?: string;
  agentId?: string;
  taskId?: string;
}

export interface CanonicalContextRawFragments {
  sessionId?: string;
  path?: string;
  projectId?: string;
  gitRemoteUrl?: string;
  gitRepoRoot?: string;
  agentId?: string;
  taskId?: string;
}

export interface CanonicalDerivationField {
  value?: string;
  source: DerivationSource;
}

export interface CanonicalProjectKeyDerivationField extends CanonicalDerivationField {
  marker?: ProjectIdentityMarker;
  warning?: "path_fallback_used";
}

export interface CanonicalContextIdentity {
  userId: string;
  contextScopeKind: ContextScopeKind;
  agentId?: string;
  resolvedTaskId?: string;
  projectKey?: string;
  raw: CanonicalContextRawFragments;
  derivation: {
    contextScopeKind: CanonicalDerivationField;
    agentId: CanonicalDerivationField;
    resolvedTaskId: CanonicalDerivationField;
    projectKey: CanonicalProjectKeyDerivationField;
  };
}

export interface ProjectStateRef {
  recordId: string;
  projectKey?: string;
  legacyPath?: string;
}

export interface HexisContextRef {
  scope: ContextScopeKind;
  scopeKey: string;
}

export interface ArbitrationPartitionRef {
  partitionKey: string;
  scope: MemoryScope;
  sessionId?: string;
}

function normalizeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProjectId(projectId: string): string {
  return projectId.trim().toLowerCase();
}

export function normalizeGitRemoteUrl(remoteUrl: string): string {
  return remoteUrl
    .trim()
    .replace(/^ssh:\/\//i, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@]+@/, "")
    .replace(/^([^:/]+):/, "$1/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$|\/+$/g, "");
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

/** sha256-hex(v).slice(0,24) over UTF-8 — the shared fingerprint primitive.
 *  Leit mirrors this exactly (fp24). A byte-for-byte duplicate lives in
 *  runir-session-store.ts:53; it is intentionally not unified in Rúnir-78sy.3. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Canonical `project:<normalized>` key format — the ONE source deriveProjectKey
 *  and the continuity binding-key derivation both call (no re-spelling). */
export function projectKeyFromProjectId(projectId: string): string {
  return `project:${normalizeProjectId(projectId)}`;
}

/** Canonical `git:<fp24(normalizeGitRemoteUrl)>` key format — the ONE source
 *  deriveProjectKey and the continuity binding-key derivation both call. */
export function projectKeyFromGitRemote(remoteUrl: string): string {
  return `git:${fingerprint(normalizeGitRemoteUrl(remoteUrl))}`;
}

/**
 * fp24 of a normalized workspace/repo-root path — matches
 * runir_session.workspace_fingerprint (runir-session-store.ts:131:
 * fingerprint(normalizePath(workspacePath))). Enrollment stores ONLY this
 * fingerprint, never the raw path, and binds evidence by equality with
 * runir_session.workspace_fingerprint.
 */
export function fingerprintWorkspacePath(path: string): string {
  return fingerprint(normalizePath(path));
}

/**
 * Ingress canonicalization for the enrollment/continuity workspace dimension
 * (ratified A-3). `workspaceId` does not exist elsewhere in the service yet, so
 * null/undefined/empty/whitespace collapse to the `"-"` sentinel already used
 * across identity keys; a present value is trimmed. Applied before every
 * enrollment lookup, unique key, and query so routes and stores agree.
 */
export function canonicalizeWorkspaceId(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "-";
}

function deriveProjectKey(
  projectId: string | undefined,
  gitRemoteUrl: string | undefined,
  gitRepoRoot: string | undefined,
  path: string | undefined,
): CanonicalProjectKeyDerivationField {
  if (projectId) {
    return {
      value: projectKeyFromProjectId(projectId),
      source: "projectId",
      marker: "explicit",
    };
  }
  if (gitRemoteUrl) {
    return {
      value: projectKeyFromGitRemote(gitRemoteUrl),
      source: "gitRemote",
      marker: "git",
    };
  }
  if (gitRepoRoot) {
    return {
      value: `git:${fingerprint(`root:${basename(gitRepoRoot)}`)}`,
      source: "gitRoot",
      marker: "git",
    };
  }
  if (path) {
    return {
      value: `path:${fingerprint(normalizePath(path))}`,
      source: "path",
      marker: "path-fallback",
      warning: "path_fallback_used",
    };
  }
  return { source: "absent", marker: "absent" };
}

function deriveContextScopeKind(raw: CanonicalContextRawFragments): CanonicalDerivationField {
  if (raw.sessionId) {
    return { value: "session", source: "sessionId" };
  }
  if (raw.projectId || raw.gitRemoteUrl || raw.gitRepoRoot || raw.path) {
    return {
      value: "project",
      source: raw.projectId
        ? "projectId"
        : raw.gitRemoteUrl
          ? "gitRemote"
          : raw.gitRepoRoot
            ? "gitRoot"
            : "path",
    };
  }
  return { value: "agent", source: raw.agentId ? "agentId" : "default" };
}

export function resolveCanonicalContextIdentity(input: CanonicalContextInput): CanonicalContextIdentity {
  const raw: CanonicalContextRawFragments = {
    sessionId: normalizeToken(input.sessionId),
    path: normalizeToken(input.path),
    projectId: normalizeToken(input.projectId),
    gitRemoteUrl: normalizeToken(input.gitRemoteUrl),
    gitRepoRoot: normalizeToken(input.gitRepoRoot),
    agentId: normalizeToken(input.agentId),
    taskId: normalizeToken(input.taskId),
  };

  const projectKey = deriveProjectKey(raw.projectId, raw.gitRemoteUrl, raw.gitRepoRoot, raw.path);
  const contextScopeKind = deriveContextScopeKind(raw);
  const agentId: CanonicalDerivationField = raw.agentId
    ? { value: raw.agentId, source: "agentId" }
    : { source: "absent" };
  const resolvedTaskId: CanonicalDerivationField = raw.taskId
    ? { value: raw.taskId, source: "taskId" }
    : { source: "absent" };

  return {
    userId: normalizeToken(input.userId) ?? input.userId,
    contextScopeKind: (contextScopeKind.value as ContextScopeKind | undefined) ?? "agent",
    agentId: agentId.value,
    resolvedTaskId: resolvedTaskId.value,
    projectKey: projectKey.value,
    raw,
    derivation: {
      contextScopeKind,
      agentId,
      resolvedTaskId,
      projectKey,
    },
  };
}

export function buildProjectStateRecordId(userId: string, projectKey?: string, legacyPath?: string): string {
  const discriminator = projectKey ?? legacyPath ?? "*";
  return `project_state_${fingerprint(`${userId}::${discriminator}`)}`;
}

export function buildProjectStateRef(identity: CanonicalContextIdentity): ProjectStateRef {
  return {
    recordId: buildProjectStateRecordId(identity.userId, identity.projectKey, identity.raw.path),
    projectKey: identity.projectKey,
    legacyPath: identity.raw.path,
  };
}

export function buildHexisContextRef(identity: CanonicalContextIdentity): HexisContextRef {
  switch (identity.contextScopeKind) {
    case "session":
      return {
        scope: "session",
        scopeKey: `${identity.userId}::session::${identity.raw.sessionId ?? "default"}`,
      };
    case "project":
      return {
        scope: "project",
        scopeKey: `${identity.userId}::project::${identity.raw.projectId ?? identity.raw.gitRemoteUrl ?? identity.raw.path ?? "default"}`,
      };
    case "agent":
    default:
      return {
        scope: "agent",
        scopeKey: `${identity.userId}::agent::${identity.agentId ?? identity.userId}`,
      };
  }
}

export function buildArbitrationPartitionRef(
  identity: CanonicalContextIdentity,
  scope: MemoryScope,
): ArbitrationPartitionRef {
  const partitionKey = `${identity.userId}::${scope}::${identity.raw.sessionId ?? "-"}`;
  return {
    partitionKey,
    scope,
    sessionId: identity.raw.sessionId,
  };
}

export function formatCanonicalContextForDebug(identity: CanonicalContextIdentity): string {
  return [
    `scope=${identity.contextScopeKind}`,
    `projectKey=${identity.projectKey ?? "-"}`,
    `projectIdentity=${identity.derivation.projectKey.marker ?? "absent"}`,
    `agentId=${identity.agentId ?? "-"}`,
    `taskId=${identity.resolvedTaskId ?? "-"}`,
    `scopeSource=${identity.derivation.contextScopeKind.source}`,
    `projectSource=${identity.derivation.projectKey.source}`,
  ].join(" ");
}
