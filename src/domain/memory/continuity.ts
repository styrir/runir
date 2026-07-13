// Continuity-state domain types (Rúnir-78sy.3, Archeion v2 Phase 2).
//
// camelCase TS domain shapes for the continuity builder + enrollment. The
// snake_case Persisted*Row shapes and mapRow converters live in the store
// module (src/storage/surreal/continuity-state-store.ts), per the repo
// convention (domain record camelCase in src/domain/memory/, persisted row +
// ensure* + query fns in the storage module).

/** How a project entered the enrolled set. */
export type ProjectEnrollmentSource = "leit" | "manual";

/**
 * One enrolled project the continuity builder iterates. The binding anchors
 * (projectId / repoRemote / repoRootFingerprint) map enrollment to runir
 * evidence via the three-candidate union in the builder. Raw repo paths are
 * NEVER stored — only their fingerprint.
 */
export type ProjectEnrollmentRecord = {
  id: string;
  userId: string;
  workspaceId: string;
  projectKey: string;
  projectId?: string;
  defaultNamespaceId?: string;
  repoRemote?: string;
  /** fp24(normalizePath(repoRoot)) — matches runir_session.workspace_fingerprint. */
  repoRootFingerprint?: string;
  source: ProjectEnrollmentSource;
  enrolledAt: string;
};

/** Fields an enrollment upsert accepts (id + enrolledAt are derived/stamped). */
export type ProjectEnrollmentWrite = Omit<ProjectEnrollmentRecord, "id" | "enrolledAt"> & {
  enrolledAt?: string;
};

/**
 * A single canonical continuity-state row per (userId, workspaceId, projectKey).
 * Supersede-by-replace: one canonical row, CAS-versioned, `validAt` stamped each
 * write (§7 850i fold-in). History auditability = source evidence refs + the
 * underlying semiotes/noemata, not row history.
 */
export type ProjectContinuityStateRecord = {
  id: string;
  userId: string;
  workspaceId: string;
  projectKey: string;
  projectId?: string;
  defaultNamespaceId?: string;
  // §7 synthesized list fields.
  currentFocus: string[];
  latestProgress: string[];
  nextSteps: string[];
  blockers: string[];
  openLoops: string[];
  unfiledIntentions: string[];
  pendingVerification: string[];
  recentlyChangedArtifacts: string[];
  likelyStaleBeads: string[];
  activeAgentRuns: string[];
  /** Free-form evidence anchors (e.g. {kind, id, at}). */
  sourceEvidenceRefs: Array<Record<string, unknown>>;
  confidence: number;
  sourceSessionIds: string[];
  supportingSemioteIds: string[];
  version: number;
  validAt: string;
  updatedAt: string;
};

/** Fields a continuity-state CAS write accepts (id/version/validAt/updatedAt derived). */
export type ProjectContinuityStateWrite = Omit<
  ProjectContinuityStateRecord,
  "id" | "version" | "validAt" | "updatedAt"
> & {
  validAt?: string;
  updatedAt?: string;
};

/** The synthesized list-field payload the LLM produces (§7). */
export type ContinuitySynthesisFields = Pick<
  ProjectContinuityStateRecord,
  | "currentFocus"
  | "latestProgress"
  | "nextSteps"
  | "blockers"
  | "openLoops"
  | "unfiledIntentions"
  | "pendingVerification"
  | "recentlyChangedArtifacts"
  | "likelyStaleBeads"
  | "activeAgentRuns"
>;

/** Per-(user, workspace, project) build cursor. `builtThrough` is the verbatim
 *  ISO string of the newest evidence row folded into the last successful
 *  synthesis; compared lexicographically with strict `>` app-side (the
 *  dedup_state pattern), never a Surreal datetime round-trip. */
export type ContinuityBuildStateRecord = {
  userId: string;
  workspaceId: string;
  projectKey: string;
  builtThrough: string;
  updatedAt: string;
};

// ── Continuity gaps (Rúnir-78sy.4, Archeion v2 Phase 3) ──────────────────────
// Evidence-backed gap records + typed evidence refs. Brief §8. The ship-now
// detectors (unfiled_intent / started_unfinished / missing_handoff, §11.1) run
// deterministically over the builder's synthesized §7 lists + runir_session
// evidence in Step 4.6; the 4 collector-blocked kinds (§11.2) stay inert until
// Leit's S-2 push and are surfaced as "not yet evaluated", never "no gaps".

/** Disk-sensitivity discriminant for an evidence excerpt (§9.2). An excerpt with
 *  an UNDEFINED sensitivity is treated as sensitive (fail-closed) by the report. */
export type EvidenceSensitivity = "normal" | "verbatim_session" | "private_path" | "secret_redacted";

/** Bounded, source-specific evidence anchor (brief §8). Rúnir-resident sources
 *  ship now; the workspace_execution, bead, git, and doc_artifact sources arrive
 *  via Leit's S-2 push (Phase 3b). */
export type EvidenceRef = {
  sourceType:
    | "session_turn"
    | "session_summary"
    | "semiote"
    | "noema"
    | "runir_session"
    | "agent_run_event"
    | "workspace_execution"
    | "bead"
    | "git_commit"
    | "git_diff"
    | "doc_artifact"
    | "handoff";
  sourceId: string;
  label: string;
  uri?: string;
  excerpt?: string;
  timestamp?: string;
  confidence?: number;
  sensitivity?: EvidenceSensitivity;
};

/** Full 7-kind union (brief §8). Only the 3 ship-now kinds (§11.1) are ever
 *  emitted this bead; the other 4 are §11.2 collector-blocked (S-2). */
export type ContinuityGapKind =
  | "unfiled_intent"
  | "started_unfinished"
  | "orphaned_change"
  | "doc_drift"
  | "bead_stale"
  | "missing_handoff"
  | "stale_agent_run";

/** The 3 kinds this bead's deterministic detectors emit. */
export type ShipNowGapKind = "unfiled_intent" | "started_unfinished" | "missing_handoff";

export type ContinuityGapConfidence = "weak" | "developing" | "strong";

/** new → active → {dismissed | materialized | superseded}. Dismissed/materialized
 *  rows are retained (supersede-by-default) — a same-dedupeKey re-detect never
 *  reverts status; only a dedupeKey change surfaces a fresh row. */
export type ContinuityGapStatus = "new" | "active" | "dismissed" | "materialized" | "superseded";

export type ContinuityGapRecord = {
  id: string;
  userId: string;
  /** canonicalized "-" sentinel for repo-only projects (A-3). */
  workspaceId: string;
  projectKey: string;
  /** S-1 materialization targets (Leit) — carried, empty pre-S-2. */
  targetProjectId?: string;
  targetNamespaceId?: string;
  kind: ContinuityGapKind;
  title: string;
  summary: string;
  recommendation: string;
  /** Leit work-item refs; empty pre-S-2. */
  relatedWorkItems: string[];
  candidateTaskPreview?: { title: string; description: string };
  evidence: EvidenceRef[];
  /** Deterministic SORT-ONLY ordering hint (count-based) — NOT a confidence or
   *  quality metric, and never threshold-tuned against a benchmark (§ benchmark
   *  integrity). Use `confidence` for gap strength. */
  score: number;
  confidence: ContinuityGapConfidence;
  status: ContinuityGapStatus;
  /** Stable across re-detection of the SAME latent gap; changes when the
   *  underlying evidence content changes (rolling kinds fold a content
   *  fingerprint; missing_handoff keys on the session id). */
  dedupeKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastReportedAt?: string;
};

/** Detector output → upsert. id/firstSeenAt/lastSeenAt derived/stamped by the
 *  store (firstSeenAt set ONCE on create, lastSeenAt each write). */
export type ContinuityGapWrite = Omit<ContinuityGapRecord, "id" | "firstSeenAt" | "lastSeenAt"> & {
  firstSeenAt?: string;
  lastSeenAt?: string;
};

/** Per-(user, workspace, project) gap-evaluation cursor (Rúnir-78sy.4, §R.1).
 *  `evaluatedThrough` = the continuity-state `updatedAt` the detector last
 *  evaluated against; lets the report tell "gaps current with state" from
 *  "gaps pending evaluation" (never claiming "0 gaps" for an unevaluated row). */
export type ContinuityGapBuildStateRecord = {
  userId: string;
  workspaceId: string;
  projectKey: string;
  evaluatedThrough: string;
  updatedAt: string;
};

/** Per-(user, workspace, project) report cursor (Rúnir-78sy.5, §B.1). The
 *  watermark is a CONTENT HASH, not a timestamp — immune to the builder's
 *  LLM-fallback `updatedAt` re-stamp churn; re-render iff the hash changed. */
export type ContinuityReportStateRecord = {
  userId: string;
  workspaceId: string;
  projectKey: string;
  reportedContentHash: string;
  reportedThrough: string;
  updatedAt: string;
};

// ── Continuity evidence ingestion (Rúnir-78sy.9, S-2 push) ───────────────────
// POST /hooks/evidence stores pushed EvidenceRefs so the collector-blocked
// detectors (orphaned_change/doc_drift/bead_stale/stale_agent_run) can query
// them; continuity_gap.evidence remains detector OUTPUT, never ingest input.

/** The 5 sourceTypes Leit's S-2 collector is authorized to push (A-2 write-path
 *  exclusivity). Any other EvidenceRef.sourceType is per-item rejected. */
export type LeitEvidenceSourceType = "git_commit" | "git_diff" | "bead" | "workspace_execution" | "doc_artifact";

export const LEIT_EVIDENCE_SOURCE_TYPES: readonly LeitEvidenceSourceType[] = [
  "git_commit",
  "git_diff",
  "bead",
  "workspace_execution",
  "doc_artifact",
];

/** One persisted, deduped evidence row keyed on the 5-tuple
 *  (userId, workspaceId, projectKey, sourceType, sourceId). Best-effort session
 *  binding never rejects the row (C4); `occurred_at`/`bound_session_id` are
 *  NONE when the ref lacks a parseable timestamp or no window contains it. */
export type ContinuityEvidenceRecord = {
  id: string;
  userId: string;
  /** canonicalized "-" sentinel for repo-only projects (A-3). */
  workspaceId: string;
  projectKey: string;
  /** The ENROLLMENT's project_id — the durable materialization target. */
  projectId?: string;
  /** The request's project_id when it conflicts with the enrollment's (F8);
   *  never used as the materialization target, preserved for repair. */
  conflictingProjectId?: string;
  sourceType: LeitEvidenceSourceType;
  sourceId: string;
  /** Verbatim `ref.timestamp` when present and a parseable ISO string; absent
   *  otherwise (F1) — never a Surreal datetime round-trip. */
  occurredAt?: string;
  ref: EvidenceRef;
  boundSessionId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** Detector/route input → upsert. id/firstSeenAt/lastSeenAt derived/stamped by
 *  the store (firstSeenAt set ONCE on create, lastSeenAt each write). */
export type ContinuityEvidenceWrite = Omit<ContinuityEvidenceRecord, "id" | "firstSeenAt" | "lastSeenAt"> & {
  firstSeenAt?: string;
  lastSeenAt?: string;
};

/** POST /hooks/evidence request body (S-2 ingestion contract). */
export type EvidenceIngestRequest = {
  userId: string;
  /** "-" sentinel workspaceId canonicalized at ingress when omitted/null (A-3). */
  workspaceId?: string;
  projectKey: string;
  /** Leit's durable project id; carried for materialization targets (F8). */
  projectId?: string;
  evidence: EvidenceRef[];
};

/** POST /hooks/evidence response — counts only, never raw ref/excerpt content. */
export type EvidenceIngestResponse = {
  accepted: number;
  updated: number;
  rejected: number;
};
