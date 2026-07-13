import type { SearchHit } from "../../domain/memory/types";
import type { IntentSignal } from "../intent/intent-analyzer";

export type PreferencePacketCategory =
  | "hard_constraints_safety_privacy"
  | "tools_environment"
  | "coding_style"
  | "workflow_process"
  | "communication_style"
  | "ui_product_taste"
  | "business_preferences";

export type PreferencePacketSourceKind = "semiote" | "noema";

export type PreferencePacketItem = {
  id: string;
  category: PreferencePacketCategory;
  text: string;
  score: number;
  sourceKind: PreferencePacketSourceKind;
  trust: "untrusted_retrieved_data";
  reason: string;
  scope?: string;
  path?: string;
};

export type PreferencePacket = {
  version: "jit-preference-packet-v1";
  trust: "untrusted_retrieved_data";
  generatedFrom: "postProcessRecallResults";
  intentLabel: IntentSignal["label"];
  categoryOrder: PreferencePacketCategory[];
  categories: Record<PreferencePacketCategory, PreferencePacketItem[]>;
  audit: {
    selectedIds: string[];
    excludedIds: string[];
    sourceKinds: Record<PreferencePacketSourceKind, number>;
    tokenBudget: number;
    approximateTokens: number;
    truncated: boolean;
    truncationStrategy: "category_priority_then_score";
  };
};

export type BuildPreferencePacketOptions = {
  intent: IntentSignal;
  tokenBudget?: number;
};

export const PREFERENCE_PACKET_CATEGORY_ORDER: PreferencePacketCategory[] = [
  "hard_constraints_safety_privacy",
  "tools_environment",
  "coding_style",
  "workflow_process",
  "communication_style",
  "ui_product_taste",
  "business_preferences",
];

const DEFAULT_TOKEN_BUDGET = 600;

function emptyCategories(): Record<PreferencePacketCategory, PreferencePacketItem[]> {
  return {
    hard_constraints_safety_privacy: [],
    tools_environment: [],
    coding_style: [],
    workflow_process: [],
    communication_style: [],
    ui_product_taste: [],
    business_preferences: [],
  };
}

function sourceKindForHit(hit: SearchHit): PreferencePacketSourceKind {
  return hit.id.startsWith("noema:") ? "noema" : "semiote";
}

function sanitizePreferenceText(text: string): string {
  return text
    .replace(/\0/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/^>{1,2}\s*/, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Shared chars/4 token heuristic. Exported for the budget-aware projection
 * (Rúnir-tfxt.1) so selection and the preference packet estimate identically.
 * The fit contract is budget-AWARE, not token-exact.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isPreferenceLike(hit: SearchHit, intent: IntentSignal): boolean {
  if (hit.category === "preferences" || hit.category === "profile") return true;
  if (intent.label === "preference" && hit.text.trim().length > 0) return true;
  return /\b(prefer|preference|preferred|likes?|dislikes?|usually|always|never|must|do not|don't|avoid|style|convention|setting|configuration)\b/i
    .test(hit.text);
}

function classifyPreferenceCategory(text: string): PreferencePacketCategory {
  if (/\b(secret|credential|api key|token|privacy|private|permission|approval|destructive|production|must|never|do not|don't|avoid)\b/i.test(text)) {
    return "hard_constraints_safety_privacy";
  }
  if (/\b(vitest|typescript|eslint|npm|pnpm|yarn|gitnexus|beads|bd |claude|codex|opencode|surreal|sqlite|postgres|tool|cli|terminal|config|setting)\b/i.test(text)) {
    return "tools_environment";
  }
  if (/\b(style|format|lint|strict|naming|typescript|refactor|test|coverage|comment|ascii)\b/i.test(text)) {
    return "coding_style";
  }
  if (/\b(plan|bead|handoff|review|verify|test harness|proof|phase|workflow|process|gate|commit|push)\b/i.test(text)) {
    return "workflow_process";
  }
  if (/\b(tone|concise|verbose|explain|wording|call me|address|speak|summary)\b/i.test(text)) {
    return "communication_style";
  }
  if (/\b(ui|ux|frontend|design|color|palette|card|button|layout|dashboard|product)\b/i.test(text)) {
    return "ui_product_taste";
  }
  return "business_preferences";
}

function buildItem(hit: SearchHit, intent: IntentSignal): PreferencePacketItem | null {
  if (!isPreferenceLike(hit, intent)) return null;
  const text = sanitizePreferenceText(hit.text);
  if (!text) return null;
  const category = classifyPreferenceCategory(text);
  return {
    id: hit.id,
    category,
    text,
    score: hit.score,
    sourceKind: sourceKindForHit(hit),
    trust: "untrusted_retrieved_data",
    reason: hit.category === "preferences" || hit.category === "profile"
      ? `category:${hit.category}`
      : `intent_or_heuristic:${intent.label}`,
    scope: hit.scope,
    path: hit.path,
  };
}

function categoryPriority(category: PreferencePacketCategory): number {
  return PREFERENCE_PACKET_CATEGORY_ORDER.indexOf(category);
}

export function buildPreferencePacket(
  selected: SearchHit[],
  options: BuildPreferencePacketOptions,
): PreferencePacket | undefined {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const categories = emptyCategories();
  const selectedIds: string[] = [];
  const nonPreferenceExcludedIds: string[] = [];
  const truncatedIds: string[] = [];
  const sourceKinds: Record<PreferencePacketSourceKind, number> = { semiote: 0, noema: 0 };
  let approximateTokenCount = 0;
  let truncated = false;
  const candidates: Array<{ item: PreferencePacketItem; sourceIndex: number }> = [];

  for (const [sourceIndex, hit] of selected.entries()) {
    const item = buildItem(hit, options.intent);
    if (!item) {
      nonPreferenceExcludedIds.push(hit.id);
      continue;
    }
    candidates.push({ item, sourceIndex });
  }

  const orderedCandidates = candidates.sort((a, b) => {
    const categoryDelta = categoryPriority(a.item.category) - categoryPriority(b.item.category);
    if (categoryDelta !== 0) return categoryDelta;
    const scoreDelta = b.item.score - a.item.score;
    if (scoreDelta !== 0) return scoreDelta;
    return a.sourceIndex - b.sourceIndex;
  });

  for (const { item } of orderedCandidates) {
    const itemTokens = approximateTokens(item.text);
    if (approximateTokenCount + itemTokens > tokenBudget) {
      truncated = true;
      truncatedIds.push(item.id);
      continue;
    }
    categories[item.category].push(item);
    selectedIds.push(item.id);
    sourceKinds[item.sourceKind]++;
    approximateTokenCount += itemTokens;
  }

  if (selectedIds.length === 0) return undefined;

  return {
    version: "jit-preference-packet-v1",
    trust: "untrusted_retrieved_data",
    generatedFrom: "postProcessRecallResults",
    intentLabel: options.intent.label,
    categoryOrder: PREFERENCE_PACKET_CATEGORY_ORDER,
    categories,
    audit: {
      selectedIds,
      excludedIds: [...nonPreferenceExcludedIds, ...truncatedIds],
      sourceKinds,
      tokenBudget,
      approximateTokens: approximateTokenCount,
      truncated,
      truncationStrategy: "category_priority_then_score",
    },
  };
}
