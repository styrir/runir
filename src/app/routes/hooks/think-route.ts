import type { Hono } from "hono";
import { jsonrepair } from "jsonrepair";
import {
  buildThinkPrompt,
  buildThinkChatRequest,
  emptyThinkResponse,
  parseThinkResponse,
  resolveThinkModel,
  THINK_MAX_EVIDENCE_ITEMS,
  THINK_MAX_EVIDENCE_TEXT_CHARS,
  THINK_MAX_QUESTION_CHARS,
  type ThinkEvidenceItem,
  type ThinkSynthesis,
} from "../../../recall/orchestrator/think-synthesis.js";
export { buildThinkChatRequest } from "../../../recall/orchestrator/think-synthesis.js";

type RecallResult = {
  kind?: string;
  body?: unknown;
  statusCode?: 400 | 401 | 403 | 404 | 409 | 500 | 503;
};

export type ThinkRouteDeps = {
  resolveUserId: (requestedUserId: string) => string;
  recall: (args: { body: Record<string, unknown>; question: string; userId: string }) => Promise<RecallResult>;
  resolveApiKey: () => string | undefined;
  resolveBaseUrl: () => string;
  resolveTimeoutMs: () => number;
  persistSynthesis: (args: {
    retrievalTraceId: string;
    synthesis: ThinkSynthesis & { question: string; model: string };
  }) => Promise<unknown>;
  fetchFn?: typeof fetch;
  resolveModel?: () => string;
  warn?: (message: string) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function selectThinkEvidence(
  value: unknown,
  limit = THINK_MAX_EVIDENCE_ITEMS,
): ThinkEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((hit) => {
      const row = asRecord(hit);
      return {
        id: String(row.id ?? ""),
        text: String(row.content ?? row.text ?? row.l2 ?? "").slice(0, THINK_MAX_EVIDENCE_TEXT_CHARS),
      };
    })
    .filter((item) => item.id.length > 0 && item.text.length > 0)
    .slice(0, Math.max(0, limit));
}

/** Register only the explicit Think endpoint behind narrow, testable IO seams. */
export function registerThinkRoute(app: Hono, deps: ThinkRouteDeps): void {
  app.post("/memory/think", async (c) => {
    const body = asRecord(await c.req.json().catch(() => ({})));
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return c.json({ error: "explicit userId required" }, 400);
    }
    let userId: string;
    try {
      userId = deps.resolveUserId(body.userId);
    } catch {
      return c.json({ error: "unauthorized" }, 400);
    }
    const question = typeof body.question === "string" && body.question.trim()
      ? body.question.trim().slice(0, THINK_MAX_QUESTION_CHARS)
      : typeof body.prompt === "string"
        ? body.prompt.trim().slice(0, THINK_MAX_QUESTION_CHARS)
        : "";
    if (!question) return c.json({ error: "question required" }, 400);

    const result = await deps.recall({ body, question, userId });
    const recallBody = asRecord(result.body);
    if (result.statusCode) {
      return c.json(recallBody, result.statusCode);
    }
    const selectedRows = Array.isArray(recallBody.selected) ? recallBody.selected : [];
    const selectedBeforeCap = selectedRows.length;
    const selectedIds = selectedRows
      .map((value) => asRecord(value))
      .map((row) => String(row.id ?? ""))
      .filter(Boolean);
    const selectedEvidence = selectThinkEvidence(selectedRows, Number.MAX_SAFE_INTEGER);
    const evidence = selectedEvidence.slice(0, THINK_MAX_EVIDENCE_ITEMS);
    const retrievalTraceId = typeof recallBody.retrievalTraceId === "string"
      ? recallBody.retrievalTraceId
      : undefined;
    const model = deps.resolveModel?.() ?? resolveThinkModel();

    if (result.kind === "skipped" || evidence.length === 0) {
      return c.json({
        ...emptyThinkResponse(question),
        retrievalTraceId,
        evidenceCount: 0,
        evidence: [],
        model,
        retrieval: {
          selectedBeforeCap,
          selectedIds,
          retainedIds: [],
          cap: THINK_MAX_EVIDENCE_ITEMS,
          synthesisSkipped: true,
        },
      });
    }

    const apiKey = deps.resolveApiKey();
    if (!apiKey) return c.json({ error: "think requires the gateway API key" }, 500);
    const { system, user } = buildThinkPrompt(question, evidence);
    let synthesis: ThinkSynthesis;
    let usage: Record<string, number> = {};
    try {
      const response = await (deps.fetchFn ?? fetch)(`${deps.resolveBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildThinkChatRequest(model, system, user)),
        signal: AbortSignal.timeout(deps.resolveTimeoutMs()),
      });
      if (!response.ok) throw new Error(`gateway ${response.status}`);
      const data = asRecord(await response.json());
      const rawUsage = asRecord(data.usage);
      usage = {
        ...(typeof rawUsage.prompt_tokens === "number" ? { promptTokens: rawUsage.prompt_tokens } : {}),
        ...(typeof rawUsage.completion_tokens === "number" ? { completionTokens: rawUsage.completion_tokens } : {}),
        ...(typeof rawUsage.total_tokens === "number" ? { totalTokens: rawUsage.total_tokens } : {}),
      };
      const choices = Array.isArray(data.choices) ? data.choices : [];
      const first = asRecord(choices[0]);
      const message = asRecord(first.message);
      synthesis = parseThinkResponse(String(message.content ?? ""), evidence, jsonrepair);
    } catch (error) {
      synthesis = {
        answer: null,
        claims: [],
        citations: [],
        droppedCitations: [],
        gaps: [
          `synthesis call failed: ${String(error).slice(0, 120)} — raw evidence is in the citations-capable /memory/search surface`,
        ],
        schemaValid: false,
        parseClassification: "unparseable",
      };
    }

    if (retrievalTraceId) {
      void deps.persistSynthesis({
        retrievalTraceId,
        synthesis: { question, ...synthesis, model },
      }).catch((error: unknown) =>
        deps.warn?.(`memory-hybrid: think synthesis persist failed: ${String(error).slice(0, 120)}`));
    }

    return c.json({
      ...synthesis,
      retrievalTraceId,
      evidenceCount: evidence.length,
      evidence: evidence.map((item) => ({ id: item.id, preview: item.text.slice(0, 140) })),
      model,
      usage,
      retrieval: {
        selectedBeforeCap,
        selectedIds,
        retainedIds: evidence.map((item) => item.id),
        cap: THINK_MAX_EVIDENCE_ITEMS,
        synthesisSkipped: false,
      },
    });
  });
}
