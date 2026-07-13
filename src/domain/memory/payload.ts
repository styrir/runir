// Persisted record-shape types: the canonical payload, provenance envelope,
// session record, semiote relations, and entity-graph records.
//
// These are the on-disk shapes that flow between writers and readers. The
// boundary/scope discriminants they reference live in `./boundary.js`.

import type {
  MemoryCategory,
  MemoryRole,
  MemoryScope,
  MemoryTier,
  MemoryWriteSource,
  ProjectIdentitySource,
} from "./boundary.js";

// MIM-24 entity-graph types (`EntityKind`, `EntityRecord`, `EntityEdge`,
// `EntityMention`, etc.) live in `./boundary.ts` alongside the other domain
// discriminants. Importers continue to load them via the barrel re-export.

/** Lifecycle state persisted on memory records. */
export type MemoryLifecycleState = {
  active: boolean;
  inactiveAt?: string;
  inactiveReason?: string;
  supersededById?: string;
  supersedesId?: string;
  lineageRootId?: string;
};

export type NoemaClaimStatus =
  | "active"
  | "superseded"
  | "conflicted"
  | "rejected";

export type NoemaStableClaim = {
  subject: string;
  predicate: string;
  value: string;
};

export type MemoryRawSpan = {
  text: string;
  sourceTurnIndex?: number;
  cursorStart?: number;
  cursorEnd?: number;
  kind?: "source_turn" | "list_item" | "code" | "exact_answer";
};

export type MemoryAtomicFact = {
  subject?: string;
  predicate?: string;
  value?: string;
  text?: string;
};

export type MemoryEvent = {
  actor?: string;
  action?: string;
  object?: string;
  happenedAt?: string;
  text?: string;
};

export type MemoryAtomicClaim = {
  subject?: string;
  predicate?: string;
  value?: string;
  text?: string;
  rawSpanText?: string;
  order?: number;
};

/** Canonical shape of the payload object stored on memory records. */
export type MemoryPayload = {
  l2: string;                // L2 content (the full fact text)
  l0: string;                // L0 abstract — one-line index
  l1: string;                // L1 overview — structured markdown
  category: MemoryCategory;
  tier: MemoryTier;
  factKey?: string;          // "category:slug-XXXXXX" or "category:XXXXXX" — dedup key
  claimSubject?: string;     // optional stable Noema slot subject override
  claimPredicate?: string;   // optional stable Noema slot predicate override
  writeSource: MemoryWriteSource;
  tags: string[];            // never null — empty array minimum
  accessCount: number;       // default 0, incremented on recall
  lastAccessedAt?: string;   // ISO 8601 string, undefined if never recalled
  userId: string;
  sessionId?: string;
  source: string;            // e.g. "memory-hybrid"
  scope: MemoryScope;
  confidence: number;
  memoryRole?: MemoryRole;
  validAt?: string;
  invalidAt?: string;
  continuitySubjectKey?: string;
  createdAt: string;
  updatedAt: string;
  // Lifecycle fields (existing)
  active?: boolean;
  inactiveAt?: string;
  inactiveReason?: string;
  supersededById?: string;
  supersedesId?: string;
  lineageRootId?: string;
  // Attribution fields (Code-jrzw)
  path?: string;    // absolute cwd at write time, e.g. "/home/user/code/my-project"
  client?: string;  // originating client: "hermes" | "claude-code" | "openclaw" | "cursor" | "pi" | string (open set — Rúnir-tfxt.3)
  // Multi-tenant attribution (Rúnir-yod0.9.1 / arch1.02.0)
  principalId?: string;  // boundaryContractVersion: arch1.02.0
  tenantId?: string;     // boundaryContractVersion: arch1.02.0; defaults to DEFAULT_TENANT_ID for scope=global projection
  // Decay/maintenance fields (MIM-70)
  decayScore?: number;  // computed vitality 0.0–1.0, updated each consolidation run
  pinnedAt?: string;    // ISO 8601; if set, record is exempt from all automatic pruning
  // Noema promotion identity (Rúnir-noem1.2)
  noemaClaimKey?: string;
  noemaRevisionHash?: string;
  noemaStatus?: NoemaClaimStatus;
  noemaStableClaim?: NoemaStableClaim;
  // Exact-QA retention metadata. Optional on legacy rows and written only
  // when extraction can preserve source-shaped evidence.
  rawSpan?: MemoryRawSpan;
  rawSpans?: MemoryRawSpan[];
  atomicFact?: MemoryAtomicFact;
  event?: MemoryEvent;
  atomicClaims?: MemoryAtomicClaim[];
};

export type SemioteProvenanceSourceKind =
  | "capture"
  | "session-end"
  | "manual-store";

export type SemioteProvenanceEnvelope = {
  sourceKind: SemioteProvenanceSourceKind;
  writeSource: MemoryWriteSource;
  retrievalTraceId?: string;
  runirSessionId?: string;
  nativeSessionId?: string;
  sessionId?: string;
  path?: string;
  client?: string;
  sourceHostId?: string;
  sourceEventId?: string;
  sourceTurnIndex?: number;
  sourceCursorStart?: number;
  sourceCursorEnd?: number;
  extraction?: {
    mode?: "capture" | "session-end" | "memory-store";
    model?: string;
    capturedAt?: string;
  };
  derivation?: {
    contextScopeKind: "session" | "project" | "agent";
    projectKey?: string;
    agentId?: string;
    resolvedTaskId?: string;
  };
  // Multi-tenant attribution (Rúnir-yod0.9.1 / arch1.02.0)
  principalId?: string;  // boundaryContractVersion: arch1.02.0
  tenantId?: string;     // boundaryContractVersion: arch1.02.0; defaults to DEFAULT_TENANT_ID for scope=global projection
};

export type RunirSessionStatus = "active" | "idle" | "stale" | "closed";

export type RunirSessionRecord = {
  id: string;
  userId: string;
  projectKey?: string;
  projectIdentitySource: ProjectIdentitySource;
  clientKind?: string;
  nativeSessionId?: string;
  nativeSessionKey?: string;
  nativeSessionAliases: string[];
  workspacePath?: string;
  workspaceFingerprint?: string;
  hostId?: string;
  deviceLabel?: string;
  status: RunirSessionStatus;
  openedAt: string;
  lastSeenAt: string;
  closedAt?: string;
  closeReason?: string;
  /** Durable last-close event marker (Rúnir-78sy.13, F1): survives
   *  reactivation, unlike closedAt/closeReason which are the live-status
   *  pairing and are cleared when the row resumes active. Consumed by
   *  the missing_handoff detector (fetchRecentlyEndedSessions). */
  lastClosedAt?: string;
  resolverKey: string;
};

export type SemioteRelationKind = "related_to" | "derived_from";

export function isSemioteRelationKind(value: unknown): value is SemioteRelationKind {
  return value === "related_to" || value === "derived_from";
}

export type SemioteRelationRecord = {
  id?: string;
  in: string;
  out: string;
  kind: SemioteRelationKind;
  userId: string;
  scope: MemoryScope;
  sessionId?: string;
  path?: string;
  retrievalTraceId?: string;
  sourceWrite?: MemoryWriteSource;
  provenance?: string;
  createdAt: string;
  updatedAt: string;
};
