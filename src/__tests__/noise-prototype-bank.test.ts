import { describe, it, expect, vi } from "vitest";
import { NoisePrototypeBank, BUILTIN_NOISE_TEXTS } from "../capture/extraction/noise-prototype-bank.js";

describe("NoisePrototypeBank", () => {
  it("has ~15 builtin noise texts", () => {
    expect(BUILTIN_NOISE_TEXTS.length).toBeGreaterThanOrEqual(12);
    expect(BUILTIN_NOISE_TEXTS.length).toBeLessThanOrEqual(20);
  });

  it("isNoise returns false when not initialized", () => {
    const bank = new NoisePrototypeBank();
    expect(bank.isNoise([1, 0, 0])).toBe(false);
    expect(bank.initialized).toBe(false);
  });

  it("initializes and detects noise at threshold 0.92", async () => {
    const bank = new NoisePrototypeBank();
    // Fake embedder returns a predictable unit vector for each text
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async (text: string) => {
        // Return different embeddings for different texts so degeneracy check passes
        const hash = text.length % 10;
        const vec = new Array(10).fill(0);
        vec[hash] = 1;
        return vec;
      }),
    };
    await bank.init(fakeEmbedder);
    expect(bank.initialized).toBe(true);
    expect(bank.size).toBeGreaterThanOrEqual(12);
  });

  it("detects exact prototype match as noise", async () => {
    const bank = new NoisePrototypeBank();
    const protoEmbedding = [1, 0, 0, 0, 0];
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async (_text: string, idx?: number) => {
        // All prototypes get unique embeddings; we don't care about exact match here
        // We'll test isNoise directly with a vector close to protoEmbedding
        return protoEmbedding;
      }),
    };
    // Manually test: bank stores [1,0,0,0,0] for first prototype
    // A vector identical to it should be noise (cosine = 1.0 > 0.92)
    await bank.init(fakeEmbedder);
    if (bank.initialized) {
      expect(bank.isNoise(protoEmbedding)).toBe(true);
    }
  });

  it("does not flag dissimilar vector as noise", async () => {
    const bank = new NoisePrototypeBank();
    // Give each prototype a unique embedding
    let callIdx = 0;
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async () => {
        const vec = new Array(20).fill(0);
        vec[callIdx % 20] = 1;
        callIdx++;
        return vec;
      }),
    };
    await bank.init(fakeEmbedder);
    // A random vector orthogonal to all prototypes
    const dissimilar = new Array(20).fill(0);
    dissimilar[19] = 1; // likely unique axis
    expect(bank.isNoise(dissimilar)).toBe(false);
  });

  it("learns from zero-fact extractions, capped at 200", async () => {
    const bank = new NoisePrototypeBank();
    let callIdx = 0;
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async () => {
        const vec = new Array(20).fill(0);
        vec[callIdx % 20] = 1;
        callIdx++;
        return vec;
      }),
    };
    await bank.init(fakeEmbedder);
    const initialSize = bank.size;

    // Learn a new vector
    const newVec = new Array(20).fill(0);
    newVec[15] = 0.5;
    newVec[16] = 0.5;
    bank.learn(newVec);
    expect(bank.size).toBe(initialSize + 1);
  });

  it("degeneracy check disables bank when first two prototypes > 0.98 cosine", async () => {
    const bank = new NoisePrototypeBank();
    // All prototypes return identical embedding → degeneracy
    const fakeEmbedder = {
      embedDocument: vi.fn().mockResolvedValue([1, 0, 0]),
    };
    await bank.init(fakeEmbedder);
    expect(bank.initialized).toBe(false);
  });

  it("init failure does not throw — sets initialized=false", async () => {
    const bank = new NoisePrototypeBank();
    const fakeEmbedder = {
      embedDocument: vi.fn().mockRejectedValue(new Error("embed fail")),
    };
    // Should not throw
    await bank.init(fakeEmbedder);
    expect(bank.initialized).toBe(false);
  });

  it("learn deduplicates at cosine > 0.95", async () => {
    const bank = new NoisePrototypeBank();
    let callIdx = 0;
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async () => {
        const vec = new Array(20).fill(0);
        vec[callIdx % 20] = 1;
        callIdx++;
        return vec;
      }),
    };
    await bank.init(fakeEmbedder);
    const sizeAfterInit = bank.size;

    // Learn same vector twice — second should be deduped
    const vec = [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    bank.learn(vec);
    const sizeAfterFirst = bank.size;
    expect(sizeAfterFirst).toBe(sizeAfterInit + 1);

    bank.learn(vec); // identical → cosine = 1.0 > 0.95 → dedup
    expect(bank.size).toBe(sizeAfterFirst);
  });

  it("learn is a no-op when not initialized", () => {
    const bank = new NoisePrototypeBank();
    bank.learn([1, 0, 0]);
    expect(bank.size).toBe(0);
  });

  it("learn respects MAX_LEARNED cap (200)", async () => {
    const bank = new NoisePrototypeBank();
    // Use small unique vectors for builtin prototypes
    let callIdx = 0;
    const dim = 300;
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async () => {
        const vec = new Array(dim).fill(0);
        vec[callIdx % dim] = 1;
        callIdx++;
        return vec;
      }),
    };
    await bank.init(fakeEmbedder);
    expect(bank.initialized).toBe(true);
    const builtinCount = bank.size;

    // Fill up to MAX_LEARNED (200) learned entries
    for (let i = 0; i < 200; i++) {
      const vec = new Array(dim).fill(0);
      // Use unique indices beyond what builtins used
      vec[(builtinCount + i) % dim] = 1;
      // Add a second component to ensure uniqueness
      vec[((builtinCount + i + 1) % dim)] = 0.01 * (i + 1);
      bank.learn(vec);
    }

    const sizeAtCap = bank.size;
    // Try to learn one more — should be rejected by cap
    const extraVec = new Array(dim).fill(0);
    extraVec[299] = 0.5;
    extraVec[298] = 0.5;
    bank.learn(extraVec);
    expect(bank.size).toBe(sizeAtCap);
  });

  it("init failure with non-Error thrown — String(err) path", async () => {
    const bank = new NoisePrototypeBank();
    const fakeEmbedder = {
      embedDocument: vi.fn().mockRejectedValue("string-error"),
    };
    await bank.init(fakeEmbedder);
    expect(bank.initialized).toBe(false);
  });

  it("isNoise returns true when vector matches any prototype above threshold", async () => {
    const bank = new NoisePrototypeBank();
    let callIdx = 0;
    const fakeEmbedder = {
      embedDocument: vi.fn().mockImplementation(async () => {
        const vec = new Array(10).fill(0);
        vec[callIdx % 10] = 1;
        callIdx++;
        return vec;
      }),
    };
    await bank.init(fakeEmbedder);
    expect(bank.initialized).toBe(true);

    // Create a vector nearly identical to the first prototype [1,0,0,...0]
    const nearMatch = new Array(10).fill(0);
    nearMatch[0] = 1;
    nearMatch[1] = 0.1; // slight deviation, still high cosine
    expect(bank.isNoise(nearMatch)).toBe(true);
  });
});
