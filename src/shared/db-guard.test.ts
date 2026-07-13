import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProdDbGuardError,
  assertEnvNotProdDbForEval,
  assertNotProdDbForEval,
  assertNotProdServiceUrl,
  isProdDbTuple,
  isProdServiceUrl,
  isRealTenant,
  prodWriteAllowed,
  realTenants,
  requireRealTenants,
} from "./db-guard.js";

describe("db-guard", () => {
  const ENV_KEYS = ["RUNIR_ALLOW_PROD_DB", "SURREAL_NS", "SURREAL_DB", "RUNIR_REAL_TENANTS"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("isProdDbTuple", () => {
    it("is true only for main/main", () => {
      expect(isProdDbTuple("main", "main")).toBe(true);
      expect(isProdDbTuple("main", "eval")).toBe(false);
      expect(isProdDbTuple("staging", "main")).toBe(false);
      expect(isProdDbTuple(undefined, undefined)).toBe(false);
    });
  });

  describe("isProdServiceUrl", () => {
    it("matches the local :7700 app on every local-host form", () => {
      expect(isProdServiceUrl("http://127.0.0.1:7700")).toBe(true);
      expect(isProdServiceUrl("http://localhost:7700")).toBe(true);
      expect(isProdServiceUrl("http://localhost:7700/hooks/capture")).toBe(true);
      expect(isProdServiceUrl("http://[::1]:7700")).toBe(true);
    });
    it("matches local bind-address aliases that hit the same :7700 listener", () => {
      expect(isProdServiceUrl("http://0.0.0.0:7700")).toBe(true);
      expect(isProdServiceUrl("http://[::]:7700")).toBe(true);
      expect(isProdServiceUrl("http://[::ffff:127.0.0.1]:7700")).toBe(true);
    });
    it("does not match other ports, remote hosts, or userinfo tricks", () => {
      expect(isProdServiceUrl("http://127.0.0.1:7811")).toBe(false); // reserved dev port
      expect(isProdServiceUrl("http://localhost:8000")).toBe(false); // surreal
      expect(isProdServiceUrl("http://10.0.0.5:7700")).toBe(false); // remote host
      expect(isProdServiceUrl("http://127.0.0.1:7700@evil.com")).toBe(false); // userinfo, real host is evil.com
      expect(isProdServiceUrl("not-a-url")).toBe(false);
    });
  });

  describe("assertNotProdDbForEval", () => {
    it("throws on main/main without the escape", () => {
      expect(() => assertNotProdDbForEval({ namespace: "main", database: "main" })).toThrow(ProdDbGuardError);
    });
    it("passes on an isolated eval target", () => {
      expect(() => assertNotProdDbForEval({ namespace: "main", database: "eval" })).not.toThrow();
    });
    it("passes on main/main WITH the explicit escape", () => {
      process.env.RUNIR_ALLOW_PROD_DB = "1";
      expect(prodWriteAllowed()).toBe(true);
      expect(() => assertNotProdDbForEval({ namespace: "main", database: "main" })).not.toThrow();
    });
  });

  describe("assertNotProdServiceUrl", () => {
    it("throws when pointed at the prod :7700 app", () => {
      expect(() => assertNotProdServiceUrl("http://127.0.0.1:7700")).toThrow(ProdDbGuardError);
    });
    it("passes for an isolated eval service URL", () => {
      expect(() => assertNotProdServiceUrl("http://127.0.0.1:7811")).not.toThrow();
    });
    it("passes for the prod URL WITH the explicit escape", () => {
      process.env.RUNIR_ALLOW_PROD_DB = "1";
      expect(() => assertNotProdServiceUrl("http://127.0.0.1:7700")).not.toThrow();
    });
  });

  describe("assertEnvNotProdDbForEval", () => {
    it("defaults unset env to main/main and therefore throws", () => {
      expect(() => assertEnvNotProdDbForEval()).toThrow(ProdDbGuardError);
    });
    it("passes when SURREAL_DB is an isolated eval target", () => {
      process.env.SURREAL_DB = "eval";
      expect(() => assertEnvNotProdDbForEval()).not.toThrow();
    });
  });

  describe("real-tenant allowlist", () => {
    it("is empty when unset and parses a comma list when set", () => {
      expect(realTenants().size).toBe(0);
      process.env.RUNIR_REAL_TENANTS = "brooks, alice ,";
      expect([...realTenants()].sort()).toEqual(["alice", "brooks"]);
      expect(isRealTenant("brooks")).toBe(true);
      expect(isRealTenant("g004-locomo-x")).toBe(false);
    });
    it("requireRealTenants fails closed when unset", () => {
      expect(() => requireRealTenants()).toThrow(ProdDbGuardError);
      process.env.RUNIR_REAL_TENANTS = "brooks";
      expect([...requireRealTenants()]).toEqual(["brooks"]);
    });
  });
});
