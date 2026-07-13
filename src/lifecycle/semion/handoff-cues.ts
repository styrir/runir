// Handoff cue phrase list — single source of truth for two generated consumers
// (Rúnir-78sy.7, Codex-ACCEPTed brief v3 Part A). Broadens `missing_handoff`'s
// stored-role detection ("has a durable handoff?") beyond the 3-phrase regex
// `classifyRecallMemoryKind` uses at capture (recall-status-policy.ts:130,
// byte-identical, untouched — this module is a DETECTOR-ONLY adoption point).
//
// Cue families are empirically grounded in prod handoff-shaped rows (scout
// S3, F5-F7), not hypothesized wording. Bias toward precision (a missed cue
// suppresses a gap — a false-negative, the acceptable failure direction; a
// false-fire nags the user) but do not starve the set: every family below has
// live confirming evidence. "wrapping up"/"closing out"/"state at end" were
// checked and had ZERO genuine hits (F7) — do not add them without evidence.
//
// Consumers:
//   1. `matchesHandoffCue(text)` — JS matcher (unit tests, future recall
//      adoption point per the brief; NOT wired into classifyRecallMemoryKind).
//   2. `buildHandoffCueSqlFragment()` — a parameterized SurrealQL
//      `string::contains` OR-chain matched against the top-level lowercased
//      `text_norm` column (session-scope-indexed, F11-F13: 126ms worst case
//      on the busiest real session). Bound $vars, never string-interpolated
//      (matches this file's existing parameterization convention).
//
// Both consumers are literal-substring matchers (not regex) so SQL string::
// contains and the JS check agree by construction — the live-DB fixture-matrix
// test (continuity-gaps-handoff-cue-repro.test.ts) pins SQL ≡ JS per row.

/**
 * One cue family = one or more literal, already-lowercase substrings. Any one
 * substring present anywhere in the (lowercased) text counts as a family hit.
 * Substrings, not regex: `string::contains` has no regex form in this design
 * (F11-F14 — proven fast, no new index needed), so every fragment here must
 * be a plain literal that both string::contains and a JS `.includes()`-style
 * check evaluate identically.
 */
interface CueFamily {
  readonly name: string;
  readonly phrases: readonly string[];
}

const CUE_FAMILIES: readonly CueFamily[] = [
  // Legacy 3-phrase regex (recall-status-policy.ts:130) — kept as a superset so
  // the detector never regresses below what recall already recognizes.
  {
    name: "legacy",
    phrases: ["session handoff", "resume here", "next time"],
  },
  // Resume-point family (F5) — the single most common REAL missed-handoff
  // phrasing in the mined corpus: "what to pick up next session" framing,
  // worded differently from the legacy phrases but semantically identical.
  {
    name: "resume-point",
    phrases: ["resume point", "resume points", "resume order", "next resume point", "next designated resume point"],
  },
  // Handoff-doc-CREATION family (F6, Codex MAJOR-4 — creation/existence
  // semantics ONLY). A fact stating a handoff FILE was authored is strong
  // session-bound evidence a handoff occurred. Deliberately excludes a bare
  // `docs/handoffs/<file>.md` path reference: a session that merely reads or
  // cites a prior handoff must not suppress its own gap (a citation is not an
  // authorship event). This is the one cue family that leans on a repo path
  // convention (docs/handoffs/) rather than pure semantics — flagged per F6.
  {
    name: "handoff-doc-created",
    phrases: [
      "handoff doc created",
      "handoff document created",
      "handoff was created",
      "handoff document was created",
      "handoff doc was created",
      "durable handoff doc is already committed",
      "handoff committed to docs/handoffs/",
      "handoff doc committed to docs/handoffs/",
    ],
  },
];

/** Flat, lowercase phrase list — the literal single source of truth both
 *  generated consumers below derive from. */
export const HANDOFF_CUE_PHRASES: readonly string[] = CUE_FAMILIES.flatMap((family) => family.phrases);

/**
 * True if `text` contains any handoff cue phrase (case-insensitive substring
 * match — mirrors SurrealQL `string::contains` against lowercased text_norm).
 * Detector-only: NOT used by classifyRecallMemoryKind (recall stays untouched).
 */
export function matchesHandoffCue(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return HANDOFF_CUE_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Builds a parameterized SurrealQL `string::contains(...)` OR-chain over the
 * given column, plus the bound vars to merge into the caller's query vars.
 * Bound as `$<varPrefix>0..$<varPrefix>N` (never string-interpolated) so the
 * static compiled-in phrases still go through SurrealDB's parameter binding,
 * matching this repo's existing SurrealQL convention.
 */
export function buildHandoffCueSqlFragment(
  column: string,
  varPrefix = "cue",
): { fragment: string; vars: Record<string, string> } {
  const vars: Record<string, string> = {};
  const clauses = HANDOFF_CUE_PHRASES.map((phrase, i) => {
    const varName = `${varPrefix}${i}`;
    vars[varName] = phrase;
    return `string::contains(${column}, $${varName})`;
  });
  return { fragment: clauses.join(" OR "), vars };
}
