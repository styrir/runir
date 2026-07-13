import { describe, it, expect } from "vitest";
import { resolveScopeFilter, resolveWriteScope } from "../recall/query/scope-predicate.js";

describe("resolveScopeFilter — scope hardening", () => {
  it("trims whitespace: ' all ' resolves same as 'all'", () => {
    const trimmed = resolveScopeFilter(" all ", "sess1");
    const clean = resolveScopeFilter("all", "sess1");
    expect(trimmed.whereClause).toBe(clean.whereClause);
  });

  it("trims whitespace: ' session ' resolves same as 'session'", () => {
    const trimmed = resolveScopeFilter(" session ", "sess1");
    const clean = resolveScopeFilter("session", "sess1");
    expect(trimmed.whereClause).toBe(clean.whereClause);
    expect(trimmed.vars).toEqual(clean.vars);
  });

  it("empty string resolves same as undefined (default retrieval)", () => {
    const empty = resolveScopeFilter("", "sess1");
    const undef = resolveScopeFilter(undefined, "sess1");
    expect(empty.whereClause).toBe(undef.whereClause);
  });

  it("whitespace-only string resolves same as undefined", () => {
    const whitespace = resolveScopeFilter("   ", "sess1");
    const undef = resolveScopeFilter(undefined, "sess1");
    expect(whitespace.whereClause).toBe(undef.whereClause);
  });

  it("undefined produces default retrieval (not empty)", () => {
    const result = resolveScopeFilter(undefined, "sess1");
    expect(result.whereClause).not.toBe("");
  });

  it("'all' produces empty whereClause (no scope filter)", () => {
    const result = resolveScopeFilter("all", "sess1");
    expect(result.whereClause).toBe("");
  });
});

describe("resolveWriteScope — scope hardening", () => {
  const mockLogger = { warn: () => {} };

  it("trims whitespace: ' session ' resolves to session", () => {
    const result = resolveWriteScope(" session ", undefined, "sess1", mockLogger);
    expect(result.scope).toBe("session");
  });

  it("trims whitespace: ' user ' resolves to user", () => {
    const result = resolveWriteScope(" user ", undefined, undefined, mockLogger);
    expect(result.scope).toBe("user");
  });

  it("empty string resolves same as undefined (default user scope)", () => {
    const empty = resolveWriteScope("", undefined, undefined, mockLogger);
    const undef = resolveWriteScope(undefined, undefined, undefined, mockLogger);
    expect(empty.scope).toBe(undef.scope);
  });

  it("whitespace-only resolves same as undefined", () => {
    const ws = resolveWriteScope("   ", undefined, undefined, mockLogger);
    const undef = resolveWriteScope(undefined, undefined, undefined, mockLogger);
    expect(ws.scope).toBe(undef.scope);
  });
});
