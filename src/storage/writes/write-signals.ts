import type { SimilarCandidate } from "../../domain/memory/types.js";
import { normalizeText } from "./text-normalize.js";
import { GENERIC_VALUE_TOKENS, contentTokens, hasOpposingStateFlip } from "./referent-identity.js";

function splitSegments(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function buildMergedText(existingText: string, incomingText: string): string {
  const existingNorm = normalizeText(existingText);
  const incomingNorm = normalizeText(incomingText);

  if (existingNorm === incomingNorm) {
    return existingText;
  }
  if (incomingNorm.includes(existingNorm)) {
    return incomingText;
  }
  if (existingNorm.includes(incomingNorm)) {
    return existingText;
  }

  const mergedParts: string[] = [];
  const seen = new Set<string>();
  for (const segment of [...splitSegments(existingText), ...splitSegments(incomingText)]) {
    const normalized = normalizeText(segment);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    mergedParts.push(segment);
  }

  const merged = mergedParts.join(" ").trim();
  if (!merged) {
    return incomingText;
  }
  if (merged.length > 1200) {
    return incomingText.length >= existingText.length ? incomingText : existingText;
  }
  return merged;
}

// Shared subject/value split points for the statement-key heuristics.
// Selection is LEFTMOST-IN-TEXT across the whole list (Rúnir-nanf): the old
// array-order-first scan let a late " is " in a subordinate clause hijack the
// key — "User has moved to Denver, which is now their current place of
// residence" keyed on " is " while "User has moved to Austin, Texas." keyed on
// " moved to ", so opposing location states got DIFFERENT keys and
// merge-updated into a fused-history blob instead of superseding (fam02 root
// cause). The earliest split point in the sentence is the actual
// subject/predicate boundary regardless of which delimiter it is.
// The motion/state group exists because location facts previously hit NO
// delimiter at all and fell back to the first-8-words key (city included).
const STATEMENT_DELIMITERS = [
  ":",
  " is ",
  " are ",
  " was ",
  " were ",
  " = ",
  " uses ",
  " use ",
  " switched to ",
  " changed to ",
  " updated to ",
  " moved to ",
  " moved from ",
  " relocated to ",
  " resides in ",
  " lives in ",
  " renamed to ",
];

/** Leftmost occurrence (at or after minIndex) of ANY statement delimiter. */
function findLeftmostDelimiter(normalized: string, minIndex: number): { index: number; delimiter: string } | null {
  let best: { index: number; delimiter: string } | null = null;
  for (const delimiter of STATEMENT_DELIMITERS) {
    const index = normalized.indexOf(delimiter);
    if (index >= minIndex && (best === null || index < best.index)) {
      best = { index, delimiter };
    }
  }
  return best;
}

export function deriveStatementKey(text: string): string {
  const normalized = normalizeText(text);
  // minIndex 8 (unchanged): a split point inside the first 8 chars yields a
  // degenerate subject ("x", "user") — fall through to the 8-word key instead.
  const split = findLeftmostDelimiter(normalized, 8);
  if (split) {
    return normalized.slice(0, split.index).trim();
  }

  return normalized
    .split(" ")
    .slice(0, 8)
    .join(" ")
    .trim();
}

function extractStatementValue(text: string): string {
  const normalized = normalizeText(text);
  // MUST stay in lockstep with deriveStatementKey: shouldSupersede compares the
  // value-side of texts whose key-side matched, so both use the same leftmost
  // split (minIndex 0 here, as before — value extraction tolerates short subjects).
  const split = findLeftmostDelimiter(normalized, 0);
  if (split) {
    return normalized.slice(split.index + split.delimiter.length).trim();
  }

  return normalized;
}

/** Same-subject-key value-change supersession signal, computed over raw texts.
 *  A correction is: same statement key (subject slot) AND a genuinely different,
 *  non-substring value (or an opposing on/off-style state). This is the
 *  production supersede predicate; Rúnir-w077 (F1) lifts it out of the
 *  merge-only band so the skip band (cosine ≥ skipThreshold) can no longer
 *  swallow a correction purely because its embedding crossed 0.95. */
export function wouldSupersedeTexts(existingText: string, incomingText: string): boolean {
  const existingKey = deriveStatementKey(existingText);
  const incomingKey = deriveStatementKey(incomingText);
  if (!existingKey || !incomingKey || existingKey !== incomingKey) {
    return false;
  }

  if (hasOpposingStateFlip(existingText, incomingText)) {
    return true;
  }

  const existingValue = extractStatementValue(existingText);
  const incomingValue = extractStatementValue(incomingText);
  if (!existingValue || !incomingValue || existingValue === incomingValue) {
    return false;
  }

  if (
    existingValue.includes(incomingValue) ||
    incomingValue.includes(existingValue)
  ) {
    return false;
  }

  return true;
}

// Rúnir-w077 (F2): the extractor already tags corrections (see
// src/domain/memory/prompts.ts). These four are explicit "this replaces prior
// state" markers — a standalone `negative` is deliberately EXCLUDED (a negative
// constraint is not necessarily a supersession of a stored fact).
const CORRECTION_MARKER_TAGS = new Set([
  "update",
  "supersedes_prior",
  "invalidation",
  "no_longer_true",
]);

// Tag namespaces that carry context/meta, not a stable attribute SLOT. Excluded
// from slot-overlap and named-value checks so two facts can't be judged
// "same slot" purely by sharing `project:atlas` / `speaker:user`.
const NON_SLOT_TAG_PREFIXES = ["speaker:", "status:"];

function normTags(tags?: string[]): string[] {
  return (tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

export function hasCorrectionMarker(tags?: string[]): boolean {
  for (const t of normTags(tags)) {
    if (CORRECTION_MARKER_TAGS.has(t)) return true;
  }
  return false;
}

function isSlotTag(tag: string): boolean {
  if (!tag.includes(":")) return false;
  if (CORRECTION_MARKER_TAGS.has(tag)) return false;
  return !NON_SLOT_TAG_PREFIXES.some((p) => tag.startsWith(p));
}

// Canonicalize a slot tag for comparison: the extractor's value formatting
// drifts run-to-run (`role:tech-lead` vs `role:tech_lead`), so fold `_`→`-`
// before matching. Not applied to marker detection (markers like
// `no_longer_true`/`supersedes_prior` keep their underscores).
function canonicalSlotTag(tag: string): string {
  return tag.replace(/_/g, "-");
}

/** Role-handoff signal: candidate and incoming occupy the same slot when they
 *  share at least TWO identical slot tags (e.g. `project:atlas` + `role:tech-lead`).
 *  One shared scope tag (`project:atlas` alone) is intentionally not enough. */
export function sharesSlotTags(candidateTags?: string[], incomingTags?: string[]): boolean {
  const inc = new Set(
    normTags(incomingTags).filter(isSlotTag).map(canonicalSlotTag),
  );
  if (inc.size === 0) return false;
  let shared = 0;
  for (const t of new Set(
    normTags(candidateTags).filter(isSlotTag).map(canonicalSlotTag),
  )) {
    if (inc.has(t)) shared += 1;
  }
  return shared >= 2;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tag namespaces that name the fact's SUBJECT/entity (not an attribute like
// `datastore:`/`role:`). Used only as a NEGATIVE signal: if both sides name
// subjects and they are disjoint, the extractor is telling us these are
// DIFFERENT entities → refuse a tag-driven supersede (Codex). Drift-tolerant:
// values are unioned across namespaces, so `project:atlas` vs `subject:atlas`
// still counts as the same subject.
const SUBJECT_TAG_PREFIXES = [
  "project:", "subject:", "person:", "owner:", "entity:", "service:", "app:", "repo:",
];

function subjectValues(tags?: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of normTags(tags)) {
    const canon = canonicalSlotTag(t);
    for (const p of SUBJECT_TAG_PREFIXES) {
      if (canon.startsWith(p)) {
        const v = canon.slice(p.length);
        if (v) out.add(v);
        break;
      }
    }
  }
  return out;
}

/** Negative guard: both sides name subjects and share NONE → different entities,
 *  block tag-driven supersede. If either side names no subject, there's no
 *  evidence of a conflict, so don't block (fall through to the text checks). */
export function conflictingSubjects(candidateTags?: string[], incomingTags?: string[]): boolean {
  const a = subjectValues(candidateTags);
  const b = subjectValues(incomingTags);
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) {
    if (b.has(v)) return false;
  }
  return true;
}

/** Rúnir-pn1l value-change signal for the CUE-driven slot path: the two facts SHARE a
 *  subject (same context, e.g. `project:atlas`) AND name a DIFFERENT subject value (the
 *  occupant changed, e.g. `person:priya-nair` → `subject:marcus-webb`). This is the
 *  "same-subject/same-attribute/DIFFERENT-value" guard the dropped extractor marker used
 *  to imply — `sharesSlotTags` proves same-slot, not changed-value. Distinguishes a
 *  genuine handoff from a co-valid scope distinction (both "Atlas + Postgres", differing
 *  only in free text). Only consulted on the cue path; the marker path is unchanged. */
export function subjectsChanged(candidateTags?: string[], incomingTags?: string[]): boolean {
  const a = subjectValues(candidateTags);
  const b = subjectValues(incomingTags);
  if (a.size === 0 || b.size === 0) return false;
  let shared = false;
  let differs = false;
  for (const v of a) {
    if (b.has(v)) shared = true;
    else differs = true;
  }
  if (!differs) {
    for (const v of b) {
      if (!a.has(v)) {
        differs = true;
        break;
      }
    }
  }
  return shared && differs;
}

/** True when candidate and incoming texts share a distinctive token OTHER than
 *  the named distinguishing value — i.e. they are about the same subject, not
 *  just two facts that happen to name the same tech. Blocks the cross-entity
 *  supersede (e.g. a Speki migration superseding an Atlas fact). */
function sharesContextToken(candidateText: string, incomingText: string, exclude: string): boolean {
  const inc = contentTokens(incomingText);
  for (const tok of contentTokens(candidateText)) {
    if (tok !== exclude && inc.has(tok)) return true;
  }
  return false;
}

/** Datastore-migration signal: a tagged correction that NAMES the candidate's
 *  distinguishing (changed) value in its text (e.g. "migrated off SurrealDB"),
 *  AND shares subject context with the candidate. Tag comparison is
 *  separator-canonicalized; the named token must be distinctive (≥4 chars,
 *  not generic); and a shared non-value context token is required so naming a
 *  common tech across DIFFERENT subjects cannot trigger a supersede. */
export function incomingNamesCandidateValue(
  candidate: SimilarCandidate,
  incomingText: string,
  incomingTags?: string[],
): boolean {
  const candTags = normTags(candidate.tags).filter(isSlotTag);
  if (candTags.length === 0) return false;
  const incomingCanon = new Set(normTags(incomingTags).map(canonicalSlotTag));
  const hay = incomingText.toLowerCase();
  for (const rawTag of candTags) {
    const tag = canonicalSlotTag(rawTag);
    if (incomingCanon.has(tag)) continue; // shared tag = context, not distinguisher
    const value = tag.slice(tag.indexOf(":") + 1);
    for (const tok of value.split(/[^a-z0-9]+/)) {
      if (tok.length < 4 || GENERIC_VALUE_TOKENS.has(tok)) continue;
      if (!new RegExp(`\\b${escapeRegExp(tok)}\\b`).test(hay)) continue;
      // Distinctive distinguishing value is named — require shared subject too.
      if (sharesContextToken(candidate.l2, incomingText, tok)) return true;
    }
  }
  return false;
}
// Rúnir-pn1l Layer 0 — currentness/replacement cues. When the extractor DROPS the
// correction marker (nondeterministic), a same-slot value change is still a
// supersession IF the incoming text explicitly signals replacement/transition.
// Generic transition language only; the structural slot conflict + the
// conflicting-subject guard remain required (§3b), so a cue ALONE never supersedes.
// Directional/transition language only (Codex review: avoid bare additive phrasing
// like a standalone "switch"/"now"). Breadth is further contained by subjectsChanged
// (a cue NEVER supersedes without a same-subject value change on the slot path).
//
// Rúnir-pn1l.9 — the directional-transition verbs (switch / move / transition) allow
// an OPTIONAL -ly adverb before the direction preposition and accept `away` as a
// direction, so natural correction phrasing ("switching AWAY from", "moved directly
// away from", "switched directly over to", "transitioned away from") is recognized
// as the abandonment grammar it expresses — NOT a row-specific literal.
//
// Tightening rationale (Codex REVISE):
// - Intervening token restricted to `\w+ly` (-ly adverbs only) so a direct object
//   ("switch users to admin", "transitioned teams from X") does NOT fire.
// - `move … on` changed to `move … on\s+to` (requires "on to"), so "moved on the
//   proposal" does NOT fire while "moved on to TypeScript" still does.
// - Standalone `in favor of` removed — too broad ("argued in favor of Postgres");
//   the coupling is kept ONLY inside the dropped|ditched pattern.
// - `dropped|ditched` object bounded: first word after verb must NOT be a determiner
//   (the/a/an) to exclude idioms like "dropped the ball for the team". A named
//   technology/person is the direct object in all legitimate abandonment uses. The
//   {0,3}-word window bounds a typical object name (e.g. "Redux", "Vim") without
//   slurping a whole clause before `for`/`in favor of`.
const CURRENTNESS_CUE_PATTERNS: RegExp[] = [
  /\breplac(?:e|es|ed|ing)\b/,
  /\bno longer\b/,
  /\binstead of\b/,
  /\bmigrat(?:e|es|ed|ing)\b/,
  /\bswitch(?:ed|ing)?\s+(?:\w+ly\s+)?(?:to|from|off|over|away)\b/,
  /\bmoved?\s+(?:\w+ly\s+)?(?:to|off|from|over|away)\b/,
  /\bmoved?\s+on\s+to\b/,
  /\btransition(?:ed|ing|s)?\s+(?:\w+ly\s+)?(?:to|from|away)\b/,
  /\b(?:dropped|ditched)\s+(?!the\b|a\b|an\b)(?:\w+\s+){0,3}(?:for\b|in favor of\b)/,
  /\bis now\b/,
  /\bas of\b/,
  /\btook over\b/,
  /\btaking over\b/,
  /\bstepped down\b/,
  /\bthe new\b/,
  /\b(?:updated|changed|upgraded)\s+(?:to|from)\b/,
];

export function hasCurrentnessCue(text: string): boolean {
  const t = text.toLowerCase();
  return CURRENTNESS_CUE_PATTERNS.some((re) => re.test(t));
}
/** Rúnir-pn1l Layer 2 — a Layer-0-abstain candidate worth escalating to the LLM
 *  judge. Requires POSITIVE same-subject evidence (shared slot tags OR the incoming
 *  text naming the candidate's distinguishing value), a currentness cue, and a
 *  non-conflicting subject. `!conflictingSubjects` alone is only a negative guard —
 *  an untagged cross-entity fact would pass it — so the positive evidence is what
 *  keeps a cued, untagged cross-entity handoff out of the judge (Codex brief-gate). */
export function isJudgeWorthy(
  candidate: SimilarCandidate,
  incomingText: string,
  incomingTags: string[] | undefined,
): boolean {
  if (conflictingSubjects(candidate.tags, incomingTags)) return false;
  if (!hasCurrentnessCue(incomingText)) return false;
  return (
    sharesSlotTags(candidate.tags, incomingTags) ||
    incomingNamesCandidateValue(candidate, incomingText, incomingTags)
  );
}

// Rúnir-pn1l.10 Guard 1 — distinct-occasion anchor types (in priority order).
// A structural qualifier that unambiguously identifies a calendar period or episode.
// EXCLUDED: bare ordinals ("first"/"second") — too broad; loose 3-letter month-prefix
// regex — false-matches names (e.g. "Marcus" → "mar"). Occasion words are matched as
// full explicit phrases, not substrings.
const DISTINCT_OCCASION_PATTERNS: Array<{ type: string; re: RegExp }> = [
  // ISO date: 2024-01-15
  { type: "iso-date",  re: /\b(\d{4}-\d{2}-\d{2})\b/ },
  // Calendar quarter: Q1 / Q2 / Q3 / Q4 (case-insensitive)
  { type: "quarter",   re: /\b(q[1-4])\b/i },
  // Explicit 4-digit year: 2020-2099
  { type: "year",      re: /\b(20\d{2})\b/ },
  // Named occasion words — full-word only
  { type: "occasion",  re: /\b(sprint\s*\d+|week\s*\d+|phase\s*\d+|iteration\s*\d+|milestone\s*\d+|v\d+\.\d+)\b/i },
];

/** Rúnir-pn1l.10 Guard 1 — extract the first structural temporal/ordinal qualifier from `text`.
 *  Returns a {type, value} pair, or null when none is found. The value is lowercased
 *  (whitespace-collapsed) so "Q1" and "q1" are identical for comparison. Pure; no side effects.
 *  Rúnir-h435.1 PIN-6: exported for the unconditional atomic-proven F1 occasion leg
 *  (zero logic change — same extraction). */
export function distinctOccasionAnchor(text: string): { type: string; value: string } | null {
  for (const { type, re } of DISTINCT_OCCASION_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      return { type, value: m[1].toLowerCase().replace(/\s+/g, " ") };
    }
  }
  return null;
}

/** Rúnir-pn1l.10 Guard 2 — isAdditiveContent.
 *  An incoming is additive over the candidate when it:
 *    (A) novelty: |novel tokens| >= NOVEL_TOKEN_FLOOR (3 absolute), AND
 *    (B) novelty ratio: |novel| / |incoming tokens| >= NOVEL_RATIO_FLOOR (0.40).
 *  Uses the existing contentTokens() function (strips generic stopwords, >=4 chars).
 *  Does NOT use retention — retention is uniformly high for both additive AND paraphrase
 *  at the skip-band cosine range (Scout A empirical finding: retention 0.71-0.75). Pure. */
const NOVEL_TOKEN_FLOOR = 3;
const NOVEL_RATIO_FLOOR = 0.40;
export function isAdditiveContent(candidateText: string, incomingText: string): boolean {
  const candTokens = contentTokens(candidateText);
  const incTokens  = contentTokens(incomingText);
  if (incTokens.size === 0) return false;
  let novelCount = 0;
  for (const tok of incTokens) {
    if (!candTokens.has(tok)) novelCount += 1;
  }
  return novelCount >= NOVEL_TOKEN_FLOOR && novelCount / incTokens.size >= NOVEL_RATIO_FLOOR;
}
/** Rúnir-pn1l.5 — in the merge band, a high-cosine candidate must NOT be folded into one row when it
 *  is cross-entity (disjoint subjects) or an ambiguous same-slot value change with no currentness cue
 *  (a bare handoff). Both are keep-both cases: folding two distinct facts into one record is an
 *  over-merge anti-pattern (docs/analysis/2026-06-22-merge-vs-keepboth-research.md — all surveyed
 *  reference systems keep distinct high-cosine facts as separate rows). Returns the branch reason, or
 *  null to merge as before. Marker-present is already handled (break) before this fires, so it is not
 *  re-checked here. Conservative: changes merge-update → create, never to supersede.
 *
 *  Rúnir-pn1l.10 Guard 1: adds a "distinct-occasion" branch AFTER the conflicting-subjects check.
 *  When both candidate and incoming carry a same-TYPE structural qualifier (quarter, ISO-date,
 *  explicit year, named episode) with DIFFERENT values, and subjects are shared (non-conflicting),
 *  the two facts describe co-valid distinct events → keep both. Absent or one-sided anchors fall
 *  through; same anchor on both sides falls through (paraphrase of the same event).
 *
 *  Exported (Rúnir-pn1l.13.6, P2.2): a pure helper, exporting it for test-only replay
 *  (`merge-keepboth-guard.test.ts` AC4) is low-risk — no behavior change. */
export function mergeKeepBothReason(
  candidate: SimilarCandidate,
  incomingText: string,
  incomingTags: string[] | undefined,
): string | null {
  if (conflictingSubjects(candidate.tags, incomingTags)) {
    // Rúnir-pn1l.13.4 (U6, 13.5 fold-in): subject tags drift across re-extractions of the
    // SAME fact (the 9/26 dup_recapture rows all fired THIS leg, Addendum B). A subject-tag
    // conflict may only keep-both when the incoming is actually novel vs the candidate (R5);
    // otherwise it is a same-fact re-capture and must fall through to normal merge. The
    // distinct-occasion and ambiguous-slot-change-no-cue legs are deliberately NOT pre-checked
    // (KTD7). Anchor conflicts are handled unconditionally by the band-level veto (U5) in the arbitration pipeline (`findSupersedeTarget` / `resolveDecision`).
    if (isAdditiveContent(candidate.l2, incomingText)) return "conflicting-subjects";
    // not novel → fall through to the remaining legs / merge
  }

  // Rúnir-pn1l.10 Guard 1: distinct-occasion anchor check (AFTER conflicting-subjects so
  // cross-entity rows that both carry a quarter still route to conflicting-subjects, not here).
  // Precondition: subjects non-conflicting AND at least one shared subject value (not unrelated).
  const candAnchor = distinctOccasionAnchor(candidate.l2);
  const incAnchor  = distinctOccasionAnchor(incomingText);
  if (
    candAnchor !== null &&
    incAnchor  !== null &&
    candAnchor.type  === incAnchor.type &&
    candAnchor.value !== incAnchor.value
  ) {
    // Shared-subject precondition: at least one subject value appears on both sides.
    // This prevents keep-both on two genuinely unrelated facts that happen to both
    // carry a quarter (e.g. "Q1 Bifrost report" vs "Q2 Speki report" with no overlap).
    const a = subjectValues(candidate.tags);
    const b = subjectValues(incomingTags);
    const hasSharedSubject = a.size > 0 && b.size > 0 && [...a].some((v) => b.has(v));
    if (hasSharedSubject) {
      return "distinct-occasion";
    }
  }

  if (
    sharesSlotTags(candidate.tags, incomingTags) &&
    subjectsChanged(candidate.tags, incomingTags) &&
    !hasCurrentnessCue(incomingText)
  ) {
    return "ambiguous-slot-change-no-cue";
  }
  return null;
}
