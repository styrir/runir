/**
 * test-seed.ts — Code-377
 * Curated seed dataset for NS:test/DB:test pipeline testing.
 * ~40 fixed-UUID memories across 3 clusters + singletons + superseded pool.
 * ~15 entity records with entity_edges for co-occurrence clustering.
 */

import { RecordId } from "surrealdb";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

export interface SeedMemory {
  id: string;               // seed-<cluster>-<N>
  l2: string;               // full-text memory (20-100 words)
  l0: string;               // headline (empty string = needs enrichment)
  l1: string;               // structured markdown (empty string = needs enrichment)
  category: string;
  tier: string;
  confidence: number;
  scope: string;
  userId: string;
  writeSource: string;
  tags: string[];
  createdAt: string;
  active: boolean;
}

export interface SeedEntity {
  id: string;               // stable slug
  kind: string;
  canonicalName: string;
  nameNorm: string;
  description: string;
  sourceProject: string;
  confidence: number;
  userId: string;
  scope: string;
}

// ---------------------------------------------------------------------------
// Fixed timestamps (deterministic)
// ---------------------------------------------------------------------------
const T0 = "2026-01-15T10:00:00.000Z";
const T1 = "2026-01-16T10:00:00.000Z";
const T2 = "2026-01-17T10:00:00.000Z";
const T3 = "2026-01-18T10:00:00.000Z";
const T4 = "2026-01-19T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Cluster A — SurrealDB (8 memories)
// entities: SurrealDB, RELATE, entity_edges
// ---------------------------------------------------------------------------
const CLUSTER_A: SeedMemory[] = [
  // 4x category:cases, writeSource:session_summary, l0/l1 empty (needs enrichment)
  {
    id: "seed-surreal-1",
    l2: "SurrealDB RELATE statement maps entity_edges between entities and memories tables. The graph traversal allows querying which memories mention a given entity without a full table scan, making the memory-graph pipeline significantly faster at scale.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["surrealdb", "relate", "entity_edges", "graph"],
    createdAt: T0,
    active: true,
  },
  {
    id: "seed-surreal-2",
    l2: "Using SurrealDB RELATE with type::record() casting in entity_edges avoids string-based record IDs that break under the WebSocket driver. Always cast both in and out sides explicitly when creating graph edges.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["surrealdb", "relate", "entity_edges", "casting"],
    createdAt: T0,
    active: true,
  },
  {
    id: "seed-surreal-3",
    l2: "SurrealDB entity_edges table is defined as TYPE RELATION FROM entities TO entities | memories. This dual target type lets the same edge table model both entity co-occurrence and entity-to-memory mention links in a single RELATE call.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["surrealdb", "entity_edges", "schema", "relation"],
    createdAt: T1,
    active: true,
  },
  {
    id: "seed-surreal-4",
    l2: "SurrealDB RELATE command fails silently when the source record does not exist. To debug, run a SELECT before the RELATE to confirm the source entity_edges record is present, then retry the relation creation.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["surrealdb", "relate", "debugging"],
    createdAt: T1,
    active: true,
  },
  // 2x category:patterns, writeSource:session-end, l0/l1 populated
  {
    id: "seed-surreal-5",
    l2: "Pattern: When SurrealDB queries fail via JS SDK WebSocket, always test the equivalent query over HTTP first. The HTTP and WebSocket drivers diverge on how they parse type::record() and RELATE expressions, so HTTP confirms correctness before debugging the WebSocket path.",
    l0: "SurrealDB: HTTP/WS driver divergence debug pattern",
    l1: "## Trigger\nSurrealDB query fails via JS SDK WebSocket.\n\n## Steps\n1. Reproduce same query over HTTP transport\n2. Compare HTTP vs WebSocket results\n3. If HTTP works, issue is driver-side CBOR encoding\n\n## Resolution\nCheck type::record() casting and RELATE syntax for WS compatibility.",
    category: "patterns",
    tier: "durable",
    confidence: 0.95,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["surrealdb", "pattern", "debugging", "websocket"],
    createdAt: T2,
    active: true,
  },
  {
    id: "seed-surreal-6",
    l2: "Pattern: SurrealDB entity_edges UNIQUE index on (in, out, kind) prevents duplicate RELATE calls. Wrap all RELATE operations in a try/catch that updates the existing edge on unique-constraint violation instead of re-throwing the error.",
    l0: "SurrealDB: RELATE idempotency via UNIQUE index + catch",
    l1: "## Pattern\nRELATE with UNIQUE index on entity_edges prevents duplicates.\n\n## Implementation\n- DEFINE INDEX idx_ee_unique ON TABLE entity_edges COLUMNS in, out, kind UNIQUE\n- Catch unique-constraint error in linkEntityToMemory\n- On conflict: UPDATE lastSeenAt instead of failing",
    category: "patterns",
    tier: "durable",
    confidence: 0.95,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["surrealdb", "entity_edges", "relate", "idempotency"],
    createdAt: T2,
    active: true,
  },
  // 2x category:entities, writeSource:session-end, l0/l1 populated
  {
    id: "seed-surreal-7",
    l2: "SurrealDB is the multi-model database powering the Rúnir memory graph. It provides native graph traversal via RELATE, full-text search with BM25 analyzer, vector similarity search, and a flexible schema with SCHEMAFULL table definitions.",
    l0: "SurrealDB: multi-model DB for Rúnir memory graph",
    l1: "## Entity\nSurrealDB is the primary data store for Rúnir.\n\n## Capabilities\n- Graph: RELATE + entity_edges traversal\n- Search: BM25 full-text + vector cosine similarity\n- Schema: SCHEMAFULL with typed fields",
    category: "entities",
    tier: "durable",
    confidence: 0.88,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["surrealdb", "database", "multi-model"],
    createdAt: T3,
    active: true,
  },
  {
    id: "seed-surreal-8",
    l2: "entity_edges is the SurrealDB relation table that stores RELATE edges between entities and memories. Each edge carries kind, confidence, contextText, and observedAt fields. The UNIQUE index on (in, out, kind) ensures idempotent re-linking.",
    l0: "entity_edges: SurrealDB relation table for graph edges",
    l1: "## Entity\nentity_edges is the graph relation table.\n\n## Fields\n- in: entity record\n- out: entity or memory record\n- kind: 'mentioned_in' | 'co_occurs_with'\n- confidence: float\n- observedAt: datetime",
    category: "entities",
    tier: "working",
    confidence: 0.88,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["entity_edges", "surrealdb", "schema"],
    createdAt: T3,
    active: true,
  },
];

// ---------------------------------------------------------------------------
// Cluster B — Vault Exporter (6 memories)
// entities: vault-exporter, PARA, Obsidian
// ---------------------------------------------------------------------------
const CLUSTER_B: SeedMemory[] = [
  // 3x category:events, writeSource:session_summary, l0/l1 empty
  {
    id: "seed-vault-1",
    l2: "vault-exporter shipped the PARA-aware folder routing: memories route to 01 Projects, 02 Areas, 03 Resources, or 04 Archives based on para_hint. Obsidian picks them up automatically on the next sync.",
    l0: "",
    l1: "",
    category: "events",
    tier: "working",
    confidence: 0.85,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["vault-exporter", "para", "obsidian", "routing"],
    createdAt: T0,
    active: true,
  },
  {
    id: "seed-vault-2",
    l2: "vault-exporter now writes synthesis_notes from SurrealDB directly into the Obsidian PARA vault. Each synthesis note becomes a markdown file with YAML front-matter containing clusterId, tags, and para_placement fields.",
    l0: "",
    l1: "",
    category: "events",
    tier: "working",
    confidence: 0.85,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["vault-exporter", "obsidian", "para", "synthesis"],
    createdAt: T1,
    active: true,
  },
  {
    id: "seed-vault-3",
    l2: "vault-exporter PARA placement logic: if para_hint starts with '01' it goes to Projects, '02' to Areas, '03' to Resources, '04' to Archives. Obsidian Dataview queries use these YAML fields for dashboards.",
    l0: "",
    l1: "",
    category: "events",
    tier: "working",
    confidence: 0.85,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["vault-exporter", "para", "obsidian", "dataview"],
    createdAt: T1,
    active: true,
  },
  // 2x category:cases, writeSource:capture, l0/l1 empty
  {
    id: "seed-vault-4",
    l2: "vault-exporter incorrectly created duplicate Obsidian files when runVaultExport was called twice without clearing the output directory. Fixed by using writeFileSync with the same deterministic filename derived from the synthesis note's clusterId.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.8,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["vault-exporter", "obsidian", "bug-fix", "determinism"],
    createdAt: T2,
    active: true,
  },
  {
    id: "seed-vault-5",
    l2: "vault-exporter PARA folder for superseded memories: always writes to '04 Archives/superseded/' regardless of the memory's original para_hint. This makes archival easy to find and review in Obsidian.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.8,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["vault-exporter", "para", "archives", "superseded"],
    createdAt: T2,
    active: true,
  },
  // 1x category:patterns, writeSource:session-end, l0/l1 populated
  {
    id: "seed-vault-6",
    l2: "Pattern: vault-exporter generates Obsidian-compatible markdown by prefixing each file with YAML front-matter. Include tags, para_placement, clusterId, and createdAt in the front-matter so Dataview queries can filter by any field without parsing the note body.",
    l0: "vault-exporter: YAML front-matter pattern for Obsidian Dataview",
    l1: "## Pattern\nvault-exporter writes YAML front-matter on every exported note.\n\n## Required Fields\n- tags: array\n- para_placement: string (e.g. '03 Resources')\n- clusterId: string\n- createdAt: ISO datetime\n\n## Benefit\nObsidian Dataview queries filter without parsing note body.",
    category: "patterns",
    tier: "durable",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["vault-exporter", "obsidian", "para", "dataview", "pattern"],
    createdAt: T3,
    active: true,
  },
];

// ---------------------------------------------------------------------------
// Cluster C — Gemini Flash (5 memories)
// entities: Gemini Flash, OpenRouter, LLM
// ---------------------------------------------------------------------------
const CLUSTER_C: SeedMemory[] = [
  // 3x category:cases, writeSource:capture, l0/l1 empty
  {
    id: "seed-gemini-1",
    l2: "Gemini Flash via OpenRouter returns structured JSON reliably when the LLM prompt includes a strict schema example. Without the example, the LLM sometimes wraps the JSON in markdown code fences, breaking the parser.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.75,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["gemini-flash", "openrouter", "llm", "json", "structured-output"],
    createdAt: T1,
    active: true,
  },
  {
    id: "seed-gemini-2",
    l2: "OpenRouter rate limits Gemini Flash at 10 requests per minute on the free tier. The Rúnir enrichment pipeline batches LLM calls and adds a 100ms delay between requests to avoid 429 errors from OpenRouter.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.75,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["openrouter", "gemini-flash", "llm", "rate-limit"],
    createdAt: T1,
    active: true,
  },
  {
    id: "seed-gemini-3",
    l2: "Gemini Flash context window is 1M tokens via OpenRouter. For LLM-based memory enrichment, keeping the prompt under 4000 tokens ensures fast response times. Longer prompts noticeably increase latency even though the model supports much larger inputs.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "working",
    confidence: 0.75,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["gemini-flash", "llm", "context-window", "openrouter"],
    createdAt: T2,
    active: true,
  },
  // 2x category:entities, writeSource:session-end, l0/l1 populated
  {
    id: "seed-gemini-4",
    l2: "Gemini Flash is the LLM model used by Rúnir for memory enrichment, entity extraction, and synthesis generation. Accessed via OpenRouter API, it provides fast inference at low cost with reliable JSON-mode output.",
    l0: "Gemini Flash: LLM for Rúnir enrichment via OpenRouter",
    l1: "## Entity\nGemini Flash is the primary LLM in the Rúnir pipeline.\n\n## Usage\n- Memory enrichment: generate l0/l1 from l2\n- Entity extraction: identify named entities\n- Synthesis: cluster summaries\n\n## Access\nOpenRouter API with JSON-mode output.",
    category: "entities",
    tier: "working",
    confidence: 0.82,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["gemini-flash", "llm", "openrouter", "enrichment"],
    createdAt: T3,
    active: true,
  },
  {
    id: "seed-gemini-5",
    l2: "OpenRouter is the LLM routing gateway used to call Gemini Flash and other models. It provides a unified API compatible with the OpenAI SDK, supports model fallbacks, and exposes usage stats. The OPENROUTER_API_KEY env var configures access.",
    l0: "OpenRouter: LLM gateway for Gemini Flash access",
    l1: "## Entity\nOpenRouter routes LLM requests to Gemini Flash and others.\n\n## Config\n- OPENROUTER_API_KEY: required env var\n- Compatible with OpenAI SDK\n\n## Features\nModel fallbacks, usage stats, unified API surface.",
    category: "entities",
    tier: "working",
    confidence: 0.82,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["openrouter", "llm", "gemini-flash", "gateway"],
    createdAt: T3,
    active: true,
  },
];

// ---------------------------------------------------------------------------
// Singleton pool (8 memories — varied, should NOT cluster)
// ---------------------------------------------------------------------------
const SINGLETONS: SeedMemory[] = [
  // 1x profile, writeSource:session-end, l0/l1 populated
  {
    id: "seed-single-1",
    l2: "Test user is a software engineer focused on TypeScript and distributed systems. Primary project is Rúnir, a memory-graph system for AI agents. Prefers clean architecture with clear module boundaries.",
    l0: "Test User: TypeScript engineer, Rúnir project",
    l1: "## Identity\nSoftware engineer, TypeScript and distributed systems.\n\n## Project\nRúnir: memory-graph for AI agents.\n\n## Style\nClean architecture, clear module boundaries.",
    category: "profile",
    tier: "durable",
    confidence: 0.95,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["profile", "typescript", "runir"],
    createdAt: T0,
    active: true,
  },
  // 1x preferences, writeSource:session-end, l0/l1 populated
  {
    id: "seed-single-2",
    l2: "Test user prefers verbose test descriptions in Vitest using describe/it blocks with full sentences. Test files should cover happy path, edge cases, and error cases in separate describe groups.",
    l0: "Code preference: verbose Vitest describe/it blocks",
    l1: "## Preference Domain\nTesting with Vitest.\n\n## Details\n- Use describe/it with full sentence descriptions\n- Group: happy path, edge cases, error cases\n- Prefer explicit assertions over snapshot tests",
    category: "preferences",
    tier: "durable",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["preferences", "vitest", "testing"],
    createdAt: T0,
    active: true,
  },
  // 2x cases, confidence:0.6, writeSource:capture, l0/l1 empty (just above threshold)
  {
    id: "seed-single-3",
    l2: "Hono framework middleware order matters: global middleware registered with app.use('*') runs before route-specific handlers. Auth middleware must be registered before admin routes to prevent bypass.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "ephemeral",
    confidence: 0.6,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["hono", "middleware", "auth"],
    createdAt: T2,
    active: true,
  },
  {
    id: "seed-single-4",
    l2: "Vitest mock cleanup: always call vi.clearAllMocks() in beforeEach to prevent test state leaking between test cases. Stale mocks from previous tests cause hard-to-debug failures in async tests.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "ephemeral",
    confidence: 0.6,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["vitest", "mocks", "testing"],
    createdAt: T2,
    active: true,
  },
  // 2x cases, confidence:0.4, writeSource:capture, l0/l1 empty (below threshold → inbox)
  {
    id: "seed-single-5",
    l2: "Maybe worth looking into whether bun compile produces smaller binaries than the current node distribution approach for the Rúnir service.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "ephemeral",
    confidence: 0.4,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["bun", "distribution"],
    createdAt: T3,
    active: true,
  },
  {
    id: "seed-single-6",
    l2: "Considered using Drizzle ORM for SurrealDB but it does not support graph queries yet, so staying with raw SurrealQL.",
    l0: "",
    l1: "",
    category: "cases",
    tier: "ephemeral",
    confidence: 0.4,
    scope: "user",
    userId: "test-user",
    writeSource: "capture",
    tags: ["drizzle", "surrealdb", "orm"],
    createdAt: T3,
    active: true,
  },
  // 2x events, confidence:0.85, writeSource:session_summary, unique entities
  {
    id: "seed-single-7",
    l2: "Deployed Rúnir service to DigitalOcean droplet via PM2. The ecosystem.config.cjs sets all required env vars. PM2 auto-restarts on crash and persists across reboots with pm2 startup.",
    l0: "",
    l1: "",
    category: "events",
    tier: "working",
    confidence: 0.85,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["deployment", "digitalocean", "pm2"],
    createdAt: T4,
    active: true,
  },
  {
    id: "seed-single-8",
    l2: "Completed integration test pass: all 994 Vitest tests pass after adding the entity-store module. The test suite runs in under 30 seconds on the dev machine.",
    l0: "",
    l1: "",
    category: "events",
    tier: "working",
    confidence: 0.85,
    scope: "user",
    userId: "test-user",
    writeSource: "session_summary",
    tags: ["testing", "integration", "vitest"],
    createdAt: T4,
    active: true,
  },
];

// ---------------------------------------------------------------------------
// Superseded pool (4 memories, active:false)
// ---------------------------------------------------------------------------
const SUPERSEDED: SeedMemory[] = [
  // 2x should appear in 04 Archives/superseded
  {
    id: "seed-super-1",
    l2: "SurrealDB RELATE statement was first implemented using string-based record IDs, which broke under the WebSocket driver due to CBOR encoding differences.",
    l0: "SurrealDB RELATE: old string-ID approach (superseded)",
    l1: "## Old Approach\nRELATE with string IDs like 'entities:abc'.\n\n## Problem\nCBOR encoding breaks string record IDs over WebSocket.\n\n## Status\nSuperseded by type::record() casting approach.",
    category: "cases",
    tier: "ephemeral",
    confidence: 0.9,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["surrealdb", "relate", "superseded"],
    createdAt: T0,
    active: false,
  },
  {
    id: "seed-super-2",
    l2: "vault-exporter originally wrote all memories to a flat directory without PARA folder structure. This was replaced by the PARA-aware routing system.",
    l0: "vault-exporter: old flat-file approach (superseded)",
    l1: "## Old Approach\nAll files written to a single flat directory.\n\n## Problem\nNo organisation for Obsidian navigation.\n\n## Status\nSuperseded by PARA folder routing.",
    category: "cases",
    tier: "ephemeral",
    confidence: 0.85,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["vault-exporter", "para", "superseded"],
    createdAt: T0,
    active: false,
  },
  // 2x superseded by other records in the seed (test lineage)
  {
    id: "seed-super-3",
    l2: "Gemini Pro was the initial LLM used for memory enrichment before switching to Gemini Flash for lower latency.",
    l0: "LLM: Gemini Pro used before Flash migration",
    l1: "## Old State\nGemini Pro was the enrichment LLM.\n\n## Reason for Change\nGemini Flash provides similar quality at lower latency and cost.\n\n## Superseded By\nseed-gemini-4",
    category: "entities",
    tier: "ephemeral",
    confidence: 0.82,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["llm", "gemini", "superseded"],
    createdAt: T0,
    active: false,
  },
  {
    id: "seed-super-4",
    l2: "entity_edges was initially a separate lookup table (not a RELATION type) queried by joining on string fields. Performance was poor at scale.",
    l0: "entity_edges: old join-table approach (superseded)",
    l1: "## Old Approach\nentity_edges as plain lookup table with string foreign keys.\n\n## Problem\nPoor query performance at scale without native graph traversal.\n\n## Superseded By\nseed-surreal-8 (TYPE RELATION approach)",
    category: "entities",
    tier: "ephemeral",
    confidence: 0.88,
    scope: "user",
    userId: "test-user",
    writeSource: "session-end",
    tags: ["entity_edges", "surrealdb", "superseded"],
    createdAt: T0,
    active: false,
  },
];

// ---------------------------------------------------------------------------
// All seed memories
// ---------------------------------------------------------------------------
export const SEED_MEMORIES: SeedMemory[] = [
  ...CLUSTER_A,
  ...CLUSTER_B,
  ...CLUSTER_C,
  ...SINGLETONS,
  ...SUPERSEDED,
];

// ---------------------------------------------------------------------------
// Seed entities (~15 records)
// ---------------------------------------------------------------------------
export const SEED_ENTITIES: SeedEntity[] = [
  // Cluster A entities
  {
    id: "seed-ent-surrealdb",
    kind: "technology",
    canonicalName: "SurrealDB",
    nameNorm: "surrealdb",
    description: "Multi-model database used by Rúnir for memory graph storage",
    sourceProject: "runir",
    confidence: 0.95,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-relate",
    kind: "concept",
    canonicalName: "RELATE",
    nameNorm: "relate",
    description: "SurrealDB statement for creating graph edges between records",
    sourceProject: "runir",
    confidence: 0.9,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-entity-edges",
    kind: "concept",
    canonicalName: "entity_edges",
    nameNorm: "entity_edges",
    description: "SurrealDB relation table linking entities to memories",
    sourceProject: "runir",
    confidence: 0.9,
    userId: "test-user",
    scope: "user",
  },
  // Cluster B entities
  {
    id: "seed-ent-vault-exporter",
    kind: "component",
    canonicalName: "vault-exporter",
    nameNorm: "vault-exporter",
    description: "Rúnir module that exports memories to Obsidian PARA vault",
    sourceProject: "runir",
    confidence: 0.9,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-para",
    kind: "concept",
    canonicalName: "PARA",
    nameNorm: "para",
    description: "Projects/Areas/Resources/Archives folder organisation for Obsidian",
    sourceProject: "runir",
    confidence: 0.88,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-obsidian",
    kind: "technology",
    canonicalName: "Obsidian",
    nameNorm: "obsidian",
    description: "Markdown knowledge-base application used as vault target",
    sourceProject: "runir",
    confidence: 0.88,
    userId: "test-user",
    scope: "user",
  },
  // Cluster C entities
  {
    id: "seed-ent-gemini-flash",
    kind: "technology",
    canonicalName: "Gemini Flash",
    nameNorm: "gemini flash",
    description: "Google LLM model used for Rúnir enrichment and synthesis",
    sourceProject: "runir",
    confidence: 0.9,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-openrouter",
    kind: "technology",
    canonicalName: "OpenRouter",
    nameNorm: "openrouter",
    description: "LLM routing gateway providing access to Gemini Flash and other models",
    sourceProject: "runir",
    confidence: 0.9,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-llm",
    kind: "concept",
    canonicalName: "LLM",
    nameNorm: "llm",
    description: "Large Language Model — used for enrichment, entity extraction, synthesis",
    sourceProject: "runir",
    confidence: 0.85,
    userId: "test-user",
    scope: "user",
  },
  // Singleton entities (unique — won't cause clustering)
  {
    id: "seed-ent-hono",
    kind: "technology",
    canonicalName: "Hono",
    nameNorm: "hono",
    description: "HTTP framework used by Rúnir service",
    sourceProject: "runir",
    confidence: 0.85,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-vitest",
    kind: "technology",
    canonicalName: "Vitest",
    nameNorm: "vitest",
    description: "Test runner used by Rúnir",
    sourceProject: "runir",
    confidence: 0.85,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-pm2",
    kind: "technology",
    canonicalName: "PM2",
    nameNorm: "pm2",
    description: "Process manager for Rúnir production deployment",
    sourceProject: "runir",
    confidence: 0.8,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-digitalocean",
    kind: "technology",
    canonicalName: "DigitalOcean",
    nameNorm: "digitalocean",
    description: "Cloud host for Rúnir production server",
    sourceProject: "runir",
    confidence: 0.8,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-runir",
    kind: "component",
    canonicalName: "Rúnir",
    nameNorm: "rúnir",
    description: "Memory-graph system for AI agents — the project under development",
    sourceProject: "runir",
    confidence: 0.95,
    userId: "test-user",
    scope: "user",
  },
  {
    id: "seed-ent-typescript",
    kind: "technology",
    canonicalName: "TypeScript",
    nameNorm: "typescript",
    description: "Primary language for Rúnir development",
    sourceProject: "runir",
    confidence: 0.9,
    userId: "test-user",
    scope: "user",
  },
];

// ---------------------------------------------------------------------------
// Entity → memory links (entity_edges)
// Maps entity seed-id to the memory IDs it should link to
// ---------------------------------------------------------------------------
const ENTITY_MEMORY_LINKS: Array<{ entityId: string; memoryIds: string[] }> = [
  // Cluster A: SurrealDB, RELATE, entity_edges → all 8 surreal memories
  { entityId: "seed-ent-surrealdb",    memoryIds: ["seed-surreal-1","seed-surreal-2","seed-surreal-3","seed-surreal-4","seed-surreal-5","seed-surreal-6","seed-surreal-7","seed-surreal-8"] },
  { entityId: "seed-ent-relate",       memoryIds: ["seed-surreal-1","seed-surreal-2","seed-surreal-4","seed-surreal-5","seed-surreal-6"] },
  { entityId: "seed-ent-entity-edges", memoryIds: ["seed-surreal-1","seed-surreal-2","seed-surreal-3","seed-surreal-6","seed-surreal-8"] },
  // Cluster B: vault-exporter, PARA, Obsidian → all 6 vault memories
  { entityId: "seed-ent-vault-exporter", memoryIds: ["seed-vault-1","seed-vault-2","seed-vault-3","seed-vault-4","seed-vault-5","seed-vault-6"] },
  { entityId: "seed-ent-para",           memoryIds: ["seed-vault-1","seed-vault-2","seed-vault-3","seed-vault-5","seed-vault-6"] },
  { entityId: "seed-ent-obsidian",       memoryIds: ["seed-vault-1","seed-vault-2","seed-vault-3","seed-vault-4","seed-vault-6"] },
  // Cluster C: Gemini Flash, OpenRouter, LLM → all 5 gemini memories
  { entityId: "seed-ent-gemini-flash", memoryIds: ["seed-gemini-1","seed-gemini-2","seed-gemini-3","seed-gemini-4","seed-gemini-5"] },
  { entityId: "seed-ent-openrouter",   memoryIds: ["seed-gemini-1","seed-gemini-2","seed-gemini-3","seed-gemini-4","seed-gemini-5"] },
  { entityId: "seed-ent-llm",          memoryIds: ["seed-gemini-1","seed-gemini-2","seed-gemini-3","seed-gemini-4","seed-gemini-5"] },
  // Singletons — unique entity links (no cluster)
  { entityId: "seed-ent-hono",         memoryIds: ["seed-single-3"] },
  { entityId: "seed-ent-vitest",       memoryIds: ["seed-single-4","seed-single-8"] },
  { entityId: "seed-ent-pm2",          memoryIds: ["seed-single-7"] },
  { entityId: "seed-ent-digitalocean", memoryIds: ["seed-single-7"] },
  { entityId: "seed-ent-runir",        memoryIds: ["seed-single-1","seed-single-7","seed-single-8"] },
  { entityId: "seed-ent-typescript",   memoryIds: ["seed-single-1","seed-single-2"] },
];

// ---------------------------------------------------------------------------
// loadSeed — inserts all seed records, returns { memories, entities }
// ---------------------------------------------------------------------------
export async function loadSeed(
  db: SurrealClient,
  _ns?: string,
  _db_name?: string,
): Promise<{ memories: number; entities: number }> {
  const now = new Date().toISOString();

  // Insert memories
  for (const mem of SEED_MEMORIES) {
    await db.query(
      `UPSERT type::record('memories', $id) CONTENT {
        payload: $payload,
        text_norm: $textNorm,
        created_at: <datetime>$createdAt,
        updated_at: <datetime>$createdAt,
        user_id: $userId,
        scope: $scope,
        active: $active
      };`,
      {
        id: mem.id,
        payload: {
          l2: mem.l2,
          l0: mem.l0,
          l1: mem.l1,
          category: mem.category,
          tier: mem.tier,
          confidence: mem.confidence,
          scope: mem.scope,
          userId: mem.userId,
          writeSource: mem.writeSource,
          tags: mem.tags,
          createdAt: mem.createdAt,
          active: mem.active,
        },
        textNorm: mem.l2.toLowerCase().trim(),
        createdAt: mem.createdAt,
        userId: mem.userId,
        scope: mem.scope,
        active: mem.active,
      },
    );
  }

  // Insert entities
  for (const ent of SEED_ENTITIES) {
    await db.query(
      `UPSERT type::record('entities', $id) CONTENT {
        kind: $kind,
        canonicalName: $canonicalName,
        nameNorm: $nameNorm,
        aliases: [],
        aliasesNorm: [],
        description: $description,
        sourceProject: $sourceProject,
        confidence: $confidence,
        userId: $userId,
        scope: $scope,
        firstSeenAt: <datetime>$now,
        lastSeenAt: <datetime>$now,
        createdAt: <datetime>$now,
        updatedAt: <datetime>$now
      };`,
      {
        id: ent.id,
        kind: ent.kind,
        canonicalName: ent.canonicalName,
        nameNorm: ent.nameNorm,
        description: ent.description,
        sourceProject: ent.sourceProject,
        confidence: ent.confidence,
        userId: ent.userId,
        scope: ent.scope,
        now,
      },
    );
  }

  // Insert entity_edges (entity → memory links)
  for (const link of ENTITY_MEMORY_LINKS) {
    for (const memId of link.memoryIds) {
      try {
        await db.query(
          `RELATE $fromRecord -> entity_edges -> $toRecord SET
            kind = "mentioned_in",
            confidence = 0.9,
            observedAt = <datetime>$now,
            lastSeenAt = <datetime>$now,
            sourceProject = "runir",
            scope = "user",
            provenance = "seed";`,
          {
            fromRecord: new RecordId("entities", link.entityId),
            toRecord: new RecordId("memories", memId),
            now,
          },
        );
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.includes("unique") || msg.includes("already exists")) {
          // already exists — safe to ignore during seed
        } else {
          throw err;
        }
      }
    }
  }

  return { memories: SEED_MEMORIES.length, entities: SEED_ENTITIES.length };
}

// ---------------------------------------------------------------------------
// resetSeed — wipe test tables then reload
// ---------------------------------------------------------------------------
export async function resetSeed(
  db: SurrealClient,
  ns?: string,
  db_name?: string,
): Promise<{ memories: number; entities: number }> {
  // Delete all seed records (only seed-* ids to avoid clobbering non-seed data)
  await db.query(`DELETE FROM entity_edges WHERE provenance = "seed";`);
  for (const mem of SEED_MEMORIES) {
    await db.query(
      `DELETE type::record('memories', $id);`,
      { id: mem.id },
    );
  }
  for (const ent of SEED_ENTITIES) {
    await db.query(
      `DELETE type::record('entities', $id);`,
      { id: ent.id },
    );
  }
  return loadSeed(db, ns, db_name);
}
