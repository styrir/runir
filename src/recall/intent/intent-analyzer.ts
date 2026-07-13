import type { MemoryCategory } from "../../domain/memory/types.js";

export type QueryIntent =
  | "preference" | "decision" | "entity" | "event" | "fact"
  | "current_status" | "recent_work" | "schema" | "debugging" | "architecture"
  | "workflow_posture"
  | "session_opener"
  | "pre_compaction"
  | "post_compaction_validation"
  | "latest_state"
  | "exact_lookup"
  | "decision_trace"
  | "exploratory_topic"
  | "unknown_mixed";
export type RecallDepth = "l0" | "l1" | "full";

export type IntentSignal = {
  categories: MemoryCategory[];
  depth: RecallDepth;
  confidence: number;
  label: QueryIntent;
};

export type IntentHint = "opener" | "pre_compaction" | "post_compaction_validation" | undefined;

/**
 * The status-class intent labels (Rúnir-mmg2.2 R3). This is the SINGLE source of
 * truth for "is this a status/opener recall" — shared by the stale-signal
 * demotion gate (recall-selection.ts: status recency penalty + status_continuity
 * selector), the learned-noise auto-accrual counter gate (the capture-path
 * usefulness evaluation only increments status_retrieved_count/status_used_count
 * for these intents), and the learned-set application gate at the demotion site.
 * Keeping the accrual signal and the application site on one predicate is what
 * stops them from ever drifting apart.
 */
export const STATUS_CLASS_INTENTS: readonly QueryIntent[] = [
  "current_status",
  "session_opener",
  "pre_compaction",
  "post_compaction_validation",
];

/** True when the intent is a status/opener-class recall (see STATUS_CLASS_INTENTS). */
export function isStatusClassIntent(label: QueryIntent): boolean {
  return STATUS_CLASS_INTENTS.includes(label);
}

/**
 * The compaction-lifecycle intent labels (OM-2, Rúnir-tfxt.2). Requested ONLY
 * via explicit `sessionKind` hints from a client adapter at context-compaction
 * time — never matched from prompt text (a lifecycle event is not user prose).
 * Both serve the deterministic-continuity projection (SessionOpenerPayload
 * repurposed as the compaction render; canon §1 opener retirement stands) and
 * NEVER fall through to the hybrid lane.
 *
 * This is the canonical membership list. The orchestrator and
 * recall-selection deliberately use local literal checks instead of importing
 * these predicates (both modules are vi.mock'ed with explicit export lists in
 * many harnesses; a new import edge resolves `undefined` there — the OM-1
 * inline-typeof precedent). A drift-guard unit test asserts the local literals
 * agree with this list.
 */
export const COMPACTION_INTENTS: readonly QueryIntent[] = [
  "pre_compaction",
  "post_compaction_validation",
];

/** True when the intent is a compaction-lifecycle recall (see COMPACTION_INTENTS). */
export function isCompactionIntent(label: QueryIntent): boolean {
  return COMPACTION_INTENTS.includes(label);
}

/**
 * Intents whose response payload is the structured SessionOpenerPayload
 * projection rather than the rendered-lines injection. The OM-1 line-based
 * budget fit never applies to these (the opener is retired; compaction intents
 * get the payload-shaped fit in continuity/compaction-projection.ts instead).
 */
export const PAYLOAD_SHAPED_INTENTS: readonly QueryIntent[] = [
  "session_opener",
  ...COMPACTION_INTENTS,
];

type SearchHitLike = {
  id: string;
  text: string;
  score: number;
  category?: string;
  [key: string]: unknown;
};

const INTENT_PATTERNS: Array<{ label: QueryIntent; pattern: RegExp }> = [
  // Session opener — must come first (highest priority for continuity-first routing)
  { label: "session_opener", pattern: /^(hi|hello|hey|good morning|good afternoon|good evening|what's up|let'?s (continue|resume|pick up)|where (were|did) we leave off|catch me up|status update|resume|continue|(?:just\s+)?starting a new session)\b/i },
  // Guidance / architecture / design-work prompts — must come before broad status/recent/latest patterns
  { label: "architecture", pattern: /\b(how should we|what sections should|what belongs in|what regression checks?|what navigation|what should .* keep versus skip|how do we keep .* while still reusing|how do we prove .* are present but demoted|what exactly do we need to inspect|how do we evolve .* instead of|what ranking or selection metadata should|how should we expose raw json|what navigation affordances should|how do we tell reviewers)\b/i },
  { label: "architecture", pattern: /\b(html review surface|artifact contract|turn-by-turn replay|seed(?:ed)? history|recency buckets?|raw artifacts?|track navigation|turn navigation|retrieval trace id|selected ids|db delta|interesting turns?)\b/i },
  { label: "workflow_posture", pattern: /\b(highest-priority|top priority|what should the assertions prove|do we have any blocker|what(?:'s| is) the next step|let'?s write the handoff|write the handoff|priority outcome|surface blockers?)\b/i },
  { label: "latest_state", pattern: /\b(latest state|current state|current truth|latest truth|most recent state|active representative)\b/i },
  { label: "latest_state", pattern: /\b(what is|what's|show me|tell me)\s+the\s+(latest|current|active)\b/i },
  { label: "exact_lookup", pattern: /\b(exact lookup|exact match|direct lookup|look up exactly)\b/i },
  { label: "decision_trace", pattern: /\b(decision trace|decision history|why did we decide|why was .* chosen|tradeoff history)\b/i },
  { label: "exploratory_topic", pattern: /\b(explore|exploratory|broad overview|survey|landscape|tell me everything about)\b/i },
  { label: "unknown_mixed", pattern: /\b(mixed bag|not sure|ambiguous|unknown mixed)\b/i },
  // Preference patterns (EN + multilingual)
  { label: "preference", pattern: /\b(prefer|preference|preferences|preferred|favorite|favourite|like to|style|habit|convention|setting|configuration)\b/i },
  { label: "preference", pattern: /\b(how do i|what do i|my preferred|i usually|i always|i tend to)\b/i },
  { label: "preference", pattern: /偏好|喜欢|习惯|风格/i },
  // Decision patterns
  { label: "decision", pattern: /\b(decide|decided|decision|chose|chosen|why did we|rationale|tradeoff|trade-off|approach)\b/i },
  { label: "decision", pattern: /\b(opted for|went with|picked|selected|agreed on)\b/i },
  { label: "decision", pattern: /决定|选择|权衡/i },
  // MIM-69 Task 5: Specific query classes — inserted BEFORE generic entity patterns
  { label: "current_status", pattern: /\b(what are we working on|current status|status update|where are we|what changed in the current status)\b/i },
  { label: "recent_work", pattern: /\bMIM-\d+\b/i },
  { label: "recent_work", pattern: /\b(recent work|tonight|today|what changed recently|latest changes?)\b/i },
  { label: "schema", pattern: /\b(schema|SearchHit|payload\.\w+|SurrealDB.*field|DEFINE FIELD)\b/i },
  { label: "debugging", pattern: /\b(test failure|vitest|mocking|500 error|debug)\b/i },
  { label: "architecture", pattern: /\b(write arbitration|pipeline|architecture|data flow)\b/i },
  // Entity patterns (generic — must come after specific classes above)
  { label: "entity", pattern: /\b(status of|state of|what is|tell me about|describe|overview of|details about)\b/i },
  { label: "entity", pattern: /\b(component|service|module|system|project|library|framework)\b/i },
  { label: "entity", pattern: /状态|组件|服务|项目/i },
  // Event patterns
  { label: "event", pattern: /\b(happened|occurred|when did|timeline|history|deployed|shipped|released|launched)\b/i },
  { label: "event", pattern: /\b(yesterday|last week|last month|recently|earlier today)\b/i },
  { label: "event", pattern: /发生|部署|发布|上线/i },
];

const CATEGORY_MAP: Record<QueryIntent, MemoryCategory[]> = {
  preference: ["preferences", "profile"],
  decision: ["cases", "patterns"],
  entity: ["entities"],
  event: ["events", "entities"],
  fact: ["cases", "entities"],
  current_status: ["events", "entities"],
  recent_work: ["events", "cases"],
  schema: ["entities", "cases"],
  debugging: ["cases", "patterns"],
  architecture: ["entities", "cases", "patterns"],
  workflow_posture: ["events", "cases", "patterns"],
  session_opener: ["events", "entities"],
  pre_compaction: ["events", "entities"],
  post_compaction_validation: ["events", "entities"],
  latest_state: ["entities", "events"],
  exact_lookup: ["entities", "cases"],
  decision_trace: ["cases", "patterns"],
  exploratory_topic: ["entities", "patterns"],
  unknown_mixed: ["entities", "events"],
};

const DEPTH_MAP: Record<QueryIntent, RecallDepth> = {
  preference: "l0",
  decision: "full",
  entity: "full",
  event: "full",
  fact: "full",
  current_status: "l1",
  recent_work: "l1",
  schema: "l1",
  debugging: "full",
  architecture: "full",
  workflow_posture: "full",
  session_opener: "l1",
  pre_compaction: "l1",
  post_compaction_validation: "l0",
  latest_state: "l1",
  exact_lookup: "full",
  decision_trace: "full",
  exploratory_topic: "full",
  unknown_mixed: "full",
};

/**
 * Classifies query intent using regex rule matching.
 * Returns the first matching intent with associated categories and depth.
 *
 * When `opts.hint === "opener"` is passed, short-circuits the regex pass and
 * returns a `session_opener` signal directly. This lets clients (e.g. the
 * Claude Code SessionStart hook) explicitly request opener routing without
 * depending on prompt-text heuristics — needed because empty-prompt openers
 * would otherwise fall through to `shouldSkipRetrieval` upstream.
 *
 * The compaction hints (OM-2) short-circuit the same way: a compaction
 * lifecycle ping carries no user prose, so its routing must never depend on
 * prompt text. There are deliberately NO regex patterns for these labels.
 */
export function analyzeIntent(query: string, opts?: { hint?: IntentHint }): IntentSignal {
  if (opts?.hint === "opener") {
    return {
      categories: CATEGORY_MAP.session_opener,
      depth: DEPTH_MAP.session_opener,
      confidence: 0.95,
      label: "session_opener",
    };
  }
  if (opts?.hint === "pre_compaction" || opts?.hint === "post_compaction_validation") {
    return {
      categories: CATEGORY_MAP[opts.hint],
      depth: DEPTH_MAP[opts.hint],
      confidence: 0.95,
      label: opts.hint,
    };
  }
  for (const { label, pattern } of INTENT_PATTERNS) {
    if (pattern.test(query)) {
      return {
        categories: CATEGORY_MAP[label],
        depth: DEPTH_MAP[label],
        confidence: 0.8,
        label,
      };
    }
  }

  return {
    categories: CATEGORY_MAP.fact,
    depth: DEPTH_MAP.fact,
    confidence: 0.3,
    label: "fact",
  };
}

/**
 * Applies 1.15x score boost to results whose category matches the intent signal.
 * Does NOT filter out non-matching results — only boosts matching ones.
 * Re-sorts by boosted score.
 */
export function applyCategoryBoost<T extends SearchHitLike>(
  results: T[],
  intent: IntentSignal,
  boostFactor = 1.15,
): T[] {
  if (intent.label === "fact") return results;

  const targetCategories = new Set<string>(intent.categories);
  const boosted = results.map((r) => {
    if (r.category && targetCategories.has(r.category)) {
      return { ...r, score: r.score * boostFactor };
    }
    return { ...r };
  });

  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}
