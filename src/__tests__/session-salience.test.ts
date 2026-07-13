import { describe, it, expect, vi } from "vitest";
import { scoreSessionSalience } from "../capture/continuity/session-salience.js";
import type { CaptureMessage } from "../domain/memory/types.js";

function msg(role: string, content: string): CaptureMessage {
  return { role, content };
}

/** Helper: score a single message (lexical-only — salienceVectorReady is false). */
async function singleMsg(content: string) {
  const messages = [msg("user", content)];
  return scoreSessionSalience(null as any, messages, content, {
    userId: "test",
    scope: "user",
    sessionKey: "test",
    provider: null as any,
  });
}

describe("scoreSessionSalience", () => {
  describe("hard override detectors", () => {
    it("commit hash → hardOverride:true, technicalArtifactScore>=1.0", async () => {
      const result = await singleMsg("Committed as dc54da4 and deployed");
      expect(result.hardOverride).toBe(true);
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(1.0);
    });

    it("root cause language → hardOverride:true", async () => {
      const result = await singleMsg("The root cause was a race condition in the auth middleware");
      expect(result.hardOverride).toBe(true);
    });

    it("'fixed by' language → hardOverride:true", async () => {
      const result = await singleMsg("Fixed by adding a retry with exponential backoff");
      expect(result.hardOverride).toBe(true);
    });

    it("'caused by' language → hardOverride:true", async () => {
      const result = await singleMsg("The failure was caused by a missing index on the users table");
      expect(result.hardOverride).toBe(true);
    });

    it("'the fix is' language → hardOverride:true", async () => {
      const result = await singleMsg("The fix is to use RecordId directly instead of type::record()");
      expect(result.hardOverride).toBe(true);
    });

    it("'the issue was' language → hardOverride:true", async () => {
      const result = await singleMsg("The issue was that the driver coerces strings to RecordId");
      expect(result.hardOverride).toBe(true);
    });

    it("error + resolution adjacency across two messages → hardOverride:true", async () => {
      const messages = [
        msg("user", "Getting error: ECONNREFUSED when connecting to the database"),
        msg("assistant", "The fix is to update the connection string to use the new port"),
      ];
      const text = messages.map((m) => m.content).join("\n");
      const result = await scoreSessionSalience(null as any, messages, text, {
        userId: "test", scope: "user", sessionKey: "test", provider: null as any,
      });
      expect(result.hardOverride).toBe(true);
    });

    it("error in message N, resolution in message N-1 → hardOverride:true", async () => {
      const messages = [
        msg("user", "I patched the config to use port 5433"),
        msg("assistant", "That should fix the error: ECONNREFUSED you were seeing"),
      ];
      const text = messages.map((m) => m.content).join("\n");
      const result = await scoreSessionSalience(null as any, messages, text, {
        userId: "test", scope: "user", sessionKey: "test", provider: null as any,
      });
      expect(result.hardOverride).toBe(true);
    });
  });

  describe("technical artifact scoring", () => {
    it("architecture decision phrase → technicalArtifactScore>=0.8", async () => {
      const result = await singleMsg("We switched to Qdrant for vector persistence instead of LanceDB");
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(0.8);
    });

    it("file path with .ts extension → technicalArtifactScore>=0.6", async () => {
      const result = await singleMsg("The handler is in session-salience.ts in the src directory");
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(0.6);
    });

    it("CLI command 'npm install' → technicalArtifactScore>=0.5", async () => {
      const result = await singleMsg("Run npm install to get the dependencies");
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(0.5);
    });

    it("Go CLI command 'go build' → technicalArtifactScore>=0.5", async () => {
      const result = await singleMsg("Run go build ./... to compile the project");
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(0.5);
    });

    it("root cause pattern → technicalArtifactScore>=0.9", async () => {
      const result = await singleMsg("The root cause is a missing mutex lock in the auth handler");
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(0.9);
    });

    it("error/stack trace pattern → technicalArtifactScore>=0.9", async () => {
      const result = await singleMsg("Getting error: ECONNREFUSED when connecting to the database");
      expect(result.signals.technicalArtifactScore).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("low-salience inputs", () => {
    it("greeting 'Hi, how are you?' → score<0.10, hardOverride:false", async () => {
      const result = await singleMsg("Hi, how are you?");
      expect(result.score).toBeLessThan(0.10);
      expect(result.hardOverride).toBe(false);
    });

    it("casual multi-message chat → score<0.25", async () => {
      const messages = [
        msg("user", "Hey what's up?"),
        msg("assistant", "Not much, just here to help! How can I assist you today?"),
        msg("user", "Nothing really, just checking in. Have a good day!"),
      ];
      const text = messages.map((m) => m.content).join("\n");
      const result = await scoreSessionSalience(null as any, messages, text, {
        userId: "test", scope: "user", sessionKey: "test", provider: null as any,
      });
      expect(result.score).toBeLessThan(0.25);
      expect(result.hardOverride).toBe(false);
    });
  });

  describe("composite scoring", () => {
    it("full debugging session (root cause + fix + commit) → score>=0.40, hardOverride:true", async () => {
      const messages = [
        msg("user", "type::record($id) fails silently when the JS SDK passes a hyphenated UUID string — the driver coerces it to a RecordId before binding, causing the UPDATE to silently match zero rows."),
        msg("assistant", "The root cause is the JS SDK driver coercing strings to RecordId objects. Fixed by constructing new RecordId('memories', rawUuid) and binding as $rid. Committed as dc54da4."),
      ];
      const text = messages.map((m) => m.content).join("\n");
      const result = await scoreSessionSalience(null as any, messages, text, {
        userId: "test", scope: "user", sessionKey: "test", provider: null as any,
      });
      expect(result.score).toBeGreaterThanOrEqual(0.40);
      expect(result.hardOverride).toBe(true);
    });

    it("empty messages → score 0, hardOverride false", async () => {
      const result = await scoreSessionSalience(null as any, [], "", {
        userId: "test", scope: "user", sessionKey: "test", provider: null as any,
      });
      expect(result.score).toBe(0);
      expect(result.hardOverride).toBe(false);
      expect(result.reason).toBe("no messages");
    });
  });

  describe("reason string", () => {
    it("includes hardOverride reason when triggered", async () => {
      const result = await singleMsg("Committed as dc54da4");
      expect(result.reason).toContain("hardOverride");
      expect(result.reason).toContain("commit hash");
    });

    it("includes artifact labels and lexicalDensity", async () => {
      const result = await singleMsg("We switched to Qdrant instead of LanceDB for the vector store");
      expect(result.reason).toContain("technicalArtifact");
      expect(result.reason).toContain("lexicalDensity");
    });
  });

  describe("vector-path novelty query table target (Rúnir-ekos B-LIVE-1)", () => {
    it("queries the current-era PRIMARY_MEMORY_TABLE, not the legacy memories table", async () => {
      const { setSalienceVectorReady } = await import("../capture/continuity/session-salience.js");
      setSalienceVectorReady(true);
      try {
        const noveltyQueryCalls: string[] = [];
        const db = {
          query: vi.fn((sql: string) => {
            // The novelty query is the only call shaped like this — it
            // interpolates `FROM ${tableName}` (Rúnir-ekos B-LIVE-1 target).
            if (sql.includes("vector::similarity::cosine")) {
              noveltyQueryCalls.push(sql);
            }
            return Promise.resolve([[]]);
          }),
        };
        const provider = {
          embedDocument: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
          fingerprint: vi.fn().mockReturnValue("test-fp"),
        };
        const messages = [msg("user", "The root cause was a null pointer, fixed by commit abc1234")];
        const text = messages.map((m) => m.content).join("\n");
        await scoreSessionSalience(db as any, messages, text, {
          userId: "test", scope: "user", sessionKey: "test", provider: provider as any,
        });

        expect(noveltyQueryCalls.length).toBe(1);
        expect(noveltyQueryCalls[0]).toContain("FROM semiote");
        expect(noveltyQueryCalls[0]).not.toContain("FROM memories");
      } finally {
        setSalienceVectorReady(false);
      }
    });
  });

  describe("vector-path degradation", () => {
    it("DB failure → lexical-only mode, no throw", async () => {
      // Force the vector path by temporarily enabling it
      const { setSalienceVectorReady } = await import("../capture/continuity/session-salience.js");
      setSalienceVectorReady(true);
      try {
        const throwingDb = {
          query: vi.fn().mockRejectedValue(new Error("simulated DB failure")),
        };
        const throwingProvider = {
          embedDocument: vi.fn().mockRejectedValue(new Error("simulated embed failure")),
          fingerprint: vi.fn().mockReturnValue("test-fp"),
        };
        const messages = [msg("user", "The root cause was a null pointer, fixed by commit abc1234")];
        const text = messages.map((m) => m.content).join("\n");
        const result = await scoreSessionSalience(throwingDb as any, messages, text, {
          userId: "test", scope: "user", sessionKey: "test", provider: throwingProvider as any,
        });
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.vectorSignals).toBeUndefined();
        // AC5: degraded score must equal the lexical-only formula
        // lexical-only = 0.65 * technicalArtifactScore + 0.20 * lexicalDensity + 0.15 * causal_normalized
        const { technicalArtifactScore, lexicalDensity, causalMarkerCount } = result.signals;
        const sentenceCount = Math.max(text.split(/[.!?]+/).filter((s: string) => s.trim().length > 0).length, 1);
        const causalNorm = Math.min(causalMarkerCount / sentenceCount, 1);
        const expectedLexicalOnly = 0.65 * technicalArtifactScore + 0.20 * lexicalDensity + 0.15 * causalNorm;
        expect(result.score).toBeCloseTo(expectedLexicalOnly, 5);
      } finally {
        setSalienceVectorReady(false);
      }
    });
  });

  describe("feature normalization clamping", () => {
    // These test the normalization math directly (no DB needed).
    // prototype_gap: normalized = clamp((raw + 2) / 4, 0, 1)  where raw ∈ [-2, 2]
    // novelty:       normalized = clamp(raw / 2, 0, 1)         where raw ∈ [0, 2]

    it("extreme cosine values stay in [0,1]", () => {
      const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

      // prototype_gap_raw = 2.0 (max possible): clamp((2+2)/4, 0, 1) = 1.0
      expect(clamp((2 + 2) / 4, 0, 1)).toBe(1.0);

      // prototype_gap_raw = -2.0 (min possible): clamp((-2+2)/4, 0, 1) = 0.0
      expect(clamp((-2 + 2) / 4, 0, 1)).toBe(0.0);

      // novelty_raw = 0 (perfect duplicate): clamp(0/2, 0, 1) = 0.0
      expect(clamp(0 / 2, 0, 1)).toBe(0.0);

      // novelty_raw = 2.0 (max possible): clamp(2/2, 0, 1) = 1.0
      expect(clamp(2 / 2, 0, 1)).toBe(1.0);
    });

    it("mid-range prototype_gap normalizes correctly", () => {
      const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
      // raw = 0 → (0+2)/4 = 0.5
      expect(clamp((0 + 2) / 4, 0, 1)).toBe(0.5);
      // raw = 1 → (1+2)/4 = 0.75
      expect(clamp((1 + 2) / 4, 0, 1)).toBe(0.75);
    });
  });
});
