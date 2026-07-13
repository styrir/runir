import type { EmbeddingProvider } from "./embedding-provider";

export interface LlamaCppProviderConfig {
  baseURL: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

/** llama.cpp server (OpenAI-compatible /v1/embeddings) embedding provider. */
export class LlamaCppProvider implements EmbeddingProvider {
  private readonly baseURL: string;
  private readonly model: string;
  readonly dimensions: number;
  private readonly timeoutMs: number;

  constructor(config: LlamaCppProviderConfig) {
    this.baseURL = config.baseURL.replace(/\/+$/, "");
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.timeoutMs = config.timeoutMs;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(`search_query: ${text}`);
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.embed(`search_document: ${text}`);
  }

  fingerprint(): string {
    return `llamacpp:${this.model}:${this.dimensions}:cosine`;
  }

  private async embed(input: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseURL}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`llama.cpp embed HTTP ${response.status}`);
      }
      const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0]?.embedding ?? [];
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Embedding request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}