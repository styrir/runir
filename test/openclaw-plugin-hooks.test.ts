import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchRecall = vi.fn();

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}), { virtual: true });

vi.mock("../src/recall/recall-client.js", () => ({
  fetchRecall,
}), { virtual: true });

type HookHandler = (event: any, ctx: any) => unknown | Promise<unknown>;

type MockApi = {
  pluginConfig: Record<string, unknown>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
};

function createApi(pluginConfig: Record<string, unknown>): { api: MockApi; handlers: Record<string, HookHandler> } {
  const handlers: Record<string, HookHandler> = {};
  const api: MockApi = {
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn((hook: string, handler: HookHandler) => {
      handlers[hook] = handler;
    }),
  };
  return { api, handlers };
}

describe("openclaw plugin RC1 hook contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts agent_end messages to /hooks/capture as a thin pass-through payload", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ skipped: false, factsFound: 2, outcomes: { create: 2 } }),
    } as Response);

    const { default: plugin } = await import("../openclaw-plugin/index.ts");
    const { api, handlers } = createApi({
      serviceUrl: "http://runir.test/",
      userId: "brooks",
      autoCapture: true,
    });

    plugin.register(api as never);

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];

    await handlers.agent_end?.(
      { success: true, messages },
      { sessionId: "sess-openclaw", workspaceDir: "/tmp/workspace" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://runir.test/hooks/capture");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      messages,
      sessionId: "sess-openclaw",
      userId: "brooks",
      client: "openclaw",
      workspace: "/tmp/workspace",
    });
  });

  it("posts before_reset messages to /hooks/session-end and skips empty payloads", async () => {
    const fetchMock = vi.mocked(fetch);
    // Extraction-free session-end response shape (Rúnir-sq3s).
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ skipped: false, rawTurnsRecorded: 2, extraction: "disabled" }),
    } as Response);

    const { default: plugin } = await import("../openclaw-plugin/index.ts");
    const { api, handlers } = createApi({
      serviceUrl: "http://runir.test",
      username: "owner",
    });

    plugin.register(api as never);

    const messages = [
      { role: "user", content: "wrap up" },
      { role: "assistant", content: "done" },
    ];

    await handlers.before_reset?.(
      { messages, sessionId: "event-session" },
      { sessionId: "ctx-session", workspaceDir: "/tmp/workspace" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://runir.test/hooks/session-end");
    expect(JSON.parse(String(init?.body))).toEqual({
      messages,
      sessionId: "ctx-session",
      userId: "owner",
      client: "openclaw",
      workspace: "/tmp/workspace",
    });

    fetchMock.mockClear();

    await handlers.before_reset?.(
      { messages: [], sessionId: "ignored-session" },
      { sessionId: "ctx-session", workspaceDir: "/tmp/workspace" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
