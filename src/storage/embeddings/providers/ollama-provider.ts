import type { EmbeddingProvider } from "./embedding-provider";

export interface OllamaProviderConfig {
  baseURL: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

/** Ollama-backed embedding provider. Adds search_query/search_document prefixes. */
export class OllamaProvider implements EmbeddingProvider {
  private readonly baseURL: string;
  private readonly model: string;
  readonly dimensions: number;
  private readonly timeoutMs: number;

  constructor(config: OllamaProviderConfig) {
    this.baseURL = config.baseURL;
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
    return `ollama:${this.model}:${this.dimensions}:cosine`;
  }

  private async embed(input: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseURL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Ollama embed HTTP ${response.status}`);
      }
      const data = (await response.json()) as { embeddings: number[][] };
      return data.embeddings[0] ?? [];
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
