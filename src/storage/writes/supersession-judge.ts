/**
 * Rúnir-pn1l Layer 2 — single-pair OLD/NEW supersession judge (PURE core).
 *
 * This module is deliberately free of any LLM-gateway import so the storage layer
 * stays framework-independent (AGENTS.md non-negotiable; Codex brief-gate revision
 * #2). It owns only: the verdict types, the role-labeled prompt builder, and the
 * keep-both-when-unsure verdict parser. The gateway-backed factory that actually
 * calls the model lives in the app/infra layer (`src/app/supersession-judge.ts`).
 *
 * Role labels are OLD/NEW (not A/B) so the model's positional assignment is stable
 * across calls — pairwise position bias flips ~20-30% of A/B verdicts on order
 * (research §techniques #5/#6). keep-both-when-unsure is enforced structurally:
 * anything that is not a confident `supersede`/`duplicate` collapses to
 * `independent`, which the arbitrator maps to create (keep both). An uncertain
 * judge must never produce a wrong supersede.
 *
 * Rúnir-pn1l.13.7: discriminated `JudgeOutcome` + `parseJudgeVerdictRaw` so failure
 * classes are never erased into a silent `independent` verdict (D0). Prompt v2
 * freezes the continuation clause (D6). The factory returns a handle with fully-
 * resolved effective config identity (D4).
 */

import { createHash } from "node:crypto";
import type { LlmGatewayMessage } from "../../shared/llm-gateway-client.js";

export type SupersessionVerdictLabel = "duplicate" | "supersede" | "independent";

export interface SupersessionVerdict {
  verdict: SupersessionVerdictLabel;
  /** 0..1; for independent/keep-both this is the judge's reported value or 0. */
  confidence: number;
  rationale?: string;
}

/**
 * Rúnir-pn1l.13.7 D0 — discriminated judge outcomes end-to-end.
 * Failure classes are NEVER collapsed to a silent `independent` verdict at the
 * parse/factory boundary; resolution maps them to keep-both with class-distinct
 * reasons + ledger rows.
 */
export type JudgeOutcome =
  | { status: "verdict"; verdict: SupersessionVerdict }
  | { status: "unavailable" }
  | { status: "transport_error"; detail: string }
  | { status: "invalid_response"; detail: string };

/** @deprecated Prefer `SupersessionJudgeHandle.judge` (Rúnir-pn1l.13.7 D4). Kept as a
 *  structural alias for tests that still mock a bare async function. */
export type SupersessionJudge = (oldText: string, newText: string) => Promise<SupersessionVerdict>;

/** Rúnir-pn1l.13.7 D4 — fully-resolved effective request configuration, captured once
 *  at handle construction. Mid-process env mutation is out of contract. */
export interface SupersessionJudgeIdentity {
  model: string;
  promptVersion: string;
  promptSha256: string;
  confidenceFloor: number;
  temperature: number;
  /** Pre-resolved: `jsonMode && RUNIR_LLM_JSON_MODE !== "0"` at construction. */
  effectiveJsonMode: boolean;
  baseUrl: string;
  timeoutMs: number;
}

/** Rúnir-pn1l.13.7 D7 — in-process counters since boot (exposed on `/health`). */
export interface SupersessionJudgeCounters {
  verdict: number;
  unavailable: number;
  transport_error: number;
  invalid_response: number;
  vetoed: number;
  confirmed: number;
  duplicate: number;
  ledger_write_failures: number;
}

export type F2JudgeCheckResult =
  | "confirmed"
  | "vetoed"
  | "duplicate"
  | "unavailable"
  | "transport_error"
  | "invalid_response";

export type GuardOverrideLeg = "durability" | "temporal";

export interface GuardOverride {
  leg: GuardOverrideLeg;
  reason: string;
}

/** Rúnir-pn1l.13.7 D3 — provenance stamped onto applied records (F2-confirm path only). */
export interface SupersessionProvenance {
  authority: "f2_exception";
  decisionId: string;
  appliedOutcome: "create" | "supersede" | "skip";
  f2JudgeCheck: {
    result: F2JudgeCheckResult;
    confidence?: number;
    guardOverride?: GuardOverride;
    judgeIdentity: SupersessionJudgeIdentity | null;
    identityStatus: "resolved" | "no_handle";
  };
}

export interface SupersessionJudgeHandle {
  judge(oldText: string, newText: string): Promise<JudgeOutcome>;
  identity: SupersessionJudgeIdentity;
  getCounters(): SupersessionJudgeCounters;
  /** Resolution outcomes counted in the arbitrator (confirmed / vetoed / duplicate). */
  noteResolution(result: "confirmed" | "vetoed" | "duplicate"): void;
  /**
   * Prefer the module-owned `noteLedgerWriteFailure` from supersession-judge-ledger
   * (handle-independent). Handle method retained for back-compat / convenience.
   */
  noteLedgerWriteFailure(detail?: string): void;
}

export const DEFAULT_JUDGE_MODEL = "vertex/gemini-3.1-flash-lite@us";
export const DEFAULT_JUDGE_CONFIDENCE_FLOOR = 0.6;
export const DEFAULT_JUDGE_TEMPERATURE = 0.1;

/** Rúnir-pn1l.13.7 D6 — frozen prompt version id carried in handle identity + provenance. */
export const JUDGE_PROMPT_VERSION = "v2-continuation-2026-07-09";

const KEEP_BOTH: SupersessionVerdict = { verdict: "independent", confidence: 0 };
const VALID_LABELS: ReadonlySet<string> = new Set(["duplicate", "supersede", "independent"]);

/**
 * Rúnir-pn1l.13.7 D6 — frozen system prompt (v2). The CONTINUATION clause after the
 * verdict definitions is frozen; re-adjudication reports exposed pairs separately.
 */
export const JUDGE_SYSTEM_PROMPT = [
  "You compare two short memory facts to decide whether the NEW fact makes the OLD fact stale.",
  "OLD is an existing stored memory. NEW is an incoming fact that may or may not be about the same subject.",
  "",
  "Think briefly, then answer with exactly one verdict:",
  '- "supersede": NEW replaces OLD because it states a DIFFERENT, current value for the SAME subject and the SAME exclusive attribute (one value can hold at a time, e.g. the current tech lead, the datastore in use). OLD is now stale.',
  '- "duplicate": NEW restates the SAME fact as OLD (no new information, same value).',
  '- "independent": NEW and OLD can both be true at once — different subjects, additive detail, a non-exclusive attribute (co-leads, multiple skills), or a sequential move where both were valid in turn. When in any doubt, choose this.',
  "",
  "A CONTINUATION is independent, not a supersession: when NEW is the fix, result, follow-up, review verdict, or refinement of the diagnosis, plan, recommendation, finding, or state that OLD records, OLD remains valid history (the why, the specifics, the constraints) unless NEW itself restates that content. Progress in the same workstream does not make the earlier step stale. Only choose supersede for a genuine value replacement — not for work that builds on, responds to, or advances what OLD describes.",
  "",
  "Only choose supersede when you are confident OLD and NEW concern the same subject AND the attribute is exclusive AND the value genuinely changed. Otherwise prefer independent — keeping a redundant fact is far safer than deleting a co-valid one.",
  'Respond ONLY with JSON: {"verdict": "supersede"|"duplicate"|"independent", "confidence": 0.0-1.0, "rationale": "<short>"}',
].join("\n");

/** Sha256 of the frozen system prompt — part of handle identity + cassette key (D4). */
export function judgePromptSha256(): string {
  return createHash("sha256").update(JUDGE_SYSTEM_PROMPT).digest("hex");
}

/** Build the role-labeled chat messages for one OLD/NEW judgement. */
export function buildJudgePrompt(oldText: string, newText: string): LlmGatewayMessage[] {
  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: `OLD:\n${oldText}\n\nNEW:\n${newText}` },
  ];
}

/** Strip a single ```json fence wrapper if the model added one. Inlined (rather
 *  than imported from the gateway module) to keep this module gateway-free. */
function stripFences(content: string): string {
  return content.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
}

/**
 * Rúnir-pn1l.13.7 D0 — raw discriminated parse. Malformed JSON, wrong shape,
 * unknown label, and non-finite/out-of-range confidence each yield
 * `invalid_response` with a class-naming detail. Below-floor confidence is NOT
 * an error: it stays `{status:"verdict"}` and the resolver's floor check keeps
 * both (existing trust-boundary semantics).
 */
export function parseJudgeVerdictRaw(
  raw: string,
): { status: "verdict"; verdict: SupersessionVerdict } | { status: "invalid_response"; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return { status: "invalid_response", detail: "malformed_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid_response", detail: "wrong_shape" };
  }

  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  const confidence = obj.confidence;
  const rationale = typeof obj.rationale === "string" ? obj.rationale : undefined;

  if (typeof verdict !== "string" || !VALID_LABELS.has(verdict)) {
    return { status: "invalid_response", detail: "unknown_label" };
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { status: "invalid_response", detail: "non_finite_confidence" };
  }
  if (confidence < 0 || confidence > 1) {
    return { status: "invalid_response", detail: "out_of_range_confidence" };
  }

  return {
    status: "verdict",
    verdict: {
      verdict: verdict as SupersessionVerdictLabel,
      confidence,
      rationale,
    },
  };
}

/**
 * Parse a raw model response into an actionable verdict for back-compat callers.
 * Rúnir-pn1l.13.7 D0: thin wrapper over `parseJudgeVerdictRaw` —
 * `invalid_response` → keep-both `independent`. Floor enforcement lives in
 * `resolveJudgeDecision` (single floor source from the handle identity).
 */
export function parseJudgeVerdict(
  raw: string,
  _opts?: { confidenceFloor?: number },
): SupersessionVerdict {
  const parsed = parseJudgeVerdictRaw(raw);
  if (parsed.status === "invalid_response") return KEEP_BOTH;
  return parsed.verdict;
}

/** Empty counters snapshot (D7). */
export function emptyJudgeCounters(): SupersessionJudgeCounters {
  return {
    verdict: 0,
    unavailable: 0,
    transport_error: 0,
    invalid_response: 0,
    vetoed: 0,
    confirmed: 0,
    duplicate: 0,
    ledger_write_failures: 0,
  };
}
