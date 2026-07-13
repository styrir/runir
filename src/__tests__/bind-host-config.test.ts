import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveBindHost } from "../shared/bind-host.js";
import { isAuthFailOpen } from "../app/auth.js";

describe("resolveBindHost", () => {
  it("defaults to loopback when RUNIR_HOST is unset", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
  });

  it("returns the RUNIR_HOST override verbatim", () => {
    expect(resolveBindHost({ RUNIR_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveBindHost({ RUNIR_HOST: "192.168.1.10" })).toBe("192.168.1.10");
  });

  it("treats empty/whitespace RUNIR_HOST as unset", () => {
    expect(resolveBindHost({ RUNIR_HOST: "" })).toBe("127.0.0.1");
    expect(resolveBindHost({ RUNIR_HOST: "   " })).toBe("127.0.0.1");
  });

  it("trims surrounding whitespace from the override", () => {
    expect(resolveBindHost({ RUNIR_HOST: " 0.0.0.0 " })).toBe("0.0.0.0");
  });
});

// The startup WARN itself lives in bootstrap(), which cannot run without a full
// service boot (DB, embeddings, schedulers) — so we assert the exact predicate
// bootstrap consults instead. It must mirror the auth middleware's fail-open
// branch (src/app/auth.ts).
describe("isAuthFailOpen (keyless startup WARN predicate)", () => {
  const ORIGINAL_ENV = {
    NODE_ENV: process.env.NODE_ENV,
    RUNIR_API_KEY: process.env.RUNIR_API_KEY,
    RUNIR_REQUIRE_API_KEY: process.env.RUNIR_REQUIRE_API_KEY,
  };

  beforeEach(() => {
    delete process.env.RUNIR_API_KEY;
    delete process.env.RUNIR_REQUIRE_API_KEY;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is fail-open when keyless outside production without RUNIR_REQUIRE_API_KEY", () => {
    expect(isAuthFailOpen()).toBe(true);
  });

  it("is not fail-open when RUNIR_API_KEY is configured", () => {
    process.env.RUNIR_API_KEY = "secret";
    expect(isAuthFailOpen()).toBe(false);
  });

  it("is not fail-open in production (middleware fails closed instead)", () => {
    process.env.NODE_ENV = "production";
    expect(isAuthFailOpen()).toBe(false);
  });

  it("is not fail-open when RUNIR_REQUIRE_API_KEY=1 (fails closed instead)", () => {
    process.env.RUNIR_REQUIRE_API_KEY = "1";
    expect(isAuthFailOpen()).toBe(false);
  });
});
