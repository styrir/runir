import { createHash } from "node:crypto";
import { resolveEmbeddingProvider, parseConfig, validateRerankerConfig, resolveCaptureApiKey } from "../shared/config.js";
import { resolveBindHost } from "../shared/bind-host.js";
import { buildSupersessionJudge } from "./supersession-judge.js";
import {
  SurrealClient,
  getEmbeddingFingerprint,
  setEmbeddingFingerprint,
} from "../storage/surreal/surreal-store.js";
import {
  buildSemioteProvenanceEnvelope,
  getHexisById,
  getHexisByScopeKey,
  initializeSemioteSemiosis,
  patchSemioteProvenance,
  type SemioteProvenanceBuildInput,
  upsertHexis,
} from "../storage/surreal/phase2-store.js";
import { arbitrateWrite } from "../storage/writes/write-arbitrator.js";
import {
  type Bm25CorpusStats,
  type ExtractedFact,
  type HybridConfig,
  isContinuityStateMemoryRole,
  type MemoryRole,
  type MemoryWriteSource,
  type RecentWrite,
  type WriteSource,
} from "../domain/memory/types.js";
import {
  buildHexisScopeKey,
  hasHexisSignal,
  normalizeHexis,
  type HexisHint,
  type HexisState,
} from "../hexis/runtime-hexis.js";
import {
  classifyRecallMemoryKind,
} from "../recall/continuity/recall-status-policy.js";
import { makeDebugLogger } from "../shared/debug-logger.js";
import { RetrievalStatsCollector } from "../recall/selection/retrieval-stats.js";
import { NoisePrototypeBank } from "../capture/extraction/noise-prototype-bank.js";
import { initializeUsefulnessState } from "../lifecycle/semion/usefulness-feedback.js";
import { createOverlayRegistry } from "../storage/overlay/overlay-store.js";

export { resolveUserId } from "./resolve-user-id.js";

const rawConfig = {
  userId: process.env.RUNIR_USER_ID ?? "default",
  autoRecall: process.env.RUNIR_AUTO_RECALL !== "false",
  autoCapture: process.env.RUNIR_AUTO_CAPTURE !== "false",
  topK: Number(process.env.RUNIR_TOP_K ?? "5"),
  customPrompt: process.env.RUNIR_CUSTOM_PROMPT,
  surrealdb: {
    url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "",
    namespace: process.env.SURREAL_NS ?? "main",
    database: process.env.SURREAL_DB ?? "main",
  },
  embedder: {
    model: process.env.EMBEDDER_MODEL ?? "nomic-embed-text:v1.5",
    baseURL: process.env.EMBEDDER_BASE_URL ?? "http://localhost:11434",
  },
  reranker: process.env.RERANKER_PROVIDER
    ? {
        provider: process.env.RERANKER_PROVIDER,
        openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
        model: process.env.RERANKER_MODEL,
        timeoutMs: process.env.RERANKER_TIMEOUT_MS ? Number(process.env.RERANKER_TIMEOUT_MS) : undefined,
      }
    : undefined,
};

export const cfg: HybridConfig = parseConfig(rawConfig);
validateRerankerConfig(cfg, console.warn, console.info);
export const provider = resolveEmbeddingProvider();
export const debugLogger = makeDebugLogger(process.env.RUNIR_DEBUG === "1");
// Rúnir-pn1l Layer 2 / 13.7: always construct the injected supersession judge HANDLE;
// whether it is consulted is decided per-write by RUNIR_SUPERSEDE_JUDGE_GATE /
// RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM inside arbitrateWrite (ship dark, flip via plist).
// Empty key ⇒ judge() returns unavailable. Logger wired for D7 structured failure lines
// (complements, does not replace, the /health counters).
export const supersessionJudge = buildSupersessionJudge({
  apiKey: resolveCaptureApiKey(cfg),
  logger: (msg) => console.warn(msg),
});
export const retrievalStats = new RetrievalStatsCollector();
export const PORT = Number(process.env.PORT ?? "7700");
// Loopback-only by default; RUNIR_HOST=0.0.0.0 restores all-interfaces binding.
export const HOST = resolveBindHost();

export const db = new SurrealClient(cfg.surrealdb);
export const bm25StatsCache = new Map<string, Bm25CorpusStats>();
export const recentWrites = new Map<string, RecentWrite[]>();
export const overlayTtlMs = Number(process.env.RUNIR_OVERLAY_TTL_MS ?? "120000");
export const overlayRegistry = createOverlayRegistry({
  perTenantCap: Number(process.env.RUNIR_OVERLAY_PER_TENANT_CAP ?? "256"),
  ttlMs: overlayTtlMs,
  globalAggregateCap: Number(process.env.RUNIR_OVERLAY_GLOBAL_CAP ?? "5000"),
});
export const noiseBank = new NoisePrototypeBank();

export const runtime = {
  cfg,
  provider,
  debugLogger,
  retrievalStats,
  db,
  bm25StatsCache,
  recentWrites,
  overlayRegistry,
  noiseBank,
};

function hasEntries(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function hexisSignature(hexis: HexisState): string {
  return JSON.stringify({
    label: hexis.label,
    goals: hexis.goals,
    roles: hexis.roles,
    hypotheses: hexis.hypotheses ?? [],
    topicBias: hexis.topicBias ?? {},
    memoryRoleWeights: hexis.memoryRoleWeights ?? {},
    relevanceWeights: hexis.relevanceWeights,
    admissibility: hexis.admissibility ?? null,
  });
}

function mergeHexisState(persisted: HexisState, normalized: HexisState): HexisState {
  const merged: HexisState = {
    ...persisted,
    ...normalized,
    goals: normalized.goals.length > 0 ? normalized.goals : persisted.goals,
    roles: normalized.roles.length > 0 ? normalized.roles : persisted.roles,
    hypotheses: (normalized.hypotheses?.length ?? 0) > 0 ? normalized.hypotheses : persisted.hypotheses,
    topicBias: hasEntries(normalized.topicBias) ? normalized.topicBias : persisted.topicBias,
    memoryRoleWeights: hasEntries(normalized.memoryRoleWeights) ? normalized.memoryRoleWeights : persisted.memoryRoleWeights,
    relevanceWeights: {
      ...persisted.relevanceWeights,
      ...normalized.relevanceWeights,
    },
    admissibility: normalized.admissibility ?? persisted.admissibility,
    version: persisted.version,
  };
  if (hasHexisSignal(normalized) && hexisSignature(merged) !== hexisSignature(persisted)) {
    merged.version = persisted.version + 1;
  }
  return merged;
}

export async function writeWithArbitration(params: {
  text: string;
  userId: string;
  metadata?: Record<string, unknown>;
  scope: "session" | "user" | "global";
  sessionId?: string;
  source: WriteSource;
  writeSource: MemoryWriteSource;
  targetTable: "memories" | "semiote";
  hexis?: HexisState | null;
  hexisFit?: number;
  rankingExplanation?: string[];
  semioteProvenance?: SemioteProvenanceBuildInput;
  /** Rúnir-pn1l Q4 U2 (seeded-replay harness): OPTIONAL injected clock (epoch ms)
   *  forwarded RAW to `arbitrateWrite.nowMs`. Omitted by every production caller
   *  (`/hooks/capture`, `/memory/store`) ⇒ the arbitration path resolves `Date.now()`
   *  per-site, byte-identical to today. The seeded-replay harness that reproduces a
   *  memory's original write time sets it to the replayed row's `created_at`. */
  nowMs?: number;
}) {
  const initialUsefulness = initializeUsefulnessState(
    typeof params.metadata?.confidence === "number" ? params.metadata.confidence as number : undefined,
  );
  const enrichedMetadata: Record<string, unknown> = {
    ...params.metadata,
    writeSource: params.writeSource,
    usefulnessAlpha: params.metadata?.usefulnessAlpha ?? initialUsefulness.usefulnessAlpha,
    usefulnessBeta: params.metadata?.usefulnessBeta ?? initialUsefulness.usefulnessBeta,
    usefulnessScore: params.metadata?.usefulnessScore ?? initialUsefulness.usefulnessScore,
    retrievedCount: params.metadata?.retrievedCount ?? 0,
    usedCount: params.metadata?.usedCount ?? 0,
    successfulUseCount: params.metadata?.successfulUseCount ?? 0,
    crossSessionUseCount: params.metadata?.crossSessionUseCount ?? 0,
    contradictionCount: params.metadata?.contradictionCount ?? 0,
  };
  const embedding = await provider.embedDocument(params.text);

  const storedFpWrite = await getEmbeddingFingerprint(db);
  const currentFp = provider.fingerprint();
  const fingerprintOk = storedFpWrite === null || storedFpWrite === currentFp;

  const result = await arbitrateWrite({
    db,
    text: params.text,
    userId: params.userId,
    embedding,
    metadata: enrichedMetadata,
    scope: params.scope,
    sessionId: params.sessionId,
    source: params.source,
    recentWrites,
    overlay: {
      registry: overlayRegistry,
      ttlMs: overlayTtlMs,
    },
    embedText: (text: string) => provider.embedDocument(text),
    fingerprintOk,
    targetTable: params.targetTable,
    judge: supersessionJudge,
    // Rúnir-pn1l Q4 U2: forward the optional replay clock raw (undefined for prod).
    nowMs: params.nowMs,
  });
  if (result.outcome === "create" || result.outcome === "merge-update" || result.outcome === "supersede") {
    bm25StatsCache.delete(params.userId);
    bm25StatsCache.delete(`memories:${params.userId}`);
    bm25StatsCache.delete(`semiote:${params.userId}`);
    if (storedFpWrite === null) {
      await setEmbeddingFingerprint(db, currentFp);
    }
    if (params.targetTable === "semiote" && result.memoryId) {
      if (params.semioteProvenance) {
        await patchSemioteProvenance(
          db,
          result.memoryId,
          buildSemioteProvenanceEnvelope(params.semioteProvenance),
        );
      }
      await initializeSemioteSemiosis(db, result.memoryId, {
        confidence: typeof enrichedMetadata.confidence === "number" ? enrichedMetadata.confidence as number : undefined,
        usefulnessAlpha: typeof enrichedMetadata.usefulnessAlpha === "number" ? enrichedMetadata.usefulnessAlpha as number : undefined,
        usefulnessBeta: typeof enrichedMetadata.usefulnessBeta === "number" ? enrichedMetadata.usefulnessBeta as number : undefined,
        usefulnessScore: typeof enrichedMetadata.usefulnessScore === "number" ? enrichedMetadata.usefulnessScore as number : undefined,
        contradictionCount: typeof enrichedMetadata.contradictionCount === "number" ? enrichedMetadata.contradictionCount as number : undefined,
        retrievedCount: typeof enrichedMetadata.retrievedCount === "number" ? enrichedMetadata.retrievedCount as number : undefined,
        hexisId: params.hexis?.id,
        hexisVersion: params.hexis?.version,
        hexisFit: params.hexisFit,
        rankingExplanation: params.rankingExplanation,
        lastEvaluatedAt: new Date().toISOString(),
      });
    }
  }
  return result;
}

export async function resolveActiveHexis(input: {
  userId: string;
  sessionId?: string;
  path?: string;
  projectId?: string;
  agentId?: string;
  hint?: HexisHint;
  persistHint?: boolean;
}): Promise<HexisState | null> {
  const persistHint = input.persistHint ?? true;
  const explicitHintId = input.hint?.id?.trim();
  const explicitHintHasAdditionalSignal = Boolean(
    input.hint
    && (
      input.hint.scope
      || input.hint.label
      || (input.hint.goals?.length ?? 0) > 0
      || (input.hint.roles?.length ?? 0) > 0
      || (input.hint.hypotheses?.length ?? 0) > 0
      || Object.keys(input.hint.topicBias ?? {}).length > 0
      || Object.keys(input.hint.memoryRoleWeights ?? {}).length > 0
      || Object.keys(input.hint.relevanceWeights ?? {}).length > 0
      || input.hint.admissibility
      || input.hint.version != null
    ),
  );

  if (explicitHintId) {
    const explicit = await getHexisById(db, input.userId, explicitHintId);
    if (explicit) return explicit;
  }

  const fallbackInput = explicitHintId && !explicitHintHasAdditionalSignal
    ? { ...input, hint: undefined }
    : input;

  const normalized = normalizeHexis(fallbackInput);
  const scopeKey = buildHexisScopeKey(fallbackInput, normalized.scope);
  const persisted = await getHexisByScopeKey(db, input.userId, scopeKey);

  if (persisted && !fallbackInput.hint) {
    return persisted;
  }

  if (!persisted && !fallbackInput.hint) {
    return null;
  }

  const next = persisted ? mergeHexisState(persisted, normalized) : normalized;

  if (!persistHint && fallbackInput.hint) {
    return next;
  }

  await upsertHexis(db, input.userId, next);
  return next;
}

export function factMetadata(
  fact: ExtractedFact,
  path?: string,
  client?: string,
): Record<string, unknown> {
  return {
    confidence: fact.confidence,
    l0: fact.l0,
    l1: fact.l1,
    category: fact.category,
    tier: fact.tier,
    tags: fact.tags,
    ...(fact.directives && fact.directives.length > 0 ? { directives: fact.directives } : {}),
    factKey: fact.factKey,
    accessCount: 0,
    lastAccessedAt: undefined,
    hasPath: !!path,
    ...(path !== undefined ? { path } : {}),
    ...(client !== undefined ? { client } : {}),
    ...(fact.raw_source_text !== undefined ? { raw_source_text: fact.raw_source_text } : {}),
    ...(fact.rawSpan !== undefined ? { rawSpan: fact.rawSpan } : {}),
    ...(fact.rawSpans !== undefined ? { rawSpans: fact.rawSpans } : {}),
    ...(fact.atomicFact !== undefined ? { atomicFact: fact.atomicFact } : {}),
    ...(fact.event !== undefined ? { event: fact.event } : {}),
    ...(fact.atomicClaims !== undefined ? { atomicClaims: fact.atomicClaims } : {}),
  };
}

export function summarizeContinuityText(text: string, maxLength = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function extractTicketIds(text: string): string[] {
  const matches = text.match(/\b(?:[A-Z][A-Za-z0-9]+-\d+|Rúnir-[A-Za-z0-9]+)\b/g) ?? [];
  return Array.from(new Set(matches));
}

export function deriveContinuitySubjectKey(text: string, memoryRole: MemoryRole, path?: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const slug = normalized.split(" ").slice(0, 8).join(" ");
  const fingerprint = createHash("sha256")
    .update(`${memoryRole}::${path ?? "*"}::${slug}`)
    .digest("hex")
    .slice(0, 16);
  return `${memoryRole}:${fingerprint}`;
}

export function deriveContinuityMetadata(
  text: string,
  base: Record<string, unknown>,
  recordedAt: string,
): Record<string, unknown> {
  const memoryRole = classifyRecallMemoryKind({ id: "continuity", text, score: 1 }) as MemoryRole;
  const continuityMetadata: Record<string, unknown> = {
    ...base,
    memoryRole,
    summary: typeof base.summary === "string" ? base.summary : summarizeContinuityText(text),
    activeTaskIds: Array.isArray(base.activeTaskIds) ? base.activeTaskIds : extractTicketIds(text),
    continuitySubjectKey: typeof base.continuitySubjectKey === "string"
      ? base.continuitySubjectKey
      : deriveContinuitySubjectKey(text, memoryRole, base.path as string | undefined),
  };

  if (isContinuityStateMemoryRole(memoryRole)) {
    continuityMetadata.validAt = typeof base.validAt === "string" ? base.validAt : recordedAt;
    if (base.invalidAt === undefined) {
      continuityMetadata.invalidAt = undefined;
    }
  }

  return continuityMetadata;
}

// deriveProjectStateSnapshot (the authoritative end-of-session project_state
// snapshot) was deleted with the session-end extraction removal (Rúnir-y5on/
// Rúnir-sq3s) — its only caller was the /hooks/session-end write pipeline.
// project_state is now capture-warmed-only (buildWarmedProjectState).
