import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  buildThinkChatRequest,
  registerThinkRoute,
  selectThinkEvidence,
  type ThinkRouteDeps,
} from "../app/routes/hooks/think-route.js";
import {
  THINK_MAX_EVIDENCE_ITEMS,
  THINK_RETRIEVAL_TOP_K,
} from "../recall/orchestrator/think-synthesis.js";

function appWith(overrides: Partial<ThinkRouteDeps> = {}) {
  const app = new Hono();
  const deps: ThinkRouteDeps = {
    resolveUserId: (value) => value,
    recall: async () => ({ kind: "retrieved", body: { selected: [], retrievalTraceId: "trace-1" } }),
    resolveApiKey: () => "injected-by-infisical",
    resolveBaseUrl: () => "https://router.example/v1",
    resolveTimeoutMs: () => 5_000,
    resolveModel: () => "openai/gpt-5.6-luna",
    persistSynthesis: async () => undefined,
    ...overrides,
  };
  registerThinkRoute(app, deps);
  return app;
}

function request(app: Hono, body: unknown) {
  return app.request("/memory/think", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Think route contract", () => {
  it("requires an explicit user and a question", async () => {
    expect((await request(appWith(), { question: "x" })).status).toBe(400);
    expect((await request(appWith(), { userId: "owner" })).status).toBe(400);
  });

  it("returns an honest no-answer without resolving credentials or calling the model", async () => {
    const resolveApiKey = vi.fn(() => "unused");
    const fetchFn = vi.fn();
    const response = await request(appWith({ resolveApiKey, fetchFn }), {
      userId: "owner",
      question: "Who is Zephyrine?",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      answer: null,
      citations: [],
      retrievalTraceId: "trace-1",
      evidenceCount: 0,
      evidence: [],
      model: "openai/gpt-5.6-luna",
    });
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("propagates retrieval errors without resolving credentials or calling the model", async () => {
    const resolveApiKey = vi.fn(() => "unused");
    const fetchFn = vi.fn();
    const response = await request(appWith({
      recall: async () => ({
        kind: "error",
        statusCode: 500,
        body: { error: "retrieval failed" },
      }),
      resolveApiKey,
      fetchFn,
    }), {
      userId: "owner",
      question: "What failed?",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "retrieval failed" });
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caps evidence at 12 and sends the production request contract without reasoning", async () => {
    const selected = Array.from({ length: 14 }, (_, index) => ({
      id: `semiote:${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      content: `Evidence ${index}`,
    }));
    const persistSynthesis = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "openai/gpt-5.6-luna",
        max_tokens: 1200,
        temperature: 0.2,
      });
      expect(body).not.toHaveProperty("reasoning");
      expect(body).not.toHaveProperty("reasoning_effort");
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                answer: "Evidence 0",
                claims: [{
                  text: "Evidence 0",
                  citations: [selected[0]!.id],
                }],
                gaps: [],
              }),
            },
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const response = await request(appWith({
      recall: async () => ({
        kind: "retrieved",
        body: { selected, retrievalTraceId: "trace-cap" },
      }),
      fetchFn,
      persistSynthesis,
    }), {
      userId: "owner",
      question: "What is first?",
    });
    const payload = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(payload.evidenceCount).toBe(12);
    expect(payload.evidence).toHaveLength(12);
    expect(payload.retrieval).toMatchObject({
      selectedBeforeCap: 14,
      selectedIds: selected.map((item) => item.id),
      cap: 12,
      synthesisSkipped: false,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(persistSynthesis).toHaveBeenCalledOnce());
  });
});

describe("Think route pure seams", () => {
  it("retrieves a wider pool than the 12-item synthesis cap", () => {
    expect(THINK_RETRIEVAL_TOP_K).toBeGreaterThan(THINK_MAX_EVIDENCE_ITEMS);
  });

  it("normalizes supported selected-hit text fields and drops empty hits", () => {
    expect(selectThinkEvidence([
      { id: "a", content: "A" },
      { id: "b", text: "B" },
      { id: "c", l2: "C" },
      { id: "", content: "drop" },
      { id: "d" },
    ])).toEqual([
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ]);
  });

  it("bounds each evidence item before prompt construction", () => {
    expect(selectThinkEvidence([{ id: "a", content: "x".repeat(5_000) }])[0]!.text)
      .toHaveLength(4_000);
  });

  it("keeps the chat request intentionally free of reasoning parameters", () => {
    expect(buildThinkChatRequest("model", "system", "user")).toEqual({
      model: "model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    });
  });
});
