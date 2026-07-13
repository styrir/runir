/** Interface for embedding providers (Ollama, Nomic API, etc.). */
export interface EmbeddingProvider {
  /** Embeds a query string (uses search_query semantics). */
  embedQuery(text: string): Promise<number[]>;
  /** Embeds a document string (uses search_document semantics). */
  embedDocument(text: string): Promise<number[]>;
  /** Returns a deterministic fingerprint: "provider:model:dims:norm". */
  fingerprint(): string;
  /** The vector dimensionality this provider produces. Used to set the HNSW index dimension at boot. */
  readonly dimensions: number;
}
