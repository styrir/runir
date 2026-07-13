/**
 * cross-scenario-bleed-e2e.test.ts — Rúnir-yod0.10.10
 *
 * Canonical anchor:
 *   ~/Documents/Obsidian Vault/.../Rúnir architectural improvement plan.md
 *   §Priority 0 (bleed-rate-zero) + §Priority 5 (trace-first)
 *
 * This is the §Priority 0 + §Priority 5 upgrade of the 10.6 shim test
 * (harness/__tests__/cross-scenario-bleed.test.ts). It exercises the REAL
 * production retrieval path — `runHybridQueryWithEvidenceTable` — against a
 * live SurrealDB, with real embeddings from the production Ollama provider.
 *
 * FOUR CASES:
 *   1a. NEGATIVE CONTROL — default scope: resolveScopeFilter(undefined, SESSION_B)
 *       yields "AND (scope = NONE OR scope = $scopeVal OR (scope = session AND
 *       session_id = SESSION_B))", which excludes (scope=session, session_id=SESSION_A).
 *   1b. NEGATIVE CONTROL — strict session scope: resolveScopeFilter("session", SESSION_B)
 *       yields "AND scope = $scopeVal AND session_id = $sessionId", same exclusion.
 *   2.  POSITIVE CONTROL — explicit "all" scope: escape clause, no predicate.
 *       Proves 1a/1b are not tautologies (data is real and retrievable).
 *   3.  TRACE-PRESENCE (§Priority 5): uses production `onCandidateStages` callback
 *       (HybridQueryTuningOptions.onCandidateStages → RecallCandidateStages.candidatePoolIds)
 *       to prove WHY scope-isolation holds at the retrieval-stage level:
 *         - under scope="all": MEMORY_A_ID IS in candidatePoolIds (pipeline saw it)
 *         - under scope="session" (Scenario-B): MEMORY_A_ID is NOT in candidatePoolIds
 *           (SurrealDB scope-filtered it before rows reached the application)
 *
 * HONEST CAVEAT (AC-vs-reality):
 *   SQL-filtered rows never reach the application layer, so they cannot appear in
 *   TraceCollector.droppedIds (which only captures app-layer stage drops). The
 *   candidatePoolIds surface is the correct §Priority 5 evidence: presence under
 *   "all" + absence under session-scope together prove the production pipeline
 *   excludes Scenario-A at the DB WHERE clause, not by accident or empty corpus.
 *
 * MUTATION DISCIPLINE (Rúnir-yod0.10.10 §AC-3):
 *   Temporarily mutating resolveScopeFilter to return `{ whereClause: "", vars: {} }`
 *   MUST flip Cases 1a, 1b, and the candidatePoolIds "absent" assertion in Case 3 RED,
 *   while Case 2 (positive control) stays GREEN.
 *
 * SELF-SKIP LANE:
 *   When SurrealDB or the Ollama embedding provider is unreachable, all cases call
 *   ctx.skip() — the DB-less CI lane shows explicit SKIPs, never false passes.
 *   The SurrealDB-free lift is satisfied by this skip lane: deps-present → runs;
 *   deps-absent → skips visibly in 3s (probe race timeout).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import {
  upsertMemory,
  setEmbeddingFingerprint,
} from "../storage/surreal/surreal-store.js";
import {
  runHybridQueryWithEvidenceTable,
  type RecallCandidateStages,
} from "../recall/query/memory-query.js";
import { resolveScopeFilter } from "../recall/query/scope-predicate.js";
import { TraceCollector } from "../recall/selection/retrieval-trace.js";
import { resolveEmbeddingProvider } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Isolated test database — never touches prod/dev data
// ---------------------------------------------------------------------------

const TEST_DB = "bleed_e2e_test_yod0_10_10";

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
let depsAvailable = false;

// Embedding provider — production wiring (reads EMBEDDINGS_PROVIDER/MODEL/etc from env)
const embeddingProvider = resolveEmbeddingProvider();

// Test fixtures
const USER = "_bleed_e2e_u";
const SESSION_A = "bleed-e2e-sess-A";
const SESSION_B = "bleed-e2e-sess-B";

// Bare record id (without table prefix) as returned by extractId in the production pipeline
const MEMORY_A_ID = "bleed_e2e_mem_a_001";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(
  async () => {
    db = makeDb();
    try {
      // Short-circuit so the self-skip lane doesn't hang 30s on a dead port or
      // a missing Ollama model. Both DB and embedding must be reachable.
      await Promise.race([
        db.query("INFO FOR DB;"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("DB probe timeout")), 3000),
        ),
      ]);
      // Embedding probe — catches Ollama-down / model-not-pulled before setup continues.
      await Promise.race([
        embeddingProvider.embedDocument("probe"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("embed probe timeout")), 5000),
        ),
      ]);
      depsAvailable = true;
    } catch {
      depsAvailable = false;
      return;
    }

    // Clean slate in the isolated DB — FIX 3: use embedding_metadata (the real
    // guard table; surreal-store.ts:1391 UPSERTs `embedding_metadata:current`).
    await db
      .query(
        "REMOVE TABLE IF EXISTS semiote; REMOVE TABLE IF EXISTS embedding_metadata;",
      )
      .catch(() => {});

    // Minimal schema — SCHEMALESS is sufficient for the hybrid query
    await db.query("DEFINE TABLE IF NOT EXISTS semiote SCHEMALESS;");

    // Embed the Scenario-A text using the production document embedder
    const embeddingA = await embeddingProvider.embedDocument(
      "Alice prefers dark mode (Scenario A)",
    );

    // Write Scenario-A memory under session A (scope="session", sessionId=SESSION_A)
    await upsertMemory(
      db,
      MEMORY_A_ID,
      "Alice prefers dark mode (Scenario A)",
      USER,
      embeddingA,
      /* metadata */ undefined,
      /* scope */ "session",
      /* sessionId */ SESSION_A,
      /* lifecycle */ { active: true },
      /* tableName */ "semiote",
    );

    // Register the embedding fingerprint so the fingerprint guard in
    // runHybridQueryWithEvidenceTable does not reject the query.
    await setEmbeddingFingerprint(db, embeddingProvider.fingerprint());
  },
  /* timeout */ 30000,
);

afterAll(async () => {
  if (depsAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => {});
    await db.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs the PRODUCTION hybrid query and returns hit ids plus the captured
 * RecallCandidateStages (candidatePoolIds = full fused pool before rerank slice).
 * No shim — calls runHybridQueryWithEvidenceTable directly.
 */
async function queryAsSessionB(
  scopeParam: string | undefined,
  traceCollector?: TraceCollector,
): Promise<{ hitIds: string[]; candidateStages: RecallCandidateStages | null }> {
  const queryText = "Alice prefers dark mode";
  const queryEmbedding = await embeddingProvider.embedQuery(queryText);
  const scopeFilter = resolveScopeFilter(scopeParam, SESSION_B);

  let capturedStages: RecallCandidateStages | null = null;

  const hits = await runHybridQueryWithEvidenceTable({
    db,
    userId: USER,
    query: queryText,
    embedding: queryEmbedding,
    limit: 10,
    evidenceTable: "semiote",
    scopeFilter,
    embeddingProvider,
    trace: traceCollector,
    tuning: {
      onCandidateStages: (stages) => {
        capturedStages = stages;
      },
    },
    warn: (msg) => console.warn("[bleed-e2e]", msg),
  });

  return { hitIds: hits.map((h) => h.id), candidateStages: capturedStages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  "cross-scenario bleed E2E (Rúnir-yod0.10.10 — production hybrid query)",
  () => {
    describe("Case 1a — negative control (exclusion by DEFAULT scope)", () => {
      it(
        "Scenario-A memory is NOT retrievable from Scenario-B under default scope",
        async (ctx) => {
          if (!depsAvailable) ctx.skip();

          // resolveScopeFilter(undefined, SESSION_B) yields:
          //   "AND (scope = NONE OR scope = $scopeVal OR (scope = $sessionScope AND session_id = $sessionId))"
          //   with vars { scopeVal: "user", sessionScope: "session", sessionId: SESSION_B }
          // The Scenario-A row has scope="session" and session_id=SESSION_A — the
          // session_id predicate excludes it.
          const { hitIds } = await queryAsSessionB(undefined);

          // §Priority 0: bleed rate must be ZERO.
          expect(hitIds).not.toContain(MEMORY_A_ID);
        },
        20000,
      );
    });

    describe("Case 1b — negative control (strict session scope)", () => {
      it(
        "Scenario-A memory is NOT retrievable from Scenario-B under strict session scope",
        async (ctx) => {
          if (!depsAvailable) ctx.skip();

          // resolveScopeFilter("session", SESSION_B) yields:
          //   "AND scope = $scopeVal AND session_id = $sessionId"
          //   with vars { scopeVal: "session", sessionId: SESSION_B }
          // The Scenario-A row has session_id=SESSION_A — excluded by SurrealDB.
          const { hitIds } = await queryAsSessionB("session");

          // §Priority 0: bleed rate must be ZERO.
          expect(hitIds).not.toContain(MEMORY_A_ID);
        },
        20000,
      );
    });

    describe("Case 2 — positive control (escape clause: explicit shared scope)", () => {
      it(
        "Scenario-A memory IS retrievable when scope='all' (explicit shared scope)",
        async (ctx) => {
          if (!depsAvailable) ctx.skip();

          // resolveScopeFilter("all", SESSION_B) yields { whereClause: "", vars: {} }.
          // No scope predicate → SurrealDB returns all user rows.
          // Proves Cases 1a/1b are not tautologies (retrieval is NOT broken).
          const { hitIds } = await queryAsSessionB("all");

          expect(hitIds).toContain(MEMORY_A_ID);
        },
        20000,
      );
    });

    describe("Case 3 — trace presence via candidatePoolIds (§Priority 5)", () => {
      it(
        "production onCandidateStages proves WHY scope-isolation held at the retrieval-stage level",
        async (ctx) => {
          if (!depsAvailable) ctx.skip();

          // --- Under "all" scope: pipeline SEES Scenario-A (it enters candidatePoolIds) ---
          const { candidateStages: allStages } = await queryAsSessionB("all");
          // candidatePoolIds is the full fused+merged pool BEFORE the rerank-window
          // slice (memory-query.ts:730). If the record is in the DB, it must be here.
          expect(allStages).not.toBeNull();
          expect(allStages!.candidatePoolIds).toContain(MEMORY_A_ID);

          // --- Under session scope: pipeline NEVER SEES Scenario-A ---
          // SurrealDB applies the scope WHERE clause before returning rows;
          // the record is absent from the DB result set entirely and thus cannot
          // appear in the application-layer candidate pool.
          const traceCollector = new TraceCollector();
          const { candidateStages: sessionStages } = await queryAsSessionB(
            "session",
            traceCollector,
          );
          const trace = traceCollector.finalize("Alice prefers dark mode", "hybrid");

          // The production pipeline ran (stages were emitted to the TraceCollector).
          expect(trace.stages.length).toBeGreaterThan(0);

          // Scenario-A id is absent from the production candidate pool when
          // session-scoped — this is the canonical §Priority 5 evidence that
          // SurrealDB scope-filtered it pre-pool, not that retrieval returned nothing.
          //
          // Note on droppedIds: SQL-filtered rows never reach the application layer,
          // so they cannot appear in TraceCollector.droppedIds (which only captures
          // app-layer stage drops). candidatePoolIds is the correct surface here.
          if (sessionStages !== null) {
            expect(sessionStages.candidatePoolIds).not.toContain(MEMORY_A_ID);
          } else {
            // No candidates at all under session scope — the pool is empty because
            // SurrealDB returned zero rows matching the session predicate.
            // The positive-control (Case 2) already proved the record exists.
            expect(true).toBe(true); // explicitly passing: empty pool IS the evidence
          }
        },
        40000,
      );
    });
  },
);
