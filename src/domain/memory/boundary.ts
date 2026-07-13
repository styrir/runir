// Identity & scope-discriminant types for memory records.
//
// This module is the home for Rúnir's boundary/identity primitives — the
// fields that determine which records share a logical "boundary" (per ADR
// 0006, `docs/adr/0006-boundary-equality.md`). The boundary projection,
// `boundaryHash()`, and the `BoundaryRecord` shape itself are introduced
// later in arch1.02.0; this file is named/positioned so they have a home.
//
// The canonical-absent encoding block (CanonicalField, encodeField, boundaryHash)
// lives in `./boundary-hash.ts`; it is re-exported here for backwards compatibility.

export * from "./boundary-hash.js";

export type MemoryRole =
  | "project_state"
  | "current_status"
  | "session_handoff"
  | "recent_work"
  | "debugging_active"
  | "planning_active"
  | "architecture_reference"
  | "research_context"
  | "deploy_ops"
  | "admin_process"
  | "operational_noise";

export const CONTINUITY_MEMORY_ROLES: MemoryRole[] = [
  "project_state",
  "current_status",
  "session_handoff",
  "recent_work",
  "debugging_active",
  "planning_active",
];

export const CONTINUITY_STATE_MEMORY_ROLES: MemoryRole[] = [
  "current_status",
  "session_handoff",
  "debugging_active",
  "planning_active",
];

export function isMemoryRole(value: unknown): value is MemoryRole {
  return typeof value === "string"
    && [
      "project_state",
      "current_status",
      "session_handoff",
      "recent_work",
      "debugging_active",
      "planning_active",
      "architecture_reference",
      "research_context",
      "deploy_ops",
      "admin_process",
      "operational_noise",
    ].includes(value);
}

export function isContinuityMemoryRole(role: MemoryRole | undefined): role is MemoryRole {
  return !!role && CONTINUITY_MEMORY_ROLES.includes(role);
}

export function isContinuityStateMemoryRole(role: MemoryRole | undefined): role is MemoryRole {
  return !!role && CONTINUITY_STATE_MEMORY_ROLES.includes(role);
}

/**
 * Write-time scope persisted on memory records.
 * - "session": visible only within the originating session
 * - "user": visible to the user across all sessions (default for most writes)
 * - "team": visible to members of a specific team (team_id required alongside)
 * - "global": visible to all users (restricted — requires internal caller flag)
 *
 * Team scope was added 2026-05-16 (bead Rúnir-r9pn.3) for harness contract parity.
 * HTTP write-path wiring to accept teamId from clients is intentionally NOT yet
 * implemented — the type + scope predicate + scope-bleed scorer all support team
 * scope so harness scenarios can author against it; production HTTP exposure is
 * a separate concern that can land when the team identity model is fully designed.
 */
export type MemoryScope = "session" | "user" | "team" | "global";

/** Memory category — classifies the nature of the stored fact. */
export type MemoryCategory = "profile" | "preferences" | "entities" | "events" | "cases" | "patterns";

/** Memory tier — classifies durability/importance. */
export type MemoryTier = "durable" | "working" | "ephemeral";

/** Write source — how this memory entered the system. Set by call path, never by LLM. */
export type MemoryWriteSource = "session-end" | "capture" | "agent-write";

/** Shared write sources that feed arbitration. */
export type WriteSource = "memory_store" | "agent_end" | "session_summary";

/**
 * Runtime backing table for primary evidence records.
 *
 * `memories` is retained for legacy compatibility and maintenance utilities;
 * `semiote` is the current operational evidence table. This type intentionally
 * excludes `noema`, which is promoted stable knowledge rather than a primary
 * evidence-row backing table.
 */
export type MemoryRecordTable = "memories" | "semiote";

/**
 * The current-era primary evidence table (Rúnir-ekos). Current code should
 * import this constant rather than repeat the `"semiote"` literal or fall
 * back on an implicit `"memories"` default — `"memories"` string literals
 * are reserved for intentional legacy-table surfaces (admin enrich/backfill
 * routes, legacy compaction/synthesis paths), which spell it out explicitly
 * with a comment rather than relying on a parameter default.
 */
export const PRIMARY_MEMORY_TABLE: MemoryRecordTable = "semiote";

/** How the project identity was resolved for a session. */
export type ProjectIdentitySource = "explicit" | "git" | "path-fallback" | "absent";

// --- MIM-24: Entity graph identity types ---
//
// Entity-graph kinds are domain discriminants alongside `MemoryRole` /
// `MemoryCategory`; the corresponding records (`EntityRecord`, `EntityEdge`,
// `EntityMention`) describe identity-bearing nodes/edges in the graph and
// keep their boundary primitives co-located here.

export type EntityKind = "person" | "org" | "concept" | "location" | "event";

export type ConceptSubtype = "narrative" | "topic" | "technology" | "policy" | "product";

export type EdgeKind =
  | "mentioned_in"
  | "affiliated_with"
  | "participates_in"
  | "located_in"
  | "references"
  | "supports"
  | "opposes"
  | "related_to";

export type VardaClassification = {
  position?: string;
  loyalty?: string;
  ethnos?: string;
};

export type EntityRecord = {
  id?: string;
  kind: EntityKind;
  canonicalName: string;
  nameNorm: string;
  aliases: string[];
  aliasesNorm: string[];
  /** Stamped by entity-alias-enricher when LLM alias enrichment last persisted
   *  (snake_case matches the stored column). Set even when the LLM returned no
   *  aliases so later runs never re-pay for the same entity. SurrealDB 3.x may
   *  return the datetime as an object with toString(); only truthiness is used. */
  aliases_enriched_at?: string;
  description?: string;
  sourceProject: string;
  firstSeenAt: string;
  lastSeenAt: string;
  confidence: number;
  scope: MemoryScope;
  sessionId?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  // Kind-specific (optional)
  handles?: string[];
  titles?: string[];
  classification?: { varda?: VardaClassification };
  orgType?: string;
  subtype?: ConceptSubtype;
  locationType?: string;
  eventType?: string;
  startAt?: string;
  endAt?: string;
};

export type EntityEdge = {
  id?: string;
  in: string;
  out: string;
  kind: EdgeKind;
  confidence: number;
  weight?: number;
  sourceMemoryId?: string;
  contextText?: string;
  observedAt: string;
  lastSeenAt: string;
  sourceProject: string;
  scope: MemoryScope;
  sessionId?: string;
  provenance?: string;
};

export type EntityMention = {
  name: string;
  kind: EntityKind;
  context: string;
  confidence: number;
  description?: string;  // NEW — from LLM extraction
  subtype?: ConceptSubtype;
  handles?: string[];
  orgType?: string;
  aliases?: string[];
};
