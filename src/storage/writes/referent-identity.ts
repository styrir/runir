/**
 * Rúnir-pn1l.13.4 — referent identity for supersession authority.
 * Architect rule (GH#8 2026-07-05): text similarity may nominate, never retire;
 * retirement needs an independently-proven referent identity; conflicting stable
 * identifiers force keep-both unconditionally. Text heuristics are negative-only.
 * Anchor kinds are exactly the architect's id classes: file+line/range, tracker
 * (task/bead) ids, namespaced issue/PR refs, labeled review/ID ids. Commit SHAs,
 * UUIDs, bare #N, and container ids (session/run/job) are deliberately NOT anchors.
 *
 * Rúnir-pn1l Q4 U0 (2026-07-07, architect REVISE): two corrections to the F1/F2
 * closed proof list.
 * (1) `anchorRelation`'s same-kind conflict check now compares ALL-GRADE value
 *     SETS for equality (`setsEqual`), not mere intersection. A same-kind
 *     PARTIAL overlap with a disagreeing extra id on either side (e.g.
 *     candidate `GH#8,GH#9` vs incoming `GH#8,GH#10`, sharing `gh:8`) now
 *     correctly conflicts — the prior intersection check let it prove
 *     ("shared"), violating "different stable ids force keep-both." No
 *     compound-reference exception: a conflict-only-grade extra anchor still
 *     forces keep-both.
 * (2) `noemaClaimKey` was DROPPED from the `ReferentKeys` proof list (see the
 *     `proveReferentIdentity` doc comment below for the full rationale): it is
 *     never service-populated at write time, so it was only ever reachable via
 *     client-injected `/memory/store` metadata — a spoofable proof-of-identity
 *     claim. Public `/memory/store` (`src/app/routes/memory/index.ts`) now also
 *     strips client-supplied `noemaClaimKey`/`atomicFact` metadata keys before
 *     merge, defense-in-depth against the same class of injection.
 * F1 (`deterministic_text`) retires ONLY with a proven referent identity from
 * the closed proof list; F2 (extractor-marker / currentness-cue tag-driven
 * correction) is a SEPARATE, anchor-conflict-vetoed EXCEPTION with no positive
 * proof requirement of its own — report the two retirement paths separately in
 * any adjudication data, do not conflate their authority sources. U1 v2-field
 * stamping (referent verdict/proof, blocked-nomination visibility) is a HARD
 * PRECONDITION before any labeling or green-light packaging built on shadow data.
 */
import { normalizeText } from "./text-normalize.js";
export type AnchorKind = "file_line" | "tracker_id" | "labeled_id" | "issue_ref";
export type AnchorGrade = "proof" | "conflict-only";
export interface ReferentAnchor { kind: AnchorKind; value: string; grade: AnchorGrade; }

// weak_labeled_id (conflict-only, shares labeled_id kind/value-space):
// task/review label + optional parens + PURE-LETTER slug >=6. Digit-bearing slugs
// are captured proof-grade by LABELED_ID_RE instead. Shared weak values never prove.
const WEAK_LABELED_ID_RE = /\b(?:[Tt]ask|[Rr]eview)\s+\(?([a-z][a-z_-]{5,})\)?(?=[\s(.,;:]|$)/g;
const FILE_LINE_RE = /(?<![\w/])([\w@$.-]+(?:\/[\w@$.-]+)*\.[a-z][a-z0-9]{0,5}):(\d{1,6})(?:-(\d{1,6}))?\b/gi;
// Capitalized head + tail containing >=1 digit, optional dotted numeric tail.
const TRACKER_RE = /\b\p{Lu}[\p{L}\p{N}]*-(?=[a-z0-9.]*\d)[a-z0-9]+(?:\.\d+)*\b/gu;
// Proof-grade: explicit ID: label, or task/review + DIGIT-BEARING slug >=8 (parens tolerated).
const LABELED_ID_RE = /\bID:\s*([A-Za-z0-9_-]{6,})\b|\b(?:[Tt]ask|[Rr]eview)\s+\(?((?=[a-z0-9_-]*\d)[a-z][a-z0-9_-]{7,})\)?\b/g;
// Namespace-preserving; bare #N deliberately unmatched.
const ISSUE_RE = /\b(GH|PR|MR|issue)\s*#?\s*(\d{1,6})\b/gi;

const KINDS: AnchorKind[] = ["file_line", "tracker_id", "labeled_id", "issue_ref"];

/** Reset a global regex's lastIndex and collect every match. */
function matchAll(re: RegExp, text: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

/** Deterministic, structural anchor extraction over the architect's id classes.
 *  Pure function: no I/O, no LLM. Dedupes by kind+value, preferring `proof`
 *  grade when both grades were produced for the same value. */
export function extractReferentAnchors(text: string): ReferentAnchor[] {
  const byKey = new Map<string, ReferentAnchor>();
  const add = (kind: AnchorKind, value: string, grade: AnchorGrade) => {
    const key = `${kind}\u0000${value}`;
    const existing = byKey.get(key);
    if (!existing || (existing.grade === "conflict-only" && grade === "proof")) {
      byKey.set(key, { kind, value, grade });
    }
  };

  for (const m of matchAll(FILE_LINE_RE, text)) {
    const [, file, line, range] = m;
    const value = range ? `${file}:${line}-${range}` : `${file}:${line}`;
    add("file_line", value.toLowerCase(), "proof");
  }

  for (const m of matchAll(TRACKER_RE, text)) {
    add("tracker_id", m[0].toLowerCase(), "conflict-only");
  }

  for (const m of matchAll(LABELED_ID_RE, text)) {
    const value = m[1] ?? m[2];
    if (value) add("labeled_id", value.toLowerCase(), "proof");
  }

  for (const m of matchAll(WEAK_LABELED_ID_RE, text)) {
    const value = m[1];
    if (value) add("labeled_id", value.toLowerCase(), "conflict-only");
  }

  for (const m of matchAll(ISSUE_RE, text)) {
    const [, ns, n] = m;
    add("issue_ref", `${ns.toLowerCase()}:${n}`, "proof");
  }

  return [...byKey.values()].sort((a, b) =>
    a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind.localeCompare(b.kind),
  );
}

function values(anchors: ReferentAnchor[], kind: AnchorKind): Set<string> {
  const out = new Set<string>();
  for (const a of anchors) if (a.kind === kind) out.add(a.value);
  return out;
}

function proofValues(anchors: ReferentAnchor[], kind: AnchorKind): Set<string> {
  const out = new Set<string>();
  for (const a of anchors) if (a.kind === kind && a.grade === "proof") out.add(a.value);
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

/** Rúnir-pn1l Q4 U0 (GH#8 2026-07-07 REVISE): size-equal + every member shared.
 *  Any same-kind disagreement (not just full disjointness) must force keep-both —
 *  a candidate `GH#8,GH#9` vs incoming `GH#8,GH#10` PARTIALLY overlaps (shares
 *  `gh:8`) but disagrees on the extra id, so the two writes reference different
 *  (if overlapping) sets of issues and must NOT be treated as same-referent. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export type AnchorRelation = "shared" | "conflict" | "none";

/** Conflict wins immediately over any kind whose all-grade value sets are not
 *  EQUAL (disjoint OR merely partially-overlapping with a disagreeing extra
 *  id on either side); only proof-grade intersecting values on an equal set
 *  may set `shared`. Cross-kind: one shared kind + one conflicting kind →
 *  `conflict` (conflict beats shared). No compound-reference exception — a
 *  conflict-only-grade extra anchor still forces keep-both. */
export function anchorRelation(a: ReferentAnchor[], b: ReferentAnchor[]): AnchorRelation {
  let shared = false;
  for (const kind of KINDS) {
    const av = values(a, kind);
    const bv = values(b, kind);
    if (av.size === 0 || bv.size === 0) continue;
    if (!setsEqual(av, bv)) return "conflict"; // any same-kind disagreement ⇒ keep-both
    if (intersects(proofValues(a, kind), proofValues(b, kind))) shared = true; // only proof may prove
  }
  return shared ? "shared" : "none";
}

// Generic tokens that are not distinctive entities — a secondary lexical-hygiene
// filter (NOT the thing carrying correctness; the conflicting-subject guard does
// that). Kept small and generic; domain-ish tech names are deliberately absent.
export const GENERIC_VALUE_TOKENS = new Set([
  "tech", "lead", "main", "true", "false", "user", "team", "data", "work",
  "type", "name", "role", "item", "project", "active", "status", "value",
  "thing", "stuff", "info",
]);

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 4 && !GENERIC_VALUE_TOKENS.has(tok)) out.add(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// U3 — verdict function implementing the architect's closed proof list.
// ---------------------------------------------------------------------------

/** Moved from write-arbitrator.ts (pn1l.13.4 U3): the SAME opposing-state /
 *  antonym predicate `wouldSupersedeTexts` consults, re-exported here so the
 *  production supersede path has a single shared definition — no semantic
 *  fork. */
export function hasOpposingStateFlip(existingText: string, incomingText: string): boolean {
  const existing = normalizeText(existingText);
  const incoming = normalizeText(incomingText);
  const opposingPairs: Array<[RegExp, RegExp]> = [
    [/\benabled\b/, /\bdisabled\b/],
    [/\benable\b/, /\bdisable\b/],
    [/\btrue\b/, /\bfalse\b/],
    [/\bon\b/, /\boff\b/],
    [/\byes\b/, /\bno\b/],
    [/\bpresent\b/, /\bmissing\b/],
  ];

  for (const [left, right] of opposingPairs) {
    const existingHasLeft = left.test(existing);
    const existingHasRight = right.test(existing);
    const incomingHasLeft = left.test(incoming);
    const incomingHasRight = right.test(incoming);

    if (
      (existingHasLeft && incomingHasRight) ||
      (existingHasRight && incomingHasLeft)
    ) {
      return true;
    }
  }

  return false;
}

export interface ReferentKeys {
  factKey?: string;
  continuitySubjectKey?: string;
  atomicFactIdentity?: string; // canonical `${subject}|${predicate}` when atomicFact present
}

export type ReferentVerdict =
  | { verdict: "proven"; proof: string }
  | { verdict: "conflict"; conflict: string }
  | { verdict: "unproven" };

function nonEmptyEqual(a: string | undefined, b: string | undefined): boolean {
  return typeof a === "string" && a.length > 0 && a === b;
}

/** The architect's closed proof list, in strict form: anchor conflict wins
 *  immediately (over any key equality); then stable-key equality proves;
 *  then a shared proof-grade anchor proves; anything else is unproven. NO
 *  text-similarity arm authorizes supersession — text heuristics may only
 *  force keep-both, never positively permit a retirement (Codex arch-gate P1,
 *  2026-07-06: the removed near-verbatim arm fired on value swaps like
 *  staging→production, retiring co-valid facts). continuitySubjectKey is
 *  deliberately excluded from the proof list — it is supporting-only
 *  (text-derived, runtime.ts:334) and must NEVER standalone-prove identity
 *  (KTD6).
 *
 *  The proof list is exactly TWO stable-key arms plus the anchor-shared arm:
 *  - `key:factKey` — identical-l0 duplicate detection (value-varying).
 *  - `key:atomicFactIdentity` — stable subject|predicate correction identity.
 *  - `anchor-shared` — a shared proof-grade referent anchor.
 *
 *  `noemaClaimKey` was REMOVED from this proof list (Rúnir-pn1l Q4 U0,
 *  2026-07-07, Codex brief-gate REVISE): it is never service-populated at
 *  write time (`factMetadata` and `deriveContinuityMetadata` in runtime.ts
 *  never stamp it), so the incoming side of this arm could only ever be
 *  populated by CLIENT-SUPPLIED `/memory/store` metadata — an unauthenticated
 *  proof-of-identity claim a caller could inject to force a supersede across
 *  two genuinely different, conflicting-tagged facts (spoofable). It was also
 *  redundant with `factKey` (duplicate detection) and `atomicFactIdentity`
 *  (correction detection) for every legitimate service-derived case. Dropping
 *  it loses zero legitimate behavior; see the `/memory/store` identity-metadata
 *  strip (`src/app/routes/memory/index.ts`) for the companion defense-in-depth
 *  fix that also blocks client injection of `noemaClaimKey`/`atomicFact` at the
 *  HTTP boundary. `noemaClaimKey` REMAINS a live field elsewhere (the noema
 *  claim-contract dedup key consumed by `recall/policy/noema-retrieval-policy.ts`
 *  and stored via `phase2-store.ts`) — only its use as a `ReferentKeys` proof
 *  arm is removed here. */
export function proveReferentIdentity(input: {
  candidateText: string;
  incomingText: string;
  candidateKeys: ReferentKeys;
  incomingKeys: ReferentKeys;
  /**
   * Rúnir-h435.1 PIN-5 [R1-1, R2-3]: when false, ONLY the `atomicFactIdentity`
   * key arm is skipped. The `factKey` arm, the `anchor-shared` arm, and the
   * unconditional anchor-conflict veto are UNAFFECTED. Applied lane threads
   * `atomicFactIdentityProofEnabled()`; full-bundle WOULD forces true; BASELINE
   * forces false (required honest delta). Required at every production call site;
   * pure unit tests of the arm pass `true`.
   */
  atomicAuthority: boolean;
}): ReferentVerdict {
  const rel = anchorRelation(
    extractReferentAnchors(input.candidateText),
    extractReferentAnchors(input.incomingText),
  );
  if (rel === "conflict") return { verdict: "conflict", conflict: "anchor-conflict" };

  for (const k of ["factKey", "atomicFactIdentity"] as const) {
    // Rúnir-h435.1 PIN-5: quarantine skips ONLY the atomicFactIdentity arm.
    if (k === "atomicFactIdentity" && !input.atomicAuthority) continue;
    if (nonEmptyEqual(input.candidateKeys[k], input.incomingKeys[k])) {
      return { verdict: "proven", proof: `key:${k}` };
    }
  }

  // continuitySubjectKey: supporting-only (text-derived, runtime.ts:334) —
  // NEVER standalone (KTD6). Deliberately not checked above.

  if (rel === "shared") return { verdict: "proven", proof: "anchor-shared" };

  return { verdict: "unproven" };
}
