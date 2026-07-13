import { describe, it, expect, afterEach } from "vitest";
import { resolveUserId } from "../app/resolve-user-id.js";

describe("resolveUserId", () => {
  afterEach(() => {
    delete process.env.RUNIR_SINGLE_TENANT;
  });

  it("returns bodyUserId when no single-tenant mode", () => {
    delete process.env.RUNIR_SINGLE_TENANT;
    expect(resolveUserId("alice", { userId: "default" })).toBe("alice");
  });

  it("falls back to cfg.userId when bodyUserId undefined", () => {
    delete process.env.RUNIR_SINGLE_TENANT;
    expect(resolveUserId(undefined, { userId: "fallback" })).toBe("fallback");
  });

  it("returns singleTenantId when set and no body userId", () => {
    process.env.RUNIR_SINGLE_TENANT = "owner";
    expect(resolveUserId(undefined, { userId: "default" })).toBe("owner");
  });

  it("returns singleTenantId when body matches", () => {
    process.env.RUNIR_SINGLE_TENANT = "owner";
    expect(resolveUserId("owner", { userId: "default" })).toBe("owner");
  });

  it("throws when body userId mismatches single-tenant", () => {
    process.env.RUNIR_SINGLE_TENANT = "owner";
    expect(() => resolveUserId("attacker", { userId: "default" })).toThrow("userId mismatch");
  });
});
