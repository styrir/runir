import { describe, expect, it, vi } from "vitest";

import { createReviewStudioApp } from "../app.js";
import {
  TEST_ONLY_STUB_API_KEY,
  TEST_ONLY_STUB_USER_ID,
  createReviewStudioStub,
} from "../stub-server.js";
import { DEFAULT_RUNIR_BASE_URL, parseArgs } from "../server.js";
import { buildCandidateFunnel } from "../trace-view.js";
import type { ReviewStudioFetch } from "../trace-proxy.js";

const ROOT = `${process.cwd()}/tools/review-studio/fixtures`;
const PORT = 7792;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const USER_ID = "backend-owned-user";
const API_KEY = TEST_ONLY_STUB_API_KEY;

function tokenFromBootstrap(document: string, name: string): string {
  const value = document.match(new RegExp(`<meta name="${name}" content="([^"]+)">`, "u"))?.[1];
  if (!value) throw new Error(`bootstrap ${name} missing`);
  return value;
}

function requestHeaders(token: string, csrf?: string): HeadersInit {
  return {
    Host: `${"127.0.0.1"}:${PORT}`,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Runir-Launch-Token": token,
    ...(csrf === undefined ? {} : { "X-Runir-CSRF-Token": csrf }),
  };
}

async function setup(fetcher?: ReviewStudioFetch) {
  const studio = createReviewStudioApp({
    artifactRoots: [ROOT],
    port: PORT,
    traceBackend: {
      runirBaseUrl: "http://127.0.0.1:7720/",
      runirApiKey: API_KEY,
      runirUserId: USER_ID,
      fetch: fetcher,
    },
  });
  const bootstrap = await studio.app.request(`${ORIGIN}/`, { headers: { Host: `${"127.0.0.1"}:${PORT}` } });
  const document = await bootstrap.text();
  return {
    studio,
    token: tokenFromBootstrap(document, "runir-launch-token"),
    csrf: tokenFromBootstrap(document, "runir-csrf-token"),
  };
}

function stubFetch() {
  const stub = createReviewStudioStub(USER_ID);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: ReviewStudioFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return stub.app.fetch(new Request(url, init));
  };
  return { stub, calls, fetcher };
}

describe("Review Studio sensitive receipt and lineage proxy", () => {
  it("keeps list lightweight, clamps latest-N to 200, and fetches full detail only on selection", async () => {
    const { calls, fetcher } = stubFetch();
    const { studio, token } = await setup(fetcher);

    const list = await studio.app.request(`${ORIGIN}/api/traces?limit=9999`, { headers: requestHeaders(token) });
    expect(list.status).toBe(200);
    const listPayload = await list.json() as { traces: Array<Record<string, unknown>>; coverage: { label: string; maxHistoricalWindow: number } };
    expect(listPayload.coverage).toMatchObject({ label: "latest 200 of at most 200", maxHistoricalWindow: 200 });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("200");
    expect(new URL(calls[0]!.url).searchParams.get("userId")).toBe(USER_ID);
    expect(listPayload.traces[0]).not.toHaveProperty("prependContext");
    expect(listPayload.traces[0]).not.toHaveProperty("answer");
    expect(listPayload.traces[0]).not.toHaveProperty("captureReceipt");

    const detail = await studio.app.request(`${ORIGIN}/api/traces/trace-smoke-1`, { headers: requestHeaders(token) });
    expect(detail.status).toBe(200);
    const detailPayload = await detail.json() as { trace: Record<string, unknown>; review: { candidateFunnel: { available: boolean } } };
    expect(detailPayload.trace).toHaveProperty("prependContext");
    expect(detailPayload.trace).toHaveProperty("answer");
    expect(detailPayload.review.candidateFunnel.available).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("/hooks/traces/trace-smoke-1");
  });

  it("uses only the rating route as a write and owns userId in the backend body", async () => {
    const { calls, fetcher } = stubFetch();
    const { studio, token, csrf } = await setup(fetcher);

    const response = await studio.app.request(`${ORIGIN}/api/traces/trace-smoke-1/rate`, {
      method: "POST",
      headers: { ...requestHeaders(token, csrf), "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "browser-attacker", rating: "helped", note: "owner review" }),
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new URL(calls[0]!.url).searchParams.has("userId")).toBe(false);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ userId: USER_ID, rating: "helped" });
    expect(JSON.parse(String(calls[0]!.init?.body)).userId).not.toBe("browser-attacker");
    expect(new Set(calls.map((call) => call.init?.method || "GET"))).toEqual(new Set(["POST"]));

    const invalid = await studio.app.request(`${ORIGIN}/api/traces/trace-smoke-1/rate`, {
      method: "POST",
      headers: { ...requestHeaders(token, csrf), "Content-Type": "application/json" },
      body: JSON.stringify({ rating: "promote" }),
    });
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("keeps lineage user-scoped, rejects browser upstream selection, and validates IDs", async () => {
    const { calls, fetcher } = stubFetch();
    const { studio, token } = await setup(fetcher);

    const lineage = await studio.app.request(`${ORIGIN}/api/lineage/memory-smoke-1`, { headers: requestHeaders(token) });
    expect(lineage.status).toBe(200);
    expect((await lineage.json()).lineage).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("userId")).toBe(USER_ID);

    const browserUrl = await studio.app.request(`${ORIGIN}/api/traces?url=http%3A%2F%2Fevil.test`, { headers: requestHeaders(token) });
    expect(browserUrl.status).toBe(400);
    expect((await browserUrl.json()).error).toBe("browser_upstream_url");
    expect(calls).toHaveLength(1);

    const badTrace = await studio.app.request(`${ORIGIN}/api/traces/trace%2Fescape`, { headers: requestHeaders(token) });
    const badMemory = await studio.app.request(`${ORIGIN}/api/lineage/%2E%2E%2Fsecret`, { headers: requestHeaders(token) });
    expect(badTrace.status).toBe(400);
    expect(badMemory.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("distinguishes upstream unavailable from a known trace expired by retention", async () => {
    const expiredFetch: ReviewStudioFetch = vi.fn(async (input) => {
      if (String(input).includes("/hooks/traces/trace-known")) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      throw new Error("connection refused");
    });
    const expired = await setup(expiredFetch);
    const detail = await expired.studio.app.request(`${ORIGIN}/api/traces/trace-known`, { headers: requestHeaders(expired.token) });
    expect(detail.status).toBe(410);
    expect(await detail.json()).toMatchObject({ error: "trace_expired", state: "trace_expired_by_retention" });

    const list = await expired.studio.app.request(`${ORIGIN}/api/traces`, { headers: requestHeaders(expired.token) });
    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ error: "upstream_unavailable", state: "upstream_unavailable" });

    const emptyStub = createReviewStudioStub(USER_ID);
    emptyStub.traces.splice(0);
    const emptyFetch: ReviewStudioFetch = async (input, init) => emptyStub.app.fetch(new Request(String(input), init));
    const empty = await setup(emptyFetch);
    const emptyResponse = await empty.studio.app.request(`${ORIGIN}/api/traces`, { headers: requestHeaders(empty.token) });
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toMatchObject({ coverage: { emptyState: "never_selected_or_empty" } });
  });

  it("redacts bearer and per-launch proofs from API responses, URLs, and exported UI code", async () => {
    const { calls, fetcher } = stubFetch();
    const { studio, token, csrf } = await setup(fetcher);
    const responses = [
      await studio.app.request(`${ORIGIN}/api/traces`, { headers: requestHeaders(token) }),
      await studio.app.request(`${ORIGIN}/api/traces/trace-smoke-1`, { headers: requestHeaders(token) }),
      await studio.app.request(`${ORIGIN}/api/lineage/memory-smoke-1`, { headers: requestHeaders(token) }),
      await studio.app.request(`${ORIGIN}/api/traces/trace-smoke-1/rate`, {
        method: "POST",
        headers: { ...requestHeaders(token, csrf), "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "unused" }),
      }),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(token);
      expect(text).not.toContain(csrf);
    }
    expect(calls.every((call) => !call.url.includes(API_KEY) && !call.url.includes("Bearer"))).toBe(true);
    const asset = await studio.app.request(`${ORIGIN}/assets/review-studio.js`, { headers: requestHeaders(token) });
    const source = await asset.text();
    expect(source).not.toContain("RUNIR_API_KEY");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("Authorization");
  });
});

describe("persisted candidate-count funnel", () => {
  it("uses retrievalAudit counts and never stage timings or debug attribution", () => {
    const funnel = buildCandidateFunnel({
      retrievalAudit: {
        baseCandidateCount: 9,
        noema: { candidateCount: 4 },
        admissibility: { admittedIds: ["a", "b"] },
        finalSelectedIds: ["a"],
        attribution: { stages: [{ name: "secret-stage", durationMs: 1_234 }] },
      },
    });
    expect(funnel).toMatchObject({ available: true });
    if (funnel.available) {
      expect(funnel.stages.map((stage) => stage.count)).toEqual([9, 4, 2, 1]);
      expect(JSON.stringify(funnel)).not.toContain("duration");
      expect(JSON.stringify(funnel)).not.toContain("secret-stage");
    }
  });

  it("labels insufficient persisted evidence unavailable", () => {
    expect(buildCandidateFunnel({ retrievalAudit: { baseCandidateCount: 1 } })).toMatchObject({ available: false });
    expect(buildCandidateFunnel({ retrievalAudit: { attribution: { stages: [{ outputCount: 1 }] } } })).toMatchObject({ available: false });
  });
});

describe("test-only loopback stub", () => {
  it("uses deterministic in-memory data and the explicit test bearer only", async () => {
    const stub = createReviewStudioStub();
    const response = await stub.app.fetch(new Request("http://127.0.0.1:7720/hooks/traces?userId=review-studio-smoke&limit=20", {
      headers: { Authorization: `Bearer ${TEST_ONLY_STUB_API_KEY}` },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).traces).toHaveLength(2);
    expect(TEST_ONLY_STUB_USER_ID).toBe("review-studio-smoke");
  });
});

describe("explicit trace configuration", () => {
  it("keeps the default launch file-only and refuses missing trace credentials", () => {
    expect(parseArgs(["--root", ROOT], {})).toMatchObject({ trace: false, runirBaseUrl: DEFAULT_RUNIR_BASE_URL });
    expect(() => parseArgs(["--root", ROOT, "--trace"], {})).toThrow(/RUNIR_USER_ID/u);
    expect(() => parseArgs(["--root", ROOT, "--trace"], { RUNIR_USER_ID: USER_ID })).toThrow(/RUNIR_API_KEY/u);
    expect(parseArgs(["--root", ROOT, "--trace", "--runir-base-url", "http://127.0.0.1:7720/"], {
      RUNIR_USER_ID: USER_ID,
      RUNIR_API_KEY: API_KEY,
    })).toMatchObject({ trace: true, runirUserId: USER_ID, runirApiKey: API_KEY, runirBaseUrl: "http://127.0.0.1:7720/" });
  });
});
