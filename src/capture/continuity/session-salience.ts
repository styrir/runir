import type { CaptureMessage } from "../../domain/memory/types.js";
import { STOP_WORDS } from "../extraction/capture.js";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import type { EmbeddingProvider } from "../../storage/embeddings/providers/embedding-provider.js";
import { fetchSalienceCentroids } from "./salience-prototypes.js";
import { queryTopMemoriesForNovelty } from "../../storage/surreal/surreal-store.js";
import { cosineSimilarity } from "../../shared/cosine.js";
import { PRIMARY_MEMORY_TABLE } from "../../domain/memory/types.js";

export type SalienceSignals = {
  lexicalDensity: number;
  causalMarkerCount: number;
  technicalArtifactScore: number;
};

export type SalienceResult = {
  score: number;
  /** true = bypass pre-LLM noise gate only (noiseBank.isNoise check).
   *  Does NOT bypass: confidence gate, isNoisyFact, batchDedup, or write arbitration.
   *  Those post-extraction stages run unchanged for ALL sessions. */
  hardOverride: boolean;
  signals: SalienceSignals;
  reason: string;
  vectorSignals?: {
    prototype_gap: number;
    novelty: number;
    best_matching_type: string | null;
    prototype_version: string;
  };
};

/** Module-level flag: set to true once centroid bootstrap succeeds. */
export let salienceVectorReady = false;

/** Setter for salienceVectorReady — used by bootstrap code. */
export function setSalienceVectorReady(value: boolean): void {
  salienceVectorReady = value;
}

// --- Hard override patterns ---
const COMMIT_HASH_RE = /\b[0-9a-f]{7,40}\b/i;
const CAUSAL_FIX_RE = /root cause|caused by|fixed by|the fix is|the issue was/i;
const ERROR_RE = /error:|exception:|stack trace|undefined is not|null pointer/i;
const RESOLUTION_RE = /fix|resolved|solution|patched|the issue was/i;

// --- Causal marker pattern ---
const CAUSAL_MARKER_RE = /\b(because|therefore|caused by|root cause|results in|fixed by|due to|triggered by|the issue was|solution:?)\b/gi;

// --- Technical artifact patterns with weights ---
const ARTIFACT_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\b[0-9a-f]{7,40}\b/i, weight: 1.0, label: "commit-hash" },
  { re: /root cause|caused by|the issue was/i, weight: 0.9, label: "root-cause" },
  { re: /error[: ]|exception[: ]|stack trace|ENOENT|ECONNREFUSED/i, weight: 0.9, label: "error-stack" },
  { re: /switched to|migrated from|decision:|we chose|instead of/i, weight: 0.8, label: "arch-decision" },
  { re: /\b[\w-]+\.(ts|js|go|rs|py|yaml|json|toml)\b/, weight: 0.6, label: "file-path" },
  { re: /\b(npm|npx|yarn|pnpm|cargo|docker|git|curl)\s+\w+/i, weight: 0.5, label: "cli-command" },
  { re: /\bgo\s+(build|test|run|install|mod|get|fmt|vet|generate)\b/i, weight: 0.5, label: "cli-go" },
];

function checkHardOverride(messages: CaptureMessage[]): { override: boolean; reasons: string[] } {
  const reasons: string[] = [];

  for (const msg of messages) {
    if (COMMIT_HASH_RE.test(msg.content)) {
      reasons.push("commit hash detected");
    }
    if (CAUSAL_FIX_RE.test(msg.content)) {
      reasons.push("causal fix language detected");
    }
  }

  // Error + resolution adjacency check
  for (let i = 0; i < messages.length; i++) {
    const hasError = ERROR_RE.test(messages[i]!.content);
    if (hasError) {
      const prevHasResolution = i > 0 && RESOLUTION_RE.test(messages[i - 1]!.content);
      const nextHasResolution = i < messages.length - 1 && RESOLUTION_RE.test(messages[i + 1]!.content);
      if (prevHasResolution || nextHasResolution) {
        reasons.push("error+resolution adjacency");
      }
    }
  }

  return { override: reasons.length > 0, reasons };
}

function computeLexicalDensity(messages: CaptureMessage[]): number {
  const allText = messages.map((m) => m.content).join(" ").toLowerCase();
  const tokens = allText.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  // Require a minimum token count to avoid inflated density on trivial messages
  if (tokens.length < 4) return 0;
  const unique = new Set(tokens);
  return unique.size / tokens.length;
}

function countCausalMarkers(fullText: string): number {
  const matches = fullText.match(CAUSAL_MARKER_RE);
  return matches ? matches.length : 0;
}

function computeTechnicalArtifactScore(fullText: string): { score: number; labels: string[] } {
  let score = 0;
  const labels: string[] = [];
  for (const { re, weight, label } of ARTIFACT_PATTERNS) {
    if (re.test(fullText)) {
      score += weight;
      labels.push(label);
    }
  }
  return { score: Math.min(score, 1.0), labels };
}

function buildReason(
  override: boolean,
  overrideReasons: string[],
  artifactLabels: string[],
  technicalArtifactScore: number,
  lexicalDensity: number,
  causalMarkerCount: number,
  vectorSignals?: SalienceResult["vectorSignals"],
): string {
  const reasonParts: string[] = [];
  if (override) {
    reasonParts.push(`hardOverride: ${overrideReasons.join(", ")}`);
  }
  if (artifactLabels.length > 0) {
    reasonParts.push(`technicalArtifact=${technicalArtifactScore.toFixed(2)} [${artifactLabels.join(",")}]`);
  }
  reasonParts.push(`lexicalDensity=${lexicalDensity.toFixed(2)}`);
  if (causalMarkerCount > 0) {
    reasonParts.push(`causalMarkers=${causalMarkerCount}`);
  }
  if (vectorSignals) {
    reasonParts.push(
      `prototype_gap=${vectorSignals.prototype_gap.toFixed(3)}`,
      `novelty=${vectorSignals.novelty.toFixed(3)}`,
      `best_type=${vectorSignals.best_matching_type ?? "none"}`,
    );
  }
  return reasonParts.join("; ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function scoreSessionSalience(
  db: SurrealClient,
  messages: CaptureMessage[],
  compressedText: string,
  context: { userId: string; scope: string; sessionKey: string; provider: EmbeddingProvider },
): Promise<SalienceResult> {
  if (messages.length === 0) {
    return {
      score: 0,
      hardOverride: false,
      signals: { lexicalDensity: 0, causalMarkerCount: 0, technicalArtifactScore: 0 },
      reason: "no messages",
    };
  }

  // 1. Lexical signals (synchronous — unchanged)
  const { override, reasons: overrideReasons } = checkHardOverride(messages);
  const lexicalDensity = computeLexicalDensity(messages);
  const fullText = compressedText;
  const causalMarkerCount = countCausalMarkers(fullText);
  const sentenceCount = Math.max(fullText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length, 1);
  const { score: technicalArtifactScore, labels: artifactLabels } = computeTechnicalArtifactScore(fullText);

  // 2. Normalize causal_markers
  const causalMarkersNormalized = clamp(causalMarkerCount / sentenceCount, 0, 1);

  let score: number;
  let vectorSignals: SalienceResult["vectorSignals"] | undefined;

  // 3. Vector path (if ready)
  if (salienceVectorReady) {
    try {
      // a. Embed the compressed text
      const candidateEmbedding = await context.provider.embedDocument(compressedText);

      // b. Parallel fetch: centroids + novelty
      const [centroidMap, topSimilarities] = await Promise.all([
        fetchSalienceCentroids(db),
        // Rúnir-ekos B-LIVE-1: pass the current-era table explicitly — the
        // default param on queryTopMemoriesForNovelty falls back to the
        // legacy "memories" table, which would silently score novelty
        // against stale/empty data.
        queryTopMemoriesForNovelty(db, context.userId, context.scope, context.sessionKey, candidateEmbedding, 10, PRIMARY_MEMORY_TABLE),
      ]);

      // c. Compute prototype_gap
      let maxPositiveSim = -Infinity;
      let bestMatchingType: string | null = null;
      for (const [type, centroid] of Array.from(centroidMap)) {
        if (type === "noise") continue;
        const sim = cosineSimilarity(candidateEmbedding, centroid);
        if (sim > maxPositiveSim) {
          maxPositiveSim = sim;
          bestMatchingType = type;
        }
      }
      const noiseCentroid = centroidMap.get("noise") ?? [];
      const noiseSim = noiseCentroid.length > 0
        ? cosineSimilarity(candidateEmbedding, noiseCentroid)
        : 0;
      if (maxPositiveSim === -Infinity) maxPositiveSim = 0;
      const prototypeGapRaw = maxPositiveSim - noiseSim;
      const prototypeGapNormalized = clamp((prototypeGapRaw + 2) / 4, 0, 1);

      // d. Compute novelty
      let noveltyNormalized: number;
      if (topSimilarities.length === 0) {
        noveltyNormalized = 0.5;
      } else {
        const noveltyRaw = 1 - Math.max(...topSimilarities);
        noveltyNormalized = clamp(noveltyRaw / 2, 0, 1);
      }

      // e. Final score
      score = 0.35 * prototypeGapNormalized
            + 0.25 * noveltyNormalized
            + 0.20 * lexicalDensity
            + 0.15 * causalMarkersNormalized
            + 0.05 * technicalArtifactScore;

      // f. Prototype version
      let prototypeVersion = "unknown";
      if (centroidMap.size > 0) {
        // Fetch full centroid records to get prototype_version
        try {
          const versionResults = await db.query<{ prototype_version: string }>(
            "SELECT prototype_version FROM salience_centroids LIMIT 1;",
          );
          const versionRows = versionResults[0] ?? [];
          if (versionRows.length > 0 && versionRows[0]!.prototype_version) {
            prototypeVersion = versionRows[0]!.prototype_version;
          }
        } catch {
          // non-fatal
        }
      }

      // g. Build vectorSignals
      vectorSignals = {
        prototype_gap: prototypeGapNormalized,
        novelty: noveltyNormalized,
        best_matching_type: bestMatchingType,
        prototype_version: prototypeVersion,
      };

      // h. Fire-and-forget audit log write
      db.query(
        `INSERT INTO salience_audit_log {
           id: $id,
           session_id: $session_id,
           candidate_text: $candidate_text,
           candidate_embedding: $candidate_embedding,
           best_matching_type: $best_matching_type,
           prototype_gap: $prototype_gap,
           novelty: $novelty,
           lexical_density: $lexical_density,
           causal_markers: $causal_markers,
           specificity: $specificity,
           final_score: $final_score,
           threshold: $threshold,
           decision: $decision,
           scorer_version: $scorer_version,
           embedder_version: $embedder_version,
           prototype_version: $prototype_version,
           created_at: <datetime>$created_at,
           human_label: $human_label,
           label_notes: $label_notes
         };`,
        {
          id: crypto.randomUUID(),
          session_id: context.sessionKey,
          candidate_text: compressedText.slice(0, 500),
          candidate_embedding: candidateEmbedding,
          best_matching_type: bestMatchingType,
          prototype_gap: prototypeGapNormalized,
          novelty: noveltyNormalized,
          lexical_density: lexicalDensity,
          causal_markers: causalMarkersNormalized,
          specificity: technicalArtifactScore,
          final_score: score,
          threshold: 0.40,
          decision: score >= 0.40 ? "pass" : "fail",
          scorer_version: "1.0.0",
          embedder_version: context.provider.fingerprint(),
          prototype_version: prototypeVersion,
          created_at: new Date().toISOString(),
          human_label: undefined,
          label_notes: undefined,
        },
      ).catch((err) => console.warn("salience-audit-log write failed:", err));

    } catch (err) {
      // 4. Degrade to lexical-only on any vector path failure
      console.warn("scoreSessionSalience: degrading to lexical-only:", err);
      score = 0.65 * technicalArtifactScore + 0.20 * lexicalDensity + 0.15 * causalMarkersNormalized;
      vectorSignals = undefined;
    }
  } else {
    // 4. Lexical-only (salienceVectorReady is false)
    score = 0.65 * technicalArtifactScore + 0.20 * lexicalDensity + 0.15 * causalMarkersNormalized;
    vectorSignals = undefined;
  }

  // 5. Return
  return {
    score,
    hardOverride: override,
    signals: { lexicalDensity, causalMarkerCount, technicalArtifactScore },
    reason: buildReason(override, overrideReasons, artifactLabels, technicalArtifactScore, lexicalDensity, causalMarkerCount, vectorSignals),
    vectorSignals,
  };
}
