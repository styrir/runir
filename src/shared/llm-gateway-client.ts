/**
 * Shared LLM-gateway client (Rúnir-imaf.8).
 *
 * Every non-extraction LLM lane used to hand-roll its own bare `fetch` against
 * the gateway — no AbortController, no timeout, drifting json-mode handling,
 * and inconsistent error shapes (synthesis-generator, memory-enricher,
 * entity-alias-enricher). This client owns those concerns once:
 *
 *   - AbortController timeout, default resolveLlmTimeoutMs(); the race timer
 *     is ALWAYS cleared (the withTimeout phantom-warn lesson).
 *   - `jsonMode` sends response_format json_object. Verified live 2026-06-11
 *     against requesty for BOTH production models (vertex/gemini-3.1-flash-lite@us
 *     and openai/gpt-5.4-mini). RUNIR_LLM_JSON_MODE=0 force-disables globally.
 *   - Non-ok / non-JSON / wrong-shape responses throw LlmGatewayError with a
 *     `kind` callers can branch on for retry policy.
 *
 * The gateway base URL comes from resolveLlmBaseUrl() (requesty since
 * 2026-06-11; the historical "OpenRouter" naming survives only in legacy env
 * var names). The extraction lane (capture.ts) has its own hardened path and
 * is deliberately NOT migrated here.
 */
import { resolveLlmBaseUrl, resolveLlmTimeoutMs } from "./config.js";

export interface LlmGatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmGatewayOptions {
  model: string;
  messages: LlmGatewayMessage[];
  apiKey: string;
  /** Defaults to resolveLlmTimeoutMs() (RUNIR_LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * Request response_format json_object. When ONLY this is set (no
   * `effectiveJsonMode`), RUNIR_LLM_JSON_MODE=0 still force-disables globally —
   * preserved for legacy callers that rely on the kill switch.
   */
  jsonMode?: boolean;
  /**
   * Fully-resolved JSON-mode decision. When provided, used EXACTLY — no env
   * re-check. Takes precedence over `jsonMode`. Callers that capture effective
   * config at construction (e.g. supersession-judge handle identity) MUST pass
   * this so the request cannot diverge from recorded provenance (Rúnir-pn1l.13.7 D4).
   */
  effectiveJsonMode?: boolean;
  /**
   * Gateway base URL (no trailing slash). Defaults to resolveLlmBaseUrl().
   * When provided, used EXACTLY — env-independent. Same D4 binding as
   * effectiveJsonMode.
   */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export type LlmGatewayErrorKind = "http" | "timeout" | "network" | "shape";

export class LlmGatewayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly kind: LlmGatewayErrorKind = "http",
  ) {
    super(message);
    this.name = "LlmGatewayError";
  }
}

/** True for the error classes a caller may sensibly retry (transient). */
export function isRetryableLlmGatewayError(err: unknown): boolean {
  if (!(err instanceof LlmGatewayError)) return false;
  if (err.kind === "network" || err.kind === "timeout") return true;
  return err.status === 429 || (err.status !== undefined && err.status >= 500 && err.status < 600);
}

/** Strips a single ```json fence wrapper if the model added one. */
export function stripJsonFences(content: string): string {
  return content.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
}

/**
 * One chat-completions call. Returns choices[0].message.content as a string;
 * throws LlmGatewayError for everything else. Never hangs: the abort timer
 * bounds the whole request.
 */
export async function callLlmGateway(opts: LlmGatewayOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? resolveLlmTimeoutMs();
  // Prefer caller-bound baseUrl (D4 identity); else resolve from env at call time.
  const baseUrl = opts.baseUrl ?? resolveLlmBaseUrl();
  // Prefer caller-bound effectiveJsonMode (no env re-check). Legacy jsonMode still
  // honors RUNIR_LLM_JSON_MODE=0 so existing callers keep the global kill switch.
  const useJsonMode =
    opts.effectiveJsonMode !== undefined
      ? opts.effectiveJsonMode
      : Boolean(opts.jsonMode) && process.env.RUNIR_LLM_JSON_MODE !== "0";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmGatewayError(
          `LLM gateway call timed out after ${timeoutMs}ms (model=${opts.model})`,
          undefined,
          "timeout",
        );
      }
      throw new LlmGatewayError(
        `LLM gateway network error (model=${opts.model}): ${String(err)}`,
        undefined,
        "network",
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmGatewayError(
        `LLM gateway error ${response.status} (model=${opts.model}): ${text.slice(0, 200)}`,
        response.status,
        "http",
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new LlmGatewayError(
        `LLM gateway returned a non-JSON body (model=${opts.model}): ${String(err)}`,
        response.status,
        "shape",
      );
    }

    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
      ?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LlmGatewayError(
        `LLM gateway response missing choices[0].message.content (model=${opts.model})`,
        response.status,
        "shape",
      );
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
