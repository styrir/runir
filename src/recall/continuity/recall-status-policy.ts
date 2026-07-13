import type { IntentSignal } from "../intent/intent-analyzer";
import type { MemoryRole, SearchHit } from "../../domain/memory/types";

export type RecallMemoryKind = Exclude<MemoryRole, "project_state">;

const STATUS_SIGNAL_PATTERNS = [
  /\bcurrently\b/i,
  /\bworking on\b/i,
  /\bin progress\b/i,
  /\bnext step\b/i,
  /\bblocked\b/i,
  /\bresume here\b/i,
  /\bhandoff\b/i,
  /\bcurrent status\b/i,
  /\blatest progress\b/i,
  /\bremaining work\b/i,
  /\bopen issue\b/i,
  /\bimplementing\b/i,
  /\bfixing\b/i,
  /\btesting\b/i,
  /\bdebugging\b/i,
  /\bMIM-\d+\b/i,
  /\bSTY-\d+\b/i,
];

const OPERATIONAL_NOISE_PATTERNS = [
  /\bscout\b/i,
  /\bbuilder brief\b/i,
  /\bbrief\b/i,
  /\bdeploy(?:ed)?\b/i,
  /\bpm2\b/i,
  /\bDigitalOcean\b/i,
  /\badmin(?:istrative)?\b/i,
  /\bmaintenance\b/i,
  /\bworkflow\b/i,
  /\bhousekeeping\b/i,
  /\btask initialization\b/i,
  /\benvironment setup\b/i,
  /\bserver restart\b/i,
  /\btsconfig\.json\b/i,
  /\bnpx\s+tsx\b/i,
  /\bscripts\/\b/i,
  /\bscript runs?\b/i,
  /\bread[- ]path\b/i,
  /\bcontext insufficiency\b/i,
  /\bproject[_ -]?state update flow\b/i,
  /\b\/clear\b/i,
  /\bcheckpoint hook\b/i,
  /\bwatermark progression\b/i,
  /\bmemory synchronization loop\b/i,
];

const HISTORICAL_PATTERNS = [
  /\bwas deployed\b/i,
  /\bsuccessfully deployed\b/i,
  /\bcompleted\b/i,
  /\bshipped\b/i,
  /\blaunched\b/i,
  /\bfinished\b/i,
  /\ball\s+\d+\s+tests?\s+passed\b/i,
];

function textOf(hit: SearchHit): string {
  return hit.text ?? "";
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function hasTicketSignal(text: string): boolean {
  return /\b(?:MIM|STY)-\d+\b/i.test(text);
}

function hasActiveSignal(text: string): boolean {
  return countMatches(text, STATUS_SIGNAL_PATTERNS) > 0;
}

function storedRecallKind(hit: SearchHit): RecallMemoryKind | undefined {
  if (!hit.memoryRole || hit.memoryRole === "project_state") return undefined;
  return hit.memoryRole;
}

function continuityRoleScore(hit: SearchHit): number {
  if (hit.memoryRole === "project_state") return 1;
  return memoryKindScore(storedRecallKind(hit) ?? classifyRecallMemoryKind(hit));
}

function validityScore(hit: SearchHit): number {
  if (!hit.memoryRole) return 0;
  return hit.invalidAt ? 0 : 1;
}

function hasStoredStatusRole(hit: SearchHit): boolean {
  return hit.memoryRole === "project_state"
    || hit.memoryRole === "current_status"
    || hit.memoryRole === "session_handoff"
    || hit.memoryRole === "recent_work"
    || hit.memoryRole === "debugging_active"
    || hit.memoryRole === "planning_active";
}

export function scoreStatusSignals(hit: SearchHit): number {
  const matches = countMatches(textOf(hit), STATUS_SIGNAL_PATTERNS);
  return Math.min(1, matches / 3);
}

export function scoreOperationalNoise(hit: SearchHit): number {
  const matches = countMatches(textOf(hit), OPERATIONAL_NOISE_PATTERNS);
  return Math.min(1, matches / 3);
}

export function scoreHistoricalStatusPenalty(hit: SearchHit): number {
  const text = textOf(hit);
  if (hasActiveSignal(text)) return 0;
  return countMatches(text, HISTORICAL_PATTERNS) > 0 ? 1 : 0;
}

export function scoreScopeMatch(hit: SearchHit, requestedPath?: string): number {
  if (!requestedPath) return hit.path ? 0.5 : 0.35;
  if (hit.path === requestedPath) return 1;
  if (!hit.path) return 0.35;
  return 0;
}

export function classifyRecallMemoryKind(hit: SearchHit, _intent?: IntentSignal): RecallMemoryKind {
  const storedKind = storedRecallKind(hit);
  if (storedKind) return storedKind;
  const text = textOf(hit);
  if (/\bsession handoff\b|\bresume here\b|\bnext time\b/i.test(text)) return "session_handoff";
  if (/\bdebugging\b|\bfailing test\b|\btest failure\b|\bblocked\b/i.test(text)) return "debugging_active";
  if (/\bcurrent status\b|\bcurrently\b/i.test(text)) return "current_status";
  if (/\bplan\b|\bnext step\b|\bmilestone\b/i.test(text)) return "planning_active";
  if (/\barchitecture\b|\binvariant\b|\bpipeline\b|\bdata flow\b|\bpostProcessRecallResults\b/i.test(text)) return "architecture_reference";
  if (/\bscout\b|\bresearch\b/i.test(text)) return "research_context";
  if (/\bdeploy(?:ed)?\b|\bpm2\b|\bDigitalOcean\b|\bport 7700\b/i.test(text)) return "deploy_ops";
  if (/\badmin(?:istrative)?\b|\bworkflow\b|\bbd prime\b|\bpush git changes\b/i.test(text)) return "admin_process";
  if (/\bbuilder brief\b|\btask initialization\b|\bhousekeeping\b|\bmaintenance\b|\btsconfig\.json\b|\bnpx\s+tsx\b|\bscript runs?\b/i.test(text)) return "operational_noise";
  if (hasTicketSignal(text) || /\bworking on\b|\bimplementing\b|\btesting\b|\bfixing\b/i.test(text)) return "recent_work";
  return "recent_work";
}

function memoryKindScore(kind: RecallMemoryKind): number {
  switch (kind) {
    case "current_status": return 1.0;
    case "session_handoff": return 0.95;
    case "recent_work": return 0.8;
    case "debugging_active": return 0.75;
    case "planning_active": return 0.6;
    case "architecture_reference": return 0.35;
    case "research_context": return 0.15;
    case "deploy_ops":
    case "admin_process":
    case "operational_noise":
      return 0;
  }
}

function unresolvedWorkScore(hit: SearchHit): number {
  return /\b(in progress|blocked|working on|implementing|fixing|testing|debugging|next step)\b/i.test(textOf(hit)) ? 1 : 0;
}

function recencyScore(hit: SearchHit, now = Date.now()): number {
  const stamp = hit.updatedAt ?? hit.createdAt;
  if (!stamp) return 0;
  const ageDays = Math.max(0, (now - Date.parse(stamp)) / 86_400_000);
  const halfLifeDays = 7;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function normalizeSemanticScore(hit: SearchHit, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return Math.max(0, Math.min(1, hit.score / maxScore));
}

function hasStrongStatusEvidence(hit: SearchHit, requestedPath?: string): boolean {
  return hit.memoryRole === "project_state"
    || hasStoredStatusRole(hit)
    || scoreStatusSignals(hit) >= 0.66
    || (hasTicketSignal(textOf(hit)) && scoreScopeMatch(hit, requestedPath) >= 1);
}

export function filterCurrentStatusCandidates(
  hits: SearchHit[],
  requestedPath?: string,
): { selectedPool: SearchHit[]; droppedByPolicy: SearchHit[]; mode: "strict" | "fallback" } {
  const classified = hits.map((hit) => ({ hit, kind: classifyRecallMemoryKind(hit) }));
  const strictCandidates = classified.filter(({ hit, kind }) => {
    const scope = scoreScopeMatch(hit, requestedPath);
    if (scope <= 0) return false;
    const hasPositiveGate = hit.memoryRole === "project_state"
      || hasStoredStatusRole(hit)
      || scoreStatusSignals(hit) > 0
      || hasTicketSignal(textOf(hit))
      || kind === "current_status"
      || kind === "session_handoff"
      || kind === "recent_work"
      || kind === "debugging_active";
    if (!hasPositiveGate) return false;
    const hardNegative = kind === "deploy_ops" || kind === "admin_process" || kind === "operational_noise" || kind === "research_context";
    if (hardNegative && !hasStrongStatusEvidence(hit, requestedPath)) return false;
    return true;
  });

  if (strictCandidates.length >= 2) {
    const selectedIds = new Set(strictCandidates.map(({ hit }) => hit.id));
    return {
      selectedPool: strictCandidates.map(({ hit }) => hit),
      droppedByPolicy: hits.filter((hit) => !selectedIds.has(hit.id)),
      mode: "strict",
    };
  }

  const fallbackCandidates = classified.filter(({ hit }) => scoreScopeMatch(hit, requestedPath) > 0 && classifyRecallMemoryKind(hit) !== "operational_noise");
  const selectedIds = new Set(fallbackCandidates.map(({ hit }) => hit.id));
  return {
    selectedPool: fallbackCandidates.map(({ hit }) => hit),
    droppedByPolicy: hits.filter((hit) => !selectedIds.has(hit.id)),
    mode: "fallback",
  };
}

export function computeCurrentStatusScore(hit: SearchHit, candidatePool: SearchHit[], requestedPath?: string, nowMs?: number): number {
  const maxScore = Math.max(...candidatePool.map((candidate) => candidate.score), 1);
  return (
    0.30 * normalizeSemanticScore(hit, maxScore)
    // nowMs threads the recall pipeline's pinned clock through (Rúnir-dn3e):
    // an un-pinned Date.now() here was the service-side wall-clock leak that
    // made same-data replay recordings drift between runs.
    + 0.18 * recencyScore(hit, nowMs ?? Date.now())
    + 0.15 * scoreStatusSignals(hit)
    + 0.10 * scoreScopeMatch(hit, requestedPath)
    + 0.15 * continuityRoleScore(hit)
    + 0.05 * validityScore(hit)
    + 0.07 * unresolvedWorkScore(hit)
    - 0.15 * scoreOperationalNoise(hit)
    - 0.05 * scoreHistoricalStatusPenalty(hit)
  );
}

export function rerankCurrentStatusHits(hits: SearchHit[], requestedPath?: string, nowMs?: number): SearchHit[] {
  const rescored = hits.map((hit) => ({ ...hit, score: computeCurrentStatusScore(hit, hits, requestedPath, nowMs) }));
  rescored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aStamp = a.updatedAt ?? a.createdAt ?? "";
    const bStamp = b.updatedAt ?? b.createdAt ?? "";
    if (aStamp !== bStamp) return bStamp.localeCompare(aStamp);
    return a.id.localeCompare(b.id);
  });
  return rescored;
}
