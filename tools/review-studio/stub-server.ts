import { serve } from "@hono/node-server";
import { Hono } from "hono";

/** Test-only value. Never use this as a production credential. */
export const TEST_ONLY_STUB_API_KEY = "review-studio-test-key";
export const TEST_ONLY_STUB_USER_ID = "review-studio-smoke";

type StubTrace = {
  id: string;
  userId: string;
  prompt: string;
  intentLabel: string;
  laneLabel: string;
  retrievalPath: string;
  requestedPath: string;
  sessionId: string;
  hexisId: string;
  hexisLabel: string;
  accessTrackedIds: string[];
  retrievalAudit: {
    lane: string;
    baseCandidateCount: number;
    finalSelectedIds: string[];
    noema: { candidateCount: number };
    admissibility: { admittedIds: string[] };
  };
  prependContext: string;
  answer?: string;
  feedbackReceivedAt?: string;
  captureReceipt?: { retrievalTraceId: string; sessionId: string; memoryIds: string[]; prompt: string; answer: string; client: string; path: string; receivedAt: string };
  rating?: string;
  ratingNote?: string;
  ratedAt?: string;
  items: Array<{ id: string; score: number; memoryRole: string; path: string; hexisFit: number; rankingExplanation: string[] }>;
  createdAt: string;
};

type StubLineageEntry = {
  id: string;
  active: boolean;
  createdAt: string;
  inactiveReason?: string;
  supersededById?: string;
  supersedesId?: string;
};

function seedTraces(userId: string): StubTrace[] {
  return [
    {
      id: "trace-smoke-1",
      userId,
      prompt: "Which review surface did we agree to build for Runir evaluation?",
      intentLabel: "decision_trace",
      laneLabel: "guidance_reference",
      retrievalPath: "hybrid",
      requestedPath: "/Users/brooks/Code/runir",
      sessionId: "session-smoke-1",
      hexisId: "hexis-review",
      hexisLabel: "review posture",
      accessTrackedIds: ["memory-smoke-1"],
      retrievalAudit: {
        lane: "guidance_reference",
        baseCandidateCount: 8,
        noema: { candidateCount: 3 },
        admissibility: { admittedIds: ["memory-smoke-1", "memory-smoke-2"] },
        finalSelectedIds: ["memory-smoke-1"],
      },
      prependContext: "[memory:memory-smoke-1]\nBuild a local Review Studio with bounded evidence and opt-in traces.",
      answer: "We agreed on an owner-local Review Studio with a file-only default and an explicit trace proxy.",
      feedbackReceivedAt: "2026-08-06T08:02:00.000Z",
      captureReceipt: {
        retrievalTraceId: "trace-smoke-1",
        sessionId: "session-smoke-1",
        memoryIds: ["memory-smoke-1"],
        prompt: "Which review surface did we agree to build for Runir evaluation?",
        answer: "We agreed on an owner-local Review Studio with a file-only default and an explicit trace proxy.",
        client: "review-studio-stub",
        path: "/Users/brooks/Code/runir",
        receivedAt: "2026-08-06T08:02:00.000Z",
      },
      rating: "helped",
      ratedAt: "2026-08-06T08:03:00.000Z",
      items: [
        {
          id: "memory-smoke-1",
          score: 0.931,
          memoryRole: "decision",
          path: "/Users/brooks/Code/runir",
          hexisFit: 0.88,
          rankingExplanation: ["path match", "decision lane fit", "highest fused score"],
        },
      ],
      createdAt: "2026-08-06T08:01:00.000Z",
    },
    {
      id: "trace-smoke-2",
      userId,
      prompt: "Where is the Review Studio plan recorded?",
      intentLabel: "exact_lookup",
      laneLabel: "guidance_reference",
      retrievalPath: "deterministic",
      requestedPath: "/Users/brooks/Code/runir/docs",
      sessionId: "session-smoke-1",
      hexisId: "hexis-review",
      hexisLabel: "review posture",
      accessTrackedIds: ["memory-smoke-2"],
      retrievalAudit: {
        lane: "guidance_reference",
        baseCandidateCount: 4,
        finalSelectedIds: ["memory-smoke-2"],
        noema: { candidateCount: 2 },
        admissibility: { admittedIds: ["memory-smoke-2"] },
      },
      prependContext: "[memory:memory-smoke-2]\nThe approved plan lives under docs/plans.",
      items: [
        {
          id: "memory-smoke-2",
          score: 0.812,
          memoryRole: "reference",
          path: "/Users/brooks/Code/runir/docs",
          hexisFit: 0.72,
          rankingExplanation: ["exact path match"],
        },
      ],
      createdAt: "2026-08-06T07:58:00.000Z",
    },
  ];
}

function seedLineage(): Map<string, StubLineageEntry[]> {
  return new Map([
    [
      "memory-smoke-1",
      [
        { id: "memory-smoke-1-old", active: false, createdAt: "2026-08-05T10:00:00.000Z", inactiveReason: "superseded", supersededById: "memory-smoke-1" },
        { id: "memory-smoke-1", active: true, createdAt: "2026-08-06T07:55:00.000Z", supersedesId: "memory-smoke-1-old" },
      ],
    ],
    ["memory-smoke-2", [{ id: "memory-smoke-2", active: true, createdAt: "2026-08-05T11:00:00.000Z" }]],
  ]);
}

function authorized(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header("Authorization") === `Bearer ${TEST_ONLY_STUB_API_KEY}`;
}

function explicitUserId(value: string | undefined, expected: string): boolean {
  return value === expected;
}

export type ReviewStudioStub = {
  readonly app: Hono;
  readonly traces: StubTrace[];
  readonly lineage: Map<string, StubLineageEntry[]>;
};

export function createReviewStudioStub(userId = TEST_ONLY_STUB_USER_ID): ReviewStudioStub {
  const traces = seedTraces(userId);
  const lineage = seedLineage();
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!authorized(c)) return c.json({ error: "stub unauthorized" }, 401);
    await next();
  });

  app.get("/hooks/traces", (c) => {
    if (!explicitUserId(c.req.query("userId"), userId)) return c.json({ error: "stub user scope required" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 20) || 20, 1), 200);
    const summaries = traces.slice(0, limit).map((trace) => {
      const { prependContext: _context, answer: _answer, captureReceipt: _capture, ...summary } = trace;
      return summary;
    });
    return c.json({ traces: summaries });
  });

  app.get("/hooks/traces/:id", (c) => {
    if (!explicitUserId(c.req.query("userId"), userId)) return c.json({ error: "stub user scope required" }, 400);
    const trace = traces.find((item) => item.id === c.req.param("id"));
    return trace ? c.json({ trace }) : c.json({ error: "retrieval trace not found" }, 404);
  });

  app.post("/hooks/traces/:id/rate", async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    if (body.userId !== userId) return c.json({ error: "stub user scope required" }, 400);
    const trace = traces.find((item) => item.id === c.req.param("id"));
    if (!trace) return c.json({ error: "retrieval trace not found" }, 404);
    trace.rating = typeof body.rating === "string" ? body.rating : undefined;
    trace.ratingNote = typeof body.note === "string" ? body.note : undefined;
    trace.ratedAt = "2026-08-06T08:05:00.000Z";
    return c.json({ success: true, id: trace.id, rating: trace.rating, rated: true });
  });

  app.get("/memory/lineage/:id", (c) => {
    if (!explicitUserId(c.req.query("userId"), userId)) return c.json({ error: "stub user scope required" }, 400);
    const entries = lineage.get(c.req.param("id"));
    return entries ? c.json({ memoryId: c.req.param("id"), chainLength: entries.length, lineage: entries }) : c.json({ error: "Memory not found" }, 404);
  });

  return { app, traces, lineage };
}

function parsePort(argv: readonly string[]): number {
  const index = argv.indexOf("--port");
  if (index < 0) return 7720;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("--port requires an integer from 1 to 65535");
  return value;
}

if (process.argv[1]?.endsWith("review-studio/stub-server.ts")) {
  try {
    const port = parsePort(process.argv.slice(2));
    const stub = createReviewStudioStub();
    serve({ fetch: stub.app.fetch, hostname: "127.0.0.1", port });
    process.stdout.write(`Review Studio test-only Rúnir stub listening at http://127.0.0.1:${port}\n`);
  } catch (error) {
    process.stderr.write(`Review Studio stub failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
