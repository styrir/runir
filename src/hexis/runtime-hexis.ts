import { createHash } from "node:crypto";
import type { MemoryRole, SearchHit } from "../domain/memory/types.js";
import {
  buildHexisContextRef,
  resolveCanonicalContextIdentity,
} from "../identity/canonical-context.js";

export type HexisScope = "session" | "project" | "agent";

export interface HexisAdmissibility {
  allowedScopes?: string[];
  allowedMemoryRoles?: MemoryRole[];
  minAuthority?: number;
}

export interface HexisRelevanceWeights {
  semantic: number;
  recency: number;
  usefulness: number;
  authority: number;
  stability: number;
  hexisMatch: number;
  contradictionRisk: number;
}

export interface HexisState {
  id: string;
  scope: HexisScope;
  scopeKey: string;
  label: string;
  goals: string[];
  roles: string[];
  hypotheses?: string[];
  topicBias?: Record<string, number>;
  memoryRoleWeights?: Partial<Record<MemoryRole, number>>;
  relevanceWeights: HexisRelevanceWeights;
  admissibility?: HexisAdmissibility;
  version: number;
  updatedAt: string;
}

export interface HexisHint {
  id?: string;
  scope?: HexisScope;
  label?: string;
  goals?: string[];
  roles?: string[];
  hypotheses?: string[];
  topicBias?: Record<string, number>;
  memoryRoleWeights?: Partial<Record<MemoryRole, number>>;
  relevanceWeights?: Partial<HexisRelevanceWeights>;
  admissibility?: HexisAdmissibility;
  version?: number;
}

export interface ResolveHexisInput {
  userId: string;
  sessionId?: string;
  path?: string;
  projectId?: string;
  agentId?: string;
  hint?: HexisHint;
  now?: string;
}

export interface HexisScorable {
  text: string;
  tags?: string[];
  memoryRole?: MemoryRole;
  path?: string;
  category?: string;
  scope?: string;
  authorityScore?: number;
}

export interface HexisRerankOptions {
  maxRankWindow?: number;
  scoreEpsilon?: number;
  lambda?: number;
  gateEpsilon?: number;
  laneLambda?: number;
}

const DEFAULT_MAX_RANK_WINDOW = 7;
const DEFAULT_SCORE_EPSILON = 0.0015;
const DEFAULT_LAMBDA = 1.0;
const DEFAULT_GATE_EPSILON = 0.001;

const DEFAULT_RELEVANCE_WEIGHTS: HexisRelevanceWeights = {
  semantic: 1,
  recency: 1,
  usefulness: 1,
  authority: 1,
  stability: 1,
  hexisMatch: 1,
  contradictionRisk: 1,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length > 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultHexisLabel(scope: HexisScope): string {
  switch (scope) {
    case "session":
      return "session frame";
    case "project":
      return "project frame";
    case "agent":
    default:
      return "agent frame";
  }
}

export function buildHexisScopeKey(input: ResolveHexisInput, scope: HexisScope): string {
  const identity = resolveCanonicalContextIdentity({
    userId: input.userId,
    sessionId: input.sessionId,
    path: input.path,
    projectId: input.projectId,
    agentId: input.agentId,
  });
  if (scope !== identity.contextScopeKind) {
    switch (scope) {
      case "session":
        return `${input.userId}::session::${input.sessionId ?? "default"}`;
      case "project":
        return `${input.userId}::project::${input.projectId ?? input.path ?? "default"}`;
      case "agent":
      default:
        return `${input.userId}::agent::${input.agentId ?? input.userId}`;
    }
  }
  return buildHexisContextRef(identity).scopeKey;
}

function resolveHexisScope(input: ResolveHexisInput): HexisScope {
  if (input.hint?.scope) return input.hint.scope;
  if (input.sessionId) return "session";
  if (input.projectId || input.path) return "project";
  return "agent";
}

function buildHexisId(scopeKey: string, label: string): string {
  return createHash("sha256")
    .update(`${scopeKey}::${label.trim().toLowerCase() || "hexis"}`)
    .digest("hex")
    .slice(0, 24);
}

export function normalizeHexis(input: ResolveHexisInput): HexisState {
  const scope = resolveHexisScope(input);
  const scopeKey = buildHexisScopeKey(input, scope);
  const label = input.hint?.label?.trim() || defaultHexisLabel(scope);
  const now = input.now ?? new Date().toISOString();

  return {
    id: input.hint?.id?.trim() || buildHexisId(scopeKey, label),
    scope,
    scopeKey,
    label,
    goals: unique(input.hint?.goals ?? []),
    roles: unique(input.hint?.roles ?? []),
    hypotheses: unique(input.hint?.hypotheses ?? []),
    topicBias: input.hint?.topicBias ? { ...input.hint.topicBias } : {},
    memoryRoleWeights: input.hint?.memoryRoleWeights ? { ...input.hint.memoryRoleWeights } : {},
    relevanceWeights: {
      ...DEFAULT_RELEVANCE_WEIGHTS,
      ...(input.hint?.relevanceWeights ?? {}),
    },
    admissibility: input.hint?.admissibility,
    version: input.hint?.version ?? 1,
    updatedAt: now,
  };
}

export function hasHexisSignal(hexis: HexisState | null | undefined): boolean {
  if (!hexis) return false;
  return Boolean(
    hexis.goals.length > 0
    || hexis.roles.length > 0
    || (hexis.hypotheses?.length ?? 0) > 0
    || Object.keys(hexis.topicBias ?? {}).length > 0
    || Object.keys(hexis.memoryRoleWeights ?? {}).length > 0,
  );
}

export function scoreHexisFit(
  candidate: HexisScorable,
  hexis: HexisState | null | undefined,
): { fit: number; explanation: string[] } {
  if (!hexis) {
    return { fit: 0, explanation: [] };
  }

  const explanation: string[] = [];
  const scopeAllowed = hexis.admissibility?.allowedScopes;
  if (scopeAllowed && candidate.scope && !scopeAllowed.includes(candidate.scope)) {
    return { fit: 0, explanation: ["hexis:scope-blocked"] };
  }

  const roleAllowed = hexis.admissibility?.allowedMemoryRoles;
  if (roleAllowed && candidate.memoryRole && !roleAllowed.includes(candidate.memoryRole)) {
    return { fit: 0, explanation: ["hexis:role-blocked"] };
  }

  const minAuthority = hexis.admissibility?.minAuthority;
  if (minAuthority != null && (candidate.authorityScore ?? 0) < minAuthority) {
    return { fit: 0, explanation: ["hexis:authority-blocked"] };
  }

  const candidateText = [
    candidate.text,
    ...(candidate.tags ?? []),
    candidate.memoryRole ?? "",
    candidate.path ?? "",
    candidate.category ?? "",
  ].join(" ");
  const candidateTokens = new Set(tokenize(candidateText));
  const hexisTokens = new Set(tokenize([
    hexis.label,
    ...hexis.goals,
    ...hexis.roles,
    ...(hexis.hypotheses ?? []),
  ].join(" ")));

  let overlap = 0;
  for (const token of hexisTokens) {
    if (candidateTokens.has(token)) overlap++;
  }
  const semanticFit = hexisTokens.size > 0 ? overlap / hexisTokens.size : 0;
  if (semanticFit > 0) explanation.push(`hexis:semantic=${semanticFit.toFixed(2)}`);

  let topicFit = 0;
  for (const [topic, weight] of Object.entries(hexis.topicBias ?? {})) {
    const normalized = topic.toLowerCase();
    if (candidateTokens.has(normalized) || candidate.text.toLowerCase().includes(normalized)) {
      topicFit += Math.max(0, weight);
      explanation.push(`hexis:topic:${normalized}`);
    }
  }
  topicFit = clamp01(topicFit / Math.max(Object.keys(hexis.topicBias ?? {}).length || 1, 1));

  const roleFit = candidate.memoryRole
    ? clamp01(Number(hexis.memoryRoleWeights?.[candidate.memoryRole] ?? 0))
    : 0;
  if (roleFit > 0 && candidate.memoryRole) {
    explanation.push(`hexis:role:${candidate.memoryRole}`);
  }

  const fit = clamp01((semanticFit * 0.6) + (topicFit * 0.25) + (roleFit * 0.15));
  return { fit, explanation };
}

export function calibHexisFit(fit: number): number {
  const x = clamp01(fit);
  if (process.env.HEXIS_DISABLE_CALIB === "1") {
    return x;
  }
  return 1 / (1 + Math.exp(-6 * (x - 0.5)));
}

export function computeAmbiguityGate(
  hits: SearchHit[],
  W: number,
  epsilon: number,
): number {
  if (process.env.HEXIS_DISABLE_GATE === "1") {
    return 1.0;
  }
  if (!hits || hits.length === 0) return 0.0;
  if (hits.length < W + 1) return 1.0;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const gap = Math.max(0, sorted[W - 1].score - sorted[W].score);
  if (epsilon <= 0) {
    return gap <= 0 ? 1.0 : 0.0;
  }
  if (gap <= epsilon) return 1.0;
  if (gap >= 4 * epsilon) return 0.0;
  return clamp01((4 * epsilon - gap) / (3 * epsilon));
}

export function applyHexisToHits(
  hits: SearchHit[],
  hexis: HexisState | null | undefined,
  options?: HexisRerankOptions,
): SearchHit[] {
  const maxRankWindow = Math.max(1, options?.maxRankWindow ?? DEFAULT_MAX_RANK_WINDOW);
  const lambda = options?.lambda ?? DEFAULT_LAMBDA;
  const gateEpsilon = Math.max(0, options?.gateEpsilon ?? DEFAULT_GATE_EPSILON);
  const laneLambda = options?.laneLambda ?? lambda;

  const signalPresent = Boolean(hexis) && hasHexisSignal(hexis);
  const gateEnvDisabled = process.env.HEXIS_DISABLE_GATE === "1";
  const calibEnvDisabled = process.env.HEXIS_DISABLE_CALIB === "1";

  const sortedByScore = [...hits].sort((a, b) => b.score - a.score);
  const poolRankById = new Map<string, number>();
  sortedByScore.forEach((hit, index) => {
    poolRankById.set(hit.id, index + 1);
  });

  const boundaryGap = sortedByScore.length >= maxRankWindow + 1
    ? Math.max(0, sortedByScore[maxRankWindow - 1].score - sortedByScore[maxRankWindow].score)
    : 0;

  if (laneLambda === 0) {
    return hits.map((hit) => {
      const { scoreStages, ...rest } = hit;
      const nextScoreStages = scoreStages
        ? Object.fromEntries(Object.entries(scoreStages).filter(([k]) => k !== "hexis"))
        : undefined;
      return {
        ...rest,
        preHexisScore: hit.score,
        postHexisScore: hit.score,
        poolRank: poolRankById.get(hit.id) ?? 0,
        boundaryGap: 0,
        gateValue: 0,
        hexisMode: 1,
        laneLambda: 0,
        ...(nextScoreStages && Object.keys(nextScoreStages).length > 0
          ? { scoreStages: nextScoreStages }
          : {}),
      };
    });
  }

  if (!signalPresent) {
    return hits.map((hit) => ({
      ...hit,
      preHexisScore: hit.score,
      postHexisScore: hit.score,
      poolRank: poolRankById.get(hit.id) ?? 0,
      boundaryGap: 0,
      gateValue: 0,
      hexisMode: 5,
      laneLambda,
    }));
  }

  const gate = computeAmbiguityGate(hits, maxRankWindow, gateEpsilon);
  const admissibleIds = new Set(resolveHexisReorderWindow(hits, options));

  return hits.map((hit) => {
    const preHexisScore = hit.score;
    const poolRank = poolRankById.get(hit.id) ?? 0;

    if (!admissibleIds.has(hit.id)) {
      return {
        ...hit,
        preHexisScore,
        postHexisScore: preHexisScore,
        poolRank,
        boundaryGap,
        gateValue: gate,
        hexisMode: gate <= 0 ? 2 : 0,
        laneLambda,
      };
    }

    const { fit, explanation } = scoreHexisFit({
      text: hit.text,
      tags: hit.tags,
      memoryRole: hit.memoryRole,
      path: hit.path,
      category: hit.category,
      scope: hit.scope,
      authorityScore: hit.confidence,
    }, hexis);

    const calibFit = calibHexisFit(fit);
    const hexisMatch = clamp01(hexis!.relevanceWeights.hexisMatch);

    let hexisMode: number;
    if (gate <= 0 && !gateEnvDisabled) {
      hexisMode = 2;
    } else if (gateEnvDisabled) {
      hexisMode = 3;
    } else if (calibEnvDisabled) {
      hexisMode = 4;
    } else {
      hexisMode = 0;
    }

    const boostActive = hexisMode === 0 || hexisMode === 3 || hexisMode === 4;
    const boost = boostActive ? gate * lambda * calibFit * hexisMatch * 0.25 : 0;
    const postHexisScore = preHexisScore + boost;

    const baseHit = {
      ...hit,
      score: postHexisScore,
      hexisId: hexis!.id,
      hexisVersion: hexis!.version,
      hexisFit: fit,
      rankingExplanation: explanation,
      preHexisScore,
      postHexisScore,
      poolRank,
      boundaryGap,
      gateValue: gateEnvDisabled ? 1 : gate,
      hexisMode,
      laneLambda,
    };

    if (boostActive) {
      return {
        ...baseHit,
        scoreStages: {
          ...hit.scoreStages,
          hexis: {
            fit,
            boost,
            version: hexis!.version,
          },
        },
      };
    }
    return baseHit;
  });
}

export function resolveHexisReorderWindow(
  hits: SearchHit[],
  options?: HexisRerankOptions,
): string[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return [];

  const maxRankWindow = Math.max(1, options?.maxRankWindow ?? DEFAULT_MAX_RANK_WINDOW);
  const scoreEpsilon = Math.max(0, options?.scoreEpsilon ?? DEFAULT_SCORE_EPSILON);
  const cutoffIndex = Math.min(sorted.length, maxRankWindow) - 1;
  const cutoffScore = sorted[cutoffIndex]?.score ?? sorted[sorted.length - 1]?.score ?? 0;

  return sorted
    .filter((hit, index) => index < maxRankWindow || hit.score >= cutoffScore - scoreEpsilon)
    .map((hit) => hit.id);
}
