import type { HexisHint } from "../hexis/runtime-hexis.js";
import { parseRecallResponse, type RecallResponse } from "./recall-contract.js";

export type RecallRequest = {
  prompt: string;
  sessionId?: string;
  userId?: string;
  path?: string;
  topK?: number;
  client?: string;
  preferredClient?: string;
  nowMs?: number;
  hexis?: HexisHint;
  disableHexis?: boolean;
  hexisDebug?: boolean;
  /**
   * OM-1 (Rúnir-tfxt.1): optional token ceiling for the rendered memory
   * payload (chars/4 heuristic, wrapper included). Absent/invalid → the
   * service's unchanged no-budget behavior.
   */
  budgetTokens?: number;
};

export type ModelMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
};

export async function fetchRecall(
  serviceUrl: string,
  body: RecallRequest,
  options?: { fetchImpl?: typeof fetch; apiKey?: string },
): Promise<RecallResponse> {
  const endpoint = `${serviceUrl.replace(/\/$/, "")}/hooks/recall`;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const apiKey = options?.apiKey ?? process.env.RUNIR_API_KEY;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error(`runir recall response from ${endpoint} was not valid JSON`, { cause });
  }

  let parsed: RecallResponse;
  try {
    parsed = parseRecallResponse(payload);
  } catch (cause) {
    throw new Error(`runir recall response from ${endpoint} did not match the recall response contract`, { cause });
  }

  if (!response.ok && !("error" in parsed)) {
    throw new Error(`runir recall response from ${endpoint} returned HTTP ${response.status} without the structured error variant`);
  }

  return parsed;
}

export function injectRecallContext(
  messages: ModelMessage[],
  recall: RecallResponse,
  options?: { role?: "system" | "developer" },
): ModelMessage[] {
  if ("warning" in recall || "error" in recall || !recall.prependContext) {
    return messages;
  }
  return [
    { role: options?.role ?? "developer", content: recall.prependContext },
    ...messages,
  ];
}
