import { describe, it, expect, vi } from "vitest";
import {
  SEED_PROTOTYPES,
  deriveCentroids,
  fetchSalienceCentroids,
  upsertSeedPrototypes,
} from "../src/capture/continuity/salience-prototypes.js";

describe("SEED_PROTOTYPES", () => {
  it("is a non-empty array", () => {
    expect(SEED_PROTOTYPES.length).toBeGreaterThan(0);
  });

  it("has positive seeds with a defined salience_type", () => {
    const positives = SEED_PROTOTYPES.filter((s) => s.polarity === "positive");
    expect(positives.length).toBeGreaterThan(0);
    for (const seed of positives) {
      expect(seed.salience_type).toBeDefined();
      expect(typeof seed.salience_type).toBe("string");
    }
  });

  it("has negative seeds with undefined salience_type", () => {
    const negatives = SEED_PROTOTYPES.filter((s) => s.polarity === "negative");
    expect(negatives.length).toBeGreaterThan(0);
    for (const seed of negatives) {
      expect(seed.salience_type).toBeUndefined();
    }
  });

  it("has unique seed IDs", () => {
    const ids = new Set(SEED_PROTOTYPES.map((s) => s.id));
    expect(ids.size).toBe(SEED_PROTOTYPES.length);
  });

  it("covers expected positive salience types", () => {
    const types = new Set(
      SEED_PROTOTYPES.filter((s) => s.polarity === "positive").map(
        (s) => s.salience_type,
      ),
    );
    for (const expected of ["bug", "preference", "decision", "event", "fact", "process"]) {
      expect(types.has(expected)).toBe(true);
    }
  });
});

describe("fetchSalienceCentroids", () => {
  it("returns a Map keyed by type with the salience_centroids: prefix stripped", async () => {
    const db = {
      query: vi.fn(async () => [
        [
          { id: "salience_centroids:bug", embedding: [0.1, 0.2] },
          { id: "salience_centroids:noise", embedding: [0.3, 0.4] },
        ],
      ]),
    } as unknown as never;

    const map = await fetchSalienceCentroids(db);
    expect(map.size).toBe(2);
    expect(map.get("bug")).toEqual([0.1, 0.2]);
    expect(map.get("noise")).toEqual([0.3, 0.4]);
  });

  it("handles SurrealDB RecordId-shaped id objects", async () => {
    const db = {
      query: vi.fn(async () => [
        [{ id: { id: "bug", tb: "salience_centroids" }, embedding: [0.5] }],
      ]),
    } as unknown as never;

    const map = await fetchSalienceCentroids(db);
    expect(map.has("bug")).toBe(true);
    expect(map.get("bug")).toEqual([0.5]);
  });

  it("returns an empty Map when the query throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as never;

    const map = await fetchSalienceCentroids(db);
    expect(map.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns an empty Map when the query returns no rows", async () => {
    const db = {
      query: vi.fn(async () => [[]]),
    } as unknown as never;

    const map = await fetchSalienceCentroids(db);
    expect(map.size).toBe(0);
  });
});

describe("upsertSeedPrototypes", () => {
  it("skips seeds that already exist (count > 0) and never embeds them", async () => {
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("count()")) {
        return [[{ n: 1 }]];
      }
      return [];
    });
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    await upsertSeedPrototypes(
      { query: dbQuery } as unknown as never,
      { embedDocument: embed } as unknown as never,
    );

    expect(embed).not.toHaveBeenCalled();
    expect(dbQuery).toHaveBeenCalledTimes(SEED_PROTOTYPES.length);
  });

  it("inserts seeds that do not exist by embedding then INSERT IGNORE", async () => {
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("count()")) {
        return [[{ n: 0 }]];
      }
      return [];
    });
    const embed = vi.fn(async () => [0.6, 0.8]);

    await upsertSeedPrototypes(
      { query: dbQuery } as unknown as never,
      { embedDocument: embed } as unknown as never,
    );

    expect(embed).toHaveBeenCalledTimes(SEED_PROTOTYPES.length);
    expect(dbQuery).toHaveBeenCalledTimes(SEED_PROTOTYPES.length * 2);

    const insertCalls = dbQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((q) => q.includes("INSERT IGNORE INTO salience_prototypes"));
    expect(insertCalls.length).toBe(SEED_PROTOTYPES.length);
  });

  it("treats a thrown existence-check as 'absent' and proceeds to insert", async () => {
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("count()")) {
        throw new Error("transient");
      }
      return [];
    });
    const embed = vi.fn(async () => [0.4, 0.2]);

    await upsertSeedPrototypes(
      { query: dbQuery } as unknown as never,
      { embedDocument: embed } as unknown as never,
    );

    expect(embed).toHaveBeenCalledTimes(SEED_PROTOTYPES.length);
  });
});

describe("deriveCentroids", () => {
  it("skips types with no active prototypes and warns to stderr", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dbQuery = vi.fn(async () => [[]]);

    await deriveCentroids({ query: dbQuery } as unknown as never);

    expect(warnSpy).toHaveBeenCalled();
    expect(dbQuery).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("upserts a centroid when active prototypes exist for a type", async () => {
    let callIdx = 0;
    const dbQuery = vi.fn(async (sql: string) => {
      callIdx++;
      if (sql.startsWith("SELECT id, embedding, updated_at")) {
        return [
          [
            {
              id: "seed:bug:1",
              embedding: [0.6, 0.8],
              updated_at: "2026-05-15T00:00:00.000Z",
            },
            {
              id: "seed:bug:2",
              embedding: [0.0, 1.0],
              updated_at: "2026-05-15T00:00:00.000Z",
            },
          ],
        ];
      }
      return [];
    });

    await deriveCentroids({ query: dbQuery } as unknown as never);

    const upsertCalls = dbQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((q) => q.includes("UPSERT type::record('salience_centroids'"));
    expect(upsertCalls.length).toBeGreaterThan(0);
    expect(callIdx).toBeGreaterThan(0);
  });
});
