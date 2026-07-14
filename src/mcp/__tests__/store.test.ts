import { describe, expect, it } from "vitest";
import {
  buildStoreBody,
  formatStoreOutcome,
  httpBodySnippet,
  parseStoreResponse,
  resolveStoreConfig,
  storeMemory,
  type FetchLike,
} from "../store.js";

describe("runir mcp store", () => {
  it("formats all four outcomes with id", () => {
    expect(formatStoreOutcome("create", "a")).toBe("Remembered (new): a");
    expect(formatStoreOutcome("skip", "b")).toBe(
      "Already remembered — no new record: b",
    );
    expect(formatStoreOutcome("merge-update", "c")).toBe(
      "Updated existing memory: c",
    );
    expect(formatStoreOutcome("supersede", "d")).toBe(
      "Superseded prior version: d",
    );
  });

  it("requires success===true and non-empty id including skip", () => {
    expect(() =>
      parseStoreResponse({ success: false, id: "x", outcome: "create" }),
    ).toThrow(/success was not true/);
    expect(() =>
      parseStoreResponse({ id: "x", outcome: "create" }),
    ).toThrow(/success was not true/);
    expect(() =>
      parseStoreResponse({ success: true, outcome: "skip" }),
    ).toThrow(/missing id for outcome skip/);
    expect(
      parseStoreResponse({ success: true, id: "s1", outcome: "skip" }).text,
    ).toBe("Already remembered — no new record: s1");
  });

  it("buildStoreBody is user-scope only with raw text", () => {
    const body = buildStoreBody("  keep spaces  ", {
      baseUrl: "http://127.0.0.1:7700",
      apiKey: "k",
      userId: "u",
      client: "claude",
      timeoutMs: 1000,
    });
    expect(body).toEqual({
      text: "  keep spaces  ",
      userId: "u",
      client: "claude",
      scope: "user",
    });
    expect(Object.keys(body).sort()).toEqual([
      "client",
      "scope",
      "text",
      "userId",
    ]);
  });

  it("rejects empty text before HTTP body build", () => {
    expect(() =>
      buildStoreBody("   ", {
        baseUrl: "http://x",
        apiKey: "k",
        userId: "u",
        client: "c",
        timeoutMs: 1,
      }),
    ).toThrow(/non-empty string/);
  });

  it("resolveStoreConfig refuses missing tenant/key", () => {
    expect(() => resolveStoreConfig({})).toThrow(/RUNIR_USER_ID is required/);
    expect(() =>
      resolveStoreConfig({ RUNIR_USER_ID: "u" }),
    ).toThrow(/RUNIR_API_KEY is required/);
    const cfg = resolveStoreConfig({
      RUNIR_USER_ID: "u",
      RUNIR_API_KEY: "k",
      RUNIR_BASE: "http://example:9/",
      RUNIR_CLIENT: "codex",
    });
    expect(cfg.baseUrl).toBe("http://example:9");
    expect(cfg.client).toBe("codex");
  });

  it("httpBodySnippet caps length", () => {
    const s = httpBodySnippet("E".repeat(500), 200);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBe(201);
  });

  it("storeMemory posts exact body and formats create", async () => {
    let seen: { url: string; init: { body: string; headers: Record<string, string> } } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          success: true,
          id: "mem-1",
          outcome: "create",
        }),
      };
    };
    const result = await storeMemory(
      "I like dark mode",
      {
        baseUrl: "http://127.0.0.1:7700",
        apiKey: "secret",
        userId: "owner",
        client: "claude",
        timeoutMs: 5000,
      },
      fetchImpl,
    );
    expect(result.text).toBe("Remembered (new): mem-1");
    expect(seen!.url).toBe("http://127.0.0.1:7700/memory/store");
    expect(seen!.init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(seen!.init.body)).toEqual({
      text: "I like dark mode",
      userId: "owner",
      client: "claude",
      scope: "user",
    });
  });

  it("storeMemory surfaces non-2xx with snippet", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 502,
      text: async () => "E".repeat(400),
      json: async () => ({}),
    });
    await expect(
      storeMemory(
        "x",
        {
          baseUrl: "http://127.0.0.1:7700",
          apiKey: "k",
          userId: "u",
          client: "c",
          timeoutMs: 1000,
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 502.*…/);
  });
});
