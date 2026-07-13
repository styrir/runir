type ExactSpanLike = {
  text?: unknown;
};

type ExactClaimLike = {
  subject?: unknown;
  predicate?: unknown;
  value?: unknown;
  text?: unknown;
  rawSpanText?: unknown;
};

type ExactCandidateLike = {
  text?: unknown;
  l0?: unknown;
  l1?: unknown;
  raw_source_text?: unknown;
  rawSpan?: ExactSpanLike;
  rawSpans?: ExactSpanLike[];
  atomicFact?: ExactClaimLike;
  atomicClaims?: ExactClaimLike[];
};

type ComparableClaim = {
  subject: string;
  predicate: string;
  value: string;
};

const EXACT_QUERY_PATTERNS = [
  /\bexact(?:ly)?\b/i,
  /\bverbatim\b/i,
  /\bwhich\b/i,
  /\bwhen\b/i,
  /\bwhat\b/i,
  /\bwho\b/i,
  /\bhow many\b/i,
  /\blist\b/i,
  /\bversion\b/i,
  /\bport\b/i,
  /\bcommit\b/i,
  /\bdate\b/i,
  /\bvalue\b/i,
  /\banswer\b/i,
];

const EXACT_VALUE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d+(?:\.\d+){1,}\b/,
  /\b\d+\b/,
  /\b[A-Z][A-Za-z0-9_-]*-\d+\b/,
  /\b[A-Z][A-Z0-9_]{2,}\b/,
  /`[^`]+`/,
  /\/[\w./-]+/,
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|sql|yaml|yml)\b/i,
  /\b[a-f0-9]{7,40}\b/i,
  /\b[A-Z0-9_]+=[^\s]+/,
  /https?:\/\/\S+/i,
];

const LIST_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\S/m;

const EXACT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "does", "for", "from", "how", "i", "if",
  "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "should", "that", "the", "their",
  "them", "there", "these", "they", "this", "those", "to", "up", "us", "was", "we", "what", "when", "where",
  "which", "who", "why", "will", "with", "you", "your",
]);

function normalizeExactText(text: string): string {
  return text.toLowerCase().replace(/[`"']/g, "").replace(/\s+/g, " ").trim();
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function collectCandidateTexts(candidate: ExactCandidateLike): string[] {
  const texts = [
    textValue(candidate.text),
    textValue(candidate.l0),
    textValue(candidate.l1),
    textValue(candidate.raw_source_text),
    textValue(candidate.rawSpan?.text),
    ...(candidate.rawSpans ?? []).map((span) => textValue(span?.text)),
    textValue(candidate.atomicFact?.subject),
    textValue(candidate.atomicFact?.predicate),
    textValue(candidate.atomicFact?.value),
    textValue(candidate.atomicFact?.text),
    ...(candidate.atomicClaims ?? []).flatMap((claim) => [
      textValue(claim?.subject),
      textValue(claim?.predicate),
      textValue(claim?.value),
      textValue(claim?.text),
      textValue(claim?.rawSpanText),
    ]),
  ].filter((text) => text.trim().length > 0);
  return Array.from(new Set(texts));
}

export function hasExactQaValueSignal(text: string): boolean {
  return EXACT_VALUE_PATTERNS.some((pattern) => pattern.test(text)) || LIST_LINE_PATTERN.test(text);
}

/** All EXACT_VALUE_PATTERNS matches in the RAW text, lowercased for set
 *  comparison (Rúnir-dnpp). Raw, not normalizeExactText: ALL-CAPS codes
 *  (PONG, READY, PROD_API_TOKEN) are value signals only in their raw form. */
export function exactValueTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const pattern of EXACT_VALUE_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.match(global) ?? []) out.add(match.toLowerCase());
  }
  return out;
}

export function detectExactQaIntent(query: string): boolean {
  const normalized = query.trim();
  if (!normalized) return false;
  const questionLike = normalized.includes("?") || EXACT_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
  return questionLike && (hasExactQaValueSignal(normalized) || EXACT_QUERY_PATTERNS.some((pattern) => pattern.test(normalized)));
}

export function exactQaTokens(text: string): string[] {
  const normalized = normalizeExactText(text);
  const tokens = normalized.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const filtered = tokens.filter((token) => token.length > 2 && !EXACT_STOPWORDS.has(token));
  return Array.from(new Set(filtered.length > 0 ? filtered : tokens));
}

export function scoreExactQaCandidate(query: string, candidate: ExactCandidateLike): number {
  if (!detectExactQaIntent(query)) return 0;
  const queryTokens = exactQaTokens(query);
  if (queryTokens.length === 0) return 0;

  const haystacks = collectCandidateTexts(candidate).map(normalizeExactText);
  if (haystacks.length === 0) return 0;

  let matched = 0;
  for (const token of queryTokens) {
    if (haystacks.some((text) => text.includes(token))) {
      matched++;
    }
  }
  const overlap = matched / queryTokens.length;
  const hasExactSource = haystacks.some(hasExactQaValueSignal);
  const rawSpanBonus = haystacks.some((text) => text.length > 0 && text === normalizeExactText(textValue(candidate.rawSpan?.text))) ? 0.1 : 0;
  return Math.min(1, overlap + (hasExactSource ? 0.25 : 0) + rawSpanBonus);
}

function parseClaim(text: string): ComparableClaim | null {
  const normalized = normalizeExactText(text);
  const delimiters = [
    " switched to ",
    " changed to ",
    " updated to ",
    " replaced ",
    " uses ",
    " use ",
    " is ",
    " are ",
    " was ",
    " were ",
    " = ",
    ":",
  ];

  for (const delimiter of delimiters) {
    const index = normalized.indexOf(delimiter);
    if (index < 4) continue;
    const subject = normalized.slice(0, index).trim();
    const value = normalized.slice(index + delimiter.length).trim();
    if (subject.length > 0 && value.length > 0) {
      return { subject, predicate: delimiter.trim(), value };
    }
  }

  return null;
}

function listItems(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function sentenceCount(text: string): number {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0).length;
}

/** Exported for the read-side contradiction collapse (Rúnir-yfve): a
 *  multi-fact compound row is never a safe elimination target, and callers
 *  need this gate to fail CLOSED instead of collapsing what they can't compare. */
export function isCompactComparableClaim(text: string): boolean {
  return sentenceCount(text) <= 2 && exactQaTokens(text).length <= 30;
}

function sameSubject(a: string, b: string): boolean {
  if (a === b) return true;
  const aTokens = new Set(exactQaTokens(a));
  const bTokens = new Set(exactQaTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared++;
  }
  return shared / Math.min(aTokens.size, bTokens.size) >= 0.6;
}

function meaningfullyDifferentValue(a: string, b: string): boolean {
  const left = normalizeExactText(a);
  const right = normalizeExactText(b);
  if (!left || !right || left === right) return false;
  if (left.includes(right) || right.includes(left)) return false;
  return hasExactQaValueSignal(left) || hasExactQaValueSignal(right);
}

export function areAnswerDistinctTexts(existingText: string, incomingText: string): boolean {
  const existingList = LIST_LINE_PATTERN.test(existingText) ? listItems(existingText) : [];
  const incomingList = LIST_LINE_PATTERN.test(incomingText) ? listItems(incomingText) : [];
  if (existingList.length > 1 && incomingList.length > 1) {
    return normalizeExactText(existingList.join("\n")) !== normalizeExactText(incomingList.join("\n"));
  }

  const existingClaim = parseClaim(existingText);
  const incomingClaim = parseClaim(incomingText);
  if (!existingClaim || !incomingClaim) return false;
  if (!isCompactComparableClaim(existingText) || !isCompactComparableClaim(incomingText)) return false;
  return (
    !sameSubject(existingClaim.subject, incomingClaim.subject)
    && existingClaim.predicate === incomingClaim.predicate
    && meaningfullyDifferentValue(existingClaim.value, incomingClaim.value)
  );
}
