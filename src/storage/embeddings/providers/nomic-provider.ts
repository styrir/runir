import type { EmbeddingProvider } from "./embedding-provider";

export interface NomicAPIProviderConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

/** Nomic API-backed embedding provider. Uses task_type param (no text prefixes). */
export class NomicAPIProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  readonly dimensions: number;
  private readonly timeoutMs: number;

  constructor(config: NomicAPIProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.timeoutMs = config.timeoutMs;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text, "search_query");
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.embed(text, "search_document");
  }

  fingerprint(): string {
    return `nomic:${this.model}:${this.dimensions}:cosine`;
  }

  private async embed(text: string, taskType: "search_query" | "search_document"): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch("https://api-atlas.nomic.ai/v1/embedding/text", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          texts: [text],
          task_type: taskType,
          dimensionality: this.dimensions,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Nomic embed HTTP ${response.status}`);
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
