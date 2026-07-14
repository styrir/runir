/**
 * Explicit-remember store client for the shared MCP adapter (Rúnir-sh1 Slice 2).
 * Thin HTTP only — no extraction, tags, metadata, or arbitration.
 * User-scope only (MCP has no reliable session id).
 */

import { readFileSync } from "node:fs";

export const STORE_OUTCOMES = [
  "create",
  "skip",
  "merge-update",
  "supersede",
] as const;

export type StoreOutcome = (typeof STORE_OUTCOMES)[number];

export type StoreConfig = {
  baseUrl: string;
  apiKey: string;
  userId: string;
  client: string;
  timeoutMs: number;
};

export type StoreResult = {
  id: string;
  outcome: StoreOutcome;
  text: string;
};

const OUTCOME_SET = new Set<string>(STORE_OUTCOMES);

/** Bound error-body surface ("snippet", not full dump). */
export function httpBodySnippet(body: string, max = 200): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function formatStoreOutcome(outcome: StoreOutcome, id: string): string {
  switch (outcome) {
    case "create":
      return `Remembered (new): ${id}`;
    case "skip":
      return `Already remembered — no new record: ${id}`;
    case "merge-update":
      return `Updated existing memory: ${id}`;
    case "supersede":
      return `Superseded prior version: ${id}`;
  }
}

export function parseStoreResponse(data: unknown): StoreResult {
  if (!data || typeof data !== "object") {
    throw new Error("runir_store: malformed response body");
  }
  const record = data as Record<string, unknown>;
  if (record.success !== true) {
    throw new Error(
      `runir_store: success was not true (${JSON.stringify(record.success)})`,
    );
  }
  const outcome = record.outcome;
  const id = record.id;
  if (typeof outcome !== "string" || !OUTCOME_SET.has(outcome)) {
    throw new Error(
      `runir_store: unrecognized outcome ${JSON.stringify(outcome)}`,
    );
  }
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`runir_store: missing id for outcome ${outcome}`);
  }
  const trimmedId = id.trim();
  const typed = outcome as StoreOutcome;
  return {
    id: trimmedId,
    outcome: typed,
    text: formatStoreOutcome(typed, trimmedId),
  };
}

/**
 * Resolve config from process env. Explicit-write path: no tenant/key defaults.
 * RUNIR_ENV_FILE is only honored when explicitly set (no baked default path).
 */
export function resolveStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): StoreConfig {
  const userId = env.RUNIR_USER_ID?.trim();
  if (!userId) {
    throw new Error(
      "runir_store: RUNIR_USER_ID is required (no default tenant on the explicit-write path)",
    );
  }

  let apiKey = env.RUNIR_API_KEY?.trim();
  const envFile = env.RUNIR_ENV_FILE?.trim();
  if (!apiKey && envFile) {
    apiKey = readDotEnvValue(envFile, "RUNIR_API_KEY");
  }
  if (!apiKey) {
    throw new Error(
      envFile
        ? "runir_store: RUNIR_API_KEY missing; checked process env and RUNIR_ENV_FILE"
        : "runir_store: RUNIR_API_KEY is required",
    );
  }

  const baseUrl = (env.RUNIR_BASE ?? "http://127.0.0.1:7700").replace(/\/$/, "");
  const client = env.RUNIR_CLIENT?.trim() || "runir-mcp";
  const timeoutRaw = Number(env.RUNIR_STORE_TIMEOUT_MS ?? 15_000);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 15_000;

  return { baseUrl, apiKey, userId, client, timeoutMs };
}

function readDotEnvValue(filePath: string, key: string): string | undefined {
  try {
    const prefix = `${key}=`;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(prefix)) {
        continue;
      }
      const raw = trimmed.slice(prefix.length).trim();
      const unquoted = raw.match(/^(["'])(.*)\1$/)?.[2] ?? raw;
      return unquoted.trim() || undefined;
    }
  } catch {
    // Missing file is a normal miss when RUNIR_ENV_FILE is set incorrectly.
  }
  return undefined;
}

/** Build the exact HTTP body for user-scope MCP store (no session/tags/metadata). */
export function buildStoreBody(
  text: string,
  cfg: StoreConfig,
): Record<string, string> {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("runir_store: 'text' must be a non-empty string");
  }
  return {
    text, // raw text (emptiness checked via trim)
    userId: cfg.userId,
    client: cfg.client,
    scope: "user",
  };
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export async function storeMemory(
  text: string,
  cfg: StoreConfig,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  signal?: AbortSignal,
): Promise<StoreResult> {
  const body = buildStoreBody(text, cfg);
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const response = await fetchImpl(`${cfg.baseUrl}/memory/store`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "runir-mcp/1.0",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: combined,
  });
  if (!response.ok) {
    const snippet = httpBodySnippet(await response.text());
    throw new Error(`HTTP ${response.status} from /memory/store: ${snippet}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("runir_store: malformed JSON in HTTP 2xx from /memory/store");
  }
  return parseStoreResponse(data);
}
