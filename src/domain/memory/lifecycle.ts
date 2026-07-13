// Lifecycle, arbitration, project-state, and extraction types.
//
// Covers everything that drives the write path's decisioning: the CAS-versioned
// project-state record, write-arbitration thresholds + outcomes, the extracted-
// fact shapes feeding ingestion, supersession provenance, and the topic
// segmentation/session-watermark records used by the capture pipeline.

import type {
  MemoryCategory,
  MemoryRole,
  MemoryScope,
  MemoryTier,
  WriteSource,
} from "./boundary.js";
import type {
  MemoryAtomicClaim,
  MemoryAtomicFact,
  MemoryEvent,
  MemoryRawSpan,
} from "./payload.js";

export type ContinuityDirectiveKind =
  | "action"
  | "blocker"
  | "constraint"
  | "avoidance"
  | "question"
  | "verification"
  | "dependency"
  | "handoff"
  | "decision";

export type ContinuityDirectivePolarity =
  | "do"
  | "do_not"
  | "wait_for"
  | "ask"
  | "verify"
  | "decide"
  | "remember";

export type ContinuityDirectiveStatus = "open" | "blocked" | "done" | "stale";
export type ContinuityDirectiveOwner = "user" | "assistant" | "external" | "unknown";
export type ContinuityDirectiveSource = "explicit" | "inferred";

export type ContinuityDirective = {
  kind: ContinuityDirectiveKind;
  polarity: ContinuityDirectivePolarity;
  status: ContinuityDirectiveStatus;
  text: string;
  condition?: string;
  subject?: string;
  target?: string;
  owner?: ContinuityDirectiveOwner;
  source: ContinuityDirectiveSource;
  confidence: number;
  evidence: string;
};

export type ProjectStateRecord = {
  id: string;
  userId: string;
  projectKey?: string;
  path?: string;
  currentFocus?: string;
  activeTicketIds: string[];
  latestProgress?: string;
  blockers: string[];
  nextSteps: string[];
  directives?: ContinuityDirective[];
  updatedAt: string;
  sourceSessionId?: string;
  supportingMemoryIds: string[];
  confidence: number;
  version: number;
  previousProjectStateId?: string;
};

export type ProjectStateWrite = Omit<ProjectStateRecord, "id" | "version" | "previousProjectStateId"> & {
  version?: number;
  previousProjectStateId?: string;
};

/** Chat message shape consumed by capture extraction. */
export type CaptureMessage = {
  role: string;
  content: string;
};

// --- 52e.3: Write arbitration types and constants ---

/** Resolution outcome from write arbitration. */
export type ArbitrationOutcome = "create" | "skip" | "merge-update" | "supersede";

/** Result of the write arbitration decision. */
export type ArbitrationResult = {
  outcome: ArbitrationOutcome;
  /** The memory id that was created or updated (undefined for skip). */
  memoryId?: string;
  /** For merge-update: the id of the existing memory that was updated. */
  mergedIntoId?: string;
  /** The existing candidate that triggered the resolution, when applicable. */
  matchedMemoryId?: string;
  /** Human-readable reason for the decision. */
  reason: string;
};

/** Internal arbitration decision before write execution. The `"judge"` outcome is
 *  an INTERNAL escalation (Rúnir-pn1l Layer 2): `arbitrateWrite` resolves it via the
 *  injected LLM judge into a concrete create/skip/supersede before returning, so the
 *  public `ArbitrationResult.outcome` never carries it.
 *
 *  Rúnir-pn1l.13.7: `"judge_pending"` is a SHADOW-ONLY would_outcome string (D4b) —
 *  never an applied ArbitrationDecision.outcome. Shadow lanes emit it for F2
 *  nominations under forced-ON f2JudgeConfirm when no judge resolves the pending. */
export type ArbitrationDecision = {
  outcome: ArbitrationOutcome | "judge";
  reason: string;
  candidate?: SimilarCandidate;
  mergedText?: string;
  /** Rúnir-w077/pn1l: which signal drove a supersede — "deterministic_text"
   *  (same-subject-key value change), "extractor_correction:{slot,named_value}"
   *  (LLM correction tag + compatible candidate), or "currentness_cue:slot"
   *  (Rúnir-pn1l Layer 0: text currentness cue + same-subject value change on the slot
   *  path, fired when the extractor dropped the marker). Stamped onto the replacement
   *  for provenance. */
  supersedeSignal?: string;
  /**
   * Rúnir-pn1l.13.7 D3 — F2-confirm provenance stamped onto applied memory metadata
   * when a memory record IS written (confirmed supersede → replacement; veto/failure
   * → created record). Flag-off and F1 paths NEVER carry this field. Skip (duplicate)
   * writes no memory record — the ledger is the durable trace.
   * Structural shape matches `SupersessionProvenance` in supersession-judge.ts
   * (domain must not import storage).
   */
  supersessionProvenance?: {
    authority: "f2_exception";
    decisionId: string;
    appliedOutcome: "create" | "supersede" | "skip";
    f2JudgeCheck: {
      result:
        | "confirmed"
        | "vetoed"
        | "duplicate"
        | "unavailable"
        | "transport_error"
        | "invalid_response";
      confidence?: number;
      guardOverride?: { leg: "durability" | "temporal"; reason: string };
      judgeIdentity: {
        model: string;
        promptVersion: string;
        promptSha256: string;
        confidenceFloor: number;
        temperature: number;
        effectiveJsonMode: boolean;
        baseUrl: string;
        timeoutMs: number;
      } | null;
      identityStatus: "resolved" | "no_handle";
    };
  };
  /**
   * Rúnir-pn1l.13.7 D3 — pending ledger row for live applied-path F2 escalations.
   * Written AFTER the applied mutation succeeds; shadow/replay never set this.
   * userId/scope filled by arbitrateWrite before append. Structural shape matches
   * `SupersessionJudgeLedgerRow` (domain must not import storage).
   */
  judgeLedgerPending?: {
    decisionId: string;
    /** ISO-8601 decision timestamp, minted ONCE (stable across ledger retries). */
    ts: string;
    userId: string;
    scope: string;
    candidateId: string;
    candidateSha256: string;
    incomingSha256: string;
    signal: string;
    band: string | null;
    cosine: number;
    result:
      | "confirmed"
      | "vetoed"
      | "duplicate"
      | "unavailable"
      | "transport_error"
      | "invalid_response";
    confidence?: number;
    guardOverride?: { leg: "durability" | "temporal"; reason: string };
    judgeIdentity: {
      model: string;
      promptVersion: string;
      promptSha256: string;
      confidenceFloor: number;
      temperature: number;
      effectiveJsonMode: boolean;
      baseUrl: string;
      timeoutMs: number;
    } | null;
    identityStatus: "resolved" | "no_handle";
    appliedOutcome: "create" | "supersede" | "skip";
  };
  /**
   * Rúnir-pn1l.13.7 D5 / code-review P1#4 — non-verdict resolution marker for
   * shadow/replay strict policy. Set when the judge returned unavailable /
   * transport_error / invalid_response. Live applied path still maps these to
   * keep-both `create`; shadow emit records them as `judge_pending` (unresolved)
   * so Slice 2 can fail a run when unresolved > 0. Distinct from ordinary create.
   */
  judgeUnresolved?: {
    status: "unavailable" | "transport_error" | "invalid_response";
    detail?: string;
  };
  /** Rúnir-pn1l.13.2: which arbitration pass produced this outcome.
   *  Optional — default undefined preserves all existing callers/tests. Used by
   *  the shadow would-decision logger so adjudicators see the pass, not just the
   *  reason string. Values: "exact-dup" | "correction-supersede" | "recent-near-dup-skip" |
   *  "store-near-dup-skip" | "merge-band" | "create". */
  band?: string;
  /** Rúnir-pn1l.13.4 (U5): referent-identity provenance, surfaced to the shadow v2
   *  columns. All optional (default undefined preserves existing callers/tests).
   *  - `blockedNomination`: a signal that NOMINATED a retirement but was blocked for
   *    lack of a proven referent identity (e.g. "deterministic_text:unproven").
   *  - `referentVerdict` / `referentProof`: the verdict + proof that DROVE a supersede
   *    ("proven" + e.g. "key:factKey" / "anchor-shared"), a band-level anchor-conflict
   *    veto ("conflict" + the conflict detail: merge-band, recent-band, store-near-dup-
   *    band, AND — Rúnir-pn1l Q4 U1 — the correction-band anchor-conflict `continue` in
   *    `findSupersedeTarget`, all fall-through-stamped the same way), OR — Rúnir-pn1l Q4
   *    U1 — `"f2_exception"`: an F2 retirement (`extractor_correction:{slot,named_value}`
   *    / `currentness_cue:slot`), which has no positive referent-identity proof
   *    requirement of its own (only the anchor-conflict veto applies to it — a SEPARATE
   *    retirement authority from F1's proof requirement, plan §10.2 Route 3; `referentProof`
   *    on an `"f2_exception"` row is `signal:{the supersede signal}`, a provenance string,
   *    NOT a referent-identity proof string like `key:factKey`/`anchor-shared`). Report
   *    F1-`"proven"` and F2-`"f2_exception"` retirements SEPARATELY in any adjudication —
   *    they are not the same claim.
   *
   *  Rúnir-pn1l.13.7 D4b — shadow `would_outcome:"judge_pending"` is a non-final
   *  WOULD outcome for F2 nominations under forced-ON f2JudgeConfirm (judge-less
   *  shadow). EXCLUDED from the ordinary diverged pool; consumers must refuse it
   *  as final. Provenance fields on applied records additionally carry
   *  `supersessionProvenance` (see above) when the live F2-confirm path wrote. */
  blockedNomination?: string;
  referentVerdict?: string;
  referentProof?: string;
  /** Rúnir-pn1l.13.6 (Item B): a point-in-time snapshot of the triggering candidate,
   *  captured AT ARBITRATION TIME so a guard-blocked / veto-blocked row can be replayed
   *  offline (via `mergeKeepBothReason` or `proveReferentIdentity`) without re-fetching a
   *  since-mutated candidate from the live DB. Read ONLY by `emitShadow`; nothing else
   *  consumes it. Mirrors the `referentVerdict`/`referentProof`/`blockedNomination`
   *  precedent exactly.
   *
   *  Rúnir-pn1l.13.6 set this at FOUR sites (merge-band veto, store-near-dup veto,
   *  recent-band veto, merge keep-both guard) — every one genuinely snapshots the row's
   *  own matched/vetoed candidate (`ShadowCandidateSnapshot.snapshot_role` defaults to
   *  `"matched_candidate"` for exactly this reason).
   *
   *  Rúnir-pn1l Q4 U1 adds TWO more sites inside `findSupersedeTarget`'s correction pass
   *  (A3a: `deterministic_text:unproven` F1-nomination-blocked; A3b: correction-band
   *  anchor-conflict), both role-tagged `"blocked_nomination"` on the snapshot itself and
   *  stamped onto the fall-through decision with `??=` precedence AGAINST what
   *  `resolveRemainingBands()` (bands 3-5) may already have set — a later band's own
   *  matched-candidate snapshot is preserved untouched; the correction-band
   *  blocked-nomination snapshot fills in ONLY when no later band captured one. This is
   *  deliberate: the correction pass runs FIRST and may find a candidate A blocked, while a
   *  LATER band (recent/store/merge) may separately match/veto a DIFFERENT candidate B —
   *  the `snapshot_role` tag is the belt to this precedence's suspenders, so even a future
   *  ordering mistake could not make A's snapshot readable as B's matched-candidate
   *  content. */
  shadowCandidateSnapshot?: ShadowCandidateSnapshot;
  /**
   * Rúnir-h435.1 F1: shadow-only marker for atomic-guard keep-both creates.
   * Present when the unconditional atomic guard unit (or equivalent) turned an
   * F1-proven supersede into create. Carries the guard leg + reason + the signal
   * that would have driven retirement — used by the isolated nomination frame to
   * label the selected candidate `guard-kept-both` and other proven nominations
   * `proven-not-selected`. HARD CONSTRAINT: never set `supersedeSignal` on the
   * same create — applied create metadata must stay free of supersedeSignal.
   */
  guardKeepBoth?: {
    leg: "durability" | "temporal" | "occasion";
    reason: string;
    signal: string;
  };
};

/** Rúnir-pn1l.13.6 (Item B): shadow-only point-in-time candidate content snapshot.
 *  `l2`+`tags` cover `mergeKeepBothReason` replay; `factKey`/`noemaClaimKey`/`atomicFact`
 *  additionally cover `proveReferentIdentity` replay for anchor-conflict veto rows.
 *  `atomicFact` reuses `SimilarCandidate.atomicFact`'s type verbatim.
 *
 *  Rúnir-pn1l Q4 U1: `snapshot_role` disambiguates WHICH candidate this snapshot
 *  describes, so a `"blocked_nomination"` snapshot on a row whose
 *  `would_matched_id` points at a DIFFERENT (later-band) candidate B can never be
 *  mistaken for B's own snapshot (Codex brief-gate P1 #2). `"matched_candidate"`
 *  = the same candidate the decision's `would_outcome`/`would_matched_id`
 *  describes (the four pre-U1 snapshot sites: merge-band veto, merge keep-both
 *  guard, recent-band veto, store-near-dup veto). `"blocked_nomination"` = a
 *  correction-band candidate that F1/anchor-conflict blocked from retirement and
 *  that fell through WITHOUT becoming the row's matched candidate (the two new
 *  U1 snapshot sites in `findSupersedeTarget`'s correction pass). Absent (older
 *  rows, and both pre-U1 test fixtures) is treated as `"matched_candidate"` for
 *  back-compat — every pre-U1 snapshot site genuinely snapshotted the matched/
 *  vetoed candidate, so this default changes no existing row's meaning. */
export type ShadowCandidateSnapshot = {
  id?: string;
  l2: string;
  tags: string[] | null;
  factKey?: string | null;
  noemaClaimKey?: string | null;
  atomicFact?: MemoryAtomicFact | null;
  snapshot_role?: "matched_candidate" | "blocked_nomination";
};

/** A candidate memory found during similarity search for arbitration. */
export type SimilarCandidate = {
  id: string;
  l2: string;         // L2 content (the retrieved memory text)
  similarity: number;
  createdAt: string;
  updatedAt?: string;
  scope?: MemoryScope;
  sessionId?: string;
  memoryRole?: MemoryRole;
  validAt?: string;
  invalidAt?: string;
  lineageRootId?: string;
  continuitySubjectKey?: string;
  /** Rúnir-w077: extractor tags (e.g. `project:atlas`, `role:tech-lead`,
   *  `update`) carried through from the stored payload so arbitration can
   *  detect corrections by shared slot / correction marker, not just text. */
  tags?: string[];
  /** Rúnir-pn1l.2: the stored fact's durability tier (`payload.tier`), carried
   *  through so the supersede temporal/durability guard can refuse to let a
   *  transient/ephemeral incoming fact overwrite a durable stored one. */
  tier?: MemoryTier;
  /** Rúnir-pn1l.13.4: referent-identity keys carried through from the stored
   *  payload so `proveReferentIdentity` can run its key-equality proof arms
   *  (`factKey` / `atomicFact→atomicFactIdentity`) against the incoming write.
   *  Surfaced by the `findSimilarMemories` mapper; inert until the U5 gate
   *  consumes them. `continuitySubjectKey` (above) is the supporting-only
   *  fourth key.
   *  `noemaClaimKey` (below) is NOT a `proveReferentIdentity` proof arm
   *  (Rúnir-pn1l Q4 U0, 2026-07-07: removed — never service-populated at
   *  write time, so it was only ever reachable via client-injected
   *  `/memory/store` metadata, a spoofable proof-of-identity claim). It is
   *  preserved here solely because it is carried through onto the shadow
   *  `candidate_snapshot_json` (see `ShadowCandidateSnapshot` above and
   *  `snapshotCandidate` in `shadow-snapshots.ts`), and it remains the noema
   *  claim-contract dedup key consumed by
   *  `recall/policy/noema-retrieval-policy.ts` — an unrelated mechanism. */
  factKey?: string;
  noemaClaimKey?: string;
  atomicFact?: MemoryAtomicFact;
};

/** An entry in the in-memory recent-write dedup cache. */
export type RecentWrite = {
  text: string;
  normalizedText: string;
  embedding: number[];
  userId: string;
  scope: MemoryScope;
  sessionId?: string;
  memoryRole?: MemoryRole;
  source: WriteSource;
  writtenAtMs: number;
};

/** Thresholds and limits for write arbitration. */
export type ArbitrationConfig = {
  /** Skip if cosine similarity >= this within skipWindowHours. Default: 0.95 */
  skipThreshold: number;
  /** Time window in hours for skip detection. Default: 24 */
  skipWindowHours: number;
  /** Merge-update if cosine similarity >= this within mergeWindowHours. Default: 0.85 */
  mergeThreshold: number;
  /** Time window in hours for merge-update detection. Default: 72 */
  mergeWindowHours: number;
  /** Max candidates to fetch from SurrealDB for similarity check. Default: 5 */
  candidateLimit: number;
  /** TTL for in-memory recent-write entries in minutes. Default: 5 */
  recentWriteTtlMinutes: number;
  /**
   * Supersede-candidacy floor for the correction pass (findSupersedeTarget).
   * Cosine similarity must be >= this value for a candidate to reach the structural
   * guards (currentness-cue, sharesSlotTags, subjectsChanged, conflictingSubjects).
   * Defaults to the EFFECTIVE mergeThreshold when unset — byte-identical prod behavior.
   * Must be <= mergeThreshold; values above mergeThreshold are clamped to mergeThreshold.
   * Set via RUNIR_SUPERSEDE_CANDIDATE_FLOOR env var or input.config.supersedeCandidateFloor.
   * Rúnir-pn1l.12.
   */
  supersedeCandidateFloor?: number;
};

/** Default arbitration config values from Scout recommendations. */
export const DEFAULT_ARBITRATION_CONFIG: ArbitrationConfig = {
  skipThreshold: 0.95,
  skipWindowHours: 24,
  mergeThreshold: 0.85,
  mergeWindowHours: 72,
  candidateLimit: 5,
  recentWriteTtlMinutes: 5,
};

// ── Rúnir-h435.1 Unit B: atomic-isolated counterfactual frame types ──────────

/** PIN-2 / SAFETY FRAME activation classes persisted on atomic_shadow_attempt. */
export type AtomicShadowActivationClass =
  | "safety_activation"
  | "efficacy_only"
  | "computation_failed";

/** Exhaustive F1-nomination dispositions [R9-1]. */
export type AtomicNominationDisposition =
  | "proven-retired"
  | "unproven-blocked"
  | "anchor-vetoed"
  | "guard-kept-both"
  | "proven-not-selected";

/**
 * Decision-time INCOMING snapshot for the atomic-isolated packet [R9-3].
 * Deep-copied at decision time; never re-fetched by id.
 */
export type AtomicIncomingSnapshot = {
  text: string;
  tags: string[] | null;
  atomicFact: MemoryAtomicFact | null;
  canonicalIdentity: string | null;
  canonicalTriple: {
    subject: string;
    predicate: string;
    value: string;
  } | null;
  tier: string | null;
  validAt: string | null;
};

/**
 * Decision-time candidate snapshot for the atomic-isolated packet / nominations.
 * Carries proof + guard inputs (text, tags, atomicFact, tier, validAt/createdAt,
 * referent keys). Deep-copied at decision time.
 */
export type AtomicCandidateSnapshot = {
  id: string;
  text: string;
  tags: string[] | null;
  atomicFact: MemoryAtomicFact | null;
  tier: string | null;
  validAt: string | null;
  createdAt: string | null;
  referentKeys: {
    factKey: string | null;
    continuitySubjectKey: string | null;
    atomicFactIdentity: string | null;
  };
};

/** Optional frame-identity input (PIN-3). Production omits → organic UTC-day. */
export type AtomicFrameSource = {
  stratum: "replay" | "organic";
  frameId: string;
};

/** Result from topic segmentation LLM call. */
export type TopicSegmentationResult = {
  topics: Array<{
    title: string;
    summary: string;
  }>;
};

/** Watermark record for session capture progress tracking. */
export type SessionWatermark = {
  id?: unknown;
  session_key: string;
  user_id: string;
  captured_at: string;
  message_count: number;
};

/**
 * Raw fact as returned by the LLM — enrichment fields may be missing.
 * This is the parse boundary type before normalization.
 */
export type RawExtractedFact = {
  l2: string;
  confidence: number;
  l0?: string;
  l1?: string;
  category?: string;   // unvalidated — may be invalid or missing
  tier?: string;        // unvalidated — advisory only, ignored by deterministic rules
  tags?: unknown;       // may be null, undefined, or non-array
  directives?: unknown; // optional continuity action semantics emitted at write time
  /** Index into the CaptureMessage[] array for the source turn. LLM-emitted; used to
   *  dereference raw_source_text without having the LLM emit verbatim text. */
  source_turn_index?: number;
  /** Verbatim source turn text, stamped post-LLM by dereferencing source_turn_index
   *  against the CaptureMessage[] array. Populated only when source_turn_index is
   *  present and in range; left undefined otherwise. */
  raw_source_text?: string;
  rawSpan?: MemoryRawSpan;
  rawSpans?: MemoryRawSpan[];
  atomicFact?: MemoryAtomicFact;
  event?: MemoryEvent;
  atomicClaims?: MemoryAtomicClaim[];
};

/** A fact extracted from a conversation with enriched metadata. All fields guaranteed present. */
export type ExtractedFact = {
  l2: string;           // L2: full narrative
  l0: string;           // L0: one-line index
  l1: string;           // L1: structured markdown
  confidence: number;
  category: MemoryCategory;
  tier: MemoryTier;
  tags: string[];
  directives?: ContinuityDirective[];
  factKey: string;        // "category:slug-XXXXXX" or "category:XXXXXX" (hash-only for non-Latin)
  /** Original user/assistant turn text before LLM paraphrasing.
   *  Populated during extraction post-processing by dereferencing source_turn_index. */
  raw_source_text?: string;
  rawSpan?: MemoryRawSpan;
  rawSpans?: MemoryRawSpan[];
  atomicFact?: MemoryAtomicFact;
  event?: MemoryEvent;
  atomicClaims?: MemoryAtomicClaim[];
};

/** Derive a deterministic subject key from an extracted fact for continuity invalidation.
 *  Returns `category:l1` when both are present, falls back to factKey, then empty string. */
export function deriveSubjectKey(fact: ExtractedFact): string {
  if (fact.category && fact.l1) {
    return `${fact.category}:${fact.l1}`;
  }
  if (fact.factKey) {
    return fact.factKey;
  }
  return "";
}

/** Provenance marker for supersede edges.
 *  "deterministic" = write-time arbitration (cosine + subject-key match).
 *  "llm-generated" = staleness pass or consolidation sweep (LLM decision). */
export type SupersedeProvenance = "deterministic" | "llm-generated";

/** Minimum confidence score for an extracted fact to pass the quality gate.
 *  Configurable via CONFIDENCE_THRESHOLD env var. Default: 0.7 */
export const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.7");

/** Maximum transcript length (in characters) passed to segmentAndSummarize().
 *  Transcripts exceeding this are truncated from the front (keeping recent messages). */
export const MAX_TRANSCRIPT_CHARS = 400_000;
