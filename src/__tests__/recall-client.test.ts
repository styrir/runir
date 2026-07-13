import { describe, expect, it, vi } from "vitest";
import { fetchRecall } from "../recall/recall-client.js";

describe("fetchRecall", () => {
  it("posts to /hooks/recall and parses success payloads", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:7700/hooks/recall");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ prompt: "continue", path: "/Users/brooks/Code/runir" }));
      return new Response(JSON.stringify({
        prependContext: "ctx",
        count: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await fetchRecall("http://localhost:7700", {
      prompt: "continue",
      path: "/Users/brooks/Code/runir",
    }, { fetchImpl });

    expect(result).toEqual({ prependContext: "ctx", count: 1 });
  });

  it("adds Authorization header when RUNIR_API_KEY is configured", async () => {
    const original = process.env.RUNIR_API_KEY;
    process.env.RUNIR_API_KEY = "test-key";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      });
      return new Response(JSON.stringify({
        prependContext: "ctx",
        count: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    try {
      await fetchRecall("http://localhost:7700", { prompt: "continue" }, { fetchImpl });
    } finally {
      if (original === undefined) delete process.env.RUNIR_API_KEY;
      else process.env.RUNIR_API_KEY = original;
    }
  });

  it("returns the structured error variant on non-2xx responses when the payload matches the contract", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      prependContext: null,
      count: 0,
      error: "query failed",
    }), { status: 500, headers: { "Content-Type": "application/json" } }));

    await expect(fetchRecall("http://localhost:7700", { prompt: "continue" }, { fetchImpl })).resolves.toEqual({
      prependContext: null,
      count: 0,
      error: "query failed",
    });
  });

  it("throws when the response body is not a valid recall contract", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(fetchRecall("http://localhost:7700", { prompt: "continue" }, { fetchImpl })).rejects.toThrow(/recall response/i);
  });
});


describe("injectRecallContext", () => {
  it("prepends recall prependContext verbatim as a developer message", async () => {
    const { injectRecallContext } = await import("../recall/recall-client.js");
    const result = injectRecallContext(
      [{ role: "user", content: "Let\'s continue." }],
      { prependContext: "<relevant-memories>ctx</relevant-memories>", count: 1 },
    );

    expect(result).toEqual([
      { role: "developer", content: "<relevant-memories>ctx</relevant-memories>" },
      { role: "user", content: "Let\'s continue." },
    ]);
  });

  it("leaves messages unchanged when recall returns warning, error, or null prependContext", async () => {
    const { injectRecallContext } = await import("../recall/recall-client.js");
    const base = [{ role: "user", content: "hello" }] as const;

    expect(injectRecallContext([...base], { prependContext: null, count: 0 })).toEqual(base);
    expect(injectRecallContext([...base], { prependContext: null, count: 0, warning: "skip" })).toEqual(base);
    expect(injectRecallContext([...base], { prependContext: null, count: 0, error: "boom" })).toEqual(base);
  });
});
