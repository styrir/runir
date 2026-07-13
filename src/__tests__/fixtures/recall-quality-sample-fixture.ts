/**
 * Regression fixtures from docs/runir-recall-quality-sample.md.
 * Each fixture reproduces a documented recall quality failure.
 */
import type { SearchHit } from "../../domain/memory/types";

export const STALE_SCHEMA_HIT: SearchHit = {
  id: "stale-schema-1",
  text: "Memory schema fields include embedding (vector), payload.data (text), payload.createdAt/updatedAt, payload.userId, payload.hash, and tags.",
  score: 0.88,
  category: "entities",
  createdAt: "2026-03-05T00:00:00Z",
};

export const FRESH_SCHEMA_HIT: SearchHit = {
  id: "fresh-schema-1",
  text: "The memories table uses payload.l2 for full narrative text, payload.l0 for abstract, payload.l1 for summary, payload.category for classification, and payload.tier for lifecycle.",
  score: 0.82,
  category: "entities",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-29T00:00:00Z",
};

export const CONTRADICTION_PAIR = {
  old: {
    id: "arch-old",
    text: "All memory writes are processed through writeWithArbitration() which handles dedup, merge, and supersede decisions.",
    score: 0.85,
    category: "cases" as const,
    createdAt: "2026-03-10T00:00:00Z",
  } satisfies SearchHit,
  new: {
    id: "arch-new",
    text: "The core write arbitration function in runir is named arbitrateWrite, which handles dedup, merge, and supersede decisions.",
    score: 0.87,
    category: "cases" as const,
    path: "/Users/brooks/Code/runir",
    createdAt: "2026-03-29T00:00:00Z",
  } satisfies SearchHit,
};

export const NULL_PATH_NOISE_HIT: SearchHit = {
  id: "noise-1",
  text: "Benchmark finding: Qwen3 30B A3B failed benchmark (NO-GO) on structured extraction tasks with complex JSON schemas.",
  score: 0.75,
  category: "cases",
  // no path — cross-project noise
};

export const STALE_BENCHMARK_HIT: SearchHit = {
  id: "stale-bench-1",
  text: "After resolving a test failure related to character budgets, all 313 tests passed and TypeScript type checking was verified.",
  score: 0.78,
  category: "events",
  createdAt: "2026-03-08T00:00:00Z",
};

export const STALE_BENCHMARK_HIT_258: SearchHit = {
  id: "stale-bench-2",
  text: "All 258 tests passed after the refactor of the extraction pipeline.",
  score: 0.74,
  category: "events",
  createdAt: "2026-03-04T00:00:00Z",
};

export const SESSION_HANDOFF_HIT: SearchHit = {
  id: "handoff-1",
  text: "Session handoff: currently working on current_status/session_opener topical precision for Runir. Next step is implementing deterministic filtering and reranking for active project-state memories.",
  score: 0.78,
  category: "events",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-31T22:00:00Z",
};

export const ACTIVE_RECENT_WORK_HIT: SearchHit = {
  id: "recent-work-1",
  text: "Working on MIM-71 follow-up now: implementing stricter current_status selection rules and testing them against live recall artifacts.",
  score: 0.76,
  category: "events",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-31T21:00:00Z",
};

export const DEPLOY_OPS_HIT: SearchHit = {
  id: "deploy-1",
  text: "The Runir service was successfully deployed to DigitalOcean and is managed by PM2 on port 7700.",
  score: 0.91,
  category: "events",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-31T23:00:00Z",
};

export const SCOUT_BRIEF_HIT: SearchHit = {
  id: "scout-1",
  text: "Scout task initialization: prepare the Builder Brief for current_status recall follow-up work in Runir.",
  score: 0.89,
  category: "events",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-31T23:30:00Z",
};

export const ADMIN_PROCESS_HIT: SearchHit = {
  id: "admin-1",
  text: "Administrative workflow note: run bd prime, update issue status, and push git changes before ending the session.",
  score: 0.87,
  category: "patterns",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-31T23:20:00Z",
};

export const ARCHITECTURE_REFERENCE_HIT: SearchHit = {
  id: "arch-ref-1",
  text: "Architecture note: postProcessRecallResults applies stale demotion, contradiction collapse, and path-aware selection before formatting recall injection.",
  score: 0.74,
  category: "cases",
  path: "/Users/brooks/Code/runir",
  createdAt: "2026-03-30T10:00:00Z",
};
