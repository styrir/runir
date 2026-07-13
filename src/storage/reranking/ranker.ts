import { DEFAULT_LLM_RERANKER_MODEL, type RerankerConfig, type ScoreStageAttribution } from "../../domain/memory/types";
import type { EmbeddingProvider } from "../embeddings/providers/embedding-provider";
// Candidate/text caps are owned by config (single source of truth), not read
// ad-hoc here. RERANK_MAX_CANDIDATES bounds how many candidates the reranker
// SCORES; the reranked-path retrieval-pool floor is the SEPARATE
// RERANK_CANDIDATE_FLOOR (used in memory-query.ts), not this cap.
import { RERANK_MAX_CANDIDATES, RERANK_MAX_CHARS, resolveLlmBaseUrl } from "../../shared/config";

/** Reranker result: id→score map plus per-id label for scoreStages. */
export type RerankResult = {
  scores: Map<string, number>;
  labels: Map<string, string>;
};

/** Reranks hybrid candidates via an OpenRouter LLM and returns id->score with labels. */
export async function rerank(
  query: string,
  candidates: Array<{ id: string; text: string }>,
  apiKey: string,
  timeoutMs: number,
  warn?: (msg: string) => void,
  model?: string,
): Promise<Map<string, number>> {
  const result = await rerankWithLabels(query, candidates, apiKey, timeoutMs, warn, model);
  return result.scores;
}

/** Reranks hybrid candidates and returns both scores and labels for scoreStages attribution. */
export async function rerankWithLabels(
  query: string,
  candidates: Array<{ id: string; text: string }>,
  apiKey: string,
  timeoutMs: number,
  warn?: (msg: string) => void,
  model: string = DEFAULT_LLM_RERANKER_MODEL,
): Promise<RerankResult> {
  const empty: RerankResult = { scores: new Map(), labels: new Map() };
  const truncated = candidates
    .slice(0, RERANK_MAX_CANDIDATES)
    .map((c) => ({ id: c.id.replace(/`/g, ""), text: c.text.slice(0, RERANK_MAX_CHARS) }));
  const systemPrompt =
    'You are a retrieval reranker. Rate each memory candidate for relevance to the query. Output ONLY valid JSON array, no markdown. Each element: {"id":"<id>","relevance":<0-1>,"label":"direct|supporting|background|irrelevant"}';
  const userPrompt = `Query: ${query}\n\nCandidates:\n${truncated.map((c) => `[${c.id}] ${c.text}`).join("\n")}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${resolveLlmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    // The abort timer stays live THROUGH response.json() below — a provider can
    // send 200 headers then stall the body, so clearing it here would leave the
    // body read unbounded. The finally clears it on every terminal path; an
    // AbortError (fetch OR body read) lands in the catch and degrades to empty,
    // same as any other failure (Rúnir-imaf.10).

    // Auth degradation: 401/403 → warn and return empty, don't throw
    if (response.status === 401 || response.status === 403) {
      warn?.(`memory-hybrid reranker: auth failed (HTTP ${response.status}), degrading gracefully`);
      return empty;
    }
    if (!response.ok) {
      warn?.(`memory-hybrid reranker: HTTP ${response.status}, degrading gracefully`);
      return empty;
    }
    const data = (await response.json()) as any;
    const text = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as Array<{
      id: string;
      relevance: number;
      label: string;
    }>;
    const scores = new Map<string, number>();
    const labels = new Map<string, string>();
    for (const item of parsed) {
      if (item.label !== "irrelevant") {
        const cleanId = item.id.replace(/`/g, "");
        scores.set(cleanId, item.relevance);
        scores.set(`\`${cleanId}\``, item.relevance);
        labels.set(cleanId, item.label);
        labels.set(`\`${cleanId}\``, item.label);
      }
    }
    return { scores, labels };
  } catch (err: unknown) {
    // Log the error for observability but degrade gracefully
    const msg = err instanceof Error ? err.message : String(err);
    warn?.(`memory-hybrid reranker: failed (${msg}), degrading gracefully`);
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Maps cosine similarity score to a relevance label. */
function scoreToLabel(score: number): string {
  if (score >= 0.7) return "direct";
  if (score >= 0.5) return "supporting";
  if (score >= 0.3) return "background";
  return "irrelevant";
}

/**
 * Rejects when `signal` aborts; never resolves otherwise. Races against the
 * provider embed awaits so a stalled embedder cannot hold the rerank stage open
 * past the caller's budget. The in-flight embed itself is NOT cancelled (the
 * EmbeddingProvider interface takes no signal) — it leaks but is bounded by the
 * provider's own per-embed timeout + the Ollama request queue, so the leak is
 * self-clearing (Rúnir-ogkn.3, scout Q2).
 */
function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return new Promise<never>(() => {}); // never settles → no-op race arm
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The rerank stage was aborted.", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("The rerank stage was aborted.", "AbortError")),
      { once: true },
    );
  });
}

/**
 * Local BI-ENCODER (embedding) reranker — NOT a cross-encoder. Embeds the query
 * once and each candidate independently via Ollama, then scores by cosine. It
 * re-sorts on the same vector signal as the retrieval vector-leg (so it largely
 * recovers pure-vector ranking from the fused RRF order); a true cross-encoder
 * jointly scores query-document pairs (see Rúnir-c2g8 / the reranker screen).
 *
 * PROVIDED-VECTOR PATH (Rúnir-ogkn.2): when a candidate carries an `embedding`
 * field (fetched from the DB stage-2 payload), the stored vector is used directly
 * for cosine scoring — zero Ollama round-trips for that candidate.
 *
 * Score equivalence note: stored vectors were generated from embedDocument over the
 * FULL stored text at write time; the old path embedded text.slice(0, RERANK_MAX_CHARS=
 * 1200). For texts ≤1200 chars the input is identical. For longer texts the stored
 * vector covers the full text while the fallback path would truncate — scores may
 * shift slightly, which is acceptable (landing gate tolerates divergence in
 * reranker-attributable fields per brief §acceptance_criteria).
 *
 * DIMENSION MISMATCH: the fingerprint guard (runHybridQueryWithEvidenceTable) already
 * gates the entire query path to ensure all DB embeddings match the current embedder's
 * dimension. Per-candidate dim checks are therefore a defensive belt-and-braces only.
 * On mismatch: skip + warn, never throw.
 *
 * `signal` bounds the (otherwise unbounded) provider embed awaits: when it
 * aborts, every pending embed loses its race and the function degrades to an
 * empty result so the caller can return the fused (pre-rerank) order. Without a
 * signal the awaits are unbounded (Rúnir-ogkn.3). With all vectors provided, the
 * stage cost is ~1 embed (query) + O(n) cosines.
 */
export async function rerankLocal(
  query: string,
  candidates: Array<{ id: string; text: string; embedding?: number[] }>,
  provider: EmbeddingProvider,
  warn?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<RerankResult> {
  const empty: RerankResult = { scores: new Map(), labels: new Map() };
  if (candidates.length === 0) return empty;

  // A single abort arm shared across the query + all candidate embeds. It only
  // ever rejects (or hangs forever when no signal), so it never wins a race on
  // the happy path and leaks no timer (Rúnir-ogkn.3).
  const abortArm = rejectOnAbort(signal);
  // Swallow the unhandled-rejection the abort arm produces once the stage has
  // already resolved/degraded — the race losers' rejections are otherwise
  // unobserved and would surface as a leaked rejection under vitest strict.
  abortArm.catch(() => {});

  try {
    // Embed query once (search_query semantics) — raced against abort.
    const queryEmbedding = await Promise.race([provider.embedQuery(query), abortArm]);
    if (queryEmbedding.length === 0) return empty;
    const queryDim = queryEmbedding.length;

    const truncated = candidates.slice(0, RERANK_MAX_CANDIDATES).map((c) => ({
      id: c.id,
      text: c.text.slice(0, RERANK_MAX_CHARS),
      // Pass stored embedding through; validated against queryDim before use.
      embedding: c.embedding,
    }));

    // Resolve each candidate's embedding vector:
    //   • Provided (stored DB vector, same dim as queryEmbedding) → use directly, zero embed call.
    //   • Provided but wrong dim → skip + warn (defensive; fingerprint guard prevents this in prod).
    //   • Missing → fall back to embedDocument (signal-raced, existing path).
    const candidateEmbeddings = await Promise.all(
      truncated.map((c) => {
        if (c.embedding !== undefined) {
          if (c.embedding.length !== queryDim) {
            warn?.(
              `memory-hybrid local reranker: dimension mismatch for candidate "${c.id}" — stored ${c.embedding.length}d vs query ${queryDim}d, skipping`,
            );
            return Promise.resolve([] as number[]);
          }
          // Use provided vector directly — no Ollama round-trip.
          return Promise.resolve(c.embedding);
        }
        // Fallback: embed this candidate (search_document semantics), raced against the
        // shared abort arm so a single stalled candidate cannot hold the whole Promise.all
        // open past the budget; on abort the embed loses and the candidate degrades to an
        // empty vector (skipped below).
        return Promise.race([provider.embedDocument(c.text), abortArm]).catch(() => [] as number[]);
      }),
    );

    // aa98 max-sentence lever (flag-gated screen, default OFF): a compound
    // row's stored whole-text embedding averages every fact it contains, so
    // the bi-encoder ranks short lexically-tight rows above long gold-bearing
    // compounds (length dilution — live: an 80-char wrong-attribute distractor
    // outscored the 14-fact compound that /memory/search ranked #1). With
    // RUNIR_RERANK_MAX_SENTENCE=1, multi-sentence candidates score as
    // max(wholeText, best single sentence), with sentence embeds bounded per
    // candidate. Costs extra Ollama calls inside the rerank window — screen
    // before any default flip.
    const maxSentenceMode = process.env.RUNIR_RERANK_MAX_SENTENCE === "1";
    const MAX_SENTENCES_PER_CANDIDATE = 12;
    const sentenceScores = new Map<number, number>();
    if (maxSentenceMode) {
      await Promise.all(truncated.map(async (c, i) => {
        const sentences = c.text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
        if (sentences.length <= 1) return;
        const embeds = await Promise.all(
          sentences.slice(0, MAX_SENTENCES_PER_CANDIDATE).map((s) =>
            Promise.race([provider.embedDocument(s), abortArm]).catch(() => [] as number[]),
          ),
        );
        let best = -1;
        for (const sEmb of embeds) {
          if (sEmb.length !== queryDim) continue;
          const sim = cosineSimilarity(queryEmbedding, sEmb);
          if (sim > best) best = sim;
        }
        if (best >= 0) sentenceScores.set(i, best);
      }));
    }

    const scores = new Map<string, number>();
    const labels = new Map<string, string>();

    for (let i = 0; i < truncated.length; i++) {
      const emb = candidateEmbeddings[i]!;
      if (emb.length === 0) continue;

      let sim = cosineSimilarity(queryEmbedding, emb);
      const bestSentence = sentenceScores.get(i);
      if (bestSentence !== undefined && bestSentence > sim) sim = bestSentence;
      const label = scoreToLabel(sim);
      if (label !== "irrelevant") {
        const id = truncated[i]!.id;
        scores.set(id, sim);
        scores.set(`\`${id}\``, sim);
        labels.set(id, label);
        labels.set(`\`${id}\``, label);
      }
    }

    return { scores, labels };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warn?.(`memory-hybrid local reranker: failed (${msg}), degrading gracefully`);
    return empty;
  }
}

/** Default reranker thresholds per provider. */
const DEFAULT_THRESHOLDS: Record<string, number> = {
  local: 0.3,
  llm: 0.2,
};

/**
 * Provider router: dispatches reranking to the configured provider.
 *   "off"   → empty result (skip reranking)
 *   "local" → rerankLocal() via Ollama embeddings
 *   "llm"   → rerankWithLabels() via OpenRouter
 *
 * On failure, degrades gracefully (warns + returns empty).
 *
 * `opts.budgetMs` caps the stage against the caller's remaining recall budget
 * (Rúnir-ogkn.3): the LLM path's effective fetch timeout becomes
 * min(config.timeoutMs ?? 5000, budgetMs) so it cannot overrun RECALL_BUDGET_MS,
 * and `opts.signal` bounds the local path's otherwise-unbounded embed awaits. The
 * caller (query layer) owns the wall-clock race + degrade-to-fused-order; these
 * are the in-stage belt-and-braces so neither provider waits past the budget.
 */
export async function rerankWithProvider(
  config: RerankerConfig,
  query: string,
  candidates: Array<{ id: string; text: string; embedding?: number[] }>,
  embedder?: EmbeddingProvider,
  warn?: (msg: string) => void,
  opts?: { signal?: AbortSignal; budgetMs?: number },
): Promise<RerankResult & { threshold: number }> {
  const empty = { scores: new Map<string, number>(), labels: new Map<string, string>(), threshold: 0 };

  if (config.provider === "off") return empty;

  if (config.provider === "local") {
    if (!embedder) {
      warn?.("memory-hybrid reranker: local provider requires embedder config, skipping");
      return empty;
    }
    const threshold = config.threshold ?? DEFAULT_THRESHOLDS.local!;
    const result = await rerankLocal(
      query,
      candidates,
      embedder,
      warn,
      opts?.signal,
    );
    return { ...result, threshold };
  }

  if (config.provider === "llm") {
    const apiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      warn?.("memory-hybrid reranker: llm provider has no API key, skipping");
      return empty;
    }
    const threshold = config.threshold ?? DEFAULT_THRESHOLDS.llm!;
    // The LLM fetch timeout is capped at the remaining recall budget so a slow
    // provider cannot push the stage past RECALL_BUDGET_MS even though its own
    // wall-clock race is the query layer's job (Rúnir-ogkn.3, scout Q4).
    const configuredTimeoutMs = config.timeoutMs ?? 5000;
    const effectiveTimeoutMs =
      opts?.budgetMs !== undefined ? Math.min(configuredTimeoutMs, opts.budgetMs) : configuredTimeoutMs;
    const result = await rerankWithLabels(
      query,
      candidates,
      apiKey,
      effectiveTimeoutMs,
      warn,
      config.model,  // RERANKER_MODEL → effective model (Rúnir-imaf.3); undefined → default
    );
    return { ...result, threshold };
  }

  // Unknown provider — treat as off
  warn?.(`memory-hybrid reranker: unknown provider "${(config as any).provider}", skipping`);
  return empty;
}

/** Attaches reranker scoreStage attribution to search hits. */
export function attachRerankerStages(
  hits: Array<{ id: string; scoreStages?: ScoreStageAttribution }>,
  scores: Map<string, number>,
  labels: Map<string, string>,
  threshold: number,
): void {
  for (const hit of hits) {
    const score = scores.get(hit.id);
    if (score !== undefined) {
      if (!hit.scoreStages) hit.scoreStages = {};
      hit.scoreStages.reranker = {
        score,
        label: labels.get(hit.id),
        threshold,
      };
    }
  }
}
