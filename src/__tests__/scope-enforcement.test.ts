/**
 * MIM-52: Scope predicate invariants.
 * Tests deny-all, cross-scope contamination, and scope mapping behavior.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveScopeFilter, resolveWriteScope } from "../recall/query/scope-predicate.js";

const mockLogger = { warn: vi.fn() };

// ---------------------------------------------------------------------------
// resolveScopeFilter — basic scope mapping
// ---------------------------------------------------------------------------
describe("resolveScopeFilter — basic scope mapping", () => {
  it("scope='user': includes legacy (scope=NONE) records", () => {
    const sf = resolveScopeFilter("user", undefined);
    expect(sf.whereClause).toContain("scope = NONE");
    expect(sf.vars.scopeVal).toBe("user");
  });

  it("scope='user': matches both NONE and 'user' scope records", () => {
    const sf = resolveScopeFilter("user", "sess-1");
    expect(sf.whereClause).toContain("scope = NONE OR scope = $scopeVal");
  });

  it("scope='session' with sessionId: returns session-specific filter", () => {
    const sf = resolveScopeFilter("session", "sess-abc");
    expect(sf.whereClause).toContain("session_id");
    expect(sf.vars.sessionId).toBe("sess-abc");
    expect(sf.vars.scopeVal).toBe("session");
  });

  it("scope='all': returns empty whereClause (no filtering)", () => {
    const sf = resolveScopeFilter("all", "sess-1");
    expect(sf.whereClause).toBe("");
  });

  it("undefined scope with sessionId: default — user + legacy + session", () => {
    const sf = resolveScopeFilter(undefined, "sess-1");
    expect(sf.whereClause).toContain("scope = NONE");
    expect(sf.whereClause).toContain("session_id");
  });

  it("undefined scope without sessionId: default — user + legacy only", () => {
    const sf = resolveScopeFilter(undefined, undefined);
    expect(sf.whereClause).toContain("scope = NONE");
    expect(sf.whereClause).not.toContain("session_id");
  });
});

// ---------------------------------------------------------------------------
// resolveScopeFilter — empty/whitespace string behavior
// ---------------------------------------------------------------------------
describe("resolveScopeFilter — empty and whitespace strings", () => {
  it("empty string '' is treated same as undefined (default retrieval)", () => {
    const empty = resolveScopeFilter("", "sess-1");
    const undef = resolveScopeFilter(undefined, "sess-1");
    expect(empty.whereClause).toBe(undef.whereClause);
  });

  it("whitespace-only string is treated same as undefined", () => {
    const ws = resolveScopeFilter("   ", "sess-1");
    const undef = resolveScopeFilter(undefined, "sess-1");
    expect(ws.whereClause).toBe(undef.whereClause);
  });

  it("empty string is NOT a deny (whereClause is not empty for default retrieval)", () => {
    const sf = resolveScopeFilter("", "sess-1");
    // The default branch (with sessionId) produces a non-empty whereClause
    expect(sf.whereClause).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveScopeFilter — deny invariants
// ---------------------------------------------------------------------------
describe("resolveScopeFilter — deny-all invariant", () => {
  it("scope='session' without sessionId: whereClause contains 'false'", () => {
    const sf = resolveScopeFilter("session", undefined);
    expect(sf.whereClause).toContain("false");
  });

  it("deny-all is NOT empty string (which would be allow-all)", () => {
    const deny = resolveScopeFilter("session", undefined);
    const allowAll = resolveScopeFilter("all", "sess-1");
    expect(deny.whereClause).not.toBe(allowAll.whereClause);
    expect(deny.whereClause).not.toBe("");
  });

  it("unknown scope string resolves to the same filter as omitted scope, not allow-all", () => {
    const unknown = resolveScopeFilter("xyzzy123", "sess-1");
    const omitted = resolveScopeFilter(undefined, "sess-1");
    const allowAll = resolveScopeFilter("all", "sess-1");

    expect(unknown).toEqual(omitted);
    expect(unknown.whereClause).not.toBe(allowAll.whereClause);
  });
});

// ---------------------------------------------------------------------------
// Cross-scope contamination prevention
// ---------------------------------------------------------------------------
describe("cross-scope contamination", () => {
  it("session-scope filter does NOT allow scope=NONE (user legacy) records", () => {
    const sf = resolveScopeFilter("session", "sess-abc");
    expect(sf.whereClause).not.toContain("scope = NONE");
  });

  it("session-scope filter does NOT allow scope='user' records", () => {
    const sf = resolveScopeFilter("session", "sess-abc");
    // Must not contain any widening to user scope
    expect(sf.whereClause).not.toMatch(/scope = .user/);
  });

  it("user-scope filter does NOT allow session-scoped records", () => {
    const sf = resolveScopeFilter("user", "sess-abc");
    // No session_id or session scope matching
    expect(sf.whereClause).not.toContain("session_id");
    expect(sf.whereClause).not.toMatch(/scope = .session/);
  });

  it("user-scope filter with sessionId still excludes session records", () => {
    // Even if sessionId is available, scope='user' should not retrieve session memories
    const sf = resolveScopeFilter("user", "sess-xyz");
    expect(sf.whereClause).not.toContain("session_id");
  });
});

// ---------------------------------------------------------------------------
// resolveWriteScope — scope mapping for writes
// ---------------------------------------------------------------------------
describe("resolveWriteScope — write-path scope resolution", () => {
  it("explicit 'session' with sessionId: returns { scope: 'session', sessionId }", () => {
    const result = resolveWriteScope("session", undefined, "sess-1", mockLogger);
    expect(result.scope).toBe("session");
    expect(result.sessionId).toBe("sess-1");
  });

  it("explicit 'user': returns { scope: 'user', sessionId: undefined }", () => {
    const result = resolveWriteScope("user", undefined, "sess-1", mockLogger);
    expect(result.scope).toBe("user");
    expect(result.sessionId).toBeUndefined();
  });

  it("explicit 'global': returns { scope: 'global' }", () => {
    const result = resolveWriteScope("global", undefined, undefined, mockLogger);
    expect(result.scope).toBe("global");
  });

  it("undefined scope: defaults to 'user'", () => {
    const result = resolveWriteScope(undefined, undefined, undefined, mockLogger);
    expect(result.scope).toBe("user");
  });

  it("empty string scope: defaults to 'user' (same as undefined)", () => {
    const result = resolveWriteScope("", undefined, undefined, mockLogger);
    expect(result.scope).toBe("user");
  });

  it("unknown scope string: maps to 'user' (catchall)", () => {
    const result = resolveWriteScope("custom-whatever", undefined, undefined, mockLogger);
    expect(result.scope).toBe("user");
  });

  it("longTerm=true (deprecated): maps to 'user'", () => {
    const result = resolveWriteScope(undefined, true, undefined, mockLogger);
    expect(result.scope).toBe("user");
  });

  it("longTerm=false (deprecated): maps to 'session'", () => {
    const result = resolveWriteScope(undefined, false, "sess-2", mockLogger);
    expect(result.scope).toBe("session");
  });
});
