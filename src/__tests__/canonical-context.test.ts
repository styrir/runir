import { describe, expect, it } from "vitest";
import {
  buildArbitrationPartitionRef,
  buildHexisContextRef,
  buildProjectStateRef,
  canonicalizeWorkspaceId,
  fingerprint,
  fingerprintWorkspacePath,
  normalizeGitRemoteUrl,
  resolveCanonicalContextIdentity,
} from "../identity/canonical-context.js";

describe("canonical-context", () => {
  it("prefers explicit projectId over path when deriving projectKey", () => {
    const identity = resolveCanonicalContextIdentity({
      userId: "user-1",
      sessionId: "sess-1",
      path: "/Users/brooks/Code/runir",
      projectId: "Runir-Core",
      agentId: "agent-1",
      taskId: "Rúnir-c8n1",
    });

    expect(identity.contextScopeKind).toBe("session");
    expect(identity.projectKey).toBe("project:runir-core");
    expect(identity.derivation.projectKey.source).toBe("projectId");
    expect(identity.derivation.resolvedTaskId.source).toBe("taskId");
    expect(identity.derivation.agentId.source).toBe("agentId");
  });

  it("derives a stable path-backed projectKey without using the raw path as identity", () => {
    const identity = resolveCanonicalContextIdentity({
      userId: "user-1",
      path: "/Users/brooks/Code/runir/",
    });

    expect(identity.contextScopeKind).toBe("project");
    expect(identity.projectKey).toMatch(/^path:[a-f0-9]{24}$/);
    expect(identity.projectKey).not.toContain("/Users/brooks/Code/runir");
    expect(identity.derivation.projectKey.source).toBe("path");
    expect(identity.derivation.projectKey.marker).toBe("path-fallback");
    expect(identity.derivation.projectKey.warning).toBe("path_fallback_used");
  });

  it("derives a stable git-backed projectKey across different local paths", () => {
    const a = resolveCanonicalContextIdentity({
      userId: "user-1",
      path: "/Users/brooks/Code/runir",
      gitRemoteUrl: "git@github.com:OpenAI/Runir.git",
      gitRepoRoot: "/Users/brooks/Code/runir",
    });
    const b = resolveCanonicalContextIdentity({
      userId: "user-1",
      path: "/tmp/worktrees/runir",
      gitRemoteUrl: "https://github.com/openai/runir",
      gitRepoRoot: "/tmp/worktrees/runir",
    });

    expect(a.projectKey).toBe(b.projectKey);
    expect(a.projectKey).toMatch(/^git:[a-f0-9]{24}$/);
    expect(a.derivation.projectKey.source).toBe("gitRemote");
    expect(a.derivation.projectKey.marker).toBe("git");
    expect(a.derivation.projectKey.warning).toBeUndefined();
    expect(b.derivation.projectKey.source).toBe("gitRemote");
  });

  it("builds a project_state ref from canonical projectKey while preserving legacy path", () => {
    const identity = resolveCanonicalContextIdentity({
      userId: "user-1",
      path: "/Users/brooks/Code/runir",
    });
    const ref = buildProjectStateRef(identity);

    expect(ref.projectKey).toBe(identity.projectKey);
    expect(ref.legacyPath).toBe("/Users/brooks/Code/runir");
    expect(ref.recordId).toMatch(/^project_state_[a-f0-9]{24}$/);
  });

  it("preserves legacy hexis scope-key semantics through the adapter", () => {
    const identity = resolveCanonicalContextIdentity({
      userId: "u1",
      path: "/tmp/runir.ts",
    });

    expect(buildHexisContextRef(identity)).toEqual({
      scope: "project",
      scopeKey: "u1::project::/tmp/runir.ts",
    });
  });

  it("preserves arbitration partition behavior exactly", () => {
    const identity = resolveCanonicalContextIdentity({
      userId: "u1",
      sessionId: "sess-1",
      path: "/tmp/runir.ts",
    });

    expect(buildArbitrationPartitionRef(identity, "session")).toEqual({
      partitionKey: "u1::session::sess-1",
      scope: "session",
      sessionId: "sess-1",
    });
  });

  describe("canonicalizeWorkspaceId (Rúnir-78sy.3)", () => {
    it("collapses null/undefined/empty/whitespace to the '-' sentinel", () => {
      expect(canonicalizeWorkspaceId(null)).toBe("-");
      expect(canonicalizeWorkspaceId(undefined)).toBe("-");
      expect(canonicalizeWorkspaceId("")).toBe("-");
      expect(canonicalizeWorkspaceId("   ")).toBe("-");
      expect(canonicalizeWorkspaceId("\t\n")).toBe("-");
    });

    it("trims a present value", () => {
      expect(canonicalizeWorkspaceId("ws-1")).toBe("ws-1");
      expect(canonicalizeWorkspaceId("  ws-2  ")).toBe("ws-2");
    });
  });

  describe("fingerprintWorkspacePath (Rúnir-78sy.3)", () => {
    it("equals fp24(normalizePath(path)) and is trailing-slash / backslash invariant", () => {
      // Mirrors runir_session.workspace_fingerprint = fingerprint(normalizePath(cwd)).
      const a = fingerprintWorkspacePath("/Users/brooks/Code/runir");
      const b = fingerprintWorkspacePath("/Users/brooks/Code/runir/");
      const c = fingerprintWorkspacePath("\\Users\\brooks\\Code\\runir");
      expect(a).toBe(b);
      expect(a).toBe(c);
      expect(a).toHaveLength(24);
    });
  });

  describe("exported fingerprint + normalizeGitRemoteUrl (Rúnir-78sy.3)", () => {
    it("normalizeGitRemoteUrl strips scheme/user@/.git and produces stable git: fingerprints", () => {
      const scp = normalizeGitRemoteUrl("git@github.com:AlphaComposite/runir.git");
      const https = normalizeGitRemoteUrl("https://github.com/AlphaComposite/runir.git");
      expect(scp).toBe("github.com/alphacomposite/runir");
      expect(https).toBe("github.com/alphacomposite/runir");
      expect(fingerprint(scp)).toBe(fingerprint(https));
      expect(fingerprint(scp)).toHaveLength(24);
    });
  });
});
