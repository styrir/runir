import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensurePhase2Schema } from "../storage/surreal/phase2-store.js";
import { runHybridQueryWithEvidenceTable } from "../recall/query/memory-query.js";
import { resolveNoemaRetrievalPolicy } from "../recall/policy/noema-retrieval-policy.js";

// Real-DB integration test for Rúnir-0gk6.2:
// Proves the noema leg now retrieves via fused vector KNN + scored-BM25 FTS, replacing
// the old `ORDER BY updated_at DESC LIMIT 120` lexical recency-window scan.
//
//   1. FTS leg: a noema whose canonical_norm shares query terms is retrieved by the
//      native search::score(1) BM25 index (requires the noema_text_bm25 SEARCH INDEX
//      added to ensurePhase2Schema — @1@ returns empty without it).
//   2. Vector leg: a noema whose canonical_norm shares NO query terms but whose
//      embedding is the query vector is retrieved by KNN (meaning, not lexical overlap).
//   3. Old-pathology: a relevant noema buried OUTSIDE the old 120-row recency window
//      (200+ fresher filler rows on top of it) is now found — the recency horizon is gone.
//
// Runs against an ISOLATED database. Skipped when no local SurrealDB is up
// (same skip pattern as noema-promotion-embedding.test.ts / Rúnir-0gk6.1).

const TEST_DB = "g0k6_2_noema_fused_test";
const USER = "_g0k6_2_test_user";
const EMBED_DIMS = 768;

function makeDb(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

// Deterministic unit embedding seeded by a scalar — avoids any Ollama dependency.
// Distinct seeds give near-orthogonal vectors; identical seeds give cosine 1.0.
function fakeEmbed(seed: number): number[] {
  const vec: number[] = new Array(EMBED_DIMS).fill(0);
  for (let i = 0; i < EMBED_DIMS; i++) {
    vec[i] = Math.sin(i * 0.013 + seed * 1.7) + Math.cos(i * 0.007 + seed * 0.31);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

let db: SurrealClient;
let dbAvailable = false;

async function seedNoema(
  id: string,
  canonicalText: string,
  embedding: number[],
  createdIso: string,
): Promise<void> {
  await db.query(
    `UPSERT type::record('noema', $id) SET
       canonical = { text: $text },
       canonical_text = $text,
       canonical_norm = $norm,
       embedding = $embedding,
       user_id = $userId,
       status = 'active',
       active = true,
       confidence = 0.9,
       stability = 0.8,
       created_at = <datetime>$created,
       updated_at = <datetime>$created;`,
    {
      id,
      text: canonicalText,
      norm: canonicalText.toLowerCase(),
      embedding,
      userId: USER,
      created: createdIso,
    },
  );
}

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await db
    .query("REMOVE TABLE IF EXISTS noema; REMOVE TABLE IF EXISTS semiote; REMOVE TABLE IF EXISTS memories;")
    .catch(() => {});
  // ensurePhase2Schema is self-sufficient: it defines mem_analyzer (idempotent) before
  // the noema FTS index that references it (Rúnir-0gk6.2). No external ensureBm25Index needed.
  await ensurePhase2Schema(db);

  const old = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(); // ~1 year old
  const recent = (i: number) => new Date(Date.now() - i * 1000).toISOString();

  // Target A — FTS match: shares the query terms "kubernetes ingress controller".
  // Embedding is orthogonal to the query vector so ONLY the FTS leg can find it.
  await seedNoema(
    "g0k6_2_fts_target",
    "The kubernetes ingress controller routes external traffic to services.",
    fakeEmbed(999),
    old,
  );

  // Target B — vector match: canonical_norm shares NO significant query terms, but its
  // embedding IS the query vector (seed 42), so ONLY the vector leg can find it
  // (retrieval by meaning, not lexical overlap).
  await seedNoema(
    "g0k6_2_vector_target",
    "Reverse proxies forward requests upstream within the fabric layer.",
    fakeEmbed(42),
    old,
  );

  // 220 fresher filler rows so the two targets are buried well past the old 120-row
  // recency window. Each filler is lexically + semantically unrelated to the query.
  for (let i = 0; i < 220; i++) {
    await seedNoema(
      `g0k6_2_filler_${i}`,
      `Unrelated filler claim number ${i} about gardening and weather patterns.`,
      fakeEmbed(1000 + i),
      recent(i),
    );
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

describe("noema fused vector+FTS retrieval (Rúnir-0gk6.2)", () => {
  it("FTS leg retrieves a noema by shared terms even buried past the old 120-row window", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Query embedding is the seed-42 vector; the FTS target's embedding is orthogonal
    // (seed 999), so this hit is attributable to the BM25 FTS leg, not the vector leg.
    const policy = resolveNoemaRetrievalPolicy({ label: "fact", confidence: 1 } as any);
    expect(policy.mode).toBe("primary");

    const hits = await runHybridQueryWithEvidenceTable({
      db,
      userId: USER,
      query: "kubernetes ingress controller routing",
      embedding: fakeEmbed(42),
      limit: 10,
      evidenceTable: "memories",
      noemaRetrieval: { policy },
    });

    const ids = hits.map((h) => h.id);
    expect(ids).toContain("noema:g0k6_2_fts_target");
    const ftsHit = hits.find((h) => h.id === "noema:g0k6_2_fts_target")!;
    expect(ftsHit.sourceKind).toBe("noema");
    // Composite noema scoreStages with at least the BM25 sub-leg rank (RULING 3).
    expect(ftsHit.scoreStages?.noema).toBeDefined();
    expect(ftsHit.scoreStages?.noema?.bm25Rank).toBeGreaterThan(0);
  });

  it("vector leg retrieves a noema by meaning when it shares NO query terms", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Query terms ("service mesh sidecar telemetry") do NOT appear in the vector
    // target's canonical_norm, so the BM25 leg cannot match it. Its embedding equals
    // the query vector (seed 42), so the vector KNN leg must surface it.
    const policy = resolveNoemaRetrievalPolicy({ label: "fact", confidence: 1 } as any);
    const hits = await runHybridQueryWithEvidenceTable({
      db,
      userId: USER,
      query: "service mesh sidecar telemetry observability",
      embedding: fakeEmbed(42),
      limit: 10,
      evidenceTable: "memories",
      noemaRetrieval: { policy },
    });

    const ids = hits.map((h) => h.id);
    expect(ids).toContain("noema:g0k6_2_vector_target");
    const vecHit = hits.find((h) => h.id === "noema:g0k6_2_vector_target")!;
    expect(vecHit.sourceKind).toBe("noema");
    // Reachable ONLY via the vector sub-leg (KNN on the seed-42 embedding): vectorRank
    // is set and the BM25 sub-leg did not contribute it (no shared significant terms).
    // The old lexical-only scan could never have surfaced it.
    expect(vecHit.scoreStages?.noema?.vectorRank).toBeGreaterThan(0);
    expect(vecHit.scoreStages?.noema?.bm25Rank).toBeUndefined();
  });

  it("old-pathology: a relevant noema OUTSIDE the old recency window is now found", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // The old lexical leg scanned only the 120 most-recent rows (ORDER BY updated_at
    // DESC LIMIT 120). With 220 fresher filler rows on top, both year-old targets fell
    // outside that window and were unretrievable. The fused vector+FTS legs have no
    // recency horizon, so both are retrieved.
    const policy = resolveNoemaRetrievalPolicy({ label: "fact", confidence: 1 } as any);
    const hits = await runHybridQueryWithEvidenceTable({
      db,
      userId: USER,
      query: "kubernetes ingress controller routing",
      embedding: fakeEmbed(42),
      limit: 10,
      evidenceTable: "memories",
      noemaRetrieval: { policy },
    });

    const ids = hits.map((h) => h.id);
    // The FTS target (year-old, buried under 220 fresher rows) is recovered — the old
    // 120-row recency horizon would have made this impossible.
    expect(ids).toContain("noema:g0k6_2_fts_target");
    // And it OUTRANKS every gardening filler: the legs are relevance-ranked, not
    // recency-ranked, so the term-matching year-old claim beats the fresher noise.
    // (A pure KNN leg still returns nearest neighbours, so some fillers may appear in
    // the tail — but never above the term-matched target.)
    const targetIdx = ids.indexOf("noema:g0k6_2_fts_target");
    const firstFillerIdx = ids.findIndex((id) => id.startsWith("noema:g0k6_2_filler_"));
    if (firstFillerIdx !== -1) {
      expect(targetIdx).toBeLessThan(firstFillerIdx);
    }
  });

  it("survives the BM25 app-side fallback path (zero native FTS hits)", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Regression for the production-class bug the original three tests missed: those
    // queries always stem-matched a seeded canonical_norm (mem_analyzer uses snowball),
    // so the native FTS leg returned rows and the app-side fallback NEVER executed. The
    // fallback's `SELECT id, canonical_norm ... ORDER BY updated_at DESC` was rejected by
    // SurrealDB v3 at parse time ("Missing order idiom `updated_at`") — and because
    // withTimeout only races a timer (it does NOT catch rejections), that error rejected
    // the whole recall, zeroing every hit on the live corpus where most queries miss FTS.
    //
    // Here the query terms are invented tokens with ZERO stemmed overlap with anything
    // seeded (each survives significantQueryTokens: length > 2, not a stopword), so the
    // native FTS leg returns nothing and the fallback path is FORCED. The query embedding
    // equals the vector target's embedding (seed 42), so the vector leg — unaffected by
    // the FTS fallback running — must still surface it. Asserts: (a) no throw/reject,
    // (b) the vector target is retrieved, (c) bm25Rank is undefined (fallback found no
    // token overlap, so BM25 contributed nothing).
    const policy = resolveNoemaRetrievalPolicy({ label: "fact", confidence: 1 } as any);
    const hits = await runHybridQueryWithEvidenceTable({
      db,
      userId: USER,
      query: "zorbical flemtrak quibblewock",
      embedding: fakeEmbed(42),
      limit: 10,
      evidenceTable: "memories",
      noemaRetrieval: { policy },
    });

    const ids = hits.map((h) => h.id);
    expect(ids).toContain("noema:g0k6_2_vector_target");
    const vecHit = hits.find((h) => h.id === "noema:g0k6_2_vector_target")!;
    expect(vecHit.sourceKind).toBe("noema");
    expect(vecHit.scoreStages?.noema?.vectorRank).toBeGreaterThan(0);
    expect(vecHit.scoreStages?.noema?.bm25Rank).toBeUndefined();
  });
});
