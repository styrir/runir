/**
 * Rúnir-pn1l Layer 2 — infra factory for the single-pair OLD/NEW supersession judge.
 *
 * This is the ONLY half of the judge that touches the LLM gateway; it lives in the
 * app/infra layer so the storage arbitrator (`src/storage/writes/`) stays
 * framework-independent and depends only on the injected `SupersessionJudgeHandle`
 * interface (Codex brief-gate revision #2). It composes the pure prompt builder and
 * raw verdict parser from `supersession-judge.ts` with `callLlmGateway`.
 *
 * Rúnir-pn1l.13.7 D0/D4/D7: returns a HANDLE with fully-resolved effective config
 * identity, discriminated `JudgeOutcome` (never silent independent on failure), and
 * in-process per-class counters exposed on `/health`.
 */

import { callLlmGateway, LlmGatewayError } from "../shared/llm-gateway-client.js";
import {
  getLedgerWriteFailures,
  noteLedgerWriteFailure as noteModuleLedgerWriteFailure,
  setLedgerFailureLogger,
} from "../storage/surreal/supersession-judge-ledger.js";
import {
  buildJudgePrompt,
  parseJudgeVerdictRaw,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_CONFIDENCE_FLOOR,
  DEFAULT_JUDGE_TEMPERATURE,
  JUDGE_PROMPT_VERSION,
  judgePromptSha256,
  emptyJudgeCounters,
  type SupersessionJudgeHandle,
  type SupersessionJudgeCounters,
  type JudgeOutcome,
} from "../storage/writes/supersession-judge.js";

// Resolve base URL / timeout LOCALLY (not via shared/config.js) so the many
// orchestrator tests that `vi.mock("../shared/config.js")` without re-exporting
// every config symbol keep loading runtime (relevance-gate lesson). Semantics match
// resolveLlmBaseUrl / resolveLlmTimeoutMs exactly.
const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
function resolveJudgeBaseUrl(): string {
  const raw = process.env.RUNIR_LLM_BASE_URL;
  if (!raw) return DEFAULT_LLM_BASE_URL;
  return raw.trim().replace(/\/+$/, "") || DEFAULT_LLM_BASE_URL;
}
function resolveJudgeTimeoutMs(): number {
  const n = Number(process.env.RUNIR_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30_000;
}

export function buildSupersessionJudge(opts: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  confidenceFloor?: number;
  logger?: (msg: string) => void;
}): SupersessionJudgeHandle {
  // Rúnir-pn1l.13.7 D4: resolve the FULL effective request configuration ONCE at
  // construction. Mid-process env mutation is out of contract.
  const model = opts.model ?? process.env.RUNIR_SUPERSEDE_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const confidenceFloor = opts.confidenceFloor ?? DEFAULT_JUDGE_CONFIDENCE_FLOOR;
  const temperature = DEFAULT_JUDGE_TEMPERATURE;
  const effectiveJsonMode = process.env.RUNIR_LLM_JSON_MODE !== "0";
  const baseUrl = resolveJudgeBaseUrl();
  const timeoutMs = opts.timeoutMs ?? resolveJudgeTimeoutMs();
  const promptVersion = JUDGE_PROMPT_VERSION;
  const promptSha256 = judgePromptSha256();
  const counters = emptyJudgeCounters();

  // Optional: replace the ledger module's default console.warn logger with the
  // runtime's logger. The ledger always logs via its own default when no handle
  // is ever constructed (arch-r2 P1#1); injection only redirects the seam.
  if (opts.logger) {
    setLedgerFailureLogger(opts.logger);
  }

  const identity = {
    model,
    promptVersion,
    promptSha256,
    confidenceFloor,
    temperature,
    effectiveJsonMode,
    baseUrl,
    timeoutMs,
  };

  return {
    identity,
    getCounters(): SupersessionJudgeCounters {
      // ledger_write_failures is module-owned (handle-independent) so /health
      // reflects no-handle escalations too (P1#3).
      return { ...counters, ledger_write_failures: getLedgerWriteFailures() };
    },
    noteResolution(result: "confirmed" | "vetoed" | "duplicate"): void {
      counters[result] += 1;
    },
    noteLedgerWriteFailure(detail?: string): void {
      noteModuleLedgerWriteFailure(detail);
    },
    async judge(oldText: string, newText: string): Promise<JudgeOutcome> {
      // Rúnir-pn1l.13.7 D0 factory classification: empty key / self-disabled → unavailable.
      if (!opts.apiKey) {
        counters.unavailable += 1;
        opts.logger?.("supersession-judge: unavailable (empty api key)");
        return { status: "unavailable" };
      }
      try {
        const content = await callLlmGateway({
          model,
          apiKey: opts.apiKey,
          messages: buildJudgePrompt(oldText, newText),
          temperature,
          // Thread the construction-time resolved identity EXACTLY — env-independent
          // at call time (Rúnir-pn1l.13.7 D4 / code-review P0#1). baseUrl +
          // effectiveJsonMode take precedence inside callLlmGateway so a mid-process
          // env change cannot desync provenance from the request that is sent.
          baseUrl,
          effectiveJsonMode,
          timeoutMs,
        });
        const parsed = parseJudgeVerdictRaw(content);
        if (parsed.status === "invalid_response") {
          counters.invalid_response += 1;
          opts.logger?.(
            `supersession-judge: invalid_response (${parsed.detail}): content failed parseJudgeVerdictRaw`,
          );
          return parsed;
        }
        counters.verdict += 1;
        return parsed;
      } catch (err) {
        // Rúnir-pn1l.13.7 D0/r3-#6: explicit kind mapping. Unknown → transport_error
        // (never verdict).
        if (err instanceof LlmGatewayError) {
          if (err.kind === "shape") {
            counters.invalid_response += 1;
            opts.logger?.(`supersession-judge: invalid_response (shape): ${err.message}`);
            return { status: "invalid_response", detail: err.message };
          }
          if (err.kind === "http" || err.kind === "timeout" || err.kind === "network") {
            counters.transport_error += 1;
            opts.logger?.(`supersession-judge: transport_error (${err.kind}): ${err.message}`);
            return { status: "transport_error", detail: err.message };
          }
        }
        counters.transport_error += 1;
        const detail = err instanceof Error ? err.message : String(err);
        opts.logger?.(`supersession-judge: transport_error (unknown): ${detail}`);
        return { status: "transport_error", detail };
      }
    },
  };
}
