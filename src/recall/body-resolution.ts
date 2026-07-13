/**
 * body-resolution.ts — shared pure body-fragment resolvers (Rúnir-qjn4.2).
 *
 * These four pure helpers read identity fragments off an already-parsed hook
 * request body and fold them into a canonical context identity. They were
 * duplicated verbatim between the /hooks/recall orchestrator
 * (src/recall/orchestrator/recall-orchestrator.ts) and the capture/session-end
 * route (src/app/routes/hooks/index.ts); this module is the single source so
 * the two copies cannot drift.
 *
 * Pure and Hono-free: no runtime singletons, no I/O. The only dependency is the
 * pure `resolveCanonicalContextIdentity` from the identity layer, so importing
 * this module is safe from both the recall orchestrator and the route. The
 * runtime-bound resolvers (hexis/runir-session) are intentionally NOT here —
 * their orchestrator and route forms differ (dependency injection vs. runtime
 * singletons), so they stay with their respective owners.
 */
import {
  resolveCanonicalContextIdentity,
  type CanonicalContextIdentity,
} from "../identity/canonical-context.js";

export function readNestedString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

export function resolveBodyGitRemoteUrl(body: Record<string, unknown>): string | undefined {
  if (typeof body.gitRemoteUrl === "string" && body.gitRemoteUrl.trim()) {
    return body.gitRemoteUrl;
  }
  return readNestedString(body.git, ["remoteUrl", "originUrl", "remote"]);
}

export function resolveBodyGitRepoRoot(body: Record<string, unknown>, path: string | undefined): string | undefined {
  if (typeof body.gitRepoRoot === "string" && body.gitRepoRoot.trim()) {
    return body.gitRepoRoot;
  }
  return readNestedString(body.git, ["repoRoot", "root"]) ?? path;
}

export function resolveBodyCanonicalContext(
  body: Record<string, unknown>,
  userId: string,
  path: string | undefined,
  sessionId?: string,
): CanonicalContextIdentity {
  return resolveCanonicalContextIdentity({
    userId,
    sessionId,
    path,
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    gitRemoteUrl: resolveBodyGitRemoteUrl(body),
    gitRepoRoot: resolveBodyGitRepoRoot(body, path),
    agentId: typeof body.agentId === "string" ? body.agentId : undefined,
    taskId: typeof body.taskId === "string" ? body.taskId : undefined,
  });
}
