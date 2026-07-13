import { describe, expect, it } from "vitest";
import { resolveSemioteOriginContext } from "../app/semiote-write-context.js";

describe("resolveSemioteOriginContext", () => {
  it("prefers canonical identity fragments over stale route fallback values", () => {
    const result = resolveSemioteOriginContext({
      identity: {
        userId: "u1",
        contextScopeKind: "project",
        projectKey: "project:runir",
        agentId: undefined,
        resolvedTaskId: "task-3",
        raw: {
          sessionId: "sess-canonical",
          path: "/repo/canonical",
          projectId: "runir",
        },
        derivation: {
          contextScopeKind: { value: "project", source: "projectId" },
          agentId: { source: "absent" },
          resolvedTaskId: { value: "task-3", source: "taskId" },
          projectKey: { value: "project:runir", source: "projectId", marker: "explicit" },
        },
      },
      sourceKind: "capture",
      writeSource: "capture",
      retrievalTraceId: "trace-1",
      runirSessionId: "runir_session_123",
      nativeSessionId: "native-1",
      sessionId: "sess-stale",
      path: "/repo/stale",
      client: "claude-code",
      extraction: {
        mode: "capture",
        model: "test-model",
        capturedAt: "2026-04-20T07:00:00.000Z",
      },
    });

    expect(result).toEqual({
      sessionId: "sess-canonical",
      path: "/repo/canonical",
      client: "claude-code",
      provenance: {
        sourceKind: "capture",
        writeSource: "capture",
        retrievalTraceId: "trace-1",
        runirSessionId: "runir_session_123",
        nativeSessionId: "native-1",
        sessionId: "sess-canonical",
        path: "/repo/canonical",
        client: "claude-code",
        extraction: {
          mode: "capture",
          model: "test-model",
          capturedAt: "2026-04-20T07:00:00.000Z",
        },
        identity: expect.objectContaining({
          userId: "u1",
          projectKey: "project:runir",
          resolvedTaskId: "task-3",
        }),
      },
    });
  });

  it("falls back to explicit route values when canonical identity lacks them", () => {
    const result = resolveSemioteOriginContext({
      identity: {
        userId: "u1",
        contextScopeKind: "agent",
        agentId: "agent-1",
        resolvedTaskId: undefined,
        projectKey: undefined,
        raw: {},
        derivation: {
          contextScopeKind: { value: "agent", source: "default" },
          agentId: { value: "agent-1", source: "agentId" },
          resolvedTaskId: { source: "absent" },
          projectKey: { source: "absent", marker: "absent" },
        },
      },
      sourceKind: "manual-store",
      writeSource: "agent-write",
      sessionId: "sess-explicit",
      path: "/repo/explicit",
      client: "openclaw",
    });

    expect(result.sessionId).toBe("sess-explicit");
    expect(result.path).toBe("/repo/explicit");
    expect(result.provenance).toMatchObject({
      sourceKind: "manual-store",
      writeSource: "agent-write",
      sessionId: "sess-explicit",
      path: "/repo/explicit",
      client: "openclaw",
    });
  });
});
