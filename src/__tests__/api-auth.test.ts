import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApiAuthMiddleware } from "../app/auth.js";

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  RUNIR_API_KEY: process.env.RUNIR_API_KEY,
  RUNIR_REQUIRE_API_KEY: process.env.RUNIR_REQUIRE_API_KEY,
};

function makeApp() {
  const app = new Hono();
  app.use("*", createApiAuthMiddleware());
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ready", (c) => c.json({ ok: true }));
  app.post("/memory/search", (c) => c.json({ ok: true }));
  return app;
}

describe("api auth middleware", () => {
  beforeEach(() => {
    delete process.env.RUNIR_API_KEY;
    delete process.env.RUNIR_REQUIRE_API_KEY;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
    if (ORIGINAL_ENV.RUNIR_API_KEY === undefined) delete process.env.RUNIR_API_KEY;
    else process.env.RUNIR_API_KEY = ORIGINAL_ENV.RUNIR_API_KEY;
    if (ORIGINAL_ENV.RUNIR_REQUIRE_API_KEY === undefined) delete process.env.RUNIR_REQUIRE_API_KEY;
    else process.env.RUNIR_REQUIRE_API_KEY = ORIGINAL_ENV.RUNIR_REQUIRE_API_KEY;
  });

  it("keeps /health and /ready public", async () => {
    process.env.NODE_ENV = "production";
    const app = makeApp();

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/ready")).status).toBe(200);
  });

  it("allows local/test requests when no API key is configured", async () => {
    const app = makeApp();
    const response = await app.request("/memory/search", { method: "POST" });

    expect(response.status).toBe(200);
  });

  it("fails closed in production when the API key is missing", async () => {
    process.env.NODE_ENV = "production";
    const app = makeApp();
    const response = await app.request("/memory/search", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it("rejects protected routes without a matching bearer token", async () => {
    process.env.RUNIR_API_KEY = "top-secret";
    const app = makeApp();

    expect((await app.request("/memory/search", { method: "POST" })).status).toBe(401);
    expect((
      await app.request("/memory/search", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      })
    ).status).toBe(401);
  });

  it("accepts protected routes with a matching bearer token", async () => {
    process.env.RUNIR_API_KEY = "top-secret";
    const app = makeApp();

    const response = await app.request("/memory/search", {
      method: "POST",
      headers: { Authorization: "Bearer top-secret" },
    });

    expect(response.status).toBe(200);
  });
});
