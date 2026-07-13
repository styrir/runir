import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../storage/embeddings/providers/ollama-provider", () => {
  return {
    OllamaProvider: class {
      type = "ollama";
      baseURL!: string;
      model!: string;
      dimensions!: number;
      timeoutMs!: number;
      constructor(opts: any) {
        Object.assign(this, opts);
        this.type = "ollama";
      }
    },
  };
});
vi.mock("../storage/embeddings/providers/nomic-provider", () => {
  return {
    NomicAPIProvider: class {
      type = "nomic";
      apiKey!: string;
      model!: string;
      dimensions!: number;
      timeoutMs!: number;
      constructor(opts: any) {
        Object.assign(this, opts);
        this.type = "nomic";
      }
    },
  };
});
vi.mock("../storage/embeddings/providers/llamacpp-provider", () => {
  return {
    LlamaCppProvider: class {
      type = "llamacpp";
      baseURL!: string;
      model!: string;
      dimensions!: number;
      timeoutMs!: number;
      constructor(opts: any) {
        Object.assign(this, opts);
        this.type = "llamacpp";
      }
    },
  };
});

import {
  parseConfig,
  validateRerankerConfig,
  resolveRerankerApiKey,
  resolveCaptureApiKey,
  resolveEmbeddingProvider,
} from "../shared/config";
import type { HybridConfig } from "../domain/memory/types";

// Save env
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    "EXTRACT_TIMEOUT_MS", "EXTRACT_MODEL", "EXTRACT_MAX_CHARS",
    "OPENROUTER_API_KEY", "EMBEDDINGS_PROVIDER", "EMBEDDINGS_MODEL",
    "EMBEDDINGS_DIMENSIONS", "EMBEDDINGS_TIMEOUT_MS", "OLLAMA_HOST",
    "NOMIC_API_KEY", "EMBEDDER_MODEL", "EMBEDDER_BASE_URL",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

// ── parseConfig ──────────────────────────────────────────────────────────────

describe("parseConfig", () => {
  it("returns defaults for null input", () => {
    const cfg = parseConfig(null);
    expect(cfg.userId).toBe("default");
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.topK).toBe(5);
    expect(cfg.surrealdb.url).toBe("http://localhost:8000");
    expect(cfg.embedder.provider).toBe("ollama");
    expect(cfg.reranker.provider).toBe("local");
  });

  it("returns defaults for undefined input", () => {
    const cfg = parseConfig(undefined);
    expect(cfg.userId).toBe("default");
  });

  it("overrides defaults with provided values", () => {
    const cfg = parseConfig({
      userId: "custom-user",
      autoRecall: false,
      autoCapture: false,
      topK: 10,
      customPrompt: "custom",
      surrealdb: {
        url: "http://db:8000",
        username: "admin",
        password: "pass",
        namespace: "ns",
        database: "db",
      },
      embedder: {
        provider: "nomic",
        model: "custom-model",
        baseURL: "http://custom:11434",
        apiKey: "api-key",
        dimensions: 512,
        timeoutMs: 8000,
      },
    });
    expect(cfg.userId).toBe("custom-user");
    expect(cfg.autoRecall).toBe(false);
    expect(cfg.topK).toBe(10);
    expect(cfg.surrealdb.url).toBe("http://db:8000");
    expect(cfg.embedder.provider).toBe("nomic");
    expect(cfg.embedder.dimensions).toBe(512);
  });

  it("parses reranker with provider=off", () => {
    const cfg = parseConfig({ reranker: { provider: "off" } });
    expect(cfg.reranker.provider).toBe("off");
  });

  it("parses reranker with provider=local", () => {
    const cfg = parseConfig({ reranker: { provider: "local", threshold: 0.4 } });
    expect(cfg.reranker.provider).toBe("local");
    expect((cfg.reranker as { provider: "local"; threshold?: number }).threshold).toBe(0.4);
  });

  it("parses reranker with provider=llm", () => {
    const cfg = parseConfig({
      reranker: { provider: "llm", openrouterApiKey: "key", model: "m", timeoutMs: 3000, threshold: 0.3 },
    });
    expect(cfg.reranker.provider).toBe("llm");
    expect((cfg.reranker as { provider: "llm"; openrouterApiKey: string }).openrouterApiKey).toBe("key");
  });

  it("normalizes empty/whitespace reranker model to undefined (Rúnir-imaf.3)", () => {
    for (const model of ["", "   "]) {
      const cfg = parseConfig({ reranker: { provider: "llm", openrouterApiKey: "key", model } });
      // empty RERANKER_MODEL must not reach the request body as "" — it falls through to the default
      expect((cfg.reranker as { provider: "llm"; model?: string }).model).toBeUndefined();
    }
  });

  it("falls back to local for unknown provider", () => {
    const cfg = parseConfig({ reranker: { provider: "magic" } });
    expect(cfg.reranker.provider).toBe("local");
  });

  it("handles backward compat: enabled=false → off", () => {
    const cfg = parseConfig({ reranker: { enabled: false } });
    expect(cfg.reranker.provider).toBe("off");
  });

  it("handles backward compat: enabled=true with apiKey → llm", () => {
    const cfg = parseConfig({
      reranker: { enabled: true, openrouterApiKey: "key", timeoutMs: 5000, threshold: 0.2 },
    });
    expect(cfg.reranker.provider).toBe("llm");
  });

  it("handles backward compat: enabled=true with googleApiKey → llm", () => {
    const cfg = parseConfig({ reranker: { enabled: true, googleApiKey: "gkey" } });
    expect(cfg.reranker.provider).toBe("llm");
  });

  it("handles backward compat: enabled=true without keys → local", () => {
    const cfg = parseConfig({ reranker: { enabled: true } });
    expect(cfg.reranker.provider).toBe("local");
  });

  it("reads EXTRACT_TIMEOUT_MS from env", () => {
    process.env.EXTRACT_TIMEOUT_MS = "5000";
    const cfg = parseConfig({});
    expect(cfg.extractTimeoutMs).toBe(5000);
  });

  it("reads EXTRACT_MODEL from env", () => {
    process.env.EXTRACT_MODEL = "custom-model";
    const cfg = parseConfig({});
    expect(cfg.extractModel).toBe("custom-model");
  });

  it("reads EXTRACT_MAX_CHARS from env", () => {
    process.env.EXTRACT_MAX_CHARS = "20000";
    const cfg = parseConfig({});
    expect(cfg.extractMaxChars).toBe(20000);
  });
});

// ── validateRerankerConfig ───────────────────────────────────────────────────

describe("validateRerankerConfig", () => {
  it("passes valid config without modification", () => {
    const cfg = parseConfig({ reranker: { provider: "local" } });
    const info = vi.fn();
    const result = validateRerankerConfig(cfg, undefined, info);
    expect(result.provider).toBe("local");
    expect(info).toHaveBeenCalledWith(expect.stringContaining('provider="local"'));
  });

  it("degrades unknown provider to local", () => {
    const cfg = parseConfig({});
    (cfg as any).reranker = { provider: "unknown" };
    const warn = vi.fn();
    const result = validateRerankerConfig(cfg, warn);
    expect(result.provider).toBe("local");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown reranker provider"));
  });

  it("degrades llm to off when no API key", () => {
    const cfg = parseConfig({ reranker: { provider: "llm" } });
    const warn = vi.fn();
    const result = validateRerankerConfig(cfg, warn);
    expect(result.provider).toBe("off");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no API key"));
  });

  it("keeps llm when config has API key", () => {
    const cfg = parseConfig({ reranker: { provider: "llm", openrouterApiKey: "key" } });
    const result = validateRerankerConfig(cfg);
    expect(result.provider).toBe("llm");
  });

  it("keeps llm when env has API key", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = parseConfig({ reranker: { provider: "llm" } });
    const result = validateRerankerConfig(cfg);
    expect(result.provider).toBe("llm");
  });
});

// ── resolveRerankerApiKey ────────────────────────────────────────────────────

describe("resolveRerankerApiKey", () => {
  it("returns empty for non-llm provider", () => {
    const cfg = parseConfig({ reranker: { provider: "local" } });
    expect(resolveRerankerApiKey(cfg)).toBe("");
  });

  it("returns config key for llm provider", () => {
    const cfg = parseConfig({ reranker: { provider: "llm", openrouterApiKey: "cfg-key" } });
    expect(resolveRerankerApiKey(cfg)).toBe("cfg-key");
  });

  it("falls back to env key for llm provider", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = parseConfig({ reranker: { provider: "llm" } });
    expect(resolveRerankerApiKey(cfg)).toBe("env-key");
  });
});

// ── resolveCaptureApiKey ─────────────────────────────────────────────────────

describe("resolveCaptureApiKey", () => {
  it("returns config key when provider is llm", () => {
    const cfg = parseConfig({ reranker: { provider: "llm", openrouterApiKey: "cfg-key" } });
    expect(resolveCaptureApiKey(cfg)).toBe("cfg-key");
  });

  it("falls back to env key when provider is not llm", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = parseConfig({ reranker: { provider: "local" } });
    expect(resolveCaptureApiKey(cfg)).toBe("env-key");
  });

  it("returns empty when no key available", () => {
    const cfg = parseConfig({ reranker: { provider: "local" } });
    expect(resolveCaptureApiKey(cfg)).toBe("");
  });

  it("falls back to env when llm has no config key", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = parseConfig({ reranker: { provider: "llm" } });
    expect(resolveCaptureApiKey(cfg)).toBe("env-key");
  });
});

// ── resolveEmbeddingProvider ─────────────────────────────────────────────────

describe("resolveEmbeddingProvider", () => {
  it("defaults to OllamaProvider", () => {
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.type).toBe("ollama");
  });

  it("creates NomicAPIProvider when EMBEDDINGS_PROVIDER=nomic", () => {
    process.env.EMBEDDINGS_PROVIDER = "nomic";
    process.env.NOMIC_API_KEY = "nk";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.type).toBe("nomic");
    expect(provider.apiKey).toBe("nk");
  });

  it("creates LlamaCppProvider when EMBEDDINGS_PROVIDER=llamacpp", () => {
    process.env.EMBEDDINGS_PROVIDER = "llamacpp";
    process.env.LLAMA_EMBED_BASE_URL = "http://127.0.0.1:8081";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.type).toBe("llamacpp");
    expect(provider.baseURL).toBe("http://127.0.0.1:8081");
  });

  it("reads EMBEDDINGS_MODEL", () => {
    process.env.EMBEDDINGS_MODEL = "custom-model";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.model).toBe("custom-model");
  });

  it("reads EMBEDDER_MODEL as fallback", () => {
    process.env.EMBEDDER_MODEL = "legacy-model";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.model).toBe("legacy-model");
  });

  it("reads OLLAMA_HOST", () => {
    process.env.OLLAMA_HOST = "http://custom:11434";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.baseURL).toBe("http://custom:11434");
  });

  it("reads EMBEDDER_BASE_URL as fallback", () => {
    process.env.EMBEDDER_BASE_URL = "http://legacy:11434";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.baseURL).toBe("http://legacy:11434");
  });

  it("reads EMBEDDINGS_DIMENSIONS and EMBEDDINGS_TIMEOUT_MS", () => {
    process.env.EMBEDDINGS_DIMENSIONS = "384";
    process.env.EMBEDDINGS_TIMEOUT_MS = "8000";
    const provider = resolveEmbeddingProvider() as any;
    expect(provider.dimensions).toBe(384);
    expect(provider.timeoutMs).toBe(8000);
  });
});
