import { createHash } from "node:crypto";
import {
  deriveNoemaClaimContract,
  isValidNoemaStatusTransition,
  normalizeNoemaClaimStatus,
  type DeriveNoemaClaimContractInput,
  type NoemaClaimContract,
  type NoemaClaimStatus,
  type NoemaStableClaim,
} from "./claim-contract.js";

export type NoemaCompositionSource = {
  id: string;
  text: string;
  claimKey?: string;
  revisionHash?: string;
  status?: NoemaClaimStatus;
  stableClaim?: NoemaStableClaim;
};

export type NoemaCompositionPromptMetadata = {
  promptName: string;
  schemaName: string;
  schemaVersion: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
};

export type NoemaCompositionRunBounds = {
  maxLlmCalls: number;
  attemptedLlmCalls: number;
};

export type NoemaCompositionCandidate = {
  canonicalText: string;
  claimSubject?: string;
  claimPredicate?: string;
  factKey?: string;
  status?: NoemaClaimStatus;
  supportSemioteIds: string[];
  supersedesNoemaId?: string;
  conflictsWithNoemaIds?: string[];
};

export type NoemaCompositionInputSnapshot = {
  userId: string;
  scope?: string;
  path?: string;
  memoryRole?: string;
  category?: string;
  continuitySubjectKey?: string;
  sources: NoemaCompositionSource[];
  existingStatus?: NoemaClaimStatus;
  allowSingletonDeterministicPromotion?: boolean;
};

export type NoemaCompositionValidationResult = {
  accepted: boolean;
  reason: string;
  errors: string[];
  warnings: string[];
  candidateSource: "model" | "singleton_deterministic" | "none";
  claimContract?: NoemaClaimContract;
  transition: {
    from?: NoemaClaimStatus;
    to?: NoemaClaimStatus;
    allowed: boolean;
  };
};

export type NoemaCompositionCommitDecision = {
  action: "commit" | "no_commit";
  reason: string;
  status?: NoemaClaimStatus;
  claimKey?: string;
  revisionHash?: string;
  supportSemioteIds: string[];
  supersedesNoemaId?: string;
  conflictsWithNoemaIds: string[];
};

export type NoemaCompositionDecisionLog = {
  logVersion: "noema-composition-log-v1";
  runId: string;
  createdAt: string;
  inputIds: string[];
  prompt: NoemaCompositionPromptMetadata;
  bounds: NoemaCompositionRunBounds;
  promptHash: string;
  inputHash: string;
  rawOutputHash?: string;
  parsedOutputHash?: string;
  rawModelOutput?: string;
  parsedOutput?: NoemaCompositionCandidate;
  validation: NoemaCompositionValidationResult;
  commitDecision: NoemaCompositionCommitDecision;
  decisionHash: string;
  inputSnapshot: NoemaCompositionInputSnapshot;
};

export type BuildNoemaCompositionDecisionLogInput = {
  runId: string;
  createdAt: string;
  input: NoemaCompositionInputSnapshot;
  prompt: NoemaCompositionPromptMetadata & {
    promptText?: string;
  };
  bounds: NoemaCompositionRunBounds;
  rawModelOutput?: string;
  parsedOutput?: NoemaCompositionCandidate | null;
};

export type NoemaCompositionReplayResult = {
  reproduced: boolean;
  replayedLog: NoemaCompositionDecisionLog;
  originalDecisionHash: string;
  replayedDecisionHash: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeString(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function normalizeCandidate(candidate: NoemaCompositionCandidate): NoemaCompositionCandidate {
  return {
    canonicalText: normalizeString(candidate.canonicalText),
    claimSubject: normalizeString(candidate.claimSubject) || undefined,
    claimPredicate: normalizeString(candidate.claimPredicate) || undefined,
    factKey: normalizeString(candidate.factKey) || undefined,
    status: normalizeNoemaClaimStatus(candidate.status),
    supportSemioteIds: uniqueSorted(candidate.supportSemioteIds),
    supersedesNoemaId: normalizeString(candidate.supersedesNoemaId) || undefined,
    conflictsWithNoemaIds: uniqueSorted(candidate.conflictsWithNoemaIds ?? []),
  };
}

function buildSingletonCandidate(input: NoemaCompositionInputSnapshot): NoemaCompositionCandidate | null {
  if (!input.allowSingletonDeterministicPromotion || input.sources.length !== 1) {
    return null;
  }
  const source = input.sources[0];
  if (!source?.text.trim()) {
    return null;
  }
  return normalizeCandidate({
    canonicalText: source.text,
    claimSubject: source.stableClaim?.subject,
    claimPredicate: source.stableClaim?.predicate,
    status: source.status ?? "active",
    supportSemioteIds: [source.id],
  });
}

function deriveClaimContract(
  input: NoemaCompositionInputSnapshot,
  candidate: NoemaCompositionCandidate,
): NoemaClaimContract {
  const contractInput: DeriveNoemaClaimContractInput = {
    userId: input.userId,
    scope: input.scope,
    path: input.path,
    memoryRole: input.memoryRole,
    category: input.category,
    continuitySubjectKey: input.continuitySubjectKey,
    factKey: candidate.factKey,
    canonicalText: candidate.canonicalText,
    claimSubject: candidate.claimSubject,
    claimPredicate: candidate.claimPredicate,
    status: candidate.status,
  };
  return deriveNoemaClaimContract(contractInput);
}

function validateCandidate(args: {
  input: NoemaCompositionInputSnapshot;
  bounds: NoemaCompositionRunBounds;
  parsedOutput?: NoemaCompositionCandidate | null;
}): {
  candidate?: NoemaCompositionCandidate;
  validation: NoemaCompositionValidationResult;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sourceIds = new Set(args.input.sources.map((source) => source.id));
  let candidateSource: NoemaCompositionValidationResult["candidateSource"] = "model";
  let candidate = args.parsedOutput ? normalizeCandidate(args.parsedOutput) : null;

  if (args.bounds.attemptedLlmCalls > args.bounds.maxLlmCalls) {
    errors.push("llm_call_budget_exceeded");
  }

  if (!candidate) {
    candidate = buildSingletonCandidate(args.input);
    candidateSource = candidate ? "singleton_deterministic" : "none";
  }

  if (!candidate) {
    errors.push("missing_candidate");
  } else {
    if (!candidate.canonicalText) {
      errors.push("empty_canonical_text");
    }
    if (candidate.supportSemioteIds.length === 0) {
      errors.push("missing_support_ids");
    }
    for (const supportId of candidate.supportSemioteIds) {
      if (!sourceIds.has(supportId)) {
        errors.push(`unknown_support_id:${supportId}`);
      }
    }
  }

  const claimContract = candidate ? deriveClaimContract(args.input, candidate) : undefined;
  const requestedStatus = candidate ? normalizeNoemaClaimStatus(candidate.status) : undefined;
  const existingStatus = args.input.existingStatus
    ? normalizeNoemaClaimStatus(args.input.existingStatus)
    : undefined;
  const transitionAllowed = requestedStatus
    ? !existingStatus || isValidNoemaStatusTransition(existingStatus, requestedStatus)
    : false;

  if (candidate?.conflictsWithNoemaIds?.length) {
    warnings.push("candidate_conflicts_with_existing_noema");
  }
  if (!transitionAllowed && requestedStatus) {
    errors.push(`invalid_status_transition:${existingStatus}->${requestedStatus}`);
  }

  const accepted = errors.length === 0;
  return {
    candidate: candidate ?? undefined,
    validation: {
      accepted,
      reason: accepted ? "accepted" : errors[0] ?? "rejected",
      errors,
      warnings,
      candidateSource,
      claimContract,
      transition: {
        from: existingStatus,
        to: requestedStatus,
        allowed: transitionAllowed,
      },
    },
  };
}

function decideCommit(args: {
  candidate?: NoemaCompositionCandidate;
  validation: NoemaCompositionValidationResult;
}): NoemaCompositionCommitDecision {
  const candidate = args.candidate;
  const claimContract = args.validation.claimContract;
  const conflictsWithNoemaIds = candidate?.conflictsWithNoemaIds ?? [];
  if (!candidate || !claimContract || !args.validation.accepted) {
    return {
      action: "no_commit",
      reason: args.validation.reason,
      status: claimContract?.status,
      claimKey: claimContract?.claimKey,
      revisionHash: claimContract?.revisionHash,
      supportSemioteIds: candidate?.supportSemioteIds ?? [],
      supersedesNoemaId: candidate?.supersedesNoemaId,
      conflictsWithNoemaIds,
    };
  }
  if (claimContract.status === "conflicted" || conflictsWithNoemaIds.length > 0) {
    return {
      action: "no_commit",
      reason: "candidate_conflict_detected",
      status: "conflicted",
      claimKey: claimContract.claimKey,
      revisionHash: claimContract.revisionHash,
      supportSemioteIds: candidate.supportSemioteIds,
      supersedesNoemaId: candidate.supersedesNoemaId,
      conflictsWithNoemaIds,
    };
  }
  return {
    action: "commit",
    reason: "deterministic_validation_passed",
    status: claimContract.status,
    claimKey: claimContract.claimKey,
    revisionHash: claimContract.revisionHash,
    supportSemioteIds: candidate.supportSemioteIds,
    supersedesNoemaId: candidate.supersedesNoemaId,
    conflictsWithNoemaIds,
  };
}

function logWithoutDerivedHashes(input: BuildNoemaCompositionDecisionLogInput): Omit<
  NoemaCompositionDecisionLog,
  "promptHash" | "inputHash" | "rawOutputHash" | "parsedOutputHash" | "validation" | "commitDecision" | "decisionHash"
> {
  const prompt: NoemaCompositionPromptMetadata = {
    promptName: input.prompt.promptName,
    schemaName: input.prompt.schemaName,
    schemaVersion: input.prompt.schemaVersion,
    model: input.prompt.model,
    temperature: input.prompt.temperature,
    maxOutputTokens: input.prompt.maxOutputTokens,
  };
  return {
    logVersion: "noema-composition-log-v1",
    runId: input.runId,
    createdAt: input.createdAt,
    inputIds: input.input.sources.map((source) => source.id),
    prompt,
    bounds: input.bounds,
    rawModelOutput: input.rawModelOutput,
    parsedOutput: input.parsedOutput ?? undefined,
    inputSnapshot: input.input,
  };
}

export function buildNoemaCompositionDecisionLog(
  input: BuildNoemaCompositionDecisionLogInput,
): NoemaCompositionDecisionLog {
  const promptHash = sha256(stableJson({
    prompt: input.prompt,
  }));
  const inputHash = sha256(stableJson(input.input));
  const rawOutputHash = input.rawModelOutput === undefined ? undefined : sha256(input.rawModelOutput);
  const { candidate, validation } = validateCandidate({
    input: input.input,
    bounds: input.bounds,
    parsedOutput: input.parsedOutput,
  });
  const parsedOutputHash = candidate ? sha256(stableJson(candidate)) : undefined;
  const commitDecision = decideCommit({ candidate, validation });
  const decisionHash = sha256(stableJson({
    validation,
    commitDecision,
  }));

  return {
    ...logWithoutDerivedHashes(input),
    promptHash,
    inputHash,
    rawOutputHash,
    parsedOutputHash,
    parsedOutput: candidate,
    validation,
    commitDecision,
    decisionHash,
  };
}

export function replayNoemaCompositionDecision(
  log: NoemaCompositionDecisionLog,
): NoemaCompositionReplayResult {
  const replayedLog = buildNoemaCompositionDecisionLog({
    runId: log.runId,
    createdAt: log.createdAt,
    input: log.inputSnapshot,
    prompt: log.prompt,
    bounds: log.bounds,
    rawModelOutput: log.rawModelOutput,
    parsedOutput: log.parsedOutput ?? null,
  });
  return {
    reproduced: replayedLog.decisionHash === log.decisionHash,
    replayedLog,
    originalDecisionHash: log.decisionHash,
    replayedDecisionHash: replayedLog.decisionHash,
  };
}
