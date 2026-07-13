/**
 * Rúnir-h435.1 Unit B — B-2 durable orchestration against REAL native SurrealDB.
 *
 * Boundary: REAL arbitrateWrite with shadow ON → query all four tables.
 * Failure injections (c)/(d1)/(d2) via vi.spyOn on atomic-shadow-store writers only.
 * findSimilarMemories mocked for candidate injection; other applied DB writers may be
 * real or stubbed — supersede/upsert hit stubbed path when surreal-store is partially
 * mocked... For live durable orchestration we need REAL writers for atomic tables and
 * REAL logSupersedeShadow, but findSimilarMemories must inject candidates.
 *
 * Pattern: mock ONLY findSimilarMemories (and optionally supersede/upsert/update to
 * avoid writing semiote), leave atomic-shadow-store REAL, leave logSupersedeShadow REAL.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash } from "node:crypto";

// F9: no dag-guard mock — supersedeMemory is stubbed so dag-guard never runs;
// live supersede path is stubbed; real DB still exercises real writers for atomic tables.

// Partial mock: only the candidate-injection + applied mutation boundaries.
// logSupersedeShadow stays REAL (imported after mock with spy option).
const findSimilarMemories = vi.fn().mockResolvedValue([]);
const supersedeMemory = vi.fn().mockResolvedValue(undefined);
const updateMemoryText = vi.fn().mockResolvedValue(undefined);
const upsertMemory = vi.fn().mockResolvedValue("new-id");

vi.mock("../../surreal/surreal-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../surreal/surreal-store.js")>();
  return {
    ...actual,
    findSimilarMemories: (...args: unknown[]) => findSimilarMemories(...args),
    supersedeMemory: (...args: unknown[]) => supersedeMemory(...args),
    updateMemoryText: (...args: unknown[]) => updateMemoryText(...args),
    upsertMemory: (...args: unknown[]) => upsertMemory(...args),
  };
});

import { arbitrateWrite } from "../write-arbitrator.js";
import { SurrealClient } from "../../surreal/surreal-store.js";
import * as atomicStore from "../../surreal/atomic-shadow-store.js";
import {
  ATOMIC_SHADOW_ATTEMPT_TABLE,
  ATOMIC_SHADOW_EVENT_TABLE,
  ATOMIC_SHADOW_NOMINATION_TABLE,
} from "../../surreal/shadow-schema.js";
import type { SimilarCandidate } from "../../../domain/memory/types.js";

const TEST_DB = "h435_1_unit_b_durable_orch_test";

function makeDb(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(
  o: Partial<SimilarCandidate> & { l2: string; similarity: number },
): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "cand-1", createdAt: now, updatedAt: now, ...o };
}
function clearAllFlags() {
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_ADDITIVE_SKIP_GUARD;
  delete process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD;
  delete process.env.RUNIR_SUPERSEDE_JUDGE_GATE;
  delete process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM;
  delete process.env.RUNIR_SUPERSEDE_CANDIDATE_FLOOR;
  delete process.env.RUNIR_SUPERSEDE_SHADOW;
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
}

const ATOMIC_FACT_BASE = { subject: "Atlas datastore", predicate: "primary_engine" };

let db: SurrealClient;
let dbAvailable = false;

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    console.log(
      JSON.stringify({
        step: "B-2-durable",
        status: "skip",
        detail: "native SurrealDB 127.0.0.1:8000 unreachable — not starting Docker",
      }),
    );
    return;
  }
  await atomicStore.ensureAtomicShadowTables(db);
  const { ensureSupersedeShadowTable } = await import("../../surreal/surreal-store.js");
  await ensureSupersedeShadowTable(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAllFlags();
  process.env.RUNIR_SUPERSEDE_SHADOW = "1";
  findSimilarMemories.mockResolvedValue([]);
  supersedeMemory.mockResolvedValue(undefined);
  updateMemoryText.mockResolvedValue(undefined);
  upsertMemory.mockResolvedValue("new-id");
});
afterEach(() => {
  clearAllFlags();
  vi.restoreAllMocks();
});

describe("B-2 durable orchestration (native SurrealDB)", () => {
  it("B-2(i) safety activation + multiple F1 noms → four tables, exact set, finalized, selection_hash", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const cBest = makeCandidate({
      id: "nom-best",
      l2: "primary engine: SurrealDB for Atlas",
      similarity: 0.95,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const cOther = makeCandidate({
      id: "nom-other",
      l2: "primary engine: RocksDB for Atlas",
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "RocksDB" },
    });
    findSimilarMemories.mockResolvedValue([cBest, cOther]);
    const embedding = makeVec(0);
    await arbitrateWrite({
      db,
      text: "primary engine: Dragonfly for Atlas",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });

    // Allow fire-and-forget supersede_shadow
    await new Promise((r) => setTimeout(r, 250));

    // Scope THIS write via unique nomination candidate id (not prior rows).
    const widLookup = await db.query(
      `SELECT write_event_id, occurred_at FROM ${ATOMIC_SHADOW_NOMINATION_TABLE}
        WHERE nomination_candidate_id = 'nom-best'
        ORDER BY occurred_at DESC LIMIT 1;`,
    );
    const wid = (widLookup as any)?.[0]?.[0]?.write_event_id as string;
    expect(wid).toBeTruthy();

    // F10: EXACTLY ONE attempt / event / supersede_shadow row for THIS write_event_id.
    const attempts = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} WHERE write_event_id = $wid;`,
      { wid },
    );
    const attemptRows = ((attempts as any)?.[0] ?? []) as any[];
    expect(attemptRows.length).toBe(1);
    const attempt = attemptRows[0];
    expect(attempt.activation_class).toBe("safety_activation");
    expect(attempt.finalized).toBe(true);
    expect(attempt.finalized_at).toBeTruthy();

    const manifest = JSON.parse(attempt.nomination_manifest_keys) as string[];
    expect(manifest.length).toBeGreaterThanOrEqual(2);

    const noms = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid;`,
      { wid },
    );
    const nomRows = ((noms as any)?.[0] ?? []) as any[];
    const nomIds = nomRows.map((r) => r.nomination_candidate_id as string);
    // persisted count === manifest count === unique pair-key count (no post-hoc dedup)
    expect(nomRows.length).toBe(manifest.length);
    expect(new Set(nomIds).size).toBe(manifest.length);
    expect(new Set(nomIds)).toEqual(new Set(manifest));

    // selection_hash recomputes from pair_key
    const expectedHash = createHash("sha256").update(attempt.pair_key as string).digest("hex");
    expect(attempt.selection_hash).toBe(expectedHash);

    const events = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_EVENT_TABLE} WHERE write_event_id = $wid;`,
      { wid },
    );
    expect(((events as any)?.[0] ?? []).length).toBe(1);

    const shadows = await db.query(
      `SELECT write_event_id FROM supersede_shadow WHERE write_event_id = $wid;`,
      { wid },
    );
    const shadowHits = (shadows as any)?.[0] ?? [];
    expect(shadowHits.length).toBe(1);
    expect(shadowHits[0].write_event_id).toBe(wid);
  });

  it("B-2(ii) disposition matrix: proven-retired + proven-not-selected; anchor-vetoed", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const cBest = makeCandidate({
      id: "disp-best",
      l2: "primary engine: SurrealDB for Atlas",
      similarity: 0.95,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const cOther = makeCandidate({
      id: "disp-other",
      l2: "primary engine: RocksDB for Atlas",
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "RocksDB" },
    });
    // Anchor-conflict candidate: different GH issue anchors but same statement key shape
    const cConflict = makeCandidate({
      id: "disp-conflict",
      l2: "primary engine: Memcached for Atlas GH#99",
      similarity: 0.87,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "Memcached" },
    });
    findSimilarMemories.mockResolvedValue([cBest, cOther, cConflict]);
    const embedding = makeVec(0);
    // Incoming carries GH#8 so conflict with GH#99
    await arbitrateWrite({
      db,
      text: "primary engine: Dragonfly for Atlas GH#8",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    const attempts = await db.query(
      `SELECT write_event_id, nomination_manifest_keys, occurred_at FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} ORDER BY occurred_at DESC LIMIT 1;`,
    );
    const att = (attempts as any)?.[0]?.[0];
    expect(att).toBeTruthy();
    const wid = att.write_event_id as string;
    const noms = await db.query(
      `SELECT nomination_candidate_id, disposition, selected_candidate_id, selected_signal FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid;`,
      { wid },
    );
    const rows = ((noms as any)?.[0] ?? []) as any[];
    const byId = Object.fromEntries(rows.map((r) => [r.nomination_candidate_id, r]));
    // F10: UNCONDITIONAL asserts per fixture — all three nominations must exist.
    expect(byId["disp-best"]).toBeTruthy();
    expect(byId["disp-best"].disposition).toBe("proven-retired");
    expect(byId["disp-other"]).toBeTruthy();
    expect(byId["disp-other"].disposition).toBe("proven-not-selected");
    expect(byId["disp-other"].selected_candidate_id).toBe("disp-best");
    expect(byId["disp-other"].selected_signal).toBeTruthy();
    expect(byId["disp-conflict"]).toBeTruthy();
    expect(byId["disp-conflict"].disposition).toBe("anchor-vetoed");
  });

  it("B-2(ii) mixed F1/F2 where F2 wins: F1 nomination persists with true disposition", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // R3 STRICT: higher-sim F2 (marker+slot tags) deterministically wins selection;
    // lower-sim atomic-proven F1 still nominates and must persist as proven-not-selected
    // with selected_candidate_id === F2 and the F2 signal string. No disposition unions.
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
    const f2 = makeCandidate({
      id: "mixed-f2",
      l2: "cache backend: redis for sessions",
      similarity: 0.95,
      tags: ["slot:cache", "subject:sessions"],
    });
    const f1 = makeCandidate({
      id: "mixed-f1",
      l2: "primary engine: SurrealDB for Atlas",
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    findSimilarMemories.mockResolvedValue([f2, f1]);
    const embedding = makeVec(0);
    const r = await arbitrateWrite({
      db,
      // F1 still nominates (wouldSupersedeTexts on primary-engine pair + atomic proof);
      // F2 wins selection via shared slot tags + update marker at higher similarity.
      text: "primary engine: Dragonfly for Atlas",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["slot:cache", "subject:sessions", "update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    await new Promise((res) => setTimeout(res, 150));

    // Applied selected candidate IS F2 (deterministic win by higher similarity).
    expect(r.outcome).toBe("supersede");
    expect(r.matchedMemoryId).toBe("mixed-f2");
    expect(r.reason).toContain("extractor_correction:slot");

    const attempts = await db.query(
      `SELECT write_event_id, occurred_at FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} ORDER BY occurred_at DESC LIMIT 1;`,
    );
    const att = (attempts as any)?.[0]?.[0];
    expect(att).toBeTruthy();
    const wid = att.write_event_id as string;

    const events = await db.query(
      `SELECT applied_matched_id, isolated_matched_id, isolated_outcome FROM ${ATOMIC_SHADOW_EVENT_TABLE} WHERE write_event_id = $wid;`,
      { wid },
    );
    const ev = (events as any)?.[0]?.[0];
    expect(ev).toBeTruthy();
    expect(ev.applied_matched_id).toBe("mixed-f2");
    expect(ev.isolated_matched_id).toBe("mixed-f2");
    expect(ev.isolated_outcome).toBe("supersede");

    const noms = await db.query(
      `SELECT nomination_candidate_id, disposition, selected_candidate_id, selected_signal FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid;`,
      { wid },
    );
    const rows = ((noms as any)?.[0] ?? []) as any[];
    const byId = Object.fromEntries(rows.map((row) => [row.nomination_candidate_id, row]));
    // F1 nomination persists with EXACT disposition proven-not-selected + F2 selection.
    expect(byId["mixed-f1"]).toBeTruthy();
    expect(byId["mixed-f1"].disposition).toBe("proven-not-selected");
    expect(byId["mixed-f1"].selected_candidate_id).toBe("mixed-f2");
    expect(byId["mixed-f1"].selected_signal).toBe("extractor_correction:slot");
  });

  it("B-2(iii) packet reject → unfinalized; silent-drop (d1); wrong-member (d2)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    const cBest = makeCandidate({
      id: "fail-best",
      l2: "primary engine: SurrealDB for Atlas",
      similarity: 0.95,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const cOther = makeCandidate({
      id: "fail-other",
      l2: "primary engine: RocksDB for Atlas",
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "RocksDB" },
    });

    // (c) event-packet writer rejects
    const eventSpy = vi
      .spyOn(atomicStore, "createAtomicShadowEvent")
      .mockRejectedValueOnce(new Error("packet fail"));
    findSimilarMemories.mockResolvedValue([cBest, cOther]);
    const embedding = makeVec(0);
    await arbitrateWrite({
      db,
      text: "primary engine: Dragonfly for Atlas",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    eventSpy.mockRestore();
    await new Promise((r) => setTimeout(r, 100));
    const a1 = await db.query(
      `SELECT finalized, occurred_at FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} ORDER BY occurred_at DESC LIMIT 1;`,
    );
    expect((a1 as any)?.[0]?.[0]?.finalized).toBe(false);

    // (d1) SILENT DROP: nomination writer resolves but skips one row
    const realNom = atomicStore.createAtomicShadowNomination.bind(atomicStore);
    let dropOnce = true;
    const nomSpy = vi
      .spyOn(atomicStore, "createAtomicShadowNomination")
      .mockImplementation(async (d, params) => {
        if (dropOnce && params.nominationCandidateId === "fail-other") {
          dropOnce = false;
          return; // silent drop — resolves, no row
        }
        return realNom(d, params);
      });
    findSimilarMemories.mockResolvedValue([cBest, cOther]);
    await arbitrateWrite({
      db,
      text: "primary engine: Dragonfly for Atlas",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    nomSpy.mockRestore();
    await new Promise((r) => setTimeout(r, 100));
    const a2 = await db.query(
      `SELECT finalized, write_event_id, nomination_manifest_keys, occurred_at FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} ORDER BY occurred_at DESC LIMIT 1;`,
    );
    const att2 = (a2 as any)?.[0]?.[0];
    expect(att2.finalized).toBe(false);
    // Read-back set ≠ manifest
    const manifest2 = JSON.parse(att2.nomination_manifest_keys) as string[];
    const n2 = await db.query(
      `SELECT nomination_candidate_id FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid;`,
      { wid: att2.write_event_id },
    );
    const ids2 = new Set(
      (((n2 as any)?.[0] ?? []) as any[]).map((r) => r.nomination_candidate_id),
    );
    expect(ids2.size).not.toBe(manifest2.length);

    // (d2) SAME-CARDINALITY wrong-member substitution
    const realNom2 = atomicStore.createAtomicShadowNomination.bind(atomicStore);
    let subOnce = true;
    const nomSpy2 = vi
      .spyOn(atomicStore, "createAtomicShadowNomination")
      .mockImplementation(async (d, params) => {
        if (subOnce && params.nominationCandidateId === "fail-other") {
          subOnce = false;
          return realNom2(d, {
            ...params,
            nominationCandidateId: "WRONG-SUBSTITUTE-ID",
          });
        }
        return realNom2(d, params);
      });
    findSimilarMemories.mockResolvedValue([cBest, cOther]);
    await arbitrateWrite({
      db,
      text: "primary engine: Dragonfly for Atlas",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    nomSpy2.mockRestore();
    await new Promise((r) => setTimeout(r, 100));
    const a3 = await db.query(
      `SELECT finalized, write_event_id, nomination_manifest_keys, occurred_at FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} ORDER BY occurred_at DESC LIMIT 1;`,
    );
    const att3 = (a3 as any)?.[0]?.[0];
    expect(att3.finalized).toBe(false); // count-only finalizer would wrongly finalize
    const manifest3 = new Set(JSON.parse(att3.nomination_manifest_keys) as string[]);
    const n3 = await db.query(
      `SELECT nomination_candidate_id FROM ${ATOMIC_SHADOW_NOMINATION_TABLE} WHERE write_event_id = $wid;`,
      { wid: att3.write_event_id },
    );
    const ids3 = new Set(
      (((n3 as any)?.[0] ?? []) as any[]).map((r) => r.nomination_candidate_id as string),
    );
    // Same cardinality possible, but sets differ
    expect(ids3.size).toBe(manifest3.size);
    let setsEqual = ids3.size === manifest3.size;
    for (const id of manifest3) {
      if (!ids3.has(id)) setsEqual = false;
    }
    expect(setsEqual).toBe(false);
  });

  it("B-2(iv) efficacy_only: pair_key/selection_hash/retired_candidate_id are NONE", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    // Flag ON so applied AND isolated both supersede same target → not safety, but
    // multi-nomination still yields efficacy_only if... actually if both supersede same
    // target, activationClass is null for safety; with ≥1 nomination → efficacy_only.
    process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1";
    const cBest = makeCandidate({
      id: "eff-best",
      l2: "primary engine: SurrealDB for Atlas",
      similarity: 0.95,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "SurrealDB" },
    });
    const cOther = makeCandidate({
      id: "eff-other",
      l2: "primary engine: RocksDB for Atlas",
      similarity: 0.88,
      atomicFact: { ...ATOMIC_FACT_BASE, value: "RocksDB" },
    });
    findSimilarMemories.mockResolvedValue([cBest, cOther]);
    const embedding = makeVec(0);
    await arbitrateWrite({
      db,
      text: "primary engine: Dragonfly for Atlas",
      userId: "u-b2",
      embedding,
      scope: "user",
      source: "memory_store",
      recentWrites: new Map(),
      embedText: vi.fn().mockResolvedValue(embedding),
      metadata: {
        tags: ["update"],
        atomicFact: { ...ATOMIC_FACT_BASE, value: "Dragonfly" },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const attempts = await db.query(
      `SELECT * FROM ${ATOMIC_SHADOW_ATTEMPT_TABLE} WHERE activation_class = 'efficacy_only' ORDER BY occurred_at DESC LIMIT 5;`,
    );
    const att = (attempts as any)?.[0]?.[0];
    expect(att).toBeTruthy();
    expect(att.pair_key == null || att.pair_key === undefined).toBe(true);
    expect(att.selection_hash == null || att.selection_hash === undefined).toBe(true);
    expect(att.retired_candidate_id == null || att.retired_candidate_id === undefined).toBe(
      true,
    );
    expect(att.nomination_manifest_count).toBeGreaterThanOrEqual(1);
  });
});
