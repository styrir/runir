// S-2 evidence ingestion policy (Rúnir-78sy.9, Archeion v2 Phase 0/3b, Codex P3).
//
// Extracted from the POST /hooks/evidence route handler per src/app/AGENTS.md
// ("Route handlers may delegate to service modules, but must not duplicate
// storage/retrieval/capture policy logic") and this file's thin-shell
// precedent (/hooks/recall → orchestrateRecall). The route keeps ONLY
// auth/HTTP-shape concerns (bearer check, body parse, the userId presence
// check, resolveUserId, workspaceId canonicalization, item-count cap +
// malformed-body 400s, enrollment check + 422) and delegates the per-item
// ingestion policy here: item-shape validation, the Leit sourceType
// allowlist (F3), the 16 KiB per-ref cap (F7), the per-item try/catch tally,
// F8 projectId-conflict handling + warn log, the hoisted session-binding
// fetch (Codex P1 — ONE query per request, not per item), and the upserts.
//
// LOGGING RULE: never log raw `ref` content or `excerpt` anywhere in this
// module — logs may carry only counts, sourceType, sourceId, and ids.

import {
  LEIT_EVIDENCE_SOURCE_TYPES,
  type EvidenceRef,
  type LeitEvidenceSourceType,
} from "../../domain/memory/continuity.js";
import type { ProjectEnrollmentRecord } from "../../domain/memory/continuity.js";
import {
  fetchAnchoredCandidateSessions,
  selectBoundSessionId,
  upsertContinuityEvidence,
} from "../../storage/surreal/continuity-evidence-store.js";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";

const EVIDENCE_MAX_REF_BYTES = 16 * 1024;
const LEIT_SOURCE_TYPE_SET = new Set<string>(LEIT_EVIDENCE_SOURCE_TYPES);

export interface IngestEvidenceBatchParams {
  userId: string;
  workspaceId: string;
  projectKey: string;
  enrollment: ProjectEnrollmentRecord;
  /** The request's projectId when it conflicts with the enrollment's (F8);
   *  undefined when absent or matching. The enrollment's own projectId
   *  always remains the durable materialization target. */
  requestProjectId: string | undefined;
  evidence: unknown[];
}

export interface IngestEvidenceBatchResult {
  accepted: number;
  updated: number;
  rejected: number;
}

/**
 * Ingests one POST /hooks/evidence batch: F8 projectId-conflict detection +
 * warn log, per-item validation (F1 shape check, F3 sourceType allowlist, F7
 * size cap), best-effort session binding (F2/F6 — candidates fetched ONCE
 * for the whole batch, Codex P1), and the upsert. A per-item failure
 * increments `rejected` and never aborts the batch.
 */
export async function ingestEvidenceBatch(
  db: SurrealClient,
  logger: (msg: string) => void,
  params: IngestEvidenceBatchParams,
): Promise<IngestEvidenceBatchResult> {
  const { userId, workspaceId, projectKey, enrollment, requestProjectId, evidence } = params;

  // [F8] projectId conflict: the enrollment's project_id is the durable
  // materialization target; a conflicting request value is preserved in its
  // own column for later enrollment repair, never used as the target, and
  // never a rejection reason. One structured warn log per request — counts
  // only, no ref/excerpt content.
  const conflictingProjectId =
    requestProjectId !== undefined && enrollment.projectId !== undefined && requestProjectId !== enrollment.projectId
      ? requestProjectId
      : undefined;
  if (conflictingProjectId) {
    logger(
      `runir-service: evidence projectId mismatch user=${userId} project=${projectKey} enrollment=${enrollment.projectId} request=${conflictingProjectId}`,
    );
  }

  // [F2] Project-anchor-filtered binding candidates: PURE reads only, never
  // resolveRunirSession (resolve-or-CREATE). Fetched ONCE per request (Codex
  // P1) — only occurredAt varies per item, and that is applied in-memory by
  // selectBoundSessionId, not by re-querying per item.
  const candidateSessions = await fetchAnchoredCandidateSessions(db, userId, {
    projectId: enrollment.projectId,
    repoRemote: enrollment.repoRemote,
    repoRootFingerprint: enrollment.repoRootFingerprint,
  }).catch(() => []);

  let accepted = 0;
  let updated = 0;
  let rejected = 0;
  for (const raw of evidence) {
    try {
      if (!raw || typeof raw !== "object") {
        rejected++;
        continue;
      }
      const item = raw as Record<string, unknown>;
      // Shape-invalid = missing/non-string sourceType or sourceId (F1). A
      // missing/invalid timestamp is NOT shape-invalid — see occurredAt below.
      if (typeof item.sourceType !== "string" || typeof item.sourceId !== "string" || !item.sourceId.trim()) {
        rejected++;
        continue;
      }
      // [F3] v1 accepts ONLY the 5 Leit-supplied sourceTypes. Any other kind
      // (semiote/noema/runir_session/…) is produced Rúnir-side and must never
      // arrive via push (A-2 write-path exclusivity).
      if (!LEIT_SOURCE_TYPE_SET.has(item.sourceType)) {
        rejected++;
        continue;
      }
      const serialized = JSON.stringify(item);
      if (Buffer.byteLength(serialized, "utf8") > EVIDENCE_MAX_REF_BYTES) {
        rejected++;
        continue;
      }
      const ref = item as unknown as EvidenceRef;
      const sourceType = item.sourceType as LeitEvidenceSourceType;
      const sourceId = item.sourceId.trim();

      // [F1] Missing/unparseable timestamp -> occurredAt NONE (unbound).
      // Future timestamps fall outside all windows -> unbound (no
      // clock-skew fudge in v1 — deterministic).
      const occurredAt =
        typeof ref.timestamp === "string" && Number.isFinite(Date.parse(ref.timestamp)) ? ref.timestamp : undefined;

      // Best-effort — a binding failure never rejects the row (orchestrator
      // ruling 2). Pure in-memory selection over the batch-hoisted candidates.
      const boundSessionId = selectBoundSessionId(candidateSessions, occurredAt);

      const { outcome } = await upsertContinuityEvidence(db, {
        userId,
        workspaceId,
        projectKey,
        projectId: enrollment.projectId,
        conflictingProjectId,
        sourceType,
        sourceId,
        occurredAt,
        ref,
        boundSessionId,
      });
      if (outcome === "created") accepted++;
      else updated++;
    } catch {
      rejected++;
    }
  }

  return { accepted, updated, rejected };
}
