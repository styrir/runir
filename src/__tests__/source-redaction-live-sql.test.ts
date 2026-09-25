import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensureRejectionLogTable, logRejection } from "../storage/surreal/rejection-log-store.js";
import {
  createRetrievalTrace,
  ensurePhase2Schema,
  patchRetrievalTraceAnswer,
  patchRetrievalTraceCaptureReceipt,
  promoteSemioteToNoema,
} from "../storage/surreal/phase2-store.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const namespace = `runir277test${suffix}`;
const database = `slice1${suffix}`;
if (namespace === "main" || database === "main") throw new Error("unsafe live SQL target");
let db: SurrealClient;
let available = false;
let connected = false;

beforeAll(async () => {
  const url = process.env.RUNIR_TEST_SLOW_LANE === "1"
    ? process.env.RUNIR_TEST_SURREAL_URL ?? "http://127.0.0.1:18000"
    : process.env.SURREAL_URL ?? "http://127.0.0.1:8000";
  if (process.env.RUNIR_TEST_SLOW_LANE === "1") {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
      .catch(() => undefined);
    if (!response?.ok) throw new Error("slow lane SurrealDB unreachable");
  }
  db = new SurrealClient({
    url,
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace,
    database,
  });
  try {
    await db.query("INFO FOR DB;");
    connected = true;
  } catch {
    if (process.env.RUNIR_TEST_SLOW_LANE === "1") throw new Error("slow lane SurrealDB unreachable");
    available = false;
    return;
  }
  await ensureRejectionLogTable(db);
  await ensurePhase2Schema(db);
  available = true;
});

afterAll(async () => {
  if (connected) await db.query(`REMOVE NAMESPACE ${namespace};`);
  await db?.close().catch(() => undefined);
});

describe("Slice 1 changed SurrealQL statements", () => {
  it("round trips redacted rejection, trace, feedback, receipt, and noema writes", async (ctx) => {
    if (!available) return ctx.skip();
    const canary = "Bearer AAAAAAAAAAAAAAAAAAAAAAAA";
    await logRejection(db, { userId: "synthetic", reason: "low-confidence", candidateText: `safe ${canary}` });
    const traceId = await createRetrievalTrace(db, {
      userId: "synthetic", sessionId: "session", prompt: `prompt ${canary}`,
      intentLabel: "fact", laneLabel: "fact", retrievalPath: "hybrid", accessTrackedIds: [],
      prependContext: `context ${canary}`, items: [{ id: "semiote:synthetic", score: 0.8 }],
    });
    const question = `question ${canary}`;
    const answer = `synthesis ${canary}`;
    const claim = `claim ${canary}`;
    await db.query(
      `UPDATE type::record('retrieval_trace', $traceId) SET synthesis = $synthesis;`,
      { traceId, synthesis: { traceId, model: "synthetic-model", questionLength: question.length,
        answerLength: answer.length, redactionVersion: 1 } },
    );
    await patchRetrievalTraceAnswer(db, traceId, "synthetic", { answer: `answer ${canary}`, correctedIds: [] });
    await patchRetrievalTraceCaptureReceipt(db, traceId, "synthetic", {
      sessionId: "session", memoryIds: ["semiote:synthetic"], prompt: `prompt ${canary}`, answer: `answer ${canary}`,
    });
    const promoted = await promoteSemioteToNoema(db, {
      id: "semiote:synthetic", user_id: "synthetic", scope: "user", memory_role: "current_status",
      usefulness_score: 0.9, successful_use_count: 4, cross_session_use_count: 2,
      payload: { l2: `The service stores safe facts ${canary}`, l0: `Safe facts ${canary}`, confidence: 0.9, factKey: "cases:safe-facts" },
    }, async () => new Array(768).fill(0.1));
    expect(promoted.promoted).toBe(true);
    const rows = await db.query("SELECT * FROM rejection_log; SELECT * FROM retrieval_trace; SELECT * FROM noema;");
    expect(rows[0]?.length).toBe(1);
    expect(rows[1]?.length).toBe(1);
    expect(rows[2]?.length).toBe(1);
    expect(JSON.stringify(rows).includes(canary)).toBe(false);
    for (const text of [question, answer, claim]) expect(JSON.stringify(rows)).not.toContain(text);
    const trace = rows[1]?.[0] as Record<string, unknown>;
    expect(trace.prompt).toBe("");
    expect(trace.answer).toBe("");
    expect(trace.prepend_context == null).toBe(true);
    expect(trace.synthesis).toEqual({ traceId, model: "synthetic-model",
      questionLength: question.length, answerLength: answer.length, redactionVersion: 1 });
    const receipt = trace.capture_receipt as Record<string, unknown>;
    expect(receipt).not.toHaveProperty("prompt");
    expect(receipt).not.toHaveProperty("answer");
  });
});
