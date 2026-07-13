/**
 * SurrealDB operational store façade (Rúnir-u7tn.1).
 * Split into cohesive modules; this file re-exports the prior public surface so
 * `src/surreal-store.ts` and existing imports stay byte-compatible.
 */
export {
  ACTIVE_MEMORY_FILTER,
  DEFAULT_FINGERPRINT_TTL_MS,
  projectStateRecordId,
  mapMemoryRowToSearchHit,
  SurrealClient,
  extractId,
} from "./surreal-client.js";

export {
  ensureBm25Index,
  ensureMemoryEnrichmentSchema,
  ensureAttributionFields,
} from "./memory-schema-bootstrap.js";

export {
  hydrateLatestStateRepresentativeHits,
  embeddingForStore,
  composeUpsertMemory,
  upsertMemory,
  listMemories,
  getMemoryById,
  deleteMemoryById,
  listRecentMemories,
  listRecentFactsForCaptureContext,
  listNearbyExistingForCaptureContext,
  findSimilarMemories,
  updateMemoryText,
  supersedeMemory,
  restoreMemoryById,
  getMemoryLineage,
  getMemoryHealth,
  getBm25CorpusStats,
  fetchAllActiveMemoriesForScope,
  softArchiveInactiveOlderThan,
  queryTopMemoriesForNovelty,
  backfillHasPath,
} from "./memory-crud-store.js";

export {
  ensureSessionWatermarksTable,
  getLastWatermark,
  createWatermark,
} from "./session-watermark-store.js";

export {
  ensureEmbeddingMetadataTable,
  getEmbeddingFingerprint,
  setEmbeddingFingerprint,
} from "./embedding-fingerprint-store.js";

export {
  ensureSupersedeShadowTable,
  logSupersedeShadow,
  type LiveFlags,
  type SupersedeShadowParams,
} from "./supersede-shadow-store.js";

export {
  ensureRejectionLogTable,
  logRejection,
} from "./rejection-log-store.js";

export {
  ensureProjectStateTable,
  upsertProjectState,
  compareAndSwapProjectState,
  getProjectState,
  getProjectStateByProjectKey,
  getProjectStateForCaptureContext,
  getProjectStateForRecall,
  listContinuityMemoryHits,
  invalidateContinuityStateRecords,
} from "./project-state-store.js";
