import { describe, expect, it, vi } from "vitest";
import {
  buildRunirSessionResolverKey,
  ensureRunirSessionTable,
  resolveRunirSession,
} from "../storage/surreal/runir-session-store.js";

function mockDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

describe("runir-session-store", () => {
  it("defines the runir_session table with resolver and alias indexes", async () => {
    const db = mockDb();

    await ensureRunirSessionTable(db);

    expect(db.query).toHaveBeenCalledWith("DEFINE TABLE IF NOT EXISTS runir_session SCHEMAFULL;");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE FIELD IF NOT EXISTS resolver_key ON TABLE runir_session TYPE string;"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE INDEX IF NOT EXISTS idx_runir_session_resolver_key ON TABLE runir_session COLUMNS resolver_key UNIQUE;"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE INDEX IF NOT EXISTS idx_runir_session_native_alias ON TABLE runir_session COLUMNS user_id, native_session_key;"));
  });

  it("creates a runir-owned session id while storing native session aliases", async () => {
    const db = mockDb();

    const session = await resolveRunirSession(db, {
      userId: "u1",
      projectKey: "git:abc123",
      projectIdentitySource: "git",
      clientKind: "claudecode",
      nativeSessionId: "native-1",
      workspacePath: "/repo",
      now: "2026-04-20T08:00:00.000Z",
    });

    expect(session.id).toMatch(/^runir_session_[a-f0-9]{24}$/);
    expect(session.id).not.toContain("native-1");
    expect(session.nativeSessionAliases).toEqual(["native-1"]);
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE id = type::record('runir_session', $id)"),
      expect.objectContaining({ id: session.id }),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPSERT type::record('runir_session', $id) CONTENT"),
      expect.objectContaining({
        id: session.id,
        nativeSessionAliases: ["native-1"],
        nativeSessionId: "native-1",
        nativeSessionKey: "claudecode::native-1",
      }),
    );
  });

  it("heartbeats the same session when resolver inputs match and native session id is absent", async () => {
    const now = "2026-04-20T08:00:00.000Z";
    const resolverKey = buildRunirSessionResolverKey({
      userId: "u1",
      projectKey: "project:runir",
      clientKind: "codex",
      workspaceFingerprint: "ws-123",
    });
    const existing = {
      id: "runir_session_deadbeefdeadbeefdeadbeef",
      user_id: "u1",
      project_key: "project:runir",
      project_identity_source: "explicit",
      client_kind: "codex",
      native_session_id: null,
      native_session_key: null,
      native_session_aliases: [],
      workspace_path: "/repo",
      workspace_fingerprint: "ws-123",
      host_id: null,
      device_label: null,
      status: "active",
      opened_at: "2026-04-20T07:55:00.000Z",
      last_seen_at: "2026-04-20T07:59:00.000Z",
      closed_at: null,
      close_reason: null,
      resolver_key: resolverKey,
    };
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[existing]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const session = await resolveRunirSession(db, {
      userId: "u1",
      projectKey: "project:runir",
      projectIdentitySource: "explicit",
      clientKind: "codex",
      workspacePath: "/repo",
      workspaceFingerprint: "ws-123",
      now,
    });

    expect(session.id).toBe("runir_session_deadbeefdeadbeefdeadbeef");
    expect(session.lastSeenAt).toBe(now);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET last_seen_at = <datetime>$lastSeenAt"),
      expect.objectContaining({
        id: "runir_session_deadbeefdeadbeefdeadbeef",
        lastSeenAt: now,
      }),
    );
  });

  it("normalizes Surreal RecordId-shaped ids when heartbeating existing sessions", async () => {
    const existing = {
      id: { tb: "runir_session", id: "runir_session_deadbeefdeadbeefdeadbeef" },
      user_id: "u1",
      project_key: "project:runir",
      project_identity_source: "explicit",
      client_kind: "codex",
      native_session_id: "native-1",
      native_session_key: "codex::native-1",
      native_session_aliases: ["native-1"],
      workspace_path: "/repo",
      workspace_fingerprint: "ws-123",
      host_id: null,
      device_label: null,
      status: "active",
      opened_at: "2026-04-20T07:55:00.000Z",
      last_seen_at: "2026-04-20T07:59:00.000Z",
      closed_at: null,
      close_reason: null,
      resolver_key: "resolver",
    };
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[existing]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const session = await resolveRunirSession(db, {
      userId: "u1",
      projectKey: "project:runir",
      projectIdentitySource: "explicit",
      clientKind: "codex",
      nativeSessionId: "native-2",
      workspaceFingerprint: "ws-123",
      now: "2026-04-20T08:00:00.000Z",
    });

    expect(session.id).toBe("runir_session_deadbeefdeadbeefdeadbeef");
    expect(session.nativeSessionAliases).toEqual(["native-1", "native-2"]);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        id: "runir_session_deadbeefdeadbeefdeadbeef",
        nativeSessionAliases: ["native-1", "native-2"],
      }),
    );
  });

  it("keeps one runir session across native session id churn for the same stable workspace", () => {
    const first = buildRunirSessionResolverKey({
      userId: "u1",
      projectKey: "project:runir",
      clientKind: "codex",
      nativeSessionKey: "codex::native-1",
      workspaceFingerprint: "ws-123",
      hostId: "host-1",
    });
    const second = buildRunirSessionResolverKey({
      userId: "u1",
      projectKey: "project:runir",
      clientKind: "codex",
      nativeSessionKey: "codex::native-2",
      workspaceFingerprint: "ws-123",
      hostId: "host-1",
    });

    expect(second).toBe(first);
  });

  it("stamps closed_at and close_reason when a session is closed", async () => {
    const existing = {
      id: "runir_session_deadbeefdeadbeefdeadbeef",
      user_id: "u1",
      project_key: "project:runir",
      project_identity_source: "explicit",
      client_kind: "claudecode",
      native_session_id: "native-1",
      native_session_key: "claudecode::native-1",
      native_session_aliases: ["native-1"],
      workspace_path: "/repo",
      workspace_fingerprint: "ws-123",
      host_id: null,
      device_label: null,
      status: "active",
      opened_at: "2026-04-20T07:55:00.000Z",
      last_seen_at: "2026-04-20T07:59:00.000Z",
      closed_at: null,
      close_reason: null,
      resolver_key: "resolver",
    };
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[existing]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const now = "2026-04-20T08:05:00.000Z";
    const session = await resolveRunirSession(db, {
      userId: "u1",
      projectKey: "project:runir",
      projectIdentitySource: "explicit",
      clientKind: "claudecode",
      nativeSessionId: "native-1",
      workspaceFingerprint: "ws-123",
      status: "closed",
      closeReason: "resume",
      closedAt: now,
      now,
    });

    expect(session.status).toBe("closed");
    expect(session.closedAt).toBe(now);
    expect(session.closeReason).toBe("resume");
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("closed_at = IF $closedAt != NONE THEN <datetime>$closedAt ELSE NONE END"),
      expect.objectContaining({
        id: "runir_session_deadbeefdeadbeefdeadbeef",
        status: "closed",
        closedAt: now,
        closeReason: "resume",
      }),
    );
  });

  it("clears closed markers when a closed session is resumed as active again", async () => {
    const existing = {
      id: "runir_session_deadbeefdeadbeefdeadbeef",
      user_id: "u1",
      project_key: "project:runir",
      project_identity_source: "explicit",
      client_kind: "claudecode",
      native_session_id: "native-1",
      native_session_key: "claudecode::native-1",
      native_session_aliases: ["native-1"],
      workspace_path: "/repo",
      workspace_fingerprint: "ws-123",
      host_id: null,
      device_label: null,
      status: "closed",
      opened_at: "2026-04-20T07:55:00.000Z",
      last_seen_at: "2026-04-20T07:59:00.000Z",
      closed_at: "2026-04-20T08:00:00.000Z",
      close_reason: "prompt_input_exit",
      resolver_key: "resolver",
    };
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[existing]])
        .mockResolvedValueOnce([[]]),
    } as any;

    const now = "2026-04-20T08:10:00.000Z";
    const session = await resolveRunirSession(db, {
      userId: "u1",
      projectKey: "project:runir",
      projectIdentitySource: "explicit",
      clientKind: "claudecode",
      nativeSessionId: "native-1",
      workspaceFingerprint: "ws-123",
      status: "active",
      now,
    });

    expect(session.status).toBe("active");
    expect(session.closedAt).toBeUndefined();
    expect(session.closeReason).toBeUndefined();
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("close_reason = $closeReason"),
      expect.objectContaining({
        id: "runir_session_deadbeefdeadbeefdeadbeef",
        status: "active",
        closedAt: undefined,
        closeReason: undefined,
      }),
    );
  });
});
