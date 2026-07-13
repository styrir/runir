import type { HybridConfig, RerankerConfig } from "../domain/memory/types";
import { DEFAULT_LLM_RERANKER_MODEL } from "../domain/memory/types";
import type { EmbeddingProvider } from "../storage/embeddings/providers/embedding-provider";
import { LlamaCppProvider } from "../storage/embeddings/providers/llamacpp-provider";
import { OllamaProvider } from "../storage/embeddings/providers/ollama-provider";
import { NomicAPIProvider } from "../storage/embeddings/providers/nomic-provider";

export const CANONICAL_NOMIC_EMBED_MODEL = "nomic-embed-text:v1.5";
export const LEGACY_NOMIC_EMBED_MODEL = "nomic-embed-text-v1.5";

const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Resolves the base URL for LLM API calls. Returns the value of
 * RUNIR_LLM_BASE_URL (trimmed, trailing slash stripped) when set, or the
 * production default "https://openrouter.ai/api/v1" when unset.
 *
 * Name is provider-generic by design — the env var works for any OpenAI-
 * compatible endpoint (local proxy, alternative provider, etc.).
 */
export function resolveLlmBaseUrl(): string {
  const raw = process.env.RUNIR_LLM_BASE_URL;
  if (!raw) return DEFAULT_LLM_BASE_URL;
  return raw.trim().replace(/\/+$/, "") || DEFAULT_LLM_BASE_URL;
}

/**
 * Default timeout for LLM chat-completion calls (extraction, segmentation,
 * entity extraction). Env-tunable (RUNIR_LLM_TIMEOUT_MS) because local/proxied
 * models behind RUNIR_LLM_BASE_URL can be slower than hosted APIs — an
 * extraction-scale prompt on the local grok CLI measures ~27-29s, right at the
 * old fixed 30s ceiling. Callers' explicit opts.timeoutMs still wins.
 */
export function resolveLlmTimeoutMs(): number {
  return posIntEnv("RUNIR_LLM_TIMEOUT_MS", 30_000);
}

/** Positive-integer env read with a safe fallback — a non-numeric override must
 * never become NaN, since slice(0, NaN) returns [] and would silently rerank/fetch
 * nothing. */
function posIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Reranker candidate bounds — SINGLE SOURCE OF TRUTH (config owns these, not
 * ranker.ts via ad-hoc process.env). `RERANK_MAX_CANDIDATES` bounds how many
 * candidates the reranker SCORES. The reranked-path retrieval-pool FLOOR — how
 * many candidates `runHybridQuery` FETCHES before reranking — is the SEPARATE
 * `RERANK_CANDIDATE_FLOOR` (below). They intentionally may differ: the floor
 * defaults to 0 (no widening, prod latency unchanged) while max-candidates=50
 * holds the scoring ceiling at the top-50 reader window.
 */
export const RERANK_MAX_CANDIDATES = posIntEnv("RERANKER_MAX_CANDIDATES", 50);
export const RERANK_MAX_CHARS = posIntEnv("RERANKER_MAX_CHARS", 1200);

/**
 * Reranked-path retrieval-pool FLOOR — prod-safe optional lever (Rúnir-aa98).
 *
 * When the local reranker is active, `candidateLimit` is clamped to
 * `max(topK*3, RERANK_CANDIDATE_FLOOR)` so the reranker can rescue gold from
 * deeper ranks. DEFAULT 0 = off (no widening; prod latency unchanged).
 *
 * Latency trade-off (Rúnir-aa98, measured): widening from 15→50 candidates on a
 * 1 703-unit tenant adds ~0.5–1.3 s/query (the local bi-encoder embeds ~35 more
 * candidates). Set `RERANKER_CANDIDATE_FLOOR` (e.g. 50) to enable widening; the
 * whether-to-default-on decision stays with Rúnir-aa98.
 *
 * `posIntEnv` floors at 1, so 0 is read directly here to mean "off".
 */
export const RERANK_CANDIDATE_FLOOR = Math.max(0, Number(process.env.RERANKER_CANDIDATE_FLOOR ?? "0")) || 0;

export function normalizeEmbeddingModelName(model: string | undefined): string {
  if (!model) return CANONICAL_NOMIC_EMBED_MODEL;
  return model === LEGACY_NOMIC_EMBED_MODEL ? CANONICAL_NOMIC_EMBED_MODEL : model;
}

/** Parses plugin config into runtime defaults used by memory-hybrid. */
export function parseConfig(value: unknown): HybridConfig {
  const raw = (value ?? {}) as Record<string, any>;
  return {
    userId: raw.userId ?? "default",
    autoRecall: raw.autoRecall ?? true,
    autoCapture: raw.autoCapture ?? true,
    topK: raw.topK ?? 5,
    customPrompt: raw.customPrompt,
    surrealdb: {
      url: raw.surrealdb?.url ?? "http://localhost:8000",
      username: raw.surrealdb?.username ?? "root",
      password: raw.surrealdb?.password ?? "",
      namespace: raw.surrealdb?.namespace ?? "main",
      database: raw.surrealdb?.database ?? "main",
    },
    embedder: {
      provider: (raw.embedder?.provider ?? "ollama") as "ollama" | "nomic",
      model: normalizeEmbeddingModelName(raw.embedder?.model),
      baseURL: raw.embedder?.baseURL ?? "http://localhost:11434",
      apiKey: raw.embedder?.apiKey,
      dimensions: raw.embedder?.dimensions ?? 768,
      timeoutMs: raw.embedder?.timeoutMs ?? 4000,
    },
    reranker: parseRerankerConfig(raw.reranker),
    extractTimeoutMs: Number(process.env.EXTRACT_TIMEOUT_MS ?? "30000"),
    extractModel: process.env.EXTRACT_MODEL ?? undefined,
    extractMaxChars: parseInt(process.env.EXTRACT_MAX_CHARS ?? "40000", 10),
  };
}

/**
 * Parses reranker config with backward compatibility.
 * Old shape: { enabled, googleApiKey, openrouterApiKey, timeoutMs }
 * New shape: discriminated union on `provider`
 */
function parseRerankerConfig(raw: Record<string, any> | undefined): RerankerConfig {
  if (!raw) return { provider: "local" };

  // New-style config: provider field present
  if (raw.provider !== undefined) {
    switch (raw.provider) {
      case "off":
        return { provider: "off" };
      case "local":
        return {
          provider: "local",
          timeoutMs: raw.timeoutMs,
          threshold: raw.threshold,
        };
      case "llm":
        return {
          provider: "llm",
          openrouterApiKey: raw.openrouterApiKey ?? "",
          model: raw.model?.trim() || undefined,  // empty RERANKER_MODEL → undefined → default model
          timeoutMs: raw.timeoutMs,
          threshold: raw.threshold,
        };
      default:
        return { provider: "local" };
    }
  }

  // Backward compat: old flat shape with `enabled` boolean
  if (raw.enabled === false) {
    return { provider: "off" };
  }
  if (raw.enabled === true && (raw.openrouterApiKey || raw.googleApiKey)) {
    return {
      provider: "llm",
      openrouterApiKey: raw.openrouterApiKey ?? "",
      model: raw.model,
      timeoutMs: raw.timeoutMs,
      threshold: raw.threshold,
    };
  }

  // Default: local cross-encoder
  return { provider: "local" };
}

/** Valid provider names for runtime validation. */
const VALID_PROVIDERS = new Set(["off", "local", "llm"]);

/**
 * Validates reranker config at startup. Mutates config in place for degradation:
 *   - Unknown provider → falls back to "local" with warning
 *   - "llm" without API key → degrades to "off" with warning
 * Returns the (possibly modified) config for logging.
 */
export function validateRerankerConfig(
  cfg: HybridConfig,
  warn?: (msg: string) => void,
  info?: (msg: string) => void,
): RerankerConfig {
  const r = cfg.reranker;

  // Check for unknown providers (shouldn't happen after parseConfig, but safety net)
  if (!VALID_PROVIDERS.has(r.provider)) {
    warn?.(`memory-hybrid: unknown reranker provider "${r.provider}", falling back to "local"`);
    cfg.reranker = { provider: "local" };
    return cfg.reranker;
  }

  // Degrade llm → off if no API key available
  if (r.provider === "llm") {
    const apiKey = r.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      warn?.('memory-hybrid: reranker provider "llm" configured but no API key found (config or OPENROUTER_API_KEY), degrading to "off"');
      cfg.reranker = { provider: "off" };
      return cfg.reranker;
    }
  }

  const modelSuffix = r.provider === "llm"
    ? ` model="${r.model ?? DEFAULT_LLM_RERANKER_MODEL}"${r.model ? "" : " (default)"}`
    : "";
  info?.(`memory-hybrid: reranker provider="${r.provider}"${modelSuffix}`);
  return r;
}

/** Resolves reranker API key from config + env for LLM provider. */
export function resolveRerankerApiKey(cfg: HybridConfig): string {
  const r = cfg.reranker;
  if (r.provider === "llm") {
    return r.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
  }
  return "";
}

/**
 * Resolves an OpenRouter API key for the capture/extraction pipeline.
 * Unlike resolveRerankerApiKey, this always checks env regardless of reranker provider,
 * because capture needs an LLM call even when reranker is "local" or "off".
 */
export function resolveCaptureApiKey(cfg: HybridConfig): string {
  const r = cfg.reranker;
  if (r.provider === "llm" && r.openrouterApiKey) {
    return r.openrouterApiKey;
  }
  return process.env.OPENROUTER_API_KEY || "";
}

/**
 * Factory for creating the active EmbeddingProvider from environment variables.
 * SOLE OWNER — defined only here. Re-exported by embedding-client.ts for backward compat.
 *
 * Reads: EMBEDDINGS_PROVIDER, EMBEDDINGS_MODEL, EMBEDDINGS_DIMENSIONS,
 *        EMBEDDINGS_TIMEOUT_MS, OLLAMA_HOST, LLAMA_EMBED_BASE_URL, NOMIC_API_KEY
 * Backward-compat fallbacks: EMBEDDER_MODEL, EMBEDDER_BASE_URL
 */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  const providerName = (process.env.EMBEDDINGS_PROVIDER ?? "ollama").toLowerCase();
  const model = normalizeEmbeddingModelName(
    process.env.EMBEDDINGS_MODEL ?? process.env.EMBEDDER_MODEL,
  );
  const dimensions = Number(process.env.EMBEDDINGS_DIMENSIONS ?? "768");
  const timeoutMs = Number(process.env.EMBEDDINGS_TIMEOUT_MS ?? "4000");

  if (providerName === "nomic") {
    const apiKey = process.env.NOMIC_API_KEY ?? "";
    return new NomicAPIProvider({ apiKey, model, dimensions, timeoutMs });
  }

  if (providerName === "llamacpp" || providerName === "llama-cpp" || providerName === "llama") {
    const baseURL =
      process.env.LLAMA_EMBED_BASE_URL
      ?? process.env.EMBEDDER_BASE_URL
      ?? "http://127.0.0.1:8081";
    return new LlamaCppProvider({ baseURL, model, dimensions, timeoutMs });
  }

  // Default: ollama
  const baseURL = process.env.OLLAMA_HOST ?? process.env.EMBEDDER_BASE_URL ?? "http://localhost:11434";
  return new OllamaProvider({ baseURL, model, dimensions, timeoutMs });
}

/**
 * MIM-20 environment variables (read directly from process.env in consuming modules).
 * Listed here for documentation purposes only.
 *
 * CONFIDENCE_THRESHOLD       Minimum confidence for extracted facts (default: 0.7)
 * CONSOLIDATION_INTERVAL_MS  Sweep interval in ms (default: 3600000 = 1h)
 * CONSOLIDATION_MIN_SESSIONS Min sessions before sweep runs (default: 5)
 * CONSOLIDATION_MIN_HOURS    Min hours between sweeps (default: 24)
 * STALENESS_LOCK_TTL_S       Staleness pass lock TTL seconds (default: 60)
 * CONSOLIDATION_LOCK_TTL_S   Consolidation sweep lock TTL seconds (default: 300)
 */
const _MIM20_ENV_VARS_DOCUMENTED = true;
