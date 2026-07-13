import type { Hono } from "hono";
import { normalizeExtractedFact } from "../../../capture/extraction/capture.js";
import { scoreHexisFit, type HexisHint } from "../../../hexis/runtime-hexis.js";
import { findEntityByName, getSupportingMemoryIds } from "../../../entities/entity-store.js";
import { normalizeEntityName } from "../../../entities/entity-arbitrator.js";
import { toAuditSearchResults, toToolSearchResults } from "../../../recall/selection/recall-selection.js";
import { TraceCollector } from "../../../recall/selection/retrieval-trace.js";
import { runHybridQueryWithEvidenceTable, runHybridQueryWithEvidenceTableAndEntityTrace, vectorSearch, type RunHybridQueryWithEvidenceTableInput, type HybridQueryTuningOptions } from "../../../recall/query/memory-query.js";
import { resolveRankingProfile } from "../../../recall/policy/ranking-profile.js";
import { resolveAttrField, resolveScopeFilter, resolveWriteScope } from "../../../recall/query/scope-predicate.js";
import type { RawExtractedFact } from "../../../domain/memory/types.js";
import {
  ACTIVE_MEMORY_FILTER,
  deleteMemoryById,
  extractId,
  getEmbeddingFingerprint,
  getMemoryById,
  getMemoryHealth,
  getMemoryLineage,
  listMemories,
  listRecentMemories,
  restoreMemoryById,
} from "../../../storage/surreal/surreal-store.js";
import { resolveCanonicalContextIdentity } from "../../../identity/canonical-context.js";
import { resolveRunirSession } from "../../../storage/surreal/runir-session-store.js";
import { resolveSemioteOriginContext } from "../../semiote-write-context.js";
import {
  bm25StatsCache,
  cfg,
  deriveContinuityMetadata,
  factMetadata,
  provider,
  resolveUserId,
  resolveActiveHexis,
  runtime,
  writeWithArbitration,
} from "../../runtime.js";

export function registerMemoryRoutes(app: Hono) {
  app.post("/memory/search", async (c) => {
    const body = await c.req.json();
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    // RUNIR_EXPERIMENT_TUNING (dev-only, default off) raises the recall cap and
    // enables the per-request retrieval-tuning passthrough below. Production
    // behavior is unchanged: cap 50, no caller-supplied RRF/recency overrides.
    // OWNER: Rúnir-x41m.12 (measurement harness gate — do not remove until x41m.12 closes).
    const experimentTuning = process.env.RUNIR_EXPERIMENT_TUNING === "1";
    const maxLimit = experimentTuning ? 200 : 50;
    const limit = Math.max(1, Math.min(Math.floor(body.limit ?? cfg.topK), maxLimit));
    const sessionId: string | undefined = body.sessionId;
    const scopeFilter = resolveScopeFilter(body.scope, sessionId);
    const includeInactive = body.includeInactive === true;
    const activeFilter = includeInactive ? "" : ACTIVE_MEMORY_FILTER;

    try {
      let embedding: number[];
      try {
        embedding = await provider.embedQuery(body.query);
      } catch (embErr) {
        return c.json({ results: [], warning: `Embedding unavailable: ${String(embErr)}` });
      }
      const trace = body.debug === true && process.env.RUNIR_DEBUG === "1" ? new TraceCollector() : undefined;
      // Retrieval-tuning passthrough — DEV-ONLY (gated by RUNIR_EXPERIMENT_TUNING).
      // Lets experiment harnesses sweep RRF leg weights / recency window per request
      // without code edits or restarts. Strictly validated; off in production so the
      // public route never exposes caller-controlled retrieval ranking.
      const tuning: HybridQueryTuningOptions = {
        entityLookupSessionId: sessionId,
        rankingProfile: resolveRankingProfile(uid),
      };
      if (experimentTuning) {
        const rw = body.rrfWeights;
        if (
          rw && typeof rw === "object" &&
          [rw.vector, rw.bm25, rw.recency].every((n: unknown) => typeof n === "number" && Number.isFinite(n))
        ) {
          tuning.rrfWeights = {
            vector: rw.vector,
            bm25: rw.bm25,
            recency: rw.recency,
            ...(typeof rw.entity === "number" && Number.isFinite(rw.entity) ? { entity: rw.entity } : {}),
          };
        }
        // Upper-bounded (<=100 years) so a huge value can't overflow the
        // downstream `new Date(now - hours)` and throw RangeError.
        if (typeof body.recencyWindowHours === "number" && Number.isFinite(body.recencyWindowHours)
            && body.recencyWindowHours >= 0 && body.recencyWindowHours <= 876_000) {
          tuning.recencyWindowHours = body.recencyWindowHours;
        }
      }
      const searchInput: RunHybridQueryWithEvidenceTableInput = {
        db: runtime.db,
        userId: uid,
        query: body.query,
        embedding,
        limit,
        scopeFilter,
        warn: console.warn,
        rerankerConfig: cfg.reranker,
        embeddingProvider: provider,
        activeFilter,
        evidenceTable: "semiote",
        trace,
        tuning,
      };
      const searchResult = trace
        ? await runHybridQueryWithEvidenceTableAndEntityTrace(searchInput)
        : { hits: await runHybridQueryWithEvidenceTable(searchInput), entityMatches: [], legRanks: {} };
      const results = searchResult.hits;
      const payload = includeInactive ? toAuditSearchResults(results, limit) : toToolSearchResults(results, limit);
      if (trace) {
        return c.json({
          ...payload,
          debug: {
            trace: trace.finalize(body.query, "hybrid"),
            entityMatches: searchResult.entityMatches,
            legRanks: searchResult.legRanks,
          },
        });
      }
      return c.json(payload);
    } catch (err) {
      return c.json({ error: `Search failed: ${String(err)}` }, 500);
    }
  });

  app.post("/memory/store", async (c) => {
    const body = await c.req.json();
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const storePath = resolveAttrField(body.path, "RUNIR_SCOPE_PATH");
    const storeClient = resolveAttrField(body.client, "RUNIR_SCOPE_CLIENT");
    const sessionId: string | undefined = body.sessionId;
    const hexisHint = body.hexis && typeof body.hexis === "object" && !Array.isArray(body.hexis)
      ? body.hexis as HexisHint
      : undefined;
    const rawScope = typeof body.scope === "string" ? body.scope : "user";
    const resolvedWriteScope = resolveWriteScope(rawScope, body.longTerm, sessionId, console);
    if (resolvedWriteScope.scope === "global") {
      return c.json({ error: "global scope writes are not supported via HTTP" }, 403);
    }
    if (resolvedWriteScope.scope === "team") {
      return c.json({ error: "team scope writes are not supported via HTTP" }, 403);
    }
    const { scope, sessionId: resolvedSessionId } = resolvedWriteScope;

    try {
      const contextIdentity = resolveCanonicalContextIdentity({
        userId: uid,
        sessionId,
        path: storePath,
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        gitRemoteUrl: typeof body.gitRemoteUrl === "string" ? body.gitRemoteUrl : undefined,
        gitRepoRoot: typeof body.gitRepoRoot === "string" ? body.gitRepoRoot : storePath ?? undefined,
        agentId: typeof body.agentId === "string" ? body.agentId : undefined,
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      });
      const runirSession = await resolveRunirSession(runtime.db, {
        userId: uid,
        projectKey: contextIdentity.projectKey,
        projectIdentitySource: contextIdentity.derivation.projectKey.marker,
        clientKind: storeClient ?? undefined,
        nativeSessionId: sessionId,
        workspacePath: storePath ?? undefined,
        workspaceFingerprint: typeof body.workspaceFingerprint === "string" ? body.workspaceFingerprint : undefined,
        hostId: typeof body.hostId === "string" ? body.hostId : undefined,
        deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : undefined,
      });
      const activeHexis = await resolveActiveHexis({
        userId: uid,
        sessionId,
        path: storePath,
        projectId: contextIdentity.raw.projectId,
        agentId: contextIdentity.raw.agentId,
        hint: hexisHint,
      });
      const raw: RawExtractedFact = {
        l2: body.text,
        confidence: body.confidence ?? 0.7,
      };
      const fact = normalizeExtractedFact(raw);
      const requestMetadata = typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
        ? { ...(body.metadata as Record<string, unknown>) }
        : {};
      // Rúnir-pn1l Q4 U0 (2026-07-07): clients must not supply referent-identity proof
      // keys — `noemaClaimKey` and `atomicFact` are the write-arbitration inputs that
      // `proveReferentIdentity` treats as authoritative identity proof (retire/supersede
      // authority), so an unauthenticated client could otherwise inject a matching key to
      // force a supersede across two genuinely different, conflicting facts (defense-in-
      // depth; `factKey` is already overridden below by `factMetadata`, so it is safe, and
      // `continuitySubjectKey` is not a proof arm — both are left alone). The privileged
      // faithful-replay/injection seam that must reproduce a memory's original
      // service-derived envelope (U2) is a separate fixture/injection path, NOT public
      // `/memory/store` client metadata — this strip draws that boundary cleanly.
      delete requestMetadata.noemaClaimKey;
      delete requestMetadata.atomicFact;
      const recordedAt = new Date().toISOString();
      const storeOrigin = resolveSemioteOriginContext({
        identity: contextIdentity,
        sourceKind: "manual-store",
        writeSource: "agent-write",
        runirSessionId: runirSession.id,
        nativeSessionId: sessionId,
        sessionId,
        path: storePath ?? undefined,
        client: storeClient ?? undefined,
        extraction: {
          mode: "memory-store",
          capturedAt: recordedAt,
        },
      });
      const hexisScore = scoreHexisFit({
        text: fact.l2,
        tags: fact.tags,
        path: storeOrigin.path,
        category: fact.category,
      }, activeHexis);
      const metadata = deriveContinuityMetadata(
        fact.l2,
        { ...requestMetadata, ...factMetadata(fact, storeOrigin.path, storeOrigin.client) },
        recordedAt,
      );
      const result = await writeWithArbitration({
        text: fact.l2,
        userId: uid,
        metadata,
        scope,
        sessionId: resolvedSessionId,
        source: "memory_store",
        writeSource: "agent-write",
        targetTable: "semiote",
        hexis: activeHexis,
        hexisFit: hexisScore.fit,
        rankingExplanation: hexisScore.explanation,
        semioteProvenance: storeOrigin.provenance,
      });
      return c.json({
        success: true,
        id: result.memoryId ?? result.matchedMemoryId,
        outcome: result.outcome,
      });
    } catch (err) {
      return c.json({ error: `Store failed: ${String(err)}` }, 500);
    }
  });

  app.post("/memory/list", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const sessionId: string | undefined = body.sessionId;
    const scopeFilter = resolveScopeFilter(body.scope, sessionId);

    try {
      const rows = await listMemories(runtime.db, uid, scopeFilter, "semiote");
      return c.json({
        memories: rows.map((r: any) => ({
          id: extractId(r.id),
          memory: r.payload?.l2 ?? r.payload?.data ?? "",
          created_at: r.payload?.createdAt ?? r.created_at,
          updated_at: r.payload?.updatedAt ?? r.updated_at,
          tags: r.payload?.tags,
        })),
      });
    } catch (err) {
      return c.json({ error: `List failed: ${String(err)}` }, 500);
    }
  });

  app.get("/memory/get/:id", async (c) => {
    let uid: string;
    try { uid = resolveUserId(c.req.query("userId"), cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const simpleId = c.req.param("id").replace(/^(memories|semiote):/, "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(simpleId)) {
      return c.json({ error: "Invalid memoryId format" }, 400);
    }
    try {
      const rows = await getMemoryById(runtime.db, simpleId, uid, "semiote");
      if (rows.length === 0) return c.json({ error: `Memory not found: ${simpleId}` }, 404);
      const r = rows[0];
      return c.json({
        id: extractId(r.id),
        memory: r.payload?.l2 ?? r.payload?.data ?? "",
        created_at: r.payload?.createdAt ?? r.created_at,
        updated_at: r.payload?.updatedAt ?? r.updated_at,
        tags: r.payload?.tags,
        source: r.payload?.source,
      });
    } catch (err) {
      return c.json({ error: `Get failed: ${String(err)}` }, 500);
    }
  });

  app.post("/memory/forget", async (c) => {
    const body = await c.req.json();
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const mode = body.hardDelete ? ("hard-delete" as const) : ("soft-inactivate" as const);
    const actionVerb = body.hardDelete ? "permanently deleted" : "inactivated";

    try {
      if (body.memoryId) {
        const simpleId = body.memoryId.trim().replace(/^(memories|semiote):/, "");
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(simpleId)) return c.json({ error: "Invalid memoryId format" }, 400);
        await deleteMemoryById(runtime.db, simpleId, uid, mode, "semiote");
        bm25StatsCache.clear();
        return c.json({ success: true, message: `Memory ${body.memoryId} ${actionVerb}` });
      }
      if (body.query) {
        const storedFpForget = await getEmbeddingFingerprint(runtime.db);
        if (storedFpForget !== null && storedFpForget !== provider.fingerprint()) {
          console.warn(
            "runir-service /memory/forget: embedding fingerprint mismatch — stored:",
            storedFpForget,
            "current:",
            provider.fingerprint(),
          );
          return c.json(
            { success: false, message: "Embedding fingerprint mismatch — re-embed corpus before using query-based forget" },
            409,
          );
        }
        const embedding = await provider.embedQuery(body.query);
        const hits = await vectorSearch(runtime.db, uid, embedding, 5, undefined, "semiote");
        if (hits.length === 0) return c.json({ success: false, message: "No matching memories found" });
        const topHit = hits[0]!;
        await deleteMemoryById(runtime.db, topHit.id, uid, mode, "semiote");
        bm25StatsCache.clear();
        return c.json({ success: true, deletedId: topHit.id, message: topHit.text.slice(0, 100) });
      }
      return c.json({ error: "Provide memoryId or query" }, 400);
    } catch (err) {
      return c.json({ error: `Forget failed: ${String(err)}` }, 500);
    }
  });

  app.post("/memory/recent", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const hoursBack = Math.max(1, Math.min(body.hours ?? 48, 168));
    const limit = Math.max(1, Math.min(body.limit ?? 20, 50));
    const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const sessionId: string | undefined = body.sessionId;
    const scopeFilter = resolveScopeFilter(body.scope ?? "all", sessionId);

    try {
      const rows = await listRecentMemories(runtime.db, uid, cutoff, limit, scopeFilter, "semiote");
      return c.json({
        count: rows.length,
        timeWindow: `last ${hoursBack} hours`,
        memories: rows.map((r: any) => ({
          id: extractId(r.id),
          memory: r.payload?.l2 ?? r.payload?.data ?? "",
          created_at: r.payload?.createdAt ?? r.created_at,
          updated_at: r.payload?.updatedAt ?? r.updated_at,
        })),
      });
    } catch (err) {
      return c.json({ error: `Recent query failed: ${String(err)}` }, 500);
    }
  });

  app.post("/memory/restore", async (c) => {
    const body = await c.req.json();
    let uid: string;
    try { uid = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const simpleId = body.memoryId.trim().replace(/^(memories|semiote):/, "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(simpleId)) return c.json({ error: "Invalid memoryId format" }, 400);
    try {
      const restored = await restoreMemoryById(runtime.db, simpleId, uid, "semiote");
      if (!restored) return c.json({ error: `Memory not found or already active: ${body.memoryId}` }, 404);
      bm25StatsCache.clear();
      return c.json({ success: true, message: `Memory ${body.memoryId} restored` });
    } catch (err) {
      return c.json({ error: `Restore failed: ${String(err)}` }, 500);
    }
  });

  app.get("/memory/lineage/:id", async (c) => {
    let uid: string;
    try { uid = resolveUserId(c.req.query("userId"), cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    const simpleId = c.req.param("id").replace(/^(memories|semiote):/, "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(simpleId)) return c.json({ error: "Invalid memoryId format" }, 400);
    try {
      const chain = await getMemoryLineage(runtime.db, simpleId, uid, "semiote");
      if (chain.length === 0) return c.json({ error: `Memory not found: ${simpleId}` }, 404);
      return c.json({ memoryId: simpleId, chainLength: chain.length, lineage: chain });
    } catch (err) {
      return c.json({ error: `Lineage query failed: ${String(err)}` }, 500);
    }
  });

  app.get("/memory/health", async (c) => {
    let uid: string;
    try { uid = resolveUserId(c.req.query("userId"), cfg); } catch { return c.json({ error: "unauthorized" }, 400); }
    try {
      const stats = await getMemoryHealth(runtime.db, uid, "semiote");
      return c.json(stats);
    } catch (err) {
      return c.json({ error: `Health check failed: ${String(err)}` }, 500);
    }
  });

  app.post("/memory/graph", async (c) => {
    const body = await c.req.json();
    let userId: string;
    try { userId = resolveUserId(body.userId, cfg); } catch { return c.json({ error: "unauthorized" }, 400); }

    if (!body.entityId && !body.name) {
      return c.json({ error: "entityId or name is required" }, 400);
    }

    try {
      let entity: any = null;
      let entityId: string | undefined;

      if (body.entityId) {
        const result = await runtime.db.query("SELECT * FROM type::record('entities', $entityId)", { entityId: body.entityId });
        const rows = (result[0] ?? []) as any[];
        if (rows.length > 0) {
          entity = rows[0];
          entityId = body.entityId;
        }
        if (!entity || entity.userId !== userId) {
          return c.json({ error: "entity not found" }, 404);
        }
      } else if (body.name) {
        const matches = await findEntityByName(runtime.db, normalizeEntityName(body.name), body.kind, userId, "user");
        if (matches.length > 0) {
          entity = matches[0];
          entityId = extractId(entity.id);
        }
      }

      if (!entity) {
        return c.json({ error: "entity not found" }, 404);
      }

      // Rúnir-imaf.5 option C (Rúnir-o75n.5): entity-to-entity links are never
      // populated — linkEntities has zero production callers, so
      // getEntityNeighbors (which filters kind != mentioned_in) can only ever
      // return []. Instead of a silent always-empty success, an includeNeighbors
      // request gets an explicit unsupported indicator and the dead query is
      // not issued at all. Non-breaking: still HTTP 200, neighbors stays [].
      let neighbors: any[] | undefined;
      let neighborsUnsupported: boolean | undefined;
      let neighborsReason: string | undefined;
      if (body.includeNeighbors && entityId) {
        neighbors = [];
        neighborsUnsupported = true;
        neighborsReason = "entity-to-entity links are not populated in this release";
      }

      let memoryIds: string[] | undefined;
      if (body.includeMemories && entityId) {
        memoryIds = await getSupportingMemoryIds(runtime.db, entityId);
      }

      return c.json({
        entity,
        neighbors,
        memoryIds,
        ...(neighborsUnsupported ? { neighborsUnsupported, neighborsReason } : {}),
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
}
