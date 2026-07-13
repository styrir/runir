/**
 * Deterministic relative→absolute temporal resolution for extracted memories.
 *
 * Memories ingested with relative phrases ("yesterday", "last year", …) must
 * carry a deterministic absolute date so that (a) lexical/BM25 retrieval of
 * when/date questions can match the gold token, and (b) the answer model has a
 * concrete date to return instead of echoing the phrase. Resolution is anchored
 * on the session/message timestamp and computed here — NOT delegated to the LLM
 * (the extraction prompt is only a hint; this is the source of truth).
 *
 * The resolved date is added ADDITIVELY (the verbatim phrase is preserved); we
 * never overwrite the original wording. The pass is idempotent: a date already
 * present in the text is not re-appended.
 *
 * Also strips any leaked `{SESSION_TIMESTAMP}` prompt placeholder — the
 * extraction few-shot historically taught the model to echo that literal token
 * into stored memory (Rúnir memory-system hardening).
 */

export type TemporalGranularity = "day" | "week" | "month" | "year";

export interface ResolvedTemporal {
  /** The (possibly annotated) text. */
  text: string;
  /** The primary resolved absolute date token, when a relative phrase was found. */
  validFrom?: string;
  /** Granularity of `validFrom` (year for "last year", month for "next month", else day). */
  granularity?: TemporalGranularity;
}

const PLACEHOLDER = /\{SESSION_TIMESTAMP\}/g;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function isoMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
function isoYear(d: Date): string {
  return `${d.getUTCFullYear()}`;
}

function shiftDays(anchor: Date, days: number): Date {
  const d = new Date(anchor.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function shiftMonths(anchor: Date, months: number): Date {
  const d = new Date(anchor.getTime());
  // Snap to the 1st BEFORE shifting: setUTCMonth keeps the day-of-month and does
  // not clamp, so a 29th/30th/31st anchor would overflow into the wrong month
  // (e.g. Mar 31 − 1 month → "Feb 31" → Mar 3). Only the month/year of the
  // result is ever read, so snapping the day is exact.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function shiftYears(anchor: Date, years: number): Date {
  const d = new Date(anchor.getTime());
  // Snap to the 1st first so a Feb-29 anchor cannot overflow when the target
  // year is not a leap year (only the year of the result is read).
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

interface Rule {
  re: RegExp;
  compute: (anchor: Date, m: RegExpExecArray) => { value: string; granularity: TemporalGranularity } | undefined;
}

// Word-bounded, case-insensitive. No `g` flag (we use .exec/.test once per call).
// Ordered most-specific-first so the numeric "N <unit> ago" forms win over the
// bare adverbs when both could match.
const RULES: Rule[] = [
  {
    re: /\b(\d{1,4})\s+days?\s+ago\b/i,
    compute: (a, m) => ({ value: isoDay(shiftDays(a, -Number(m[1]))), granularity: "day" }),
  },
  {
    re: /\b(\d{1,4})\s+weeks?\s+ago\b/i,
    compute: (a, m) => ({ value: isoDay(shiftDays(a, -7 * Number(m[1]))), granularity: "week" }),
  },
  {
    re: /\b(\d{1,4})\s+months?\s+ago\b/i,
    compute: (a, m) => ({ value: isoMonth(shiftMonths(a, -Number(m[1]))), granularity: "month" }),
  },
  {
    re: /\b(\d{1,4})\s+years?\s+ago\b/i,
    compute: (a, m) => ({ value: isoYear(shiftYears(a, -Number(m[1]))), granularity: "year" }),
  },
  { re: /\bday before yesterday\b/i, compute: (a) => ({ value: isoDay(shiftDays(a, -2)), granularity: "day" }) },
  { re: /\byesterday\b/i, compute: (a) => ({ value: isoDay(shiftDays(a, -1)), granularity: "day" }) },
  { re: /\btomorrow\b/i, compute: (a) => ({ value: isoDay(shiftDays(a, 1)), granularity: "day" }) },
  { re: /\btoday\b/i, compute: (a) => ({ value: isoDay(a), granularity: "day" }) },
  { re: /\blast week\b/i, compute: (a) => ({ value: isoDay(shiftDays(a, -7)), granularity: "week" }) },
  { re: /\bnext week\b/i, compute: (a) => ({ value: isoDay(shiftDays(a, 7)), granularity: "week" }) },
  { re: /\blast month\b/i, compute: (a) => ({ value: isoMonth(shiftMonths(a, -1)), granularity: "month" }) },
  { re: /\bnext month\b/i, compute: (a) => ({ value: isoMonth(shiftMonths(a, 1)), granularity: "month" }) },
  { re: /\blast year\b/i, compute: (a) => ({ value: isoYear(shiftYears(a, -1)), granularity: "year" }) },
  { re: /\bnext year\b/i, compute: (a) => ({ value: isoYear(shiftYears(a, 1)), granularity: "year" }) },
];

/**
 * Resolve relative temporal phrases in `text` against `anchorIso`, appending the
 * computed absolute date(s) additively and stripping any leaked
 * `{SESSION_TIMESTAMP}` placeholder. Pure and idempotent.
 */
export function resolveRelativeTemporalPhrases(
  text: unknown,
  anchorIso: string | undefined,
): ResolvedTemporal {
  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : "" };
  }

  const anchor = anchorIso ? new Date(anchorIso) : null;
  const hasAnchor = anchor !== null && !Number.isNaN(anchor.getTime());

  // Strip the leaked prompt placeholder: replace with the anchor day, or remove
  // it entirely when there is no usable anchor (it must never reach storage).
  let out = text.replace(PLACEHOLDER, hasAnchor ? isoDay(anchor as Date) : "");
  if (!hasAnchor) return { text: out };

  const resolved: Array<{ value: string; granularity: TemporalGranularity }> = [];
  for (const rule of RULES) {
    const m = rule.re.exec(out);
    if (!m) continue;
    const r = rule.compute(anchor as Date, m);
    if (r && !resolved.some((x) => x.value === r.value)) resolved.push(r);
  }

  // Idempotent: only append dates not already present in the text.
  const toAppend = resolved.filter((r) => !out.includes(r.value));
  if (toAppend.length > 0) {
    out = `${out} (${toAppend.map((r) => r.value).join(", ")})`;
  }

  const primary = resolved[0];
  return primary
    ? { text: out, validFrom: primary.value, granularity: primary.granularity }
    : { text: out };
}
