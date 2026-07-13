/**
 * MIM-36: Adaptive retrieval — skip trivial inputs before the embedder is called.
 * Force recall for memory-intent keywords.
 */

/** Patterns that should always skip retrieval (greetings, commands, noise). */
const SKIP_PATTERNS: RegExp[] = [
  // Greetings
  /^(hi|hello|hey|howdy|yo|sup|hiya|good\s*(morning|afternoon|evening|night))[\s!.,?]*$/i,
  // Slash commands
  /^\//,
  // Shell commands (common single-word commands with optional flags)
  /^(ls|cd|pwd|cat|echo|mkdir|rm|cp|mv|grep|find|git|npm|npx|yarn|pnpm|bun|docker|kubectl)\b/i,
  // Affirmations / acknowledgments
  /^(ok|okay|sure|yes|yeah|yep|yup|no|nah|nope|thanks|thank\s*you|thx|ty|got\s*it|understood|alright|sounds?\s*good|will\s*do|perfect|noted|right|correct|exactly|agreed|fine|cool|great|nice|good|awesome)[\s!.,?]*$/i,
  // Emoji-only (Unicode emoji ranges)
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u,
  // HEARTBEAT / system pings
  /^HEARTBEAT$/i,
  // System messages
  /^\[System\]/i,
  // Pings
  /^ping[\s!.,?]*$/i,
  // Pure whitespace or punctuation
  /^[\s\p{P}]*$/u,
  // Single word acknowledgments that may have punctuation
  /^(lol|lmao|haha|heh|hmm|ah|oh|ugh|mhm|uh-huh)[\s!.,?]*$/i,
];

/** Patterns that force retrieval even if other checks would skip (memory intent). */
const FORCE_RETRIEVE_PATTERNS: RegExp[] = [
  /\b(remember|recall|forgot|forget)\b/i,
  /\b(yesterday|last\s*week|last\s*month|last\s*time|earlier\s*today|previously)\b/i,
  /\b(my\s*(name|email|api\s*key|config|settings?|preferences?|password|address))\b/i,
  /\bwhat\s+(did|do)\s+(i|we)\b/i,
  /\bwhat\s+do\s+you\s+know\s+about\b/i,
  /\bsave\s+this\b/i,
];

/** OpenClaw metadata sentinel lines to strip before classification. */
const META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
] as const;

/** Strip OpenClaw metadata headers, cron wrapper, and timestamp prefixes. */
export function normalizeQuery(query: string): string {
  let result = query;

  // Strip metadata sentinel blocks (sentinel line to next blank line)
  for (const sentinel of META_SENTINELS) {
    const idx = result.indexOf(sentinel);
    if (idx === -1) continue;
    const blankLineIdx = result.indexOf("\n\n", idx);
    if (blankLineIdx !== -1) {
      result = result.slice(0, idx) + result.slice(blankLineIdx + 2);
    } else {
      result = result.slice(0, idx);
    }
  }

  // Strip cron wrapper: "Cron job (every X): <actual query>"
  result = result.replace(/^Cron\s+job\s*\([^)]*\):\s*/i, "");

  // Strip ISO timestamp prefix: "[2026-03-28T10:00:00Z] actual query"
  result = result.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\]\s*/, "");

  return result.trim();
}

/** Returns true if the query contains CJK characters. */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
}

/**
 * Determines whether retrieval should be skipped for this input.
 *
 * Logic order:
 * 1. Force-retrieve patterns (memory intent) → always retrieve
 * 2. Length check (< minLength or < 5 default) → skip
 * 3. Skip patterns (greetings, commands, etc.) → skip
 * 4. CJK-aware minimum length (6 for CJK, 15 otherwise) → skip if under
 *
 * @param query - The raw user input
 * @param minLength - Override for minimum length (default: 5, matching < 5 check)
 * @returns true if retrieval should be skipped
 */
export function shouldSkipRetrieval(query: string, minLength?: number): boolean {
  const normalized = normalizeQuery(query);

  // 1. Force-retrieve: memory-intent keywords always trigger retrieval
  if (FORCE_RETRIEVE_PATTERNS.some(p => p.test(normalized))) {
    return false;
  }

  // 2. Length check: very short inputs (subsumes old prompt.length < 5)
  const effectiveMinLength = minLength ?? 5;
  if (normalized.length < effectiveMinLength) {
    return true;
  }

  // 3. Skip patterns: greetings, commands, emoji, system messages, etc.
  if (SKIP_PATTERNS.some(p => p.test(normalized))) {
    return true;
  }

  // 4. CJK-aware content length check
  const contentMinLength = hasCJK(normalized) ? 6 : 15;
  if (normalized.length < contentMinLength) {
    return true;
  }

  return false;
}
