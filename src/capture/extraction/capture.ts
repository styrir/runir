import { CONFIDENCE_THRESHOLD, DEFAULT_CAPTURE_PROMPT, MAX_TRANSCRIPT_CHARS, RESET_CAPTURE_PROMPT_ADDENDUM, SEGMENTATION_SYSTEM_PROMPT, type CaptureMessage, type ExtractedFact, type MemoryCategory, type MemoryRawSpan, type MemoryTier, type RawExtractedFact, type TopicSegmentationResult } from "../../domain/memory/types";
import { normalizeContinuityDirectives } from "../../continuity/directives.js";
import { cosineSimilarity } from "../../shared/cosine";
import { resolveRelativeTemporalPhrases } from "../../domain/memory/temporal-resolver.js";
import { recordCounter, recordPipelineDrop } from "../../obs/counters.js";
import { resolveLlmBaseUrl, resolveLlmTimeoutMs } from "../../shared/config.js";
import { jsonrepair } from "jsonrepair";

// --- Platform metadata stripping ---

const META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const ADDRESSING_PREFIX_RE = /^(?:<@!?[0-9]+>|@[A-Za-z0-9_.-]+)\s*/;
const SYSTEM_EVENT_LINE_RE = /^System:\s*\[[^\n]*?\]\s*Exec\s+(?:completed|failed|started)\b.*$/gim;
const SESSION_RESET_PREFIX = "A new session was started via /new or /reset.";

export function stripPlatformMetadata(text: string): string {
  let result = text;

  // Strip sentinel blocks: from sentinel line to next sentinel or end of text.
  // Handles multi-paragraph blocks that contain internal blank lines.
  const sentinelSet = new Set<string>(META_SENTINELS);
  let changed = true;
  while (changed) {
    changed = false;
    for (const sentinel of META_SENTINELS) {
      const idx = result.indexOf(sentinel);
      if (idx === -1) continue;
      // Scan forward line-by-line from the sentinel to find where the block ends.
      // The block ends when we hit: (a) another sentinel line, or (b) end of text,
      // or (c) a non-empty line after a blank line that is not metadata.
      const lines = result.slice(idx).split("\n");
      let endOffset = 0;
      let sawBlank = false;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Check if this line starts a new sentinel block
        if (sentinelSet.has(line) || [...sentinelSet].some(s => line.startsWith(s))) {
          endOffset = lines.slice(0, i).join("\n").length;
          break;
        }
        if (line.trim() === "") {
          sawBlank = true;
        } else if (sawBlank) {
          // Non-empty line after blank — check if it looks like metadata (key: value)
          if (/^[a-zA-Z_][a-zA-Z0-9_ ]*:/.test(line)) {
            // Looks like metadata continuation, keep scanning
            sawBlank = false;
          } else {
            // Real content — end the block here
            endOffset = lines.slice(0, i).join("\n").length;
            break;
          }
        }
      }
      if (endOffset === 0) {
        // Sentinel block runs to end of text
        result = result.slice(0, idx);
      } else {
        result = result.slice(0, idx) + result.slice(idx + endOffset);
      }
      changed = true;
      break; // restart the outer loop since indices shifted
    }
  }

  // Strip session reset boilerplate
  if (result.includes(SESSION_RESET_PREFIX)) {
    result = result.replace(SESSION_RESET_PREFIX, "").trim();
  }

  // Strip system event lines
  result = result.replace(SYSTEM_EVENT_LINE_RE, "");

  // Strip addressing prefixes (only at start of text)
  result = result.replace(ADDRESSING_PREFIX_RE, "");

  // Clean up multiple blank lines left by stripping
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

// --- MIM-34: Noise filter ---

const NOISE_PATTERNS = [
  /\b(i don'?t have|i cannot|i can'?t|i am not able to|i'?m unable to|i do not have|i lack)\b.*\b(information|access|knowledge|data|details)\b/i,
  /\b(as an ai|as a language model|i'?m just an ai)\b/i,
  /\b(do you remember|can you recall|did you save|what did (i|we) say|what do you know about)\b/i,
  /^(ok|okay|got it|understood|sure|great|thanks|thank you|alright|sounds good|will do|perfect|noted)[.!]?$/i,
  /\[tool (call|result|error)\]/i,
  /^(true|false|null|undefined|NaN)$/i,
];

export function isNoisyFact(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return true;
  return NOISE_PATTERNS.some(p => p.test(trimmed));
}

// --- Record quality helpers (MIM-RQUAL) ---

const VALID_CATEGORIES: MemoryCategory[] = ["profile", "preferences", "entities", "events", "cases", "patterns"];

export function isValidCategory(c: unknown): c is MemoryCategory {
  return typeof c === "string" && VALID_CATEGORIES.includes(c as MemoryCategory);
}

/**
 * Per-category confidence floor. Returns the minimum confidence for a fact's
 * category. Wrapped via Math.max(CONFIDENCE_THRESHOLD, ...) by the caller so
 * the floor never drops below the global default (0.7).
 *
 * NOTE: This deviates from consensus plan §P2 which specified default=0.95
 * for ALL non-matching categories. The implementation splits the cases:
 *   - undefined → 0 (defers to the global CONFIDENCE_THRESHOLD floor)
 *     Preserves back-compat with existing test fixtures that predate the
 *     category system.
 *   - unrecognized string → 0.95 (strict)
 *     Catches LLM-side typos / hallucinated categories — those should not
 *     get the lenient default.
 * In production the capture LLM prompt forces one of VALID_CATEGORIES so
 * neither branch should fire often; if uncategorized facts start showing
 * up in production, revisit the undefined branch.
 */
export function perCategoryThreshold(category: string | undefined): number {
  switch (category) {
    case "preferences":
    case "profile":
      return 0.7;
    case "events":
    case "cases":
      return 0.85;
    case "entities":
    case "patterns":
      return 0.8;
    case undefined:
      // No category set — defer entirely to the global CONFIDENCE_THRESHOLD floor.
      return 0;
    default:
      // Unrecognized string category — apply strict floor.
      return 0.95;
  }
}

export function resolveTier(category: MemoryCategory, confidence: number): MemoryTier {
  if (category === "profile" || category === "preferences") return "durable";
  if (confidence < 0.5) return "ephemeral";
  if (category === "cases" && confidence >= 0.9) return "durable";
  if (category === "events" && confidence >= 0.9) return "durable";
  return "working";
}

/**
 * djb2 hash over UTF-16 code units. Returns a 32-bit unsigned integer.
 * Not cryptographic — used only for factKey disambiguation.
 */
export function djb2Hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h;
}

export function deriveFactKey(category: MemoryCategory, l0: string): string {
  const hash = djb2Hash(l0);
  const hashHex = (hash >>> 0).toString(16).padStart(6, "0").slice(-6);

  const tokens = l0.split(/[\s\p{P}]+/u).filter(Boolean);

  const asciiTokens: string[] = [];
  for (const token of tokens) {
    if (asciiTokens.length >= 6) break;
    const lower = token.toLowerCase();
    if (/^[a-z0-9]+$/.test(lower)) {
      asciiTokens.push(lower);
    }
  }

  if (asciiTokens.length < 2) {
    return `${category}:${hashHex}`;
  }

  const slug = asciiTokens.join("-");
  return `${category}:${slug}-${hashHex}`;
}

export function normalizeTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeRawSpan(value: unknown): MemoryRawSpan | undefined {
  const record = asRecord(value);
  const text = optionalString(record?.text);
  if (!record || !text) return undefined;
  const kind = optionalString(record.kind);
  const span: MemoryRawSpan = { text };
  const sourceTurnIndex = optionalNumber(record.sourceTurnIndex);
  const cursorStart = optionalNumber(record.cursorStart);
  const cursorEnd = optionalNumber(record.cursorEnd);
  if (sourceTurnIndex !== undefined) span.sourceTurnIndex = sourceTurnIndex;
  if (cursorStart !== undefined) span.cursorStart = cursorStart;
  if (cursorEnd !== undefined) span.cursorEnd = cursorEnd;
  if (kind === "source_turn" || kind === "list_item" || kind === "code" || kind === "exact_answer") {
    span.kind = kind;
  }
  return span;
}

function normalizeRawSpans(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const spans = value.map(normalizeRawSpan).filter((span): span is NonNullable<ReturnType<typeof normalizeRawSpan>> => span !== undefined);
  return spans.length > 0 ? spans.slice(0, 20) : undefined;
}

function normalizeAtomicFact(value: unknown) {
  const record = asRecord(value);
  if (!record) return undefined;
  const fact = {
    ...(optionalString(record.subject) !== undefined ? { subject: optionalString(record.subject) } : {}),
    ...(optionalString(record.predicate) !== undefined ? { predicate: optionalString(record.predicate) } : {}),
    ...(optionalString(record.value) !== undefined ? { value: optionalString(record.value) } : {}),
    ...(optionalString(record.text) !== undefined ? { text: optionalString(record.text) } : {}),
  };
  return Object.keys(fact).length > 0 ? fact : undefined;
}

function normalizeEvent(value: unknown) {
  const record = asRecord(value);
  if (!record) return undefined;
  const event = {
    ...(optionalString(record.actor) !== undefined ? { actor: optionalString(record.actor) } : {}),
    ...(optionalString(record.action) !== undefined ? { action: optionalString(record.action) } : {}),
    ...(optionalString(record.object) !== undefined ? { object: optionalString(record.object) } : {}),
    ...(optionalString(record.happenedAt) !== undefined ? { happenedAt: optionalString(record.happenedAt) } : {}),
    ...(optionalString(record.text) !== undefined ? { text: optionalString(record.text) } : {}),
  };
  return Object.keys(event).length > 0 ? event : undefined;
}

function normalizeAtomicClaims(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const claims = value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return undefined;
      const claim = {
        ...(optionalString(record.subject) !== undefined ? { subject: optionalString(record.subject) } : {}),
        ...(optionalString(record.predicate) !== undefined ? { predicate: optionalString(record.predicate) } : {}),
        ...(optionalString(record.value) !== undefined ? { value: optionalString(record.value) } : {}),
        ...(optionalString(record.text) !== undefined ? { text: optionalString(record.text) } : {}),
        ...(optionalString(record.rawSpanText) !== undefined ? { rawSpanText: optionalString(record.rawSpanText) } : {}),
        ...(optionalNumber(record.order) !== undefined ? { order: optionalNumber(record.order) } : {}),
      };
      return Object.keys(claim).length > 0 ? claim : undefined;
    })
    .filter((claim): claim is NonNullable<typeof claim> => claim !== undefined);
  return claims.length > 0 ? claims.slice(0, 50) : undefined;
}

const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

export function parseSourceListItems(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.match(LIST_LINE_RE)?.[1]?.trim())
    .filter((item): item is string => Boolean(item && item.length > 0));
}

export function repairListShapedFact(raw: RawExtractedFact): RawExtractedFact {
  const source = raw.raw_source_text;
  if (!source) return raw;
  const items = parseSourceListItems(source);
  if (items.length < 2) return raw;

  const existingClaims = normalizeAtomicClaims(raw.atomicClaims) ?? [];
  if (existingClaims.length < items.length) {
    raw.atomicClaims = items.map((item, index) => ({
      text: item,
      value: item,
      rawSpanText: item,
      order: index + 1,
    }));
  }
  raw.rawSpans = items.map((item) => {
    const cursorStart = source.indexOf(item);
    return {
      text: item,
      sourceTurnIndex: raw.source_turn_index,
      kind: "list_item",
      cursorStart,
      cursorEnd: cursorStart >= 0 ? cursorStart + item.length : undefined,
    };
  });

  if (!/^\s*(?:[-*+]|\d+[.)])\s+/m.test(raw.l1 ?? "")) {
    raw.l1 = `## Source List\n${items.map((item) => `- ${item}`).join("\n")}`;
  }
  // Null-safe on l2: a fact whose l2 is missing/non-string must not throw here
  // (it would otherwise propagate into extractMemories' batch handler). See
  // Rúnir-sm9k.3.
  const l2 = typeof raw.l2 === "string" ? raw.l2 : "";
  const represented = items.filter((item) => l2.includes(item)).length;
  if (represented / items.length < 0.5) {
    raw.l2 = `${l2}\n\nExact source list:\n${items.map((item) => `- ${item}`).join("\n")}`;
  }
  return raw;
}

// --- Identity canonicalization ---

const IDENTITY_PATTERNS: Array<{ canonicalKey: string; category: "profile" | "preferences"; pattern: RegExp }> = [
  { canonicalKey: "profile:name", category: "profile", pattern: /\b(name is|called|goes by|known as|my name)\b/i },
  { canonicalKey: "preferences:addressing", category: "preferences", pattern: /\b(address me|call me|refer to me|don't call me)\b/i },
  { canonicalKey: "profile:role", category: "profile", pattern: /\b(i am a|i'm a|i work as|my role|my job)\b/i },
  { canonicalKey: "preferences:language", category: "preferences", pattern: /\b(i prefer|i use|my preferred language|i code in)\b/i },
];

export function canonicalizeFactKey(fact: ExtractedFact): ExtractedFact {
  if (fact.category !== "profile" && fact.category !== "preferences") {
    return fact;
  }
  for (const { canonicalKey, category, pattern } of IDENTITY_PATTERNS) {
    if (fact.category === category && pattern.test(fact.l2)) {
      return { ...fact, factKey: canonicalKey };
    }
  }
  return fact;
}

export function normalizeExtractedFact(raw: RawExtractedFact): ExtractedFact {
  const l0 = raw.l0 ?? raw.l2.slice(0, 100);
  const l1 = raw.l1 ?? ("- " + l0);
  const category = isValidCategory(raw.category) ? raw.category : "cases";
  // Coerce confidence to a FINITE number. A fact can reach here with a
  // non-numeric confidence (e.g. "high", or missing) when it slips the phase-2
  // threshold gate's NaN comparison (`"high" < min` is false). Returning a
  // string would violate the declared `confidence: number` type and corrupt the
  // SurrealDB `option<number>` payload column downstream (DB write rejection /
  // type corruption). Salvage numeric strings ("0.9" → 0.9); default the
  // genuinely non-numeric to the confidence floor (the fact passed the gate, so
  // floor is the conservative bound). iter-2 (extraction-robustness mission).
  const numericConfidence = Number(raw.confidence);
  const confidence = Number.isFinite(numericConfidence) ? numericConfidence : CONFIDENCE_THRESHOLD;
  const tier = resolveTier(category, confidence);
  const tags = normalizeTags(raw.tags);
  const directives = normalizeContinuityDirectives(raw.directives);
  const factKey = deriveFactKey(category, l0);
  const rawSpan = normalizeRawSpan(raw.rawSpan)
    ?? (raw.raw_source_text !== undefined
      ? { text: raw.raw_source_text, sourceTurnIndex: raw.source_turn_index, kind: "source_turn" as const }
      : undefined);
  const rawSpans = normalizeRawSpans(raw.rawSpans);
  const atomicFact = normalizeAtomicFact(raw.atomicFact);
  const event = normalizeEvent(raw.event);
  const atomicClaims = normalizeAtomicClaims(raw.atomicClaims);

  const fact: ExtractedFact = {
    l2: raw.l2,
    l0,
    l1,
    confidence,
    category,
    tier,
    tags,
    ...(directives.length > 0 ? { directives } : {}),
    factKey,
    ...(raw.raw_source_text !== undefined ? { raw_source_text: raw.raw_source_text } : {}),
    ...(rawSpan !== undefined ? { rawSpan } : {}),
    ...(rawSpans !== undefined ? { rawSpans } : {}),
    ...(atomicFact !== undefined ? { atomicFact } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(atomicClaims !== undefined ? { atomicClaims } : {}),
  };

  return canonicalizeFactKey(fact);
}

/** Normalizes raw OpenClaw messages into text-only user/assistant capture input.
 *  Processes all messages — the 400K char cap in the extraction call is the real guard.
 *  @param rawMessages - Raw message objects from OpenClaw event.
 *  @param limit - Maximum number of messages to process (default: all). */
export function normalizeCaptureMessages(rawMessages: unknown[], limit: number = rawMessages.length): CaptureMessage[] {
  const recentMessages = rawMessages.slice(-limit);
  const formatted: CaptureMessage[] = [];

  for (const msg of recentMessages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as Record<string, unknown>;
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (
          block &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as any).text === "string"
        ) {
          text += (text ? "\n" : "") + (block as any).text;
        }
      }
    }

    if (!text) {
      continue;
    }
    // Strip platform metadata before any other processing
    text = stripPlatformMetadata(text);
    if (!text) {
      continue;
    }
    if (text.includes("<relevant-memories>")) {
      text = text
        .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "")
        .trim();
      if (!text) {
        continue;
      }
    }

    formatted.push({
      role: m.role as string,
      content: text,
    });
  }

  return formatted;
}

// --- Stop words (used by session-salience tokenization) ---
// extractTopicTags, the original consumer, was deleted with the session-end
// extraction removal (Rúnir-y5on/Rúnir-sq3s) — its only prod caller was the
// /hooks/session-end topic write loop.

export const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "it", "its", "not", "no", "so", "if", "then",
  "than", "too", "very", "just", "about", "up", "out", "how", "what",
  "which", "who", "when", "where", "why", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "only",
  "own", "same", "into", "over", "after", "before", "between",
  "through", "during", "above", "below", "session", "topic", "summary",
  "discussed", "conversation", "talked",
]);

/**
 * Pairwise cosine dedup on abstract embeddings before write arbitration.
 * When two facts have cosine > threshold (default 0.85), drops the lower-confidence one.
 */
export async function batchDedupFacts(
  facts: ExtractedFact[],
  embedText: (text: string) => Promise<number[]>,
  threshold = 0.85,
): Promise<ExtractedFact[]> {
  if (facts.length <= 1) return facts;

  // Embed each fact's l0
  const embeddings = await Promise.all(facts.map((f) => embedText(f.l0)));

  // Mark indices to remove
  const removed = new Set<number>();

  for (let i = 0; i < facts.length; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < facts.length; j++) {
      if (removed.has(j)) continue;
      const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!);
      if (sim > threshold) {
        // Keep higher confidence, remove lower
        if (facts[i]!.confidence >= facts[j]!.confidence) {
          removed.add(j);
        } else {
          removed.add(i);
          break; // i is removed, move on
        }
      }
    }
  }

  return facts.filter((_, idx) => !removed.has(idx));
}

/** Default OpenRouter extractor model = openai/gpt-5.4-mini (standardized off
 *  Gemini on 2026-05-31 — cheaper + better-calibrated than gemini-3.5-flash per
 *  a direct A/B). Override via RUNIR_EXTRACTOR_MODEL; benchmarks compare e.g.
 *  openai/gpt-5.5 (seed-supported, ~higher cost) or anthropic/claude-sonnet-4.6
 *  (no seed support, requires RUNIR_EXTRACTOR_SEED=""). */
const DEFAULT_EXTRACTOR_MODEL = "openai/gpt-5.4-mini";

function resolveExtractorModel(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.RUNIR_EXTRACTOR_MODEL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return DEFAULT_EXTRACTOR_MODEL;
}

/** Resolve seed for the extractor. Returns undefined when seed should be
 *  omitted from the request body (e.g. Anthropic Claude API does not support
 *  the `seed` parameter — set RUNIR_EXTRACTOR_SEED="" to drop it). */
function resolveExtractorSeed(): number | undefined {
  const raw = process.env.RUNIR_EXTRACTOR_SEED;
  if (raw === "") return undefined;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 42;
  }
  return 42;
}

/** Output-token ceiling for the extractor / segmenter LLM calls. The old fixed
 *  4096 truncated large-batch responses mid-JSON — "Unterminated string at
 *  position ~15900" is ≈ 4096 tokens, i.e. finish_reason "length", which makes
 *  the whole batch get discarded. Default doubled to 8192; tune via
 *  RUNIR_EXTRACT_MAX_TOKENS for larger flushes (e.g. pre-compact). The
 *  complementary robustness lever is bounding batch INPUT so output stays under
 *  the ceiling — tracked separately. */
function resolveExtractMaxTokens(): number {
  const raw = process.env.RUNIR_EXTRACT_MAX_TOKENS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 8192;
}

/** Whether the extractor request should carry `response_format: json_object`.
 *  Gated to openai/* because (a) OpenAI honours json_object (verified live
 *  2026-06-01), giving an unfenced, parseable reply that eliminates the fence/
 *  prose break that collapses a batch to [], and (b) it is single-provider on
 *  OpenRouter, so there is no risk of routing to a provider that silently
 *  ignores response_format. Anthropic/Gemini overrides are gated OFF by default
 *  (their OpenRouter json_object support is inconsistent) and keep the
 *  prompt-only + fence-stripping fallback. Override with
 *  RUNIR_EXTRACTOR_JSON_MODE="1" (force on; operator owns provider capability)
 *  or "0" (force off, e.g. emergency rollback). NOTE: we intentionally never
 *  send provider.require_parameters — gpt-5.x reasoning models exclude
 *  temperature/seed from supported_parameters, so it 404s "no endpoints". */
export function extractorJsonMode(model: string): boolean {
  const force = process.env.RUNIR_EXTRACTOR_JSON_MODE;
  if (force === "0") return false;
  if (force === "1") return true;
  // Auto heuristic (not a true capability probe): OpenAI chat models honour
  // response_format json_object. Exclude the gpt-oss / :free variants, which
  // OpenRouter reports WITHOUT response_format support — sending it there 404s
  // the whole batch. A mis-gated model still degrades safely (counted
  // http_not_ok drop, never a crash) and is overridable via the env knob.
  if (!model.startsWith("openai/")) return false;
  if (model.includes("gpt-oss") || model.endsWith(":free")) return false;
  return true;
}

/** A counter label value is safe iff it is non-empty and free of whitespace/`=`
 *  (recordCounter renders `key=value` space-separated and does not sanitize). */
const COUNTER_LABEL_SAFE = /^[^\s=]+$/;

/** Record a dropped extraction batch on the structured-stderr counter seam so
 *  silent capture loss (malformed/truncated LLM JSON) is observable in prod
 *  (PM2 stderr → scraper). The whole body is wrapped: observability must NEVER
 *  break the never-throws/return-[] extraction contract (Rúnir-sm9k.3) — e.g. a
 *  stderr EPIPE from the default emitter must not turn a drop into a rejection.
 *  `model` and every `extra` value are sanitized (whitespace/`=` corrupt the
 *  line grammar); an unsafe model falls back to "unknown". finish_reason
 *  surfaces max_tokens truncation ("length") as a distinct, actionable cause. */
function recordExtractDrop(reason: string, model: string, extra?: Record<string, string>): void {
  // imaf.9: unified counter — metric=capture_batch_dropped stage=extract scope=batch
  recordPipelineDrop("extract", "batch", reason, model, extra);
}

/** Record a dropped session-segmentation batch on the structured-stderr counter
 *  seam. Mirrors recordExtractDrop: segmentAndSummarize previously surfaced its
 *  drops only through an OPTIONAL `logger?.()` callback (prod-invisible when no
 *  logger is passed), so a malformed/fenced topics reply silently yielded no
 *  session summary. Fully guarded — observability must not break the
 *  always-returns-{topics:[]} contract. */
function recordSegmentDrop(reason: string, model: string): void {
  // imaf.9: unified counter — metric=capture_batch_dropped stage=segment scope=batch
  recordPipelineDrop("segment", "batch", reason, model);
}

/** Emit a counter on EVERY max_tokens ceiling-hit (finish_reason="length"),
 *  whether or not the truncated JSON then survived jsonrepair. The drop counters
 *  above only tag finish_reason when truncation ALSO breaks parsing, so a
 *  ceiling-hit that jsonrepair salvages (or that lands on a fact boundary) is
 *  invisible — which is exactly why "is RUNIR_EXTRACT_MAX_TOKENS=8192 high
 *  enough?" cannot be answered from current production data. This metric makes
 *  the truncation RATE observable and carries completion_tokens so the ceiling
 *  can be sized above the real p99 of response sizes (extraction-robustness
 *  mission). Fully guarded — like every counter here, observability must never
 *  break the never-throws extraction contract. */
function recordCeilingHit(stage: "extract" | "segment", data: unknown, model: string): void {
  // Fully wrapped: recordCounter() is NOT internally guarded (its default
  // emitter does process.stderr.write, which can EPIPE), and this helper is
  // called OUTSIDE the parse try/catch in both extraction sites — an escape
  // would violate the never-throws/return-[] contract (Rúnir-sm9k.3). Mirror
  // recordPipelineDrop's swallow-everything posture.
  try {
    const finish = (data as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]?.finish_reason;
    if (finish !== "length") return;
    const completion = (data as { usage?: { completion_tokens?: unknown } })?.usage?.completion_tokens;
    recordCounter("extract_response_truncated", 1, {
      labels: {
        stage,
        model: COUNTER_LABEL_SAFE.test(model) ? model : "unknown",
        max_tokens: String(resolveExtractMaxTokens()),
        ...(typeof completion === "number" ? { completion_tokens: String(completion) } : {}),
      },
    });
  } catch {
    // Observability must never break extraction.
  }
}

// G003: fence-wrapping enrichment for code-bearing captures.
//
// Some conversation turns paste code-bearing content (stack traces, ANSI
// terminal output, partial code with only an opening fence) without
// surrounding markdown fences. Downstream consumers and scorers that read
// `content` expect those structures to be fenced. The helpers below
// deterministically wrap such spans when RUNIR_VERBATIM_CODE_SHADOW=1.
//
// Idempotency: each helper no-ops when the relevant structure is already
// fenced. The dispatcher only adds new fences when the input has zero
// fences (so balanced inputs pass through unchanged) and closes the fence
// when the input has an odd fence count.

// Line-level matchers (used both for whole-text presence checks via .test(text)
// and for per-line checks in the wrapper helpers). Trace frames cover:
//   - JS/TS: `    at funcName (...)`
//   - Python: `  File "module.py", line N, in func`
// Headers cover plain `Error: msg`, typed-Error variants (e.g. TypeError, ReferenceError),
// and Python's `Traceback (most recent call last):`.
const STACK_TRACE_FRAME_LINE = /^\s+at\s+\w|^\s*File\s+"/;
const STACK_TRACE_HEADER_LINE = /^(?:[A-Z][a-zA-Z]*)?Error\b|^Traceback\b/;
// Multiline-flagged variants for the dispatcher presence check.
const STACK_TRACE_FRAME_ANY = /^\s+at\s+\w|^\s*File\s+"/m;
const STACK_TRACE_HEADER_ANY = /^(?:[A-Z][a-zA-Z]*)?Error\b|^Traceback\b/m;
const ANSI_ESCAPE = /\x1b\[/;

function wrapStackTraceInFences(text: string): string {
  const lines = text.split("\n");
  const isFrameOrHeader = (s: string) =>
    STACK_TRACE_FRAME_LINE.test(s) || STACK_TRACE_HEADER_LINE.test(s);
  // Indented continuation: source-context lines that Python tracebacks insert
  // beneath each `File "..."` frame (e.g. `    raise ValueError("bad")`).
  // Only counts when we're already inside a trace span — we never *start* a
  // trace on a bare indented line.
  const isIndentedContinuation = (s: string) => /^\s+\S/.test(s);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFrameOrHeader(line)) {
      if (start === -1) start = i;
      end = i;
    } else if (start !== -1 && isIndentedContinuation(line)) {
      // Indented source-context line inside a trace — include it.
      end = i;
    } else if (start !== -1 && line.trim() === "") {
      // blank line — allowed if the next line is more trace content.
      const next = lines[i + 1];
      if (next === undefined) break;
      if (!isFrameOrHeader(next) && !isIndentedContinuation(next)) break;
    } else if (start !== -1) {
      break;
    }
  }
  if (start === -1) return text;
  // Walk back one line if the immediately preceding line is an error header
  // (e.g. "TypeError: Cannot read...") and start is a frame.
  if (start > 0 && STACK_TRACE_HEADER_LINE.test(lines[start - 1])) {
    start -= 1;
  }
  const before = lines.slice(0, start);
  const trace = lines.slice(start, end + 1);
  const after = lines.slice(end + 1);
  return [...before, "```", ...trace, "```", ...after].join("\n");
}

function wrapAnsiBlockInFences(text: string): string {
  const lines = text.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ANSI_ESCAPE.test(lines[i])) {
      if (start === -1) start = i;
      end = i;
    }
  }
  if (start === -1) return text;
  const before = lines.slice(0, start);
  const block = lines.slice(start, end + 1);
  const after = lines.slice(end + 1);
  return [...before, "```ansi", ...block, "```", ...after].join("\n");
}

/** Apply fence-wrapping to `text`. On by default; set RUNIR_VERBATIM_CODE_SHADOW=0
 *  to opt out (emergency rollback if regression is observed in real use).
 *  - Balanced fences → return unchanged (idempotent).
 *  - Odd fence count → append a closing fence.
 *  - Zero fences → wrap stack-trace span if present; otherwise wrap ANSI span.
 *  Stack-trace wins over ANSI when both are present (per Codex caution #1). */
export function buildFenceWrappedCodeExcerpt(text: string): string {
  if (process.env.RUNIR_VERBATIM_CODE_SHADOW === "0") return text;
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount > 0 && fenceCount % 2 === 0) return text;
  if (fenceCount % 2 === 1) return `${text}\n\`\`\``;
  if (STACK_TRACE_FRAME_ANY.test(text) || STACK_TRACE_HEADER_ANY.test(text)) {
    return wrapStackTraceInFences(text);
  }
  if (ANSI_ESCAPE.test(text)) {
    return wrapAnsiBlockInFences(text);
  }
  return text;
}

/** Extracts memory facts from normalized messages through OpenRouter. */
export async function extractMemories(
  messages: CaptureMessage[],
  customPrompt: string,
  apiKey: string,
  sessionTimestamp?: string,
  onReject?: (raw: RawExtractedFact, reason: string) => void,
  opts?: { timeoutMs?: number; model?: string; onTiming?: (name: string, durationMs: number) => void },
): Promise<ExtractedFact[]> {
  let lastTimingMarkAt = Date.now();
  const markTiming = (name: string): void => {
    const now = Date.now();
    opts?.onTiming?.(name, now - lastTimingMarkAt);
    lastTimingMarkAt = now;
  };
  const ts = sessionTimestamp ?? new Date().toISOString();
  // replaceAll, not replace: the prompt references {SESSION_TIMESTAMP} in
  // several places (the rule block AND the few-shots). String.replace would
  // substitute only the FIRST, leaving later placeholders literal — which the
  // model then copies verbatim into stored memory (Rúnir temporal hardening).
  const promptWithTimestamp = customPrompt.replaceAll("{SESSION_TIMESTAMP}", ts);

  const conversation = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  // Resolve once: reused by the request body AND every drop-counter label below.
  const model = resolveExtractorModel(opts?.model);

  // AbortController with configurable timeout
  const effectiveTimeout = opts?.timeoutMs ?? resolveLlmTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

  const requestBody = (() => {
    const seed = resolveExtractorSeed();
    const jsonMode = extractorJsonMode(model);
    return JSON.stringify({
      model,
      messages: [
        { role: "system", content: promptWithTimestamp },
        {
          role: "user",
          content: `Extract facts from this conversation and return a valid json object:\n\n${conversation}`,
        },
      ],
      max_tokens: resolveExtractMaxTokens(),
      temperature: 0,
      // Gemini and OpenAI honour the seed param via OpenRouter; combined
      // with temperature=0 this cuts run-to-run extraction variance.
      // Anthropic Claude API does NOT support seed — set
      // RUNIR_EXTRACTOR_SEED="" to omit it for those models.
      ...(seed !== undefined ? { seed } : {}),
      // JSON mode (gated to openai/* — single-provider OpenAI, which honours
      // response_format): json_object forces a valid, unfenced JSON object —
      // the prompt already asks for {"facts":[...]} — eliminating the fenced/
      // prose-wrapped reply that collapses a batch to []. We deliberately do
      // NOT send provider.require_parameters: gpt-5.x are reasoning models
      // whose OpenRouter supported_parameters exclude temperature/seed (which
      // we send and the provider ignores), so require_parameters returns a
      // hard 404 "no endpoints" (verified live 2026-06-01). Gating to a
      // single-provider family makes that guard unnecessary anyway. See
      // extractorJsonMode().
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
  })();
  markTiming("prepare_request");

  let response: Response;
  try {
    response = await fetch(`${resolveLlmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: requestBody,
      signal: controller.signal,
    });
    markTiming("llm_fetch_headers");
  } catch (err: unknown) {
    markTiming("llm_fetch_headers");
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`memory-hybrid: extractMemories fetch aborted (${effectiveTimeout}ms timeout)`);
      recordExtractDrop("timeout", model);
    } else {
      console.warn(`memory-hybrid: extractMemories fetch error: ${String(err)}`);
      recordExtractDrop("fetch_error", model);
    }
    return [];
  }

  if (!response.ok) {
    clearTimeout(timeout);
    if (process.env.RUNIR_EXTRACT_DEBUG === "1") {
      process.stderr.write(
        `[extract-debug] non-OK response status=${response.status} ${response.statusText}\n`,
      );
    }
    recordExtractDrop("http_not_ok", model, {
      status: typeof response.status === "number" ? String(response.status) : "",
    });
    return [];
  }
  // Wrap response.json(): a provider that returns a non-JSON HTTP body (HTML
  // error page, truncated stream) would otherwise throw out of extractMemories,
  // violating the never-throws/return-[] contract (Rúnir-sm9k.3). The abort timer
  // stays live THROUGH the body read — a provider can send 200 headers then stall
  // the body, and Node rejects response.json() with AbortError on abort, so
  // clearing the timer before this read would leave it unbounded (Rúnir-imaf.10).
  let data: any;
  try {
    data = await response.json();
    markTiming("llm_read_json");
  } catch (err) {
    markTiming("llm_read_json");
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`memory-hybrid: extractMemories body read aborted (${effectiveTimeout}ms timeout)`);
      recordExtractDrop("timeout", model);
    } else {
      console.warn(
        `memory-hybrid: extractMemories response.json() failed, discarding batch: ${err instanceof Error ? err.message : String(err)}`,
      );
      recordExtractDrop("http_json_error", model);
    }
    return [];
  }
  clearTimeout(timeout);
  // Coerce content to a string at the source: a malformed provider response
  // could put a non-string in `content`, and the downstream .slice/.match/
  // .length calls (including the parse-failure log below) must never throw out
  // of extractMemories — it "always returns []" (Rúnir-sm9k.3).
  // data?. (not data.): response.json() can RESOLVE to literal `null` (a valid
  // JSON body), and `null.choices` would throw out of extractMemories,
  // violating the never-throws contract (Rúnir-sm9k.3). A null body then flows
  // to text="" → JSON.parse("") → a counted parse_error drop.
  const rawContent = data?.choices?.[0]?.message?.content;
  const text: string = typeof rawContent === "string" ? rawContent : "";
  // finish_reason="length" means the model hit max_tokens mid-JSON — a distinct,
  // actionable cause of a parse failure (vs a provider ignoring response_format).
  const rawFinish = data?.choices?.[0]?.finish_reason;
  const finishReason: string | undefined = typeof rawFinish === "string" ? rawFinish : undefined;
  recordCeilingHit("extract", data, model);
  if (process.env.RUNIR_EXTRACT_DEBUG === "1") {
    process.stderr.write(
      `[extract-debug] model_response (${text.length} chars): ${text.slice(0, 500).replace(/\n/g, "\\n")}\n`,
    );
  }
  // Isolate JSON parsing so a malformed LLM response is logged (not silently
  // swallowed) and cleanly yields no facts (Rúnir-sm9k.3).
  let parsed: { facts?: Array<RawExtractedFact | string> } | null;
  try {
    let jsonText = text;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    // First attempt: parse as-is.
    try {
      parsed = JSON.parse(jsonText) as { facts?: Array<RawExtractedFact | string> } | null;
    } catch {
      // Retry once via jsonrepair (covers control chars, trailing commas,
      // single quotes, unquoted keys, truncation — strictly more than the
      // old hand-rolled walker). jsonrepair throws JSONRepairError on
      // unrepairable input; that propagates to the outer catch → discard.
      parsed = JSON.parse(jsonrepair(jsonText)) as { facts?: Array<RawExtractedFact | string> } | null;
      recordCounter("extract_batch_repaired", 1, { labels: { reason: "json_repaired", model: COUNTER_LABEL_SAFE.test(model) ? model : "unknown" } });
    }
    markTiming("parse_model_json");
  } catch (err) {
    markTiming("parse_model_json");
    console.warn(
      `memory-hybrid: extractMemories JSON.parse failed, discarding batch: ${err instanceof Error ? err.message : String(err)} (response head: ${text.slice(0, 120).replace(/\n/g, "\\n")})`,
    );
    recordExtractDrop("parse_error", model, finishReason ? { finish_reason: finishReason } : undefined);
    return [];
  }
  // Guard top-level null too: JSON.parse("null") yields null, and reading
  // `.facts` off it would throw out of extractMemories (Rúnir-sm9k.3).
  if (!parsed || !Array.isArray(parsed.facts)) {
    // Valid JSON, wrong root shape (e.g. a bare array, an object without
    // `facts`, or null). Previously this drop was debug-gated = silent in prod;
    // surface it on the counter seam + an always-on warn so the batch loss is
    // observable (Rúnir-sm9k.3, iter-3 hardening).
    console.warn(
      `memory-hybrid: extractMemories parsed JSON but root.facts is not an array, discarding batch (head: ${JSON.stringify(parsed).slice(0, 120)})`,
    );
    recordExtractDrop("bad_root_shape", model, finishReason ? { finish_reason: finishReason } : undefined);
    return [];
  }
  if (process.env.RUNIR_EXTRACT_DEBUG === "1") {
    process.stderr.write(
      `[extract-debug] parsed facts.length=${parsed.facts.length}\n`,
    );
  }

  // `passed` is hoisted out of the processing block so the stage guard below
  // can return any facts already normalized when a later stage throws, instead
  // of losing the whole batch to a silent catch (Rúnir-sm9k.3).
  const passed: ExtractedFact[] = [];
  try {
    // Per-fact isolation at the rawFacts boundary: a null/primitive element
    // (null, a bare number/boolean) throws in the stamping loop below
    // (`raw.raw_source_text = undefined` is a strict-mode "create property on
    // primitive" TypeError), which bubbles to the stage guard and collapses the
    // WHOLE batch — every good sibling lost (the {"facts":[null]} case). The
    // stamping loop runs BEFORE the per-fact normalize guard (Rúnir-sm9k.3), so
    // that guard can't save it. Drop ONLY null/primitives here. Object/array
    // elements (incl. an object with a non-string `l2`) survive stamping and ARE
    // handled per-fact by the existing normalize guard, so we let them through
    // rather than duplicate/override it. Do NOT onReject the dropped value — the
    // route onReject callback derefs raw.l2/raw.confidence and would just
    // relocate the crash. iter-2 (extraction-robustness mission).
    const rawFacts: RawExtractedFact[] = [];
    let malformedFactElementCount = 0;
    for (const fact of parsed.facts) {
      if (typeof fact === "string") {
        rawFacts.push({ l2: fact, confidence: 1.0 });
        continue;
      }
      if (fact === null || typeof fact !== "object") {
        malformedFactElementCount++;
        continue;
      }
      rawFacts.push(fact as RawExtractedFact);
    }
    if (malformedFactElementCount > 0) {
      recordExtractDrop("malformed_fact_element", model, {
        dropped: String(malformedFactElementCount),
      });
    }

    // Post-process: stamp raw_source_text from source_turn_index dereference.
    //
    // When the LLM emits a valid `source_turn_index`, dereference it to the
    // matching message content. When it doesn't, LEAVE raw_source_text
    // undefined — the harness scorer's `resolveMatchedText` already falls
    // through to bundle-turn-text-via-source_turn for downstream scoring, so
    // an empty `raw_source_text` is recoverable. The fuzzy-LCS fallback that
    // previously ran here matched against the LLM-paraphrased `l2`, which on
    // code-bearing turns consistently picked the assistant's analysis turn
    // over the user's raw input — the Rúnir-o2kz bug. See
    // `src/__tests__/extract-raw-source-text.test.ts` for the regression
    // guard and `.omc/plans/runir-o2kz-close-gap-plan.md` for the decision.
    let validIndexCount = 0;
    let missingIndexCount = 0;
    let invalidIndexCount = 0;
    for (const raw of rawFacts) {
      // CRITICAL: drop any LLM-emitted raw_source_text. The LLM is not
      // authoritative for this field — only deterministic
      // source_turn_index dereference is. Gemini 3 Flash has been observed
      // emitting raw_source_text containing the assistant's analysis turn
      // instead of the user's source turn (Rúnir-o2kz). The post-LLM stamp
      // below is the single source of truth.
      // Always drop any LLM-emitted raw_source_text — only deterministic
      // stamping is authoritative. See Rúnir-o2kz.
      raw.raw_source_text = undefined;

      const idx = raw.source_turn_index;
      const llmPickedTurn =
        typeof idx === "number" && idx >= 0 && idx < messages.length
          ? messages[idx]!
          : undefined;

      // Code-content override: when the fact's paraphrase clearly references
      // code-bearing content (file paths, diff markers, stack-trace lines)
      // and the LLM's chosen turn does NOT contain a code fence or diff
      // marker, prefer the message that DOES. Gemini 3 Flash has been
      // observed pointing source_turn_index at the assistant's analysis turn
      // for diff-hunk seeds — the assistant turn is *narratively* primary but
      // not the verbatim source. The scorer needs the verbatim source for
      // fence/identifier preservation (Rúnir-o2kz seed-07).
      const codeMarker = /```|^---\s|^\+\+\+\s|^@@\s|^\s+at\s+\w+/m;
      // The paraphrase references a *real* code marker (fence, diff file/hunk
      // header, stack-trace frame) — reuse codeMarker so this stays in lockstep
      // with what counts as code, and does NOT fire on incidental prose
      // backticks or method-call-looking text (Rúnir-sm9k.2).
      const factMentionsCode = codeMarker.test(raw.l2);

      let chosen: { idx: number; msg: { content: string } } | undefined;
      if (llmPickedTurn && codeMarker.test(llmPickedTurn.content)) {
        chosen = { idx: idx as number, msg: llmPickedTurn };
      } else if (factMentionsCode && llmPickedTurn) {
        // The LLM-indexed turn is not itself code-bearing. Recover the verbatim
        // source by scanning ONLY the indexed turn's immediate neighbors
        // (itself, the prior turn, then the next turn) — NOT a global
        // newest-first sweep. A global sweep stamps the *latest* code-bearing
        // turn, so an unrelated later fenced turn (e.g. the assistant pasting a
        // different snippet) would overwrite the correct source_turn_index turn
        // — the relocated Rúnir-o2kz failure (Rúnir-sm9k.2). idx-1 covers the
        // usual "user pastes code, LLM points at the assistant analysis" order;
        // idx+1 covers "user question, assistant code block".
        for (const cand of [idx as number, (idx as number) - 1, (idx as number) + 1]) {
          if (cand >= 0 && cand < messages.length && codeMarker.test(messages[cand]!.content)) {
            chosen = { idx: cand, msg: messages[cand]! };
            break;
          }
        }
      }
      // Fall back to the indexed turn only for NON-code facts. For a code fact
      // where no code-bearing neighbor was found, leave raw_source_text
      // undefined (matching the missing-index policy) rather than stamping the
      // known-non-code indexed turn: a non-empty wrong stamp would short-circuit
      // the scorer's source_turn recovery and silently lose the verbatim source
      // when the real source is >1 turn away (Rúnir-sm9k.2 review).
      if (!chosen && llmPickedTurn && !factMentionsCode) {
        chosen = { idx: idx as number, msg: llmPickedTurn };
      }

      if (chosen) {
        raw.raw_source_text = chosen.msg.content;
        raw.source_turn_index = chosen.idx;
        validIndexCount++;
      } else if (typeof idx === "number") {
        invalidIndexCount++;
      } else {
        missingIndexCount++;
      }
    }

    // Deterministic temporal grounding: resolve relative phrases ("yesterday",
    // "last year", "N days ago", …) to absolute dates anchored on the session
    // timestamp, and strip any leaked {SESSION_TIMESTAMP} placeholder. Additive
    // (verbatim wording preserved) so when/date questions become retrievable and
    // answerable instead of echoing the phrase. Guarded on string l2 so a
    // malformed (non-string) fact still falls through to the normalize-loop skip
    // path (Rúnir-sm9k.3). See temporal-resolver.ts.
    for (const raw of rawFacts) {
      if (typeof raw.l2 === "string") raw.l2 = resolveRelativeTemporalPhrases(raw.l2, ts).text;
      if (typeof raw.l0 === "string") raw.l0 = resolveRelativeTemporalPhrases(raw.l0, ts).text;
      if (typeof raw.l1 === "string") raw.l1 = resolveRelativeTemporalPhrases(raw.l1, ts).text;
    }
    // Post-stamp enrichment: when a fact's raw_source_text carries a code
    // marker (fence, diff hunk, stack trace) but the LLM-paraphrased l2 does
    // not, append the verbatim source as a quoted block. This is server-side
    // deterministic enrichment — independent of LLM cooperation. It lets
    // downstream consumers and scorers that read `content` (not just
    // raw_source_text) see fences/identifiers. The architectural insight:
    // verbatim-first memory systems (MemPalace, Hindsight, OMEGA) score
    // 90-100% on LoCoMo/LongMemEval, vs paraphrase-first systems plateauing
    // at 65-75%. We're not flipping the architecture — we're letting both
    // shapes co-exist in `content` so the consumer doesn't have to choose.
    // G003: extended to gate Python tracebacks too — `Traceback` line and
    // indented `  File "..."` frames were previously missed, so unfenced
    // Python tracebacks bypassed the enrichment loop entirely.
    const CODE_MARKER = /```|^---\s|^\+\+\+\s|^@@\s|^\s+at\s+\w+|^\s*File\s+"|^Traceback\b|\x1b\[/m;
    for (const raw of rawFacts) {
      const rst = raw.raw_source_text;
      if (!rst || rst.length === 0) continue;
      if (CODE_MARKER.test(rst) && !CODE_MARKER.test(raw.l2)) {
        // Trim raw_source_text to a tight excerpt around the code marker (max
        // 800 chars) so we don't bloat memory units with full transcripts.
        const rawExcerpt = rst.length > 800 ? rst.slice(0, 800) + "…" : rst;
        // G003: when RUNIR_VERBATIM_CODE_SHADOW=1, wrap unfenced stack
        // traces / ANSI blocks / partial code in markdown fences before
        // appending to content. No-op when env is unset.
        const excerpt = buildFenceWrappedCodeExcerpt(rawExcerpt);
        raw.l2 = `${raw.l2}\n\nSource:\n${excerpt}`;
      }
    }

    for (const raw of rawFacts) {
      const beforeClaims = Array.isArray(raw.atomicClaims) ? raw.atomicClaims.length : 0;
      repairListShapedFact(raw);
      const afterClaims = Array.isArray(raw.atomicClaims) ? raw.atomicClaims.length : 0;
      if (beforeClaims === 0 && afterClaims > 0) {
        onReject?.(raw, "list-flattening-fail-soft-to-atomic-claims");
      }
    }

    if (process.env.RUNIR_EXTRACT_DEBUG === "1") {
      process.stderr.write(
        `[extract-debug] source_turn_index: valid=${validIndexCount} ` +
        `missing=${missingIndexCount} invalid=${invalidIndexCount} ` +
        `(rawFacts.length=${rawFacts.length})\n`,
      );
    }

    for (const raw of rawFacts) {
      const min = Math.max(CONFIDENCE_THRESHOLD, perCategoryThreshold(raw.category));
      if (raw.confidence < min) {
        console.warn(`memory-hybrid: discarded low-confidence fact (${raw.confidence} < ${min}, category=${raw.category}): ${raw.l2.slice(0, 80)}`);
        onReject?.(raw, "low-confidence");
        continue;
      }
      // Per-fact guard: one malformed fact (e.g. a non-string l2) is logged and
      // skipped, not allowed to discard the whole batch (Rúnir-sm9k.3).
      try {
        passed.push(normalizeExtractedFact(raw));
      } catch (err) {
        console.warn(
          `memory-hybrid: skipped malformed fact during normalization (category=${raw.category}): ${err instanceof Error ? err.message : String(err)}`,
        );
        onReject?.(raw, "normalize-throw");
      }
    }
    markTiming("normalize_facts");
    return passed;
  } catch (err) {
    // Net for an unexpected throw in the post-parse stages: log instead of
    // silently discarding the batch (Rúnir-sm9k.3). Returns whatever was
    // normalized before the throw — empty if it happened in a pre-normalize
    // stage (stamping/enrichment/list-repair, which run before `passed` is
    // filled), partial if in the confidence/normalize loop.
    console.warn(
      `memory-hybrid: extractMemories post-parse processing failed after ${passed.length} facts: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Count the degradation: a throw here (e.g. a non-object fact element like
    // {"facts":[null]} that blows up stamping before `passed` is filled) is an
    // otherwise-silent partial/total batch loss. `recovered` distinguishes
    // partial from total without per-fact cardinality.
    recordExtractDrop("post_parse_error", model, {
      recovered: passed.length > 0 ? "partial" : "none",
    });
    markTiming("normalize_facts");
    return passed;
  }
}

/** Resolves the effective capture prompt, defaulting to built-in extraction prompt. */
export function resolveCapturePrompt(
  customPrompt?: string,
  options: { mode?: "capture" | "session-end" } = {},
): string {
  const basePrompt = customPrompt || DEFAULT_CAPTURE_PROMPT;
  if (options.mode === "session-end") {
    return `${basePrompt}\n\n${RESET_CAPTURE_PROMPT_ADDENDUM}`;
  }
  return basePrompt;
}

/** Makes a single LLM call to segment a session transcript into topics with summaries.
 *  Used by the before_reset hook to produce structured session summaries.
 *  @param logger - Optional callback for warning-level log messages. */
export async function segmentAndSummarize(
  messages: CaptureMessage[],
  apiKey: string,
  logger?: (msg: string) => void,
  opts?: { timeoutMs?: number },
): Promise<TopicSegmentationResult> {
  let transcript = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  // Fix 4: Cap transcript size — truncate from front to keep recent messages.
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    logger?.(`memory-hybrid: transcript truncated from ${transcript.length} to ${MAX_TRANSCRIPT_CHARS} chars (front-trimmed)`);
    transcript = "[Transcript truncated — showing last 400K chars]\n\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  // Resolve once: reused by the request body AND every drop-counter label.
  const model = resolveExtractorModel();

  // Fix 6: AbortController with a configurable timeout on fetch (default 30s).
  const effectiveTimeout = opts?.timeoutMs ?? resolveLlmTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

  let response: Response;
  try {
    response = await fetch(`${resolveLlmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: (() => {
        const seed = resolveExtractorSeed();
        return JSON.stringify({
          model,
          messages: [
            { role: "system", content: SEGMENTATION_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Segment this conversation into topics, summarize each, and return a valid json object:\n\n${transcript}`,
            },
          ],
          max_tokens: resolveExtractMaxTokens(),
          temperature: 0,
          ...(seed !== undefined ? { seed } : {}),
          // JSON mode (gated to openai/*, no require_parameters) — same recipe as
          // extractMemories: the prompt already mandates {"topics":[...]}, and
          // json_object forces an unfenced parseable object so a fenced/prose
          // reply can't silently yield no session summary. See extractorJsonMode().
          ...(extractorJsonMode(model) ? { response_format: { type: "json_object" } } : {}),
        });
      })(),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      logger?.(`memory-hybrid: segmentAndSummarize fetch aborted (${effectiveTimeout}ms timeout)`);
      recordSegmentDrop("timeout", model);
    } else {
      logger?.(`memory-hybrid: segmentAndSummarize fetch error: ${String(err)}`);
      recordSegmentDrop("fetch_error", model);
    }
    return { topics: [] };
  }

  if (!response.ok) {
    clearTimeout(timeout);
    logger?.(`memory-hybrid: segmentAndSummarize HTTP ${response.status} ${response.statusText}`);
    recordSegmentDrop("http_not_ok", model);
    return { topics: [] };
  }

  // Guard response.text(): a rejecting body read (stream error, truncated
  // response) would otherwise throw out of segmentAndSummarize, breaking the
  // always-returns-{topics:[]} contract — and /hooks/session-end passes a real
  // console.warn in, so an escape becomes a 500 that aborts session-end before
  // fact extraction. The abort timer stays live THROUGH this body read — a
  // provider can send 200 headers then stall the body, and clearing the timer
  // before response.text() would leave it unbounded (Rúnir-imaf.10).
  let rawText: string;
  try {
    rawText = await response.text();
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      logger?.(`memory-hybrid: segmentAndSummarize body read aborted (${effectiveTimeout}ms timeout)`);
      recordSegmentDrop("timeout", model);
    } else {
      logger?.(`memory-hybrid: segmentAndSummarize response.text() failed: ${err instanceof Error ? err.message : String(err)}`);
      recordSegmentDrop("http_read_error", model);
    }
    return { topics: [] };
  }
  clearTimeout(timeout);
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    logger?.(`memory-hybrid: segmentAndSummarize JSON parse failure: ${rawText.slice(0, 200)}`);
    recordSegmentDrop("http_json_error", model);
    return { topics: [] };
  }

  if (!data?.choices || data.choices.length === 0) {
    logger?.("memory-hybrid: segmentAndSummarize response missing choices");
    recordSegmentDrop("missing_choices", model);
    return { topics: [] };
  }
  recordCeilingHit("segment", data, model);
  // Coerce content to a string at the source: a non-string content (object,
  // number) would make text.match/text.slice throw out of the function — and the
  // content-parse catch's own text.slice would throw too. Mirrors extractMemories.
  const rawContent = data.choices[0]?.message?.content;
  const text: string = typeof rawContent === "string" ? rawContent : "";

  try {
    let jsonText = text;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    // First attempt: parse as-is; retry once via jsonrepair on failure.
    let parsed: TopicSegmentationResult;
    try {
      parsed = JSON.parse(jsonText) as TopicSegmentationResult;
    } catch {
      // jsonrepair covers control chars, trailing commas, single quotes,
      // unquoted keys, truncation. Throws JSONRepairError when unrepairable
      // → propagates to outer catch → content_parse_error drop.
      parsed = JSON.parse(jsonrepair(jsonText)) as TopicSegmentationResult;
      recordCounter("segment_batch_repaired", 1, { labels: { reason: "json_repaired", model: COUNTER_LABEL_SAFE.test(model) ? model : "unknown" } });
    }
    if (!Array.isArray(parsed?.topics)) {
      recordSegmentDrop("bad_topics_shape", model);
      return { topics: [] };
    }
    // Validate each element against the TopicSegmentationResult contract — the
    // session-end caller does topic.summary.trim(), so a topic missing a string
    // title/summary would crash it. Filter malformed elements (recover the valid
    // siblings, iter-2-consistent) and count once if any were dropped.
    const validTopics = parsed.topics.filter(
      (t): t is { title: string; summary: string } =>
        !!t &&
        typeof t === "object" &&
        typeof (t as { title?: unknown }).title === "string" &&
        typeof (t as { summary?: unknown }).summary === "string",
    );
    if (validTopics.length !== parsed.topics.length) {
      recordSegmentDrop("bad_topics_shape", model);
    }
    return { topics: validTopics };
  } catch {
    logger?.(`memory-hybrid: segmentAndSummarize content JSON parse failure: ${text.slice(0, 200)}`);
    recordSegmentDrop("content_parse_error", model);
    return { topics: [] };
  }
}
