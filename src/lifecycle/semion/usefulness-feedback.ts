type Resolution = "explicit_success" | "implicit_success" | "rephrased" | "failure";

export type UsefulnessState = {
  usefulnessAlpha: number;
  usefulnessBeta: number;
  usefulnessScore: number;
  retrievedCount: number;
  usedCount: number;
  successfulUseCount: number;
  crossSessionUseCount: number;
  contradictionCount: number;
  lastRetrievedAt?: string;
  lastUsedAt?: string;
  lastEvaluatedAt?: string;
  hexisId?: string;
  hexisVersion?: number;
  hexisFit?: number;
  rankingExplanation?: string[];
};

export type NoemaPromotionCheck = Pick<
  UsefulnessState,
  "usefulnessScore" | "successfulUseCount" | "crossSessionUseCount" | "contradictionCount"
>;

export type UsefulnessFeedbackInput = {
  memoryText: string;
  answer: string;
  responseResolution?: Resolution;
  corrected: boolean;
  crossSession: boolean;
  previous: Partial<UsefulnessState>;
  traceCreatedAt?: string;
  now?: string;
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => token.length > 1);
}

function lexicalOverlap(memoryText: string, answer: string): number {
  const memoryTokens = new Set(tokenize(memoryText));
  const answerTokens = new Set(tokenize(answer));
  if (memoryTokens.size === 0 || answerTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of memoryTokens) {
    if (answerTokens.has(token)) overlap++;
  }
  return clamp(overlap / memoryTokens.size);
}

function resolutionWeight(resolution: Resolution | undefined): number {
  switch (resolution) {
    case "explicit_success":
      return 1;
    case "implicit_success":
      return 0.8;
    case "rephrased":
      return 0.45;
    case "failure":
      return 0;
    default:
      return 0.7;
  }
}

export function initializeUsefulnessState(confidence: number | undefined): Pick<
  UsefulnessState,
  "usefulnessAlpha" | "usefulnessBeta" | "usefulnessScore"
> {
  const prior = clamp(confidence ?? 0.5);
  const usefulnessAlpha = 1 + 4 * prior;
  const usefulnessBeta = 1 + 4 * (1 - prior);
  return {
    usefulnessAlpha,
    usefulnessBeta,
    usefulnessScore: usefulnessAlpha / (usefulnessAlpha + usefulnessBeta),
  };
}

export function applyUsefulnessFeedback(input: UsefulnessFeedbackInput): UsefulnessState {
  const now = input.now ?? new Date().toISOString();
  const previous = input.previous;
  const base = initializeUsefulnessState(previous.usefulnessScore);
  const usefulnessAlpha = previous.usefulnessAlpha ?? base.usefulnessAlpha;
  const usefulnessBeta = previous.usefulnessBeta ?? base.usefulnessBeta;

  let evidence = 0.65 * lexicalOverlap(input.memoryText, input.answer)
    + 0.35 * resolutionWeight(input.responseResolution);

  if (input.corrected) {
    evidence -= 0.7;
  }
  if (input.crossSession) {
    evidence += 0.05;
  }
  evidence = clamp(evidence);

  const nextAlpha = usefulnessAlpha + evidence;
  const nextBeta = usefulnessBeta + (1 - evidence);
  const used = evidence >= 0.35;
  const successful = evidence >= 0.7 && !input.corrected;

  return {
    usefulnessAlpha: nextAlpha,
    usefulnessBeta: nextBeta,
    usefulnessScore: nextAlpha / (nextAlpha + nextBeta),
    retrievedCount: (previous.retrievedCount ?? 0) + 1,
    usedCount: (previous.usedCount ?? 0) + (used ? 1 : 0),
    successfulUseCount: (previous.successfulUseCount ?? 0) + (successful ? 1 : 0),
    crossSessionUseCount: (previous.crossSessionUseCount ?? 0) + (successful && input.crossSession ? 1 : 0),
    contradictionCount: (previous.contradictionCount ?? 0) + (input.corrected ? 1 : 0),
    lastRetrievedAt: input.traceCreatedAt ?? now,
    lastUsedAt: used ? now : previous.lastUsedAt,
    lastEvaluatedAt: now,
  };
}

export function shouldPromoteToNoema(input: NoemaPromotionCheck): boolean {
  return (
    input.usefulnessScore >= 0.78 &&
    input.successfulUseCount >= 3 &&
    input.crossSessionUseCount >= 2 &&
    input.contradictionCount === 0
  );
}
