/**
 * Project state warming from capture.
 *
 * Opportunistic, lossy, subordinate to future session-end synthesis.
 * Keeps project_state warm so session_opener has continuity material
 * even when /hooks/session-end has never fired.
 */

import type { MemoryCategory, ProjectStateRecord } from "../../domain/memory/types.js";

export type WarmingFact = {
  text: string;
  category: MemoryCategory | string;
  confidence: number;
  outcome: string;
  timestamp: string;
  order?: number;
};

export type WarmingResult = {
  currentFocus: string | undefined;
  latestProgress: string | undefined;
};

const ELIGIBLE_CATEGORIES = new Set<string>(["events", "cases"]);
const ELIGIBLE_OUTCOMES = new Set<string>(["create", "merge-update", "supersede"]);
const MIN_CONFIDENCE = 0.75;

const FOCUS_PATTERNS = [
  /\b(working on|building|implementing|debugging|fixing|migrating|refactoring|deploying)\b/i,
  /\b(next step|todo|plan to|need to|will|should)\b/i,
  /\b(switched to|switched from|decided|chose|using|adopted)\b/i,
];

const PROGRESS_PATTERNS = [
  /\b(completed|finished|done with|shipped|merged|resolved)\b/i,
];

const ALL_STATUS_PATTERNS = [...FOCUS_PATTERNS, ...PROGRESS_PATTERNS];

export function isStatusLikeSignal(text: string): boolean {
  return ALL_STATUS_PATTERNS.some((p) => p.test(text));
}

export function classifySignalType(text: string): "focus" | "progress" {
  if (PROGRESS_PATTERNS.some((p) => p.test(text))) return "progress";
  return "focus";
}

function isEligible(fact: WarmingFact): boolean {
  return (
    ELIGIBLE_OUTCOMES.has(fact.outcome) &&
    ELIGIBLE_CATEGORIES.has(fact.category) &&
    fact.confidence >= MIN_CONFIDENCE &&
    isStatusLikeSignal(fact.text)
  );
}

function pickBest(pool: WarmingFact[]): WarmingFact | undefined {
  if (pool.length === 0) return undefined;
  return [...pool].sort((a, b) => {
    const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    if (timeDiff !== 0) return timeDiff;
    const orderDiff = (b.order ?? 0) - (a.order ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return b.confidence - a.confidence;
  })[0];
}

export function selectWarmingCandidates(facts: WarmingFact[]): WarmingResult | null {
  const eligible = facts.filter(isEligible);
  if (eligible.length === 0) return null;

  const focusPool = eligible.filter((f) => classifySignalType(f.text) === "focus");
  const progressPool = eligible.filter((f) => classifySignalType(f.text) === "progress");

  const bestFocus = pickBest(focusPool);
  const bestProgress = pickBest(progressPool);

  if (!bestFocus && !bestProgress) return null;

  return {
    currentFocus: bestFocus?.text,
    latestProgress: bestProgress?.text,
  };
}

type WarmProjectStateArgs = {
  existing: ProjectStateRecord | null;
  facts: WarmingFact[];
  userId: string;
  projectKey?: string;
  path?: string;
  sessionId?: string;
};

function newerThanExisting(timestamp: string, existingUpdatedAt?: string): boolean {
  if (!existingUpdatedAt) return true;
  const candidate = Date.parse(timestamp);
  const existing = Date.parse(existingUpdatedAt);
  if (Number.isNaN(candidate)) return false;
  if (Number.isNaN(existing)) return true;
  return candidate >= existing;
}

export function buildWarmedProjectState(args: WarmProjectStateArgs): Omit<ProjectStateRecord, "id"> | null {
  const eligible = args.facts.filter(isEligible);
  if (eligible.length === 0) return null;

  const focusPool = eligible.filter((f) => classifySignalType(f.text) === "focus");
  const progressPool = eligible.filter((f) => classifySignalType(f.text) === "progress");

  const bestFocus = pickBest(focusPool);
  const bestProgress = pickBest(progressPool);
  const existing = args.existing;

  let currentFocus = existing?.currentFocus;
  let latestProgress = existing?.latestProgress;
  let changed = false;
  const appliedFacts: WarmingFact[] = [];

  if (bestFocus && (!currentFocus || newerThanExisting(bestFocus.timestamp, existing?.updatedAt))) {
    if (currentFocus !== bestFocus.text) {
      currentFocus = bestFocus.text;
      changed = true;
    }
    appliedFacts.push(bestFocus);
  }

  if (bestProgress && (!latestProgress || newerThanExisting(bestProgress.timestamp, existing?.updatedAt))) {
    if (latestProgress !== bestProgress.text) {
      latestProgress = bestProgress.text;
      changed = true;
    }
    appliedFacts.push(bestProgress);
  }

  if (!changed && existing) {
    return null;
  }

  const updatedAt = appliedFacts.length > 0
    ? [...appliedFacts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]!.timestamp
    : (existing?.updatedAt ?? new Date().toISOString());

  return {
    userId: args.userId,
    projectKey: args.projectKey ?? existing?.projectKey,
    path: args.path,
    currentFocus,
    activeTicketIds: existing?.activeTicketIds ?? [],
    latestProgress,
    blockers: existing?.blockers ?? [],
    nextSteps: existing?.nextSteps ?? [],
    directives: existing?.directives,
    updatedAt,
    sourceSessionId: args.sessionId ?? existing?.sourceSessionId,
    supportingMemoryIds: existing?.supportingMemoryIds ?? [],
    confidence: Math.max(existing?.confidence ?? 0, ...appliedFacts.map((f) => f.confidence), 0),
    version: existing?.version ?? 1,
    previousProjectStateId: existing?.previousProjectStateId,
  };
}
