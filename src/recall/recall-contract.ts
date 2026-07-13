import { z } from "zod";
import type {
  MemoryRole,
  SessionOpenerConfidence,
  SessionOpenerEvidenceItem,
  SessionOpenerPayload,
  SessionOpenerStatus,
  SessionOpenerWarning,
} from "../domain/memory/types.js";

const MEMORY_ROLE_VALUES = [
  "project_state",
  "current_status",
  "session_handoff",
  "recent_work",
  "debugging_active",
  "planning_active",
  "architecture_reference",
  "research_context",
  "deploy_ops",
  "admin_process",
  "operational_noise",
] as const satisfies readonly MemoryRole[];

const SESSION_OPENER_CONFIDENCE_VALUES = ["high", "medium", "low"] as const satisfies readonly SessionOpenerConfidence[];
const SESSION_OPENER_STATUS_VALUES = ["active", "blocked", "stale"] as const satisfies readonly SessionOpenerStatus[];
const SESSION_OPENER_WARNING_VALUES = [
  "path_fallback_used",
  "transitional_memory_admitted",
] as const satisfies readonly SessionOpenerWarning[];
const CONTINUITY_SOURCE_VALUES = ["deterministic", "embedder"] as const;

export const memoryRoleSchema = z.enum(MEMORY_ROLE_VALUES);
export const sessionOpenerConfidenceSchema = z.enum(SESSION_OPENER_CONFIDENCE_VALUES);
export const sessionOpenerStatusSchema = z.enum(SESSION_OPENER_STATUS_VALUES);
export const sessionOpenerWarningSchema = z.enum(SESSION_OPENER_WARNING_VALUES);
export const continuitySourceSchema = z.enum(CONTINUITY_SOURCE_VALUES);

export const sessionOpenerEvidenceItemSchema = z.object({
  id: z.string().min(1),
  role: memoryRoleSchema.optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  updatedAt: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).strict();

const continuityDirectiveSchema = z.object({
  kind: z.enum([
    "action",
    "blocker",
    "constraint",
    "avoidance",
    "question",
    "verification",
    "dependency",
    "handoff",
    "decision",
  ]),
  polarity: z.enum([
    "do",
    "do_not",
    "wait_for",
    "ask",
    "verify",
    "decide",
    "remember",
  ]),
  status: z.enum(["open", "blocked", "done", "stale"]),
  text: z.string().min(1),
  condition: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  owner: z.enum(["user", "assistant", "external", "unknown"]).optional(),
  source: z.enum(["explicit", "inferred"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1),
}).strict();

export const sessionOpenerSchema = z.object({
  intent: z.literal("continue_previous_work"),
  confidence: sessionOpenerConfidenceSchema,
  scope: z.object({
    project: z.string().min(1).optional(),
    area: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  }).strict(),
  status: sessionOpenerStatusSchema,
  focus: z.array(z.string().min(1)),
  state: z.array(z.string().min(1)),
  env: z.array(z.string().min(1)),
  next: z.array(z.string().min(1)),
  directives: z.array(continuityDirectiveSchema),
  evidenceTitles: z.array(z.string().min(1)),
  warnings: z.array(sessionOpenerWarningSchema),
  evidence: z.object({
    projectState: sessionOpenerEvidenceItemSchema.optional(),
    handoff: z.array(sessionOpenerEvidenceItemSchema),
    active: z.array(sessionOpenerEvidenceItemSchema),
    recentWork: z.array(sessionOpenerEvidenceItemSchema),
    supplemental: z.array(sessionOpenerEvidenceItemSchema),
  }).strict(),
}).strict();

export const selectedHitSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
  rank: z.number().int().positive(),
  role: z.string().optional(),
  supportSummary: z.array(z.string()).optional(),
});

// OM-1 (Rúnir-tfxt.1): budget-fit audit, present only when the request carried
// a valid budgetTokens. Mirrors RecallBudgetFitAudit (recall-selection.ts).
export const recallBudgetFitSchema = z.object({
  budgetTokens: z.number().int().positive(),
  approximateTokens: z.number().int().nonnegative(),
  depth: z.enum(["l0", "l1", "full"]),
  degraded: z.boolean(),
  droppedIds: z.array(z.string()),
}).strict();

export const recallSuccessResponseSchema = z.object({
  prependContext: z.string().nullable(),
  count: z.number().int().nonnegative(),
  retrievalTraceId: z.string().min(1).optional(),
  continuitySource: continuitySourceSchema.optional(),
  sessionOpener: sessionOpenerSchema.optional(),
  selected: z.array(selectedHitSchema).optional(),
  budgetFit: recallBudgetFitSchema.optional(),
  _debug: z.unknown().optional(),
}).strict();

export const recallWarningResponseSchema = z.object({
  prependContext: z.null(),
  count: z.literal(0),
  warning: z.string().min(1),
}).strict();

export const recallErrorResponseSchema = z.object({
  prependContext: z.null(),
  count: z.literal(0),
  error: z.string().min(1),
}).strict();

export const recallResponseSchema = z.union([
  recallWarningResponseSchema,
  recallErrorResponseSchema,
  recallSuccessResponseSchema,
]);

export type SessionOpenerContract = z.infer<typeof sessionOpenerSchema>;
export type SessionOpenerEvidenceItemContract = z.infer<typeof sessionOpenerEvidenceItemSchema>;
export type RecallSuccessResponse = z.infer<typeof recallSuccessResponseSchema>;
export type RecallWarningResponse = z.infer<typeof recallWarningResponseSchema>;
export type RecallErrorResponse = z.infer<typeof recallErrorResponseSchema>;
export type RecallResponse = z.infer<typeof recallResponseSchema>;

export function parseSessionOpener(value: unknown): SessionOpenerContract {
  return sessionOpenerSchema.parse(value);
}

export function parseRecallResponse(value: unknown): RecallResponse {
  return recallResponseSchema.parse(value);
}

type AssertExtends<T extends U, U> = T;

type _SessionOpenerEvidenceItemRoundTrip = AssertExtends<SessionOpenerEvidenceItemContract, SessionOpenerEvidenceItem>;
type _SessionOpenerEvidenceItemCompatibility = AssertExtends<SessionOpenerEvidenceItem, SessionOpenerEvidenceItemContract>;
type _SessionOpenerRoundTrip = AssertExtends<SessionOpenerContract, SessionOpenerPayload>;
type _SessionOpenerCompatibility = AssertExtends<SessionOpenerPayload, SessionOpenerContract>;
