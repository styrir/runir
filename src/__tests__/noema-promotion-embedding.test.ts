import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  ensurePhase2Schema,
  promoteSemioteToNoema,
} from "../storage/surreal/phase2-store.js";
import { fetchNoemaPageNeedingEmbedding, runBackfill } from "../../scripts/backfill-noema-embeddings.js";

// Real-DB integration test for Rúnir-0gk6.1:
// Verifies that promoteSemioteToNoema writes a real embedding vector on the noema
// row when an embedText function is supplied (not just the semiote row embedding),
// AND that canonical_norm is correctly written.
//
// Also verifies the backfill helper's idempotence: rows that already have an
// embedding are excluded by the WHERE guard; rows with empty embedding are included.
//
// Runs against an ISOLATED database. Skipped when no local SurrealDB is up
// (same skip pattern as entity-consolidation-repro.test.ts / Rúnir-imaf.12).

const TEST_DB = "g0k6_noema_embed_test";
const USER = "_g0k6_test_user";

function makeDb(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

let db: SurrealClient;
let dbAvailable = false;

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  // Clean slate + full schema in the isolated test DB.
  await db.query("REMOVE TABLE IF EXISTS noema; REMOVE TABLE IF EXISTS semiote; REMOVE TABLE IF EXISTS hexis;").catch(() => {});
  await ensurePhase2Schema(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
  }
});

// Synthetic embedding: deterministic 768-d unit vector (avoids Ollama dependency).
const EMBED_DIMS = 768;
function fakeEmbed(text: string): Promise<number[]> {
  // Simple deterministic vector: first element encodes text length, rest fill to dims.
  const vec: number[] = new Array(EMBED_DIMS).fill(0);
  for (let i = 0; i < EMBED_DIMS; i++) {
    vec[i] = Math.sin(i + text.length * 0.01);
  }
  // Normalize to unit length.
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return Promise.resolve(vec.map((v) => v / norm));
}

// A minimal semiote row that passes shouldPromoteToNoema thresholds.
function makeSemioteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "semiote:test-semi-g0k6",
    user_id: USER,
    scope: "user",
    path: "/test/path.ts",
    memory_role: "current_status",
    embedding: [],            // semiote has NO pre-existing embedding
    usefulness_alpha: 10,
    usefulness_beta: 2,
    usefulness_score: 0.85,
    retrieved_count: 5,
    successful_use_count: 4,
    cross_session_use_count: 2,
    contradiction_count: 0,
    payload: {
      l2: "The test fact for noema embedding promotion.",
      l0: "Test fact",
      category: "cases",
      factKey: "cases:test-fact-g0k6",
      continuitySubjectKey: "test-subject",
      claimPredicate: "is",
      confidence: 0.88,
      userId: USER,
      scope: "user",
      path: "/test/path.ts",
    },
    ...overrides,
  };
}

describe("promoteSemioteToNoema — embedding write (Rúnir-0gk6.1)", () => {
  it("writes a real embedding vector on the noema row when embedText is supplied", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    const row = makeSemioteRow();
    const result = await promoteSemioteToNoema(db, row, fakeEmbed);

    expect(result.promoted).toBe(true);
    expect(result.id).toMatch(/^noema:/);
    expect(result.embeddingWritten).toBe(true);

    // Fetch the noema row and verify embedding + canonical_norm.
    const noemaId = result.id!.replace(/^noema:/, "");
    const fetched = await db.query<any>(
      "SELECT embedding, canonical_norm, canonical_text FROM type::record('noema', $id);",
      { id: noemaId },
    );
    const noemaRow = (fetched[0] ?? [])[0];
    expect(noemaRow).toBeDefined();

    // embedding must be a non-empty array of the expected dimensions
    expect(Array.isArray(noemaRow.embedding)).toBe(true);
    expect(noemaRow.embedding.length).toBe(EMBED_DIMS);
    // All elements must be finite numbers (valid float32 embedding)
    expect(noemaRow.embedding.every((v: unknown) => typeof v === "number" && Number.isFinite(v))).toBe(true);

    // canonical_norm must be the lowercased, trimmed, collapsed-whitespace form
    const expectedNorm = "the test fact for noema embedding promotion.";
    expect(noemaRow.canonical_norm).toBe(expectedNorm);

    // canonical_text must be preserved verbatim
    expect(noemaRow.canonical_text).toBe("The test fact for noema embedding promotion.");
  });

  it("falls back to row.embedding and sets embeddingWritten=false when embedText returns empty []", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Semiote row has a pre-existing embedding; embedText returns [].
    const existingEmbed = await fakeEmbed("pre-existing semiote embedding");
    const row = makeSemioteRow({
      id: "semiote:test-semi-g0k6-empty-vec",
      embedding: existingEmbed,
      payload: {
        l2: "Fact with pre-existing embedding but empty embedText result.",
        userId: USER,
        scope: "user",
        path: "/test/path.ts",
        factKey: "cases:test-fact-g0k6-empty-vec",
        confidence: 0.88,
      },
    });

    // embedText that returns an empty array (degraded provider).
    const emptyEmbedText = async (_text: string): Promise<number[]> => [];

    const result = await promoteSemioteToNoema(db, row, emptyEmbedText);

    expect(result.promoted).toBe(true);
    // Empty vector from provider → embeddingWritten must be false.
    expect(result.embeddingWritten).toBe(false);

    // The noema row must carry the row.embedding fallback (non-empty), not [].
    const noemaId = result.id!.replace(/^noema:/, "");
    const fetched = await db.query<any>(
      "SELECT embedding FROM type::record('noema', $id);",
      { id: noemaId },
    );
    const noemaRow = (fetched[0] ?? [])[0];
    expect(Array.isArray(noemaRow.embedding)).toBe(true);
    expect(noemaRow.embedding.length).toBe(EMBED_DIMS);
  });

  it("coerces an empty fallback embedding to NONE when embedText is NOT supplied", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Use a different factKey to produce a distinct noema id.
    const row = makeSemioteRow({
      id: "semiote:test-semi-g0k6-noembed",
      payload: {
        l2: "A second test fact without embedder.",
        userId: USER,
        scope: "user",
        path: "/test/path.ts",
        factKey: "cases:test-fact-g0k6-noembed",
        confidence: 0.88,
      },
    });

    const result = await promoteSemioteToNoema(db, row /*, no embedText */);

    expect(result.promoted).toBe(true);
    expect(result.embeddingWritten).toBe(false);

    const noemaId = result.id!.replace(/^noema:/, "");
    const fetched = await db.query<any>(
      "SELECT embedding FROM type::record('noema', $id);",
      { id: noemaId },
    );
    const noemaRow = (fetched[0] ?? [])[0];
    // Without embedText and no row embedding, the empty fallback is coerced to NONE
    // (embeddingForStore → null → `?? NONE`), never stored as a 0-dim [] — so the HNSW
    // DIMENSION index skips the row instead of erroring on write. Assert STRICT NONE:
    // a stored [] would be the exact bad shape this fix prevents.
    expect(noemaRow.embedding == null).toBe(true);
  });
});

describe("backfill helpers — idempotence and WHERE guard (Rúnir-0gk6.1)", () => {
  it("fetchNoemaPageNeedingEmbedding excludes rows that already have an embedding", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // Seed: one row with full embedding (should be excluded), one with empty (should appear).
    const fullEmb = await fakeEmbed("fully embedded row");
    const now = new Date().toISOString();

    await db.query(
      `UPSERT type::record('noema', 'bf_has_emb') SET
         canonical = {text: "has embedding"},
         canonical_text = "has embedding",
         canonical_norm = "has embedding",
         embedding = $embedding,
         user_id = $userId,
         active = true,
         created_at = <datetime>$now,
         updated_at = <datetime>$now;`,
      { embedding: fullEmb, userId: USER, now },
    );

    await db.query(
      `UPSERT type::record('noema', 'bf_no_emb') SET
         canonical = {text: "needs embedding"},
         canonical_text = "needs embedding",
         canonical_norm = "needs embedding",
         embedding = NONE,
         user_id = $userId,
         active = true,
         created_at = <datetime>$now,
         updated_at = <datetime>$now;`,
      { userId: USER, now },
    );

    const page = await fetchNoemaPageNeedingEmbedding(db, 50, 0);
    const ids = page.map((r) => r.id);

    expect(ids.some((id) => id.includes("bf_no_emb"))).toBe(true);
    expect(ids.some((id) => id.includes("bf_has_emb"))).toBe(false);
  });

  it("runBackfill dry-run reports skipped=N without writing embeddings", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // bf_no_emb still has no embedding from the previous test.
    const report = await runBackfill(db, fakeEmbed, { dryRun: true, batchSize: 50 });
    expect(report.skipped).toBeGreaterThan(0);
    expect(report.embedded).toBe(0);
    expect(report.failed).toBe(0);

    // Confirm the row still has no embedding after dry run.
    const fetched = await db.query<any>(
      "SELECT embedding FROM type::record('noema', 'bf_no_emb');",
    );
    const row = (fetched[0] ?? [])[0];
    expect(row?.embedding?.length ?? 0).toBe(0);
  });

  it("runBackfill live run embeds rows with empty embedding and is idempotent on re-run", async (ctx) => {
    if (!dbAvailable) ctx.skip();

    // First run: should embed bf_no_emb (and any other rows still needing embedding).
    const report1 = await runBackfill(db, fakeEmbed, { dryRun: false, batchSize: 50 });
    expect(report1.embedded).toBeGreaterThan(0);
    expect(report1.failed).toBe(0);

    // Confirm bf_no_emb now has a full embedding.
    const fetched = await db.query<any>(
      "SELECT embedding FROM type::record('noema', 'bf_no_emb');",
    );
    const row = (fetched[0] ?? [])[0];
    expect(Array.isArray(row?.embedding)).toBe(true);
    expect(row.embedding.length).toBe(EMBED_DIMS);

    // Second run: idempotent — no rows need embedding now.
    const report2 = await runBackfill(db, fakeEmbed, { dryRun: false, batchSize: 50 });
    expect(report2.embedded).toBe(0);
    expect(report2.processed).toBe(0);
  });
});
