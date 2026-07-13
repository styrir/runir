import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock surreal-store before importing memory-query
vi.mock("../storage/surreal/surreal-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../storage/surreal/surreal-store")>();
  return {
    ...original,
    getEmbeddingFingerprint: vi.fn(),
    ensureRejectionLogTable: vi.fn().mockResolvedValue(undefined),
    logRejection: vi.fn().mockResolvedValue(undefined),
  };
});

import { runHybridQueryWithEvidenceTable } from "../recall/query/memory-query";
import { getEmbeddingFingerprint } from "../storage/surreal/surreal-store";
import type { EmbeddingProvider } from "../storage/embeddings/providers/embedding-provider";

const mockGetFingerprint = vi.mocked(getEmbeddingFingerprint);

function makeMockProvider(fp: string): EmbeddingProvider {
  return {
    embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedDocument: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    fingerprint: () => fp,
    dimensions: 3,
  };
}

function makeMockDb(corpusCount: number) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      // Corpus count check
      if (sql.includes("count()")) {
        return Promise.resolve([[{ cnt: corpusCount }]]);
      }
      // All other queries return empty
      return Promise.resolve([[]]);
    }),
  } as any;
}

describe("fingerprint guard", () => {
  beforeEach(() => {
    mockGetFingerprint.mockReset();
  });

  it("case (a): stored matches current — proceeds normally", async () => {
    mockGetFingerprint.mockResolvedValue("ollama:nomic-embed-text:v1.5:768:cosine");
    const provider = makeMockProvider("ollama:nomic-embed-text:v1.5:768:cosine");
    const db = makeMockDb(5);

    const results = await runHybridQueryWithEvidenceTable({
      db, userId: "user1", query: "test query", embedding: [0.1, 0.2], limit: 5,
      evidenceTable: "memories", embeddingProvider: provider,
    });

    // Should not return early — proceeds to RRF (which returns [] from mock)
    expect(results).toEqual([]);
    // The corpus count query should NOT have been called (fingerprint matched)
    const countCalls = db.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("count()") && c[0].includes("payload.userId"),
    );
    expect(countCalls.length).toBe(0);
  });

  it("case (b): stored differs from current — warns and returns []", async () => {
    mockGetFingerprint.mockResolvedValue("ollama:old-model:512:cosine");
    const provider = makeMockProvider("ollama:nomic-embed-text:v1.5:768:cosine");
    const db = makeMockDb(5);
    const warn = vi.fn();

    const results = await runHybridQueryWithEvidenceTable({
      db, userId: "user1", query: "test query", embedding: [0.1, 0.2], limit: 5,
      evidenceTable: "memories", warn, embeddingProvider: provider,
    });

    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("embedding fingerprint mismatch"),
    );
  });

  it("case (c): stored is null + non-empty corpus — warns and returns []", async () => {
    mockGetFingerprint.mockResolvedValue(null);
    const provider = makeMockProvider("ollama:nomic-embed-text:v1.5:768:cosine");
    const db = makeMockDb(3); // non-empty corpus
    const warn = vi.fn();

    const results = await runHybridQueryWithEvidenceTable({
      db, userId: "user1", query: "test query", embedding: [0.1, 0.2], limit: 5,
      evidenceTable: "memories", warn, embeddingProvider: provider,
    });

    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalledWith("no embedding fingerprint for non-empty corpus");
  });

  it("case (d): stored is null + empty corpus — allows through", async () => {
    mockGetFingerprint.mockResolvedValue(null);
    const provider = makeMockProvider("ollama:nomic-embed-text:v1.5:768:cosine");
    const db = makeMockDb(0); // empty corpus
    const warn = vi.fn();

    const results = await runHybridQueryWithEvidenceTable({
      db, userId: "user1", query: "test query", embedding: [0.1, 0.2], limit: 5,
      evidenceTable: "memories", warn, embeddingProvider: provider,
    });

    // Should proceed (returns [] from mock RRF, not from guard)
    expect(results).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith("no embedding fingerprint for non-empty corpus");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("mismatch"));
  });
});
