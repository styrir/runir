import { cosineSimilarity } from "../../shared/cosine.js";

/** Multilingual noise prototypes — recall queries, agent denials, greetings (EN + ZH). */
export const BUILTIN_NOISE_TEXTS: string[] = [
  // Recall queries (EN)
  "Do you remember what I told you?",
  "Can you recall my preferences?",
  "What do you know about me?",
  "Did you save what I said earlier?",
  // Agent denials (EN)
  "I don't have any information about that",
  "I cannot access that information",
  "As an AI, I don't have personal knowledge",
  "I'm unable to recall previous conversations",
  // Greetings (EN)
  "Hello, how are you doing today?",
  "Hi there, what can I help you with?",
  "Good morning, how's it going?",
  // Chinese equivalents
  "你还记得我之前说的吗？",
  "你能回忆起我的偏好吗？",
  "你好，今天怎么样？",
  "我无法获取该信息",
];

const MAX_LEARNED = 200;
const LEARN_DEDUP_THRESHOLD = 0.95;
const DEGENERACY_THRESHOLD = 0.98;

type Embedder = {
  embedDocument(text: string): Promise<number[]>;
};

export class NoisePrototypeBank {
  private prototypes: number[][] = [];
  private _initialized = false;

  get initialized(): boolean {
    return this._initialized;
  }

  get size(): number {
    return this.prototypes.length;
  }

  /**
   * Embeds all builtin prototypes. If initialization fails or degeneracy is detected,
   * sets initialized=false and logs warning. Never throws.
   */
  async init(embedder: Embedder): Promise<void> {
    try {
      const embeddings: number[][] = [];
      for (const text of BUILTIN_NOISE_TEXTS) {
        const vec = await embedder.embedDocument(text);
        embeddings.push(vec);
      }

      // Degeneracy check: if first two prototypes are too similar, disable
      if (embeddings.length >= 2) {
        const sim = cosineSimilarity(embeddings[0]!, embeddings[1]!);
        if (sim > DEGENERACY_THRESHOLD) {
          console.warn(`noise-prototype-bank: degeneracy detected (sim=${sim.toFixed(4)}), disabling bank`);
          this._initialized = false;
          return;
        }
      }

      this.prototypes = embeddings;
      this._initialized = true;
    } catch (err) {
      console.warn(`noise-prototype-bank: init failed: ${err instanceof Error ? err.message : String(err)}`);
      this._initialized = false;
    }
  }

  /**
   * Returns true if textVector matches any prototype at cosine > threshold (default 0.92).
   * Returns false if bank is not initialized.
   */
  isNoise(textVector: number[], threshold = 0.92): boolean {
    if (!this._initialized) return false;
    for (const proto of this.prototypes) {
      if (cosineSimilarity(textVector, proto) > threshold) {
        return true;
      }
    }
    return false;
  }

  /**
   * Learns a new noise vector from zero-fact extraction feedback.
   * Deduplicates at cosine > 0.95. Caps at 200 learned entries.
   */
  learn(textVector: number[]): void {
    if (!this._initialized) return;
    // Dedup: skip if too similar to existing prototype
    for (const proto of this.prototypes) {
      if (cosineSimilarity(textVector, proto) > LEARN_DEDUP_THRESHOLD) {
        return;
      }
    }
    if (this.prototypes.length >= BUILTIN_NOISE_TEXTS.length + MAX_LEARNED) {
      return;
    }
    this.prototypes.push([...textVector]);
  }
}
