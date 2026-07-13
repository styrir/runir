import type { Hono } from "hono";
import { recordSessionTurns } from "../../../storage/surreal/session-turn-store.js";
import { resolveLlmBaseUrl, resolveLlmTimeoutMs } from "../../../shared/config.js";
import { jsonrepair } from "jsonrepair";
import type { EntityMention, ExtractedFact, MemoryRole, RawExtractedFact } from "../../../domain/memory/types.js";
import {
  scoreHexisFit,
  type HexisHint,
  type HexisState,
} from "../../../hexis/runtime-hexis.js";
import {
  resolveActiveHexisCached,
} from "../../../hexis/active-hexis-cache.js";
import {
  batchDedupFacts,
  extractMemories,
  isNoisyFact,
  normalizeCaptureMessages,
  normalizeExtractedFact,
  resolveCapturePrompt,
} from "../../../capture/extraction/capture.js";
import { compressMessages } from "../../../capture/continuity/session-compressor.js";
import { scoreSessionSalience } from "../../../capture/continuity/session-salience.js";
import { buildWarmedProjectState, type WarmingFact } from "../../../capture/continuity/project-state-warming.js";
import { buildCaptureContextPacket } from "../../../capture/capture-context-assembler.js";
import {
  classifyRecallMemoryKind,
} from "../../../recall/continuity/recall-status-policy.js";
import {
  resolveAttrField,
} from "../../../recall/query/scope-predicate.js";
import {
  createWatermark,
  extractId,
  getLastWatermark,
  getProjectState,
  logRejection,
  upsertProjectState,
} from "../../../storage/surreal/surreal-store.js";
import { linkEntityToMemory } from "../../../entities/entity-store.js";
import { getProjectEnrollment } from "../../../storage/surreal/continuity-state-store.js";
import { ingestEvidenceBatch } from "../../../lifecycle/evidence/evidence-ingest.js";
import { canonicalizeWorkspaceId } from "../../../identity/canonical-context.js";
import { runConsolidationForScope } from "../../../lifecycle/semion/consolidation.js";
import { resolveSemioteOriginContext } from "../../semiote-write-context.js";
import { recordPipelineDrop } from "../../../obs/counters.js";
import { applyUsefulnessFeedback } from "../../../lifecycle/semion/usefulness-feedback.js";
import {
  accrueUsefulnessFromCapture,
  type AccrualCaptureMessage,
  type PriorSemioteUsefulness,
  type UsefulnessAccrualDeps,
} from "../../../lifecycle/semion/usefulness-accrual.js";
import { resolveCaptureApiKey } from "../../../shared/config.js";
import {
  getPrimaryMemoryRowsByIds,
  getRetrievalTrace,
  listRetrievalTraces,
  patchRetrievalTraceAnswer,
  patchRetrievalTraceRating,
  patchSemioteUsefulness,
  promoteSemioteToNoema,
  TRACE_RATINGS,
  type TraceRating,
  upsertSemioteRelation,
} from "../../../storage/surreal/phase2-store.js";
import {
  type CanonicalContextIdentity,
} from "../../../identity/canonical-context.js";
import { resolveRunirSession } from "../../../storage/surreal/runir-session-store.js";
import { resolveBodyCanonicalContext } from "../../../recall/body-resolution.js";
import { orchestrateRecall } from "../../../recall/orchestrator/recall-orchestrator.js";
import {
  bm25StatsCache,
  cfg,
  debugLogger,
  deriveContinuityMetadata,
  factMetadata,
  noiseBank,
  provider,
  resolveUserId,
  retrievalStats,
  runtime,
  resolveActiveHexis,
  writeWithArbitration,
} from "../../runtime.js";

function entityMentionOverlapsWithFact(mention: EntityMention, factText: string): boolean {
  const nameLower = mention.name.toLowerCase();
  const factLower = factText.toLowerCase();
  if (factLower.includes(nameLower)) return true;
  const mentionWords = nameLower.split(/\s+/).filter((w) => w.length > 2);
  const factWords = new Set(factLower.split(/\s+/));
  const overlap = mentionWords.filter((w) => factWords.has(w));
  return overlap.length >= Math.min(3, mentionWords.length) && overlap.length > 0;
}

/**
 * Builds the DB-seam deps for capture-path usefulness auto-accrual (Rúnir-mmg2.2)
 * over the live runtime DB, and fires ONE evaluation fire-and-forget. The caller
 * MUST NOT await this on the response path (R1) — errors are swallowed/warn-logged
 * inside accrueUsefulnessFromCapture, so the returned promise never rejects, but we
 * also `.catch` here belt-and-braces so a thrown deps wiring error can never reach
 * the capture response.
 *
 * The persist patch is SURGICAL (R5): it carries only the usefulness fields + the
 * two status counters — no hexis* fields, no access counters, no other
 * ranking-feeding field.
 */
function fireUsefulnessAccrual(args: {
  userId: string;
  sessionId?: string;
  messages: AccrualCaptureMessage[];
}): void {
  const deps: UsefulnessAccrualDeps = {
    listTraces: (userId, limit) => listRetrievalTraces(runtime.db, userId, limit),
    loadPriorState: async (ids) => {
      const rows = await getPrimaryMemoryRowsByIds(runtime.db, ids, "semiote");
      return rows.map((row): PriorSemioteUsefulness => {
        const payload = row.payload ?? {};
        return {
          id: extractId(row.id),
          memoryText: String(payload.l2 ?? payload.data ?? ""),
          statusRetrievedCount: Number(row.status_retrieved_count ?? 0),
          statusUsedCount: Number(row.status_used_count ?? 0),
          previous: {
            usefulnessAlpha: Number(row.usefulness_alpha ?? payload.usefulnessAlpha ?? 0),
            usefulnessBeta: Number(row.usefulness_beta ?? payload.usefulnessBeta ?? 0),
            usefulnessScore: Number(row.usefulness_score ?? payload.usefulnessScore ?? payload.confidence ?? 0.5),
            retrievedCount: Number(row.retrieved_count ?? payload.retrievedCount ?? 0),
            usedCount: Number(row.used_count ?? payload.usedCount ?? 0),
            successfulUseCount: Number(row.successful_use_count ?? payload.successfulUseCount ?? 0),
            crossSessionUseCount: Number(row.cross_session_use_count ?? payload.crossSessionUseCount ?? 0),
            contradictionCount: Number(row.contradiction_count ?? payload.contradictionCount ?? 0),
            lastRetrievedAt: typeof row.last_retrieved_at === "string" ? row.last_retrieved_at : payload.lastRetrievedAt,
            lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : payload.lastUsedAt,
            lastEvaluatedAt: typeof row.last_evaluated_at === "string" ? row.last_evaluated_at : payload.lastEvaluatedAt,
          },
        };
      });
    },
    persistPatch: (patch) =>
      patchSemioteUsefulness(runtime.db, patch.id, {
        usefulnessAlpha: patch.usefulnessAlpha,
        usefulnessBeta: patch.usefulnessBeta,
        usefulnessScore: patch.usefulnessScore,
        retrievedCount: patch.retrievedCount,
        usedCount: patch.usedCount,
        successfulUseCount: patch.successfulUseCount,
        crossSessionUseCount: patch.crossSessionUseCount,
        contradictionCount: patch.contradictionCount,
        lastRetrievedAt: patch.lastRetrievedAt,
        lastUsedAt: patch.lastUsedAt,
        lastEvaluatedAt: patch.lastEvaluatedAt,
        // Status counters present ONLY for status-class intents; absent → the
        // UPDATE leaves the existing status counters untouched.
        statusRetrievedCount: patch.statusRetrievedCount,
        statusUsedCount: patch.statusUsedCount,
      }),
  };
  void accrueUsefulnessFromCapture(deps, {
    userId: args.userId,
    sessionId: args.sessionId,
    messages: args.messages,
  }).catch((err) => console.warn("runir-capture: usefulness auto-accrual wiring failed:", err));
}

type EntityFactRecordPair = { text: string; confidence: number; replacementMemoryId: string };

async function linkExtractedEntitiesToFacts(args: {
  formatted: ReturnType<typeof normalizeCaptureMessages>;
  apiKey: string | undefined;
  sessionKey: string;
  userId: string;
  sessionTimestamp: string;
  factRecordPairs: EntityFactRecordPair[];
  sourceProject: string;
}) {
  if (args.factRecordPairs.length === 0) {
    return { mentions: 0, links: 0 };
  }

  let entityMentions: EntityMention[] = [];
  try {
    if (!args.apiKey) throw new Error("entity extraction skipped: no capture API key");
    const { extractEntities } = await import("../../../entities/entity-extractor.js");
    entityMentions = await extractEntities(args.formatted, args.apiKey, args.sessionTimestamp, cfg.extractTimeoutMs);
    debugLogger.entityExtraction({
      session: args.sessionKey,
      count: entityMentions.length,
      names: entityMentions.map((m) => m.name).join(","),
    });
  } catch (err) {
    console.warn("runir-service: entity extraction failed (non-fatal):", err);
  }

  if (entityMentions.length === 0) {
    return { mentions: 0, links: 0 };
  }

  let links = 0;
  try {
    const { arbitrateEntity } = await import("../../../entities/entity-arbitrator.js");

    for (const mention of entityMentions) {
      try {
        const result = await arbitrateEntity(runtime.db, mention, args.userId, "session", args.sessionKey, args.sourceProject);
        debugLogger.entityOutcome({ session: args.sessionKey, name: mention.name, outcome: result.outcome });

        for (const pair of args.factRecordPairs) {
          if (!entityMentionOverlapsWithFact(mention, pair.text)) continue;
          await linkEntityToMemory(runtime.db, result.entityId, pair.replacementMemoryId, {
            confidence: mention.confidence,
            contextText: mention.context.slice(0, 200),
            sourceProject: args.sourceProject,
            scope: "session",
            sessionId: args.sessionKey,
          }, "semiote");
          links += 1;
        }
      } catch (mentionErr) {
        console.warn("runir-service: entity arbitration failed for mention:", mention.name, mentionErr);
        debugLogger.entityOutcome({ session: args.sessionKey, name: mention.name, outcome: "error", err: String(mentionErr) });
      }
    }
  } catch (entityErr) {
    console.warn("runir-service: entity wiring failed (non-fatal):", entityErr);
  }

  return { mentions: entityMentions.length, links };
}

function readHarnessJsonEnv<T>(envKey: string): T | undefined {
  const raw = process.env[envKey];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`runir-service: ignoring invalid ${envKey}:`, error);
    return undefined;
  }
}

function readHarnessJsonArrayEnv<T>(envKey: string): T[] | undefined {
  const parsed = readHarnessJsonEnv<unknown>(envKey);
  if (parsed === undefined) return undefined;
  if (Array.isArray(parsed)) return parsed as T[];
  console.warn(`runir-service: ignoring non-array ${envKey}`);
  return undefined;
}

/**
 * Validate/normalize an ALREADY-PARSED request-body value as a fixture-mode
 * fact array (the body is already JSON, so no re-parse). Returns the array only
 * when it is an array of records; otherwise undefined so the caller can fall
 * back to the process-global env blob. Mirrors `readHarnessJsonArrayEnv`'s
 * error-tolerance. Only ever consulted under `isHarnessFixtureMode()`, so
 * production (`RUNIR_TEST_MODE !== "1"`) never reads the body field at all.
 */
function readHarnessJsonArrayValue<T>(value: unknown): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    console.warn("runir-service: ignoring non-array captureFixtureFacts body field");
    return undefined;
  }
  if (!value.every((el) => el !== null && typeof el === "object" && !Array.isArray(el))) {
    console.warn("runir-service: ignoring captureFixtureFacts body field with non-record elements");
    return undefined;
  }
  return value as T[];
}

function isHarnessFixtureMode(): boolean {
  return process.env.RUNIR_TEST_MODE === "1";
}

/**
 * G004: parse a client-supplied session timestamp into a normalized ISO string.
 *
 * Used by /hooks/capture to let replay drivers (e.g. the LoCoMo eval) anchor
 * the extractor's relative-date reasoning to the source conversation's actual
 * wall-clock instead of the harness's "now". Invalid input → undefined, so
 * the caller falls back to `new Date().toISOString()`.
 *
 * The returned value flows ONLY into extractMemories' sessionTimestamp arg
 * (i.e., the `{SESSION_TIMESTAMP}` template substitution in the LLM prompt).
 * It must NOT replace operational `created_at` on stored memories — the
 * retrieval recency leg keys off that field, and silently rewriting write
 * time semantics would change prod retrieval ranking.
 */
function resolveSessionTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

type CaptureTimingStep = { name: string; durationMs: number };
type CaptureTimingSnapshot = {
  totalMs: number;
  phases: CaptureTimingStep[];
  longest: CaptureTimingStep | null;
  nested?: Record<string, CaptureTimingStep[]>;
};

function createCaptureTimer() {
  const routeStartedAt = Date.now();
  let lastMarkAt = routeStartedAt;
  const phases: CaptureTimingStep[] = [];
  const nested: Record<string, CaptureTimingStep[]> = {};
  return {
    mark(name: string): void {
      const now = Date.now();
      phases.push({ name, durationMs: now - lastMarkAt });
      lastMarkAt = now;
    },
    markNested(group: string, name: string, durationMs: number): void {
      (nested[group] ??= []).push({ name, durationMs });
    },
    snapshot(): CaptureTimingSnapshot {
      const totalMs = Date.now() - routeStartedAt;
      const longest = phases.reduce<CaptureTimingStep | null>(
        (max, phase) => (max === null || phase.durationMs > max.durationMs ? phase : max),
        null,
      );
      return { totalMs, phases: [...phases], longest, ...(Object.keys(nested).length ? { nested } : {}) };
    },
  };
}

function resolveHexisHint(value: unknown): HexisHint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as HexisHint;
}

function shouldDisableHexis(body: Record<string, unknown>): boolean {
  return body.disableHexis === true;
}

function resolveHexisContext(args: {
  userId: string;
  sessionId?: string;
  path?: string;
  projectId?: string;
  agentId?: string;
  hexisHint?: HexisHint;
  persistHint?: boolean;
}): Promise<HexisState | null> {
  return resolveActiveHexis({
    userId: args.userId,
    sessionId: args.sessionId,
    path: args.path,
    projectId: args.projectId,
    agentId: args.agentId,
    hint: args.hexisHint,
    persistHint: args.persistHint,
  });
}

async function resolveBodyRunirSession(
  body: Record<string, unknown>,
  userId: string,
  identity: CanonicalContextIdentity,
  path: string | undefined,
  sessionId?: string,
) {
  const clientKind = resolveAttrField(body.client, "RUNIR_SCOPE_CLIENT");
  return resolveRunirSession(runtime.db, {
    userId,
    projectKey: identity.projectKey,
    projectIdentitySource: identity.derivation.projectKey.marker ?? "absent",
    clientKind: clientKind ?? undefined,
    nativeSessionId: sessionId,
    workspacePath: path,
    workspaceFingerprint: typeof body.workspaceFingerprint === "string" ? body.workspaceFingerprint : undefined,
    hostId: typeof body.hostId === "string" ? body.hostId : undefined,
    deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : undefined,
    status: "active",
  });
}

function resolveBodyHexisContext(
  body: Record<string, unknown>,
  userId: string,
  path: string | undefined,
  sessionId?: string,
  options?: {
    persistHint?: boolean;
    allowHintRichCacheRead?: boolean;
  },
): Promise<HexisState | null> {
  if (shouldDisableHexis(body)) {
    return Promise.resolve(null);
  }
  const contextIdentity = resolveBodyCanonicalContext(body, userId, path, sessionId);
  const hexisHint = resolveHexisHint(body.hexis);
  const projectId = contextIdentity.raw.projectId;
  const agentId = contextIdentity.raw.agentId;
  return resolveActiveHexisCached({
    userId,
    sessionId,
    path,
    projectId,
    agentId,
    hexisHint,
    allowHintRichCacheRead: options?.allowHintRichCacheRead,
  }, () => resolveHexisContext({
    userId,
    sessionId,
    path,
    projectId,
    agentId,
    hexisHint,
    persistHint: options?.persistHint,
  }));
}

function scoreFactHexis(args: {
  text: string;
  tags?: string[];
  memoryRole: MemoryRole;
  path?: string;
  category?: string;
  hexis: HexisState | null;
}): { fit: number; explanation: string[] } {
  return scoreHexisFit({
    text: args.text,
    tags: args.tags,
    memoryRole: args.memoryRole,
    path: args.path,
    category: args.category,
  }, args.hexis);
}

function normalizeComparisonText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function selectDerivedFromSourceId(args: {
  shownRows: any[];
  fact: ExtractedFact;
  resultMemoryId?: string;
  outcome: string;
}): string | undefined {
  if (!args.resultMemoryId || args.outcome === "supersede" || !args.fact.factKey) {
    return undefined;
  }

  const normalizedFactText = normalizeComparisonText(args.fact.l2);
  const factKeyMatches = args.shownRows
    .map((row) => {
      const payload = row?.payload ?? {};
      return {
        id: extractId(row?.id),
        factKey: typeof payload.factKey === "string" ? payload.factKey : undefined,
        normalizedText: normalizeComparisonText(payload.l2 ?? payload.data ?? ""),
        sessionId: typeof row?.session_id === "string" ? row.session_id : payload.sessionId,
      };
    })
    .filter((candidate) =>
      candidate.id
      && candidate.id !== args.resultMemoryId
      && !candidate.sessionId
      && candidate.factKey === args.fact.factKey
      && candidate.normalizedText
      && candidate.normalizedText !== normalizedFactText,
    );

  if (factKeyMatches.length !== 1) {
    return undefined;
  }

  return factKeyMatches[0]?.id;
}

export function registerHookRoutes(app: Hono) {
  // Forced/manual trigger for the nightly demand-driven entity repair
  // (Rúnir-b40x.4). Same auth class as /hooks/maintenance. Body:
  // { userId?, sinceHours? (default 24), maxMentions?, maxReextractions? }.
  app.post("/hooks/entity-repair", async (c) => {
    const secret = process.env.MAINTENANCE_SECRET;
    const auth = c.req.header("Authorization");
    if (!secret || auth !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const apiKey = resolveCaptureApiKey(cfg);
    if (!apiKey) {
      return c.json({ error: "entity repair requires capture API key" }, 400);
    }
    const sinceHours = typeof body.sinceHours === "number" && body.sinceHours > 0 ? body.sinceHours : 24;
    const { runNightlyEntityRepair } = await import("../../../lifecycle/entity-repair/nightly-entity-repair.js");
    const report = await runNightlyEntityRepair({
      db: runtime.db,
      userId: uid,
      apiKey,
      sinceIso: new Date(Date.now() - sinceHours * 3600 * 1000).toISOString(),
      limits: {
        ...(typeof body.maxMentions === "number" ? { maxMentions: body.maxMentions } : {}),
        ...(typeof body.maxReextractions === "number" ? { maxReextractions: body.maxReextractions } : {}),
      },
      logger: (msg) => console.info(`runir-service: ${msg}`),
    });
    return c.json(report);
  });

  // Ingest entity candidates from the nightly LangExtract deep sweep
  // (Rúnir-b40x.5). Candidates flow through the EXISTING arbitrateEntity path
  // (same canonicalization/merge as session-end extraction) as session-scoped
  // stubs; the repair job's promotion sweep lifts them to user scope. Body:
  // { userId?, sessionId, candidates: [{ name, kind, context, confidence,
  //   description?, aliases?, subtype? }] }. Auth: MAINTENANCE_SECRET.
  app.post("/hooks/entity-candidates", async (c) => {
    const secret = process.env.MAINTENANCE_SECRET;
    const auth = c.req.header("Authorization");
    if (!secret || auth !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
    if (!sessionId) return c.json({ error: "sessionId required" }, 400);
    const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (rawCandidates.length === 0) return c.json({ accepted: 0, outcomes: [] });
    const { arbitrateEntity } = await import("../../../entities/entity-arbitrator.js");
    const { coerceConfidence01 } = await import("../../../entities/entity-extractor.js");
    const outcomes: Array<{ name: string; outcome: string }> = [];
    for (const raw of rawCandidates.slice(0, 50)) {
      if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim()) continue;
      const mention: EntityMention = {
        name: raw.name.trim(),
        kind: typeof raw.kind === "string" ? raw.kind : "concept",
        context: typeof raw.context === "string" ? raw.context.slice(0, 400) : "",
        confidence: coerceConfidence01(raw.confidence, 0.75),
        aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a: unknown) => typeof a === "string") : [],
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
      } as EntityMention;
      try {
        const result = await arbitrateEntity(runtime.db, mention, uid, "session", sessionId, "langextract-sweep");
        outcomes.push({ name: mention.name, outcome: result.outcome });
      } catch (err) {
        outcomes.push({ name: mention.name, outcome: `error: ${String(err).slice(0, 80)}` });
      }
    }
    return c.json({ accepted: outcomes.length, outcomes });
  });

  // S-2 evidence ingestion (Rúnir-78sy.9, Archeion v2 Phase 0/3b). Leit's
  // collector pushes EvidenceRefs here for the 4 collector-blocked continuity
  // gap detectors. Auth: dedicated RUNIR_EVIDENCE_SECRET bearer, MAINTENANCE_
  // SECRET-class posture (fail-closed 401 even when unset — ratified Q4; this
  // secret must NOT double as MAINTENANCE_SECRET, which carries consolidation-
  // forcing + entity-injection powers the collector must not hold). Path is
  // exempted from the RUNIR_API_KEY middleware via PUBLIC_PATHS (auth.ts).
  //
  // The route keeps ONLY auth/HTTP-shape concerns; the ingestion policy
  // (item validation, F3/F7/F8, binding, upserts) lives in
  // src/lifecycle/evidence/evidence-ingest.ts (Codex P3 — mirrors the
  // /hooks/recall → orchestrateRecall thin-shell precedent below).
  //
  // LOGGING RULE: never log raw `ref` content or `excerpt` anywhere on this
  // path — logs may carry only counts, sourceType, sourceId, and ids.
  app.post("/hooks/evidence", async (c) => {
    const secret = process.env.RUNIR_EVIDENCE_SECRET;
    const auth = c.req.header("Authorization");
    if (!secret || auth !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    // Explicit pre-check: without this, resolveUserId falls back to
    // cfg.userId (the default tenant) whenever body.userId is undefined,
    // which the F1 rule requires this endpoint to reject instead of silently
    // applying. The pre-check rejects missing/blank userId BEFORE that
    // fallback can apply; the try/catch below still catches the
    // RUNIR_SINGLE_TENANT mismatch throw for an explicit-but-wrong userId.
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return c.json({ error: "userId is required" }, 400);
    }
    let uid: string;
    try {
      uid = resolveUserId(body.userId, cfg);
    } catch {
      return c.json({ error: "unauthorized" }, 400);
    }
    const projectKey = typeof body.projectKey === "string" && body.projectKey.trim() ? body.projectKey.trim() : undefined;
    if (!projectKey) return c.json({ error: "projectKey required" }, 400);
    if (!Array.isArray(body.evidence)) return c.json({ error: "evidence must be an array" }, 400);
    const EVIDENCE_MAX_ITEMS = 100;
    if (body.evidence.length > EVIDENCE_MAX_ITEMS) {
      return c.json({ error: `evidence exceeds max item cap (${EVIDENCE_MAX_ITEMS})` }, 400);
    }
    const workspaceId = canonicalizeWorkspaceId(typeof body.workspaceId === "string" ? body.workspaceId : undefined);
    const requestProjectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;

    const enrollment = await getProjectEnrollment(runtime.db, uid, workspaceId, projectKey);
    if (!enrollment) {
      return c.json({ error: "project is not enrolled" }, 422);
    }

    const result = await ingestEvidenceBatch(runtime.db, console.warn, {
      userId: uid,
      workspaceId,
      projectKey,
      enrollment,
      requestProjectId,
      evidence: body.evidence as unknown[],
    });
    return c.json(result);
  });

  app.post("/hooks/maintenance", async (c) => {
    const secret = process.env.MAINTENANCE_SECRET;
    const auth = c.req.header("Authorization");
    if (!secret || auth !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const requestedScopes = Array.isArray(body.scopes)
      ? body.scopes
      : body.scope
        ? [body.scope]
        : ["session", "user", "global"];
    const scopes = requestedScopes.filter((scope: unknown): scope is "session" | "user" | "global" =>
      scope === "session" || scope === "user" || scope === "global",
    );
    const apiKey = resolveCaptureApiKey(cfg);
    if (!apiKey) {
      return c.json({ error: "maintenance requires capture API key" }, 400);
    }
    const results = await Promise.all(
      scopes.map(async (scope: "session" | "user" | "global") => ({
        scope,
        ...(await runConsolidationForScope(
          runtime.db,
          uid,
          scope,
          (text: string) => provider.embedDocument(text),
          bm25StatsCache,
          apiKey,
          console.warn,
        )),
      })),
    );
    return c.json({ ok: true, userId: uid, table: "semiote", results });
  });

  app.post("/hooks/recall", async (c) => {
    // Guard the body parse like /hooks/session-end: malformed bodies degrade
    // to {} (→ empty prompt → the adaptive skip), and the object coercion
    // covers the JSON literal `null` / bare primitives which c.req.json()
    // RESOLVES rather than throws — never an unhandled throw → Hono 500.
    const parsedRecallBody = await c.req.json().catch(() => ({}));
    const body = parsedRecallBody && typeof parsedRecallBody === "object" ? parsedRecallBody : {};
    const prompt: string = body.prompt ?? "";
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }

    // Orchestration extracted to src/recall/orchestrator/recall-orchestrator.ts
    // (Rúnir-qjn4.2). The route parses the body, resolves the user (the 400
    // unauthorized path stays here, pre-orchestration), then delegates and
    // serializes the returned body 1:1. `statusCode` carries the 500 error path.
    const result = await orchestrateRecall(
      {
        db: runtime.db,
        provider,
        overlayRegistry: runtime.overlayRegistry,
        cfg,
        debugLogger,
        retrievalStats,
        resolveActiveHexis,
      },
      { body, prompt, uid },
    );
    return result.statusCode ? c.json(result.body, result.statusCode) : c.json(result.body);
  });

  // Agent-steered THINK surface (Rúnir-b40x.6): explicit question → recall →
  // ONE gateway synthesis call under cite-or-gap hard rules → {answer,
  // citations, gaps}. Empty retrieval returns an honest no-answer WITHOUT an
  // LLM call. Verbatim-content sensitivity: requires an EXPLICIT userId (same
  // rule as the trace endpoints). The ambient hooks stay raw-prepend; this
  // surface exists for deliberate deeper queries (see the runir-search skill).
  app.post("/memory/think", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return c.json({ error: "explicit userId required" }, 400);
    }
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const question = typeof body.question === "string" && body.question.trim()
      ? body.question.trim()
      : typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!question) return c.json({ error: "question required" }, 400);

    const { buildThinkPrompt, parseThinkResponse, emptyThinkResponse } = await import("../../../recall/orchestrator/think-synthesis.js");
    const result = await orchestrateRecall(
      { db: runtime.db, provider, overlayRegistry: runtime.overlayRegistry, cfg, debugLogger, retrievalStats, resolveActiveHexis },
      { body: { ...body, prompt: question, hexisDebug: false }, prompt: question, uid },
    );
    const recallBody: any = result.body ?? {};
    const selected: any[] = Array.isArray(recallBody.selected) ? recallBody.selected : [];
    const evidence = selected
      .map((hit) => ({ id: String(hit.id ?? ""), text: String(hit.content ?? hit.text ?? hit.l2 ?? "") }))
      .filter((item) => item.id && item.text)
      .slice(0, 12);

    if (result.kind === "skipped" || evidence.length === 0) {
      return c.json({ ...emptyThinkResponse(question), retrievalTraceId: recallBody.retrievalTraceId, evidenceCount: 0 });
    }

    const apiKey = resolveCaptureApiKey(cfg);
    if (!apiKey) return c.json({ error: "think requires the gateway API key" }, 500);
    const model = process.env.RUNIR_THINK_MODEL || process.env.RUNIR_EXTRACTOR_MODEL || "vertex/gemini-3.1-flash-lite@us";
    const { system, user } = buildThinkPrompt(question, evidence);
    let synthesis;
    try {
      const response = await fetch(`${resolveLlmBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: 1200,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(resolveLlmTimeoutMs()),
      });
      if (!response.ok) throw new Error(`gateway ${response.status}`);
      const data: any = await response.json();
      const raw = String(data?.choices?.[0]?.message?.content ?? "");
      synthesis = parseThinkResponse(raw, evidence, jsonrepair);
    } catch (err) {
      synthesis = {
        answer: null, citations: [], droppedCitations: [],
        gaps: [`synthesis call failed: ${String(err).slice(0, 120)} — raw evidence is in the citations-capable /memory/search surface`],
      };
    }

    // Persist the synthesis onto the recall's own trace row (additive,
    // SCHEMALESS) so usefulness tooling can credit cited memories later.
    if (typeof recallBody.retrievalTraceId === "string" && recallBody.retrievalTraceId) {
      void runtime.db.query(
        `UPDATE type::record('retrieval_trace', $traceId) SET synthesis = $synthesis;`,
        { traceId: recallBody.retrievalTraceId, synthesis: { question, ...synthesis, model } },
      ).catch((err: unknown) => console.warn(`memory-hybrid: think synthesis persist failed: ${String(err).slice(0, 120)}`));
    }

    return c.json({
      ...synthesis,
      retrievalTraceId: recallBody.retrievalTraceId,
      evidenceCount: evidence.length,
      evidence: evidence.map((item) => ({ id: item.id, preview: item.text.slice(0, 140) })),
    });
  });

  app.post("/hooks/feedback", async (c) => {
    // Guard the body parse like /hooks/session-end: malformed bodies degrade
    // to {} (→ the existing missing retrievalTraceId/answer 400), with object
    // coercion for the JSON literal `null` / bare primitives — never a 500.
    const parsedFeedbackBody = await c.req.json().catch(() => ({}));
    const body = parsedFeedbackBody && typeof parsedFeedbackBody === "object" ? parsedFeedbackBody : {};
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }

    const retrievalTraceId = typeof body.retrievalTraceId === "string" ? body.retrievalTraceId : "";
    const answer = typeof body.answer === "string" ? body.answer : "";
    if (!retrievalTraceId || !answer.trim()) {
      return c.json({ error: "retrievalTraceId and answer are required" }, 400);
    }

    const trace = await getRetrievalTrace(runtime.db, retrievalTraceId, uid);
    if (!trace) {
      return c.json({ error: "retrieval trace not found" }, 404);
    }

    const rows = await getPrimaryMemoryRowsByIds(runtime.db, trace.items.map((item) => item.id), "semiote");
    const rowById = new Map(rows.map((row) => [extractId(row.id), row]));
    const correctedIds = new Set<string>(
      (Array.isArray(body.correctedIds) ? body.correctedIds : []).map((id: unknown) => String(id).replace(/^semiote:/, "")),
    );
    // Persist the model answer + feedback metadata onto the trace so the recall
    // receipt is complete (prompt -> recalled items -> answer -> corrections).
    // Single user-scoped UPDATE; last-write-wins on re-POST (sole writer of these fields).
    await patchRetrievalTraceAnswer(runtime.db, retrievalTraceId, uid, {
      answer,
      responseResolution: typeof body.responseResolution === "string" ? body.responseResolution : undefined,
      correctedIds: Array.from(correctedIds),
    });
    let evaluated = 0;
    const promotedIds = new Set<string>();

    for (const item of trace.items) {
      const normalizedId = item.id.replace(/^semiote:/, "");
      const row = rowById.get(normalizedId) ?? rowById.get(item.id);
      if (!row) continue;

      const payload = row.payload ?? {};
      const patch = applyUsefulnessFeedback({
        memoryText: String(payload.l2 ?? payload.data ?? ""),
        answer,
        responseResolution: body.responseResolution,
        corrected: correctedIds.has(normalizedId) || correctedIds.has(item.id),
        crossSession: Boolean(body.sessionId && trace.sessionId && body.sessionId !== trace.sessionId),
        previous: {
          usefulnessAlpha: Number(row.usefulness_alpha ?? payload.usefulnessAlpha ?? 0),
          usefulnessBeta: Number(row.usefulness_beta ?? payload.usefulnessBeta ?? 0),
          usefulnessScore: Number(row.usefulness_score ?? payload.usefulnessScore ?? payload.confidence ?? 0.5),
          retrievedCount: Number(row.retrieved_count ?? payload.retrievedCount ?? 0),
          usedCount: Number(row.used_count ?? payload.usedCount ?? 0),
          successfulUseCount: Number(row.successful_use_count ?? payload.successfulUseCount ?? 0),
          crossSessionUseCount: Number(row.cross_session_use_count ?? payload.crossSessionUseCount ?? 0),
          contradictionCount: Number(row.contradiction_count ?? payload.contradictionCount ?? 0),
          lastRetrievedAt: typeof row.last_retrieved_at === "string" ? row.last_retrieved_at : payload.lastRetrievedAt,
          lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : payload.lastUsedAt,
          lastEvaluatedAt: typeof row.last_evaluated_at === "string" ? row.last_evaluated_at : payload.lastEvaluatedAt,
        },
        traceCreatedAt: trace.createdAt,
      });
      patch.hexisId = trace.hexisId;
      patch.hexisVersion = trace.hexisVersion;
      patch.hexisFit = item.hexisFit;
      patch.rankingExplanation = item.rankingExplanation;
      await patchSemioteUsefulness(runtime.db, normalizedId, patch);
      const updatedRow = {
        ...row,
        usefulness_alpha: patch.usefulnessAlpha,
        usefulness_beta: patch.usefulnessBeta,
        usefulness_score: patch.usefulnessScore,
        retrieved_count: patch.retrievedCount,
        used_count: patch.usedCount,
        successful_use_count: patch.successfulUseCount,
        cross_session_use_count: patch.crossSessionUseCount,
        contradiction_count: patch.contradictionCount,
        last_retrieved_at: patch.lastRetrievedAt,
        last_used_at: patch.lastUsedAt,
        last_evaluated_at: patch.lastEvaluatedAt,
      };
      const promotion = await promoteSemioteToNoema(runtime.db, updatedRow);
      if (promotion.promoted && promotion.id) {
        promotedIds.add(promotion.id);
      }
      evaluated++;
    }

    return c.json({ success: true, evaluated, promoted: promotedIds.size, promotedIds: Array.from(promotedIds) });
  });

  // Memory Impact Viewer (A′): user-scoped read access to recall traces.
  // Trace data is the most sensitive projection (verbatim prompt + injected
  // context + model answer), so these endpoints require an EXPLICIT userId
  // rather than falling back to the configured default.
  app.get("/hooks/traces", async (c) => {
    const queryUserId = c.req.query("userId");
    if (queryUserId === undefined) return c.json({ error: "unauthorized" }, 400);
    let uid: string;
    try { uid = resolveUserId(queryUserId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1), 200);
    try {
      const traces = await listRetrievalTraces(runtime.db, uid, limit);
      return c.json({ traces });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get("/hooks/traces/:id", async (c) => {
    const queryUserId = c.req.query("userId");
    if (queryUserId === undefined) return c.json({ error: "unauthorized" }, 400);
    let uid: string;
    try { uid = resolveUserId(queryUserId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const traceId = c.req.param("id").replace(/^retrieval_trace:/, "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(traceId)) {
      return c.json({ error: "Invalid traceId format" }, 400);
    }
    try {
      const trace = await getRetrievalTrace(runtime.db, traceId, uid);
      if (!trace) return c.json({ error: "retrieval trace not found" }, 404);
      return c.json({ trace });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // THIN human recall-quality label (A′). DELIBERATELY SEPARATE from
  // /hooks/feedback: that endpoint requires a non-empty answer and reinforces
  // per-memory usefulness via lexical overlap; this one records the human's
  // clean verdict on the recall (helped|hurt|unused|missing|stale + note) onto
  // the trace and NEVER enters the usefulness loop. Same explicit-userId
  // posture as the trace reads (the trace is the sensitive projection).
  app.post("/hooks/traces/:id/rate", async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    if (body.userId === undefined) return c.json({ error: "unauthorized" }, 400);
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }

    const rating = typeof body.rating === "string" ? body.rating : "";
    if (!TRACE_RATINGS.includes(rating as TraceRating)) {
      return c.json({ error: `rating must be one of: ${TRACE_RATINGS.join(", ")}` }, 400);
    }
    const traceId = c.req.param("id").replace(/^retrieval_trace:/, "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(traceId)) {
      return c.json({ error: "Invalid traceId format" }, 400);
    }
    const note = typeof body.note === "string" ? body.note.trim() || undefined : undefined;

    try {
      const trace = await getRetrievalTrace(runtime.db, traceId, uid);
      if (!trace) return c.json({ error: "retrieval trace not found" }, 404);
      await patchRetrievalTraceRating(runtime.db, traceId, uid, { rating: rating as TraceRating, note });
      return c.json({ success: true, id: traceId, rating, rated: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/hooks/capture", async (c) => {
    const timer = createCaptureTimer();
    // Guard the body parse like /hooks/session-end: malformed bodies degrade
    // to {} (→ the "no messages" skip), with object coercion for the JSON
    // literal `null` / bare primitives — never an unhandled throw → Hono 500.
    const parsedCaptureBody = await c.req.json().catch(() => ({}));
    const body = parsedCaptureBody && typeof parsedCaptureBody === "object" ? parsedCaptureBody : {};
    timer.mark("parse_body");
    const isCaptureDebug = process.env.RUNIR_DEBUG === "1" || body.hexisDebug === true || body.captureDebug === true;
    const includeCaptureTimings = isCaptureDebug || body.captureTimingDebug === true;
    const debugTimings = () => (includeCaptureTimings ? { _debug: { timings: timer.snapshot() } } : {});
    const messages = body.messages ?? [];
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const capturePath = resolveAttrField(body.path, "RUNIR_SCOPE_PATH");
    const captureClient = resolveAttrField(body.client, "RUNIR_SCOPE_CLIENT");
    // G004: accept optional sessionTimestamp from clients (e.g. LoCoMo eval driver)
    // so the extractor anchors relative dates against the conversation's actual
    // wall-clock instead of "now". Falls back to new Date() when absent.
    // IMPORTANT: this timestamp is the source-conversation temporal anchor for
    // extraction only. It must NOT become the stored memory's created_at — the
    // retrieval layer's recency leg depends on operational write time.
    const clientSessionTimestamp = resolveSessionTimestamp(body.sessionTimestamp);
    timer.mark("resolve_request_context");
    if (messages.length === 0) return c.json({ skipped: true, reason: "no messages", ...debugTimings() });

    try {
      const contextIdentity = resolveBodyCanonicalContext(body, uid, capturePath, body.sessionId);
      const runirSession = await resolveBodyRunirSession(body, uid, contextIdentity, capturePath, body.sessionId);
      const activeHexis = await resolveBodyHexisContext(body, uid, capturePath, body.sessionId);
      timer.mark("resolve_identity_session_hexis");
      const formatted = normalizeCaptureMessages(messages);
      if (formatted.length === 0) return c.json({ skipped: true, reason: "no normalizable messages", ...debugTimings() });
      // Usefulness auto-accrual (Rúnir-mmg2.2): when this batch's last turn is the
      // assistant's answer, evaluate the most recent retrieval trace for the
      // session against it and persist usefulness + status-noise counters. Pure
      // lexical (no LLM), fire-and-forget, never fails/delays capture (R1).
      fireUsefulnessAccrual({ userId: uid, sessionId: body.sessionId, messages: formatted });
      const retrievalTraceId = typeof body.retrievalTraceId === "string" && body.retrievalTraceId.trim()
        ? body.retrievalTraceId.trim()
        : undefined;
      timer.mark("normalize_and_schedule_usefulness");
      const captureContextPacket = await buildCaptureContextPacket({
        db: runtime.db,
        userId: uid,
        identity: contextIdentity,
        retrievalTraceId,
        onTiming: (name, durationMs) => timer.markNested("build_capture_context", name, durationMs),
      });
      timer.mark("build_capture_context");

      const salience = await scoreSessionSalience(
        runtime.db,
        formatted,
        formatted.map((m) => m.content).join("\n"),
        { userId: uid, scope: "user", sessionKey: body.sessionId ?? "default", provider },
      );
      debugLogger.salience({
        session: body.sessionId ?? "default",
        score: salience.score,
        hardOverride: salience.hardOverride,
        reason: salience.reason,
      });
      timer.mark("score_salience");

      const compressed = compressMessages(formatted, cfg.extractMaxChars);
      const apiKey = resolveCaptureApiKey(cfg);
      // Fixture-mode only: prefer a PER-REQUEST body field (so the product-eval
      // lane can drive distinct facts per session — the process-global env blob
      // cannot disambiguate sessions) and fall back to the process env when the
      // body field is absent (existing live ingestion-harness scenarios). The
      // gate stays isHarnessFixtureMode() so production ignores the body field.
      const captureFixtureFacts = isHarnessFixtureMode()
        ? (readHarnessJsonArrayValue<RawExtractedFact>(body.captureFixtureFacts)
            ?? readHarnessJsonArrayEnv<RawExtractedFact>("RUNIR_TEST_CAPTURE_FACTS_JSON"))
        : undefined;
      timer.mark("compress_and_gate_api_key");
      if (!apiKey && !captureFixtureFacts) return c.json({ skipped: true, reason: "no capture API key", ...debugTimings() });

      if (!salience.hardOverride && salience.score < 0.25 && noiseBank.initialized) {
        try {
          const fullText = formatted.map((m) => m.content).join("\n");
          const inputEmbedding = await provider.embedDocument(fullText);
          if (noiseBank.isNoise(inputEmbedding)) {
            timer.mark("noise_bank_filter");
            return c.json({ skipped: true, reason: "noise-bank", ...debugTimings() });
          }
        } catch {}
        timer.mark("noise_bank_filter");
      }

      const onReject = (raw: { l2: string; confidence: number }, reason: string) => {
        logRejection(runtime.db, {
          reason,
          candidateText: raw.l2,
          confidence: raw.confidence,
          sessionId: body.sessionId,
          userId: uid,
        }).catch(() => {});
      };
      const extractedRawFacts = captureFixtureFacts ?? await extractMemories(
        compressed,
        resolveCapturePrompt(cfg.customPrompt),
        apiKey,
        clientSessionTimestamp ?? new Date().toISOString(),
        onReject,
        {
          timeoutMs: cfg.extractTimeoutMs,
          model: cfg.extractModel,
          onTiming: (name, durationMs) => timer.markNested("extract_memories", name, durationMs),
        },
      );
      timer.mark("extract_memories");
      const rawFacts = extractedRawFacts.map((fact) => normalizeExtractedFact(fact));

      const outcomes: Record<string, number> = { create: 0, skip: 0, "merge-update": 0, supersede: 0 };
      const rejections: { suppressed: number; rejected_short: number; rejected_noise: number } = {
        suppressed: 0,
        rejected_short: 0,
        rejected_noise: 0,
      };

      if (rawFacts.length === 0) {
        if (noiseBank.initialized && !salience.hardOverride && salience.score < 0.25) {
          try {
            const fullText = formatted.map((m) => m.content).join("\n");
            const inputEmbedding = await provider.embedDocument(fullText);
            noiseBank.learn(inputEmbedding);
          } catch {}
        }
        timer.mark("handle_empty_facts");
        return c.json({ skipped: false, factsFound: 0, outcomes, units: [], rejections, ...debugTimings() });
      }

      const facts = await batchDedupFacts(rawFacts, (text: string) => provider.embedDocument(text));
      timer.mark("dedup_fact_embeddings");
      let suppressedShownRementionCount = 0;
      let createdDerivedFromCount = 0;
      let filteredFacts = facts;
      let shownRows: any[] = [];
      if (captureContextPacket.retrieval_footprint?.shownMemoryIds.length) {
        shownRows = await getPrimaryMemoryRowsByIds(
          runtime.db,
          captureContextPacket.retrieval_footprint.shownMemoryIds,
          "semiote",
        );
        const shownTexts = new Set<string>();
        for (const row of shownRows) {
          const payload = row?.payload ?? {};
          const text = normalizeComparisonText(payload.l2 ?? payload.data ?? "");
          if (text) shownTexts.add(text);
        }
        filteredFacts = facts.filter((fact) => {
          const isShownRemention = shownTexts.has(normalizeComparisonText(fact.l2));
          if (isShownRemention) {
            suppressedShownRementionCount += 1;
            rejections.suppressed += 1;
            return false;
          }
          return true;
        });
      }
      timer.mark("filter_shown_rementions");
      const rawMessageTimestamps = (Array.isArray(messages) ? messages : [])
        .map((message: any) => {
          const value = typeof message?.timestamp === "string" ? message.timestamp : undefined;
          return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
        })
        .filter((value): value is string => Boolean(value));
      const batchTimestamp = rawMessageTimestamps.at(-1) ?? new Date().toISOString();
      const perFactResults: Array<{ fact: typeof facts[0]; outcome: string; timestamp: string; order: number; memoryId: string | null }> = [];
      for (const fact of filteredFacts) {
        if (fact.l2.trim().length < 10) {
          rejections.rejected_short += 1;
          continue;
        }
        if (isNoisyFact(fact.l2)) {
          rejections.rejected_noise += 1;
          console.warn(`memory-hybrid: noise filter rejected fact: ${fact.l2.slice(0, 80)}`);
          logRejection(runtime.db, {
            reason: "noise-filter",
            candidateText: fact.l2,
            confidence: fact.confidence,
            sessionId: body.sessionId,
            userId: uid,
          }).catch(() => {});
          continue;
        }
        const captureRecordedAt = new Date().toISOString();
        const captureOrigin = resolveSemioteOriginContext({
          identity: contextIdentity,
          sourceKind: "capture",
          writeSource: "capture",
          retrievalTraceId,
          runirSessionId: runirSession.id,
          nativeSessionId: body.sessionId,
          sessionId: body.sessionId,
          path: capturePath ?? undefined,
          client: captureClient ?? undefined,
          extraction: {
            mode: "capture",
            model: cfg.extractModel,
            capturedAt: captureRecordedAt,
          },
        });
        const hexisScore = scoreFactHexis({
          text: fact.l2,
          tags: fact.tags,
          memoryRole: classifyRecallMemoryKind({ id: "hexis-capture", text: fact.l2, score: 1 }) as MemoryRole,
          path: captureOrigin.path,
          category: fact.category,
          hexis: activeHexis,
        });
        const result = await writeWithArbitration({
          text: fact.l2,
          userId: uid,
          metadata: deriveContinuityMetadata(
            fact.l2,
            factMetadata(fact, captureOrigin.path, captureOrigin.client),
            captureRecordedAt,
          ),
          scope: "user",
          sessionId: captureOrigin.sessionId,
          source: "agent_end",
          writeSource: "capture",
          targetTable: "semiote",
          hexis: activeHexis,
          hexisFit: hexisScore.fit,
          rankingExplanation: hexisScore.explanation,
          semioteProvenance: captureOrigin.provenance,
        });
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
        const derivedFromSourceId = selectDerivedFromSourceId({
          shownRows,
          fact,
          resultMemoryId: result.memoryId,
          outcome: result.outcome,
        });
        if (derivedFromSourceId && retrievalTraceId) {
          await upsertSemioteRelation(runtime.db, {
            in: result.memoryId!,
            out: derivedFromSourceId,
            kind: "derived_from",
            userId: uid,
            scope: "user",
            sessionId: body.sessionId,
            path: capturePath ?? undefined,
            retrievalTraceId,
            sourceWrite: "capture",
            provenance: "capture-grounded",
          });
          createdDerivedFromCount += 1;
        }
        const order = perFactResults.length;
        perFactResults.push({
          fact,
          outcome: result.outcome,
          timestamp: batchTimestamp,
          order,
          memoryId: result.memoryId ?? null,
        });
      }
      timer.mark("write_arbitration");

      // Project state warming — opportunistic, lossy, subordinate to session-end
      const warmingFacts: WarmingFact[] = perFactResults.map(({ fact, outcome, timestamp, order }) => ({
        text: fact.l2,
        category: fact.category,
        confidence: fact.confidence,
        outcome,
        timestamp,
        order,
      }));
      // Only warm project_state from slices that are likely to represent a single turn.
      // Retry-with-accumulation can mix older and newer turns in one batch, and capture
      // extraction does not attribute facts back to specific source messages yet.
      if (warmingFacts.length > 0 && formatted.length <= 2) {
        const existingProjectState = await getProjectState(runtime.db, uid, capturePath ?? undefined, contextIdentity.projectKey);
        const warmedProjectState = buildWarmedProjectState({
          existing: existingProjectState,
          facts: warmingFacts,
          userId: uid,
          projectKey: contextIdentity.projectKey,
          path: capturePath ?? undefined,
          sessionId: body.sessionId,
        });
        if (warmedProjectState) {
          upsertProjectState(runtime.db, warmedProjectState)
            .catch((err) => console.warn("runir-service: capture warming upsertProjectState failed:", err));
        }
      }
      timer.mark("project_state_warming");

      const entityLinkArgs = {
        formatted,
        apiKey,
        sessionKey: body.sessionId ?? "default",
        userId: uid,
        sessionTimestamp: clientSessionTimestamp ?? new Date().toISOString(),
        factRecordPairs: perFactResults
          .filter((result): result is typeof result & { memoryId: string } => typeof result.memoryId === "string")
          .map((result) => ({
            text: result.fact.l2,
            confidence: result.fact.confidence,
            replacementMemoryId: result.memoryId,
          })),
        sourceProject: (cfg as any).sourceProject ?? "runir",
      };
      let captureEntityLinks: Awaited<ReturnType<typeof linkExtractedEntitiesToFacts>> = { mentions: 0, links: 0 };
      if (isCaptureDebug) {
        captureEntityLinks = await linkExtractedEntitiesToFacts(entityLinkArgs);
      } else {
        void linkExtractedEntitiesToFacts(entityLinkArgs).catch((err) =>
          console.warn("runir-service: capture entity linking failed (background):", err),
        );
      }
      timer.mark(isCaptureDebug ? "entity_linking" : "schedule_entity_linking");
      // [PRODUCTION-CODE TOUCH — flagged for review]
      // echoRawFacts: when `body.echoRawFacts === true` AND `RUNIR_DEBUG === "1"` AND
      // NOT fixture-mode (recording needs real extraction, fixture-mode would inject
      // pre-recorded facts), echo the real extractor output in the response so the
      // parity cassette recorder (scripts/parity/record-real-capture.ts Phase A) can
      // collect one canonical RawExtractedFact[] per capture turn without a second
      // LLM call. Production (RUNIR_DEBUG unset) never evaluates this branch.
      const echoRawFacts =
        !isHarnessFixtureMode() &&
        process.env.RUNIR_DEBUG === "1" &&
        body.echoRawFacts === true;
      const units = perFactResults.map((r) => ({
        id: r.memoryId,
        content: r.fact.l2,
        outcome: r.outcome,
        confidence: r.fact.confidence,
        category: r.fact.category,
        timestamp: r.timestamp,
        ...(r.fact.raw_source_text !== undefined ? { raw_source_text: r.fact.raw_source_text } : {}),
      }));
      timer.mark("build_response_payload");
      return c.json({
        skipped: false,
        factsFound: facts.length,
        outcomes,
        units,
        rejections,
        ...(echoRawFacts ? { rawFacts: extractedRawFacts } : {}),
        ...(includeCaptureTimings ? {
          _debug: {
            timings: timer.snapshot(),
            ...(isCaptureDebug ? {
              retrievalTraceId: retrievalTraceId ?? null,
              captureContext: captureContextPacket.debug,
              suppressedShownRementionCount,
              createdDerivedFromCount,
              entityLinks: captureEntityLinks,
              runirSession: {
                id: runirSession.id,
                projectIdentitySource: runirSession.projectIdentitySource,
                status: runirSession.status,
                closeReason: runirSession.closeReason ?? null,
              },
            } : {}),
          },
        } : {}),
      });
    } catch (err) {
      return c.json({ error: String(err), ...debugTimings() }, 500);
    }
  });

  // /hooks/session-end is extraction-FREE by decision (Rúnir-y5on/Rúnir-sq3s,
  // D1 recorded 2026-07-03): extraction is TURN-BASED ONLY via /hooks/capture
  // — a session may never cleanly end (crash/kill/resume), so end-of-session
  // LLM work was both unreliable and redundant with the per-turn capture path.
  // This handler does exactly: body parse + auth + watermark (skip/trim/
  // advance) + raw-turn recording (the nightly deep-sweep feed) + runir_session
  // close. ZERO LLM calls. The retroactive staleness pass relocated to the
  // scheduled maintenance path (runConsolidationForScope, stored-memory mode);
  // session enrichment was DROPPED from all automatic paths.
  app.post("/hooks/session-end", async (c) => {
    // Guard the body parse like every sibling hook handler in this file: a
    // malformed/truncated request body must degrade to {} (→ "no messages"
    // skip or a 400 from resolveUserId), never an unhandled throw that Hono
    // surfaces as a 500. Clients record any non-2xx as an error trace, so a
    // 500 here only pollutes the inspector's error count. The object coercion
    // covers the JSON literal `null` (and bare primitives), which c.req.json()
    // RESOLVES rather than throws — so .catch() never fires and a raw
    // `body.messages` read would 500 before the pipeline try (Codex MAJOR #3).
    const parsedBody = await c.req.json().catch(() => ({}));
    const body = parsedBody && typeof parsedBody === "object" ? parsedBody : {};
    const messages = body.messages ?? [];
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    if (messages.length === 0) return c.json({ skipped: true, reason: "no messages" });

    const sessionKey: string = body.sessionId ?? "default";
    const sessionPath = resolveAttrField(body.path, "RUNIR_SCOPE_PATH");
    const sessionClient = resolveAttrField(body.client, "RUNIR_SCOPE_CLIENT");
    const sessionTerminationReason =
      typeof body.terminationReason === "string"
        ? body.terminationReason
        : typeof body.reason === "string"
          ? body.reason
          : undefined;
    const messageOffset: number | undefined =
      typeof body.messageOffset === "number" ? body.messageOffset : undefined;
    const batchStart: number = messageOffset !== undefined ? messageOffset - messages.length : 0;
    const totalMessageCount: number = messageOffset ?? messages.length;

    try {
      const contextIdentity = resolveBodyCanonicalContext(body, uid, sessionPath, sessionKey);
      // Resolve-or-create the runir_session row up front (same row lifecycle
      // as before the extraction removal) so the status:"closed" resolve at
      // the bottom updates an existing row rather than minting one at close.
      await resolveBodyRunirSession(body, uid, contextIdentity, sessionPath, sessionKey);

      // F2 (Rúnir-78sy.13): closes the runir_session row. Shared by the
      // watermark-skip early-return below AND the tail of the happy path —
      // an end signal is an end signal even when the content is already
      // captured (the common case under turn-based capture; sq3s canon).
      // The row is already resolved above at this point in every call path,
      // so this only ever UPDATEs.
      const closeRunirSession = async (): Promise<Awaited<ReturnType<typeof resolveRunirSession>>> => {
        const sessionTs = new Date().toISOString();
        return resolveRunirSession(runtime.db, {
          userId: uid,
          projectKey: contextIdentity.projectKey,
          projectIdentitySource: contextIdentity.derivation.projectKey.marker ?? "absent",
          clientKind: sessionClient ?? undefined,
          nativeSessionId: sessionKey,
          workspacePath: sessionPath,
          workspaceFingerprint: typeof body.workspaceFingerprint === "string" ? body.workspaceFingerprint : undefined,
          hostId: typeof body.hostId === "string" ? body.hostId : undefined,
          deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : undefined,
          status: "closed",
          closeReason: sessionTerminationReason,
          closedAt: sessionTs,
          now: sessionTs,
        });
      };

      let messagesToProcess = messages;
      const watermark = await getLastWatermark(runtime.db, sessionKey, uid);

      if (watermark && watermark.message_count > 0) {
        if (watermark.message_count >= totalMessageCount) {
          await closeRunirSession();
          return c.json({ skipped: true, reason: "no new messages since last watermark" });
        }
        const overlapCount = Math.max(0, watermark.message_count - batchStart);
        if (overlapCount > 0) {
          messagesToProcess = messages.slice(overlapCount);
        }
      }

      debugLogger.watermark({
        session: sessionKey,
        prior: watermark?.message_count ?? 0,
        incoming: totalMessageCount,
        toProcess: messagesToProcess.length,
      });

      // Raw turn retention (Rúnir-b40x.3): the nightly deep sweep reassembles
      // full session text from these rows. RAW content (pre-normalize, pre-
      // compress) at ABSOLUTE indices: messagesToProcess[i] sits at
      // batchStart + (messages.length - messagesToProcess.length) + i — the
      // second term is the watermark overlap trim. Fire-and-forget: turn
      // retention must never fail or delay session-end.
      const trimOffset = messages.length - messagesToProcess.length;
      const rawTurns = messagesToProcess
        .map((m: { role?: string; content?: string }, i: number) => ({
          turnIndex: batchStart + trimOffset + i,
          role: typeof m.role === "string" ? m.role : "unknown",
          content: typeof m.content === "string" ? m.content : "",
        }))
        .filter((t: { content: string }) => t.content.length > 0);
      void recordSessionTurns(
        runtime.db,
        { userId: uid, sessionId: sessionKey, client: sessionClient, turns: rawTurns },
        (msg) => console.warn(`memory-hybrid: ${msg}`),
      ).catch((err) => console.warn(`memory-hybrid: session-turn batch failed: ${String(err).slice(0, 160)}`));

      const formatted = normalizeCaptureMessages(messagesToProcess, messagesToProcess.length);
      if (formatted.length === 0) return c.json({ skipped: true, reason: "no normalizable messages" });

      // Watermark advance — extraction-INDEPENDENT (keyed only on
      // totalMessageCount). Hoisted from the tail of the old extraction
      // pipeline: the re-fire skip above and the ≥5-watermark consolidation-
      // eligibility gate keep working exactly as before. Deliberately AFTER
      // the "no normalizable messages" skip so that skip path still leaves
      // the watermark untouched (same semantics as pre-removal).
      await createWatermark(runtime.db, sessionKey, uid, totalMessageCount);

      // Close the runir_session row (shared closure — F2).
      const closedRunirSession = await closeRunirSession();

      // Client compat: the worker (plugins/runir-claudecode/hooks/
      // runir-session-end-worker.sh) advances its write state on the HTTP
      // STATUS only (2xx) and parses no body fields — the shape below is
      // informational. Stay 2xx.
      return c.json({
        skipped: false,
        rawTurnsRecorded: rawTurns.length,
        extraction: "disabled",
        ...(process.env.RUNIR_DEBUG === "1" || body.hexisDebug === true ? {
          _debug: {
            runirSession: {
              id: closedRunirSession.id,
              projectIdentitySource: closedRunirSession.projectIdentitySource,
              status: closedRunirSession.status,
              closeReason: closedRunirSession.closeReason ?? null,
            },
          },
        } : {}),
      });
    } catch (err) {
      // Fail open: session-end is best-effort continuity bookkeeping, not a
      // critical write path. An unhandled throw anywhere in the pipeline
      // (watermark read/write, runir_session resolve/close) used to 500,
      // which the Pi client records as an error trace. Returning 200 never
      // loses data vs the old 500 — the client does not retry session-end
      // either way. Two failure regions: (1) BEFORE createWatermark — the
      // watermark stays put, so the tail is reprocessed on the next flush;
      // (2) AFTER createWatermark (runir_session close) — the raw turns are
      // already recorded + the watermark advanced, so reason "pipeline_error"
      // is reported even though the write succeeded. Log + count either way,
      // then degrade to a clean 200 skip.
      console.error(`runir-service: session-end pipeline error (session=${sessionKey}):`, err);
      recordPipelineDrop("session-end", "batch", "pipeline_error", cfg.extractModel ?? "unknown");
      return c.json({ skipped: true, reason: "pipeline_error" });
    }
  });
}
