import { createHash } from "crypto";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import type { EmbeddingProvider } from "../../storage/embeddings/providers/embedding-provider.js";

// --- L2 normalization utility ---
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// --- T2: Seed prototypes ---

export const SEED_PROTOTYPES: Array<{
  id: string;
  text: string;
  polarity: "positive" | "negative";
  salience_type: string | undefined;
}> = [
  // Positive seeds
  { id: "seed:bug:1", salience_type: "bug", polarity: "positive", text: "The root cause was a null pointer in the auth middleware, fixed by adding a guard" },
  { id: "seed:bug:2", salience_type: "bug", polarity: "positive", text: "commit dc54da4 fixed the RecordId hyphenation bug — use RecordId directly" },
  { id: "seed:pref:1", salience_type: "preference", polarity: "positive", text: "User prefers TypeScript strict mode over loose type inference" },
  { id: "seed:pref:2", salience_type: "preference", polarity: "positive", text: "Always use conventional commits with ticket reference in parens" },
  { id: "seed:decision:1", salience_type: "decision", polarity: "positive", text: "We chose SurrealDB over Postgres for the graph layer because of RELATE queries" },
  { id: "seed:decision:2", salience_type: "decision", polarity: "positive", text: "Switched from LanceDB to SurrealDB BM25 for the recall pipeline" },
  { id: "seed:event:1", salience_type: "event", polarity: "positive", text: "MIM-63 shipped: git-diff augmentation for sparse sessions, client-side collection" },
  { id: "seed:event:2", salience_type: "event", polarity: "positive", text: "Deployed feb4e2e to production, fixed tsx missing via npm install" },
  { id: "seed:fact:1", salience_type: "fact", polarity: "positive", text: "SPARSE_SESSION_THRESHOLD is 10 compressed messages" },
  { id: "seed:fact:2", salience_type: "fact", polarity: "positive", text: "The write arbitrator uses cosine >= 0.95 for skip and >= 0.85 for merge-update" },
  { id: "seed:process:1", salience_type: "process", polarity: "positive", text: "Builder brief must go through Codex review before any implementation begins" },
  { id: "seed:process:2", salience_type: "process", polarity: "positive", text: "scoreSessionSalience runs before extractMemories in the session-end path" },
  // Negative seeds
  { id: "seed:noise:1", salience_type: undefined, polarity: "negative", text: "ok thanks" },
  { id: "seed:noise:2", salience_type: undefined, polarity: "negative", text: "sounds good" },
  { id: "seed:noise:3", salience_type: undefined, polarity: "negative", text: "got it" },
  { id: "seed:noise:4", salience_type: undefined, polarity: "negative", text: "sure" },
  { id: "seed:noise:5", salience_type: undefined, polarity: "negative", text: "hello" },
  { id: "seed:noise:6", salience_type: undefined, polarity: "negative", text: "yes" },
  { id: "seed:noise:7", salience_type: undefined, polarity: "negative", text: "no problem" },
  { id: "seed:noise:8", salience_type: undefined, polarity: "negative", text: "I understand" },
];

/** Inserts missing seed prototypes, embedding their text. Never overwrites active rows. */
export async function upsertSeedPrototypes(
  db: SurrealClient,
  provider: EmbeddingProvider,
): Promise<void> {
  for (const seed of SEED_PROTOTYPES) {
    // Check existence before embedding to avoid wasted embed calls on restart.
    // Use meta::id(id) to compare against the bare string ID (SurrealDB 3.x pattern).
    const existing = await db.query<Array<{ n: number }>>(
      `SELECT count() AS n FROM salience_prototypes WHERE meta::id(id) = $rawId GROUP ALL;`,
      { rawId: seed.id },
    ).catch(() => [[{ n: 0 }]] as Array<Array<{ n: number }>>);
    const existingCount = (existing as Array<Array<{ n: number }>>)[0]?.[0]?.n ?? 0;
    if (existingCount > 0) continue;

    const rawEmbedding = await provider.embedDocument(seed.text);
    const embedding = l2Normalize(rawEmbedding);
    const now = new Date().toISOString();

    // INSERT IGNORE is idempotent — skips silently if the record already exists
    await db.query(
      `INSERT IGNORE INTO salience_prototypes {
         id: $id,
         text: $text,
         embedding: $embedding,
         polarity: $polarity,
         salience_type: $salience_type,
         seed_source: $seed_source,
         active: $active,
         created_at: <datetime>$now,
         updated_at: <datetime>$now
       };`,
      {
        id: seed.id,
        text: seed.text,
        embedding,
        polarity: seed.polarity,
        salience_type: seed.salience_type,
        seed_source: "manual",
        active: true,
        now,
      },
    );
  }
}

// --- T3: Centroid derivation ---

const POSITIVE_TYPES = ["bug", "preference", "decision", "event", "fact", "process"];

/** Derives mean centroids for each salience type + noise. Writes to salience_centroids. */
export async function deriveCentroids(db: SurrealClient): Promise<void> {
  const allTypes = [...POSITIVE_TYPES, "noise"];

  for (const type of allTypes) {
    // Load active prototypes for this type
    let queryStr: string;
    let queryVars: Record<string, unknown>;
    if (type === "noise") {
      queryStr = `SELECT id, embedding, updated_at FROM salience_prototypes WHERE active = true AND polarity = $polarity;`;
      queryVars = { polarity: "negative" };
    } else {
      queryStr = `SELECT id, embedding, updated_at FROM salience_prototypes WHERE active = true AND polarity = $polarity AND salience_type = $type;`;
      queryVars = { polarity: "positive", type };
    }

    const results = await db.query<{ id: string; embedding: number[]; updated_at: string }>(
      queryStr,
      queryVars,
    );
    const rows = results[0] ?? [];

    if (rows.length === 0) {
      console.warn(`deriveCentroids: no active prototypes for type "${type}", skipping`);
      continue;
    }

    // L2-normalize each embedding, compute mean, then double-normalize
    const dims = rows[0]!.embedding.length;
    const sum = new Array<number>(dims).fill(0);
    for (const row of rows) {
      const normed = l2Normalize(row.embedding);
      for (let i = 0; i < dims; i++) {
        sum[i]! += normed[i]!;
      }
    }
    const mean = sum.map((v) => v / rows.length);
    const centroid = l2Normalize(mean);

    // Compute prototype_version: SHA-256 of sorted(id + ":" + updated_at)
    const versionInput = rows
      .map((r) => {
        const updatedAt = typeof r.updated_at === "string"
          ? r.updated_at
          : new Date(r.updated_at as unknown as number).toISOString();
        return `${r.id}:${updatedAt}`;
      })
      .sort()
      .join(",");
    const prototypeVersion = createHash("sha256").update(versionInput).digest("hex");

    const now = new Date().toISOString();
    await db.query(
      `UPSERT type::record('salience_centroids', $recordId) CONTENT {
         embedding: $embedding,
         member_count: $member_count,
         prototype_version: $prototype_version,
         updated_at: <datetime>$now
       };`,
      {
        recordId: type,
        embedding: centroid,
        member_count: rows.length,
        prototype_version: prototypeVersion,
        now,
      },
    );
  }
}

// --- T4: Fetch centroids ---

/** Fetches all salience centroids, returning a Map keyed by type (e.g. "bug", "noise"). */
export async function fetchSalienceCentroids(
  db: SurrealClient,
): Promise<Map<string, number[]>> {
  try {
    const results = await db.query<{ id: string; embedding: number[] }>(
      "SELECT id, embedding FROM salience_centroids;",
    );
    const rows = results[0] ?? [];
    const map = new Map<string, number[]>();
    for (const row of rows) {
      // Strip "salience_centroids:" prefix from the record ID
      const rawId = row.id == null
        ? ""
        : typeof row.id === "object" && "id" in (row.id as object)
          ? String((row.id as any).id)
          : String(row.id);
      const type = rawId.replace(/^salience_centroids:/, "");
      map.set(type, row.embedding);
    }
    return map;
  } catch (err) {
    console.warn("fetchSalienceCentroids: query failed, returning empty map:", err);
    return new Map();
  }
}
