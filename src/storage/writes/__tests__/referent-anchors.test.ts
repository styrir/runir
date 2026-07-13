import { describe, it, expect } from "vitest";
import { extractReferentAnchors, anchorRelation } from "../referent-identity.js";

describe("extractReferentAnchors", () => {
  it("extracts file:line and ranges", () => {
    const a = extractReferentAnchors("bug at continuity-report.ts:84 (content hash)");
    expect(a).toContainEqual({ kind: "file_line", value: "continuity-report.ts:84", grade: "proof" });
    expect(extractReferentAnchors("see src/recall/x.ts:12-40")).toContainEqual(
      { kind: "file_line", value: "src/recall/x.ts:12-40", grade: "proof" });
  });
  it("extracts digit-bearing tracker ids incl. dotted tails (conflict-only: bare tracker tokens never prove)", () => {
    expect(extractReferentAnchors("closes Rúnir-pn1l.13.4 today"))
      .toContainEqual({ kind: "tracker_id", value: "rúnir-pn1l.13.4", grade: "conflict-only" });
    expect(extractReferentAnchors("JIRA ABC-123 moved")).toContainEqual(
      { kind: "tracker_id", value: "abc-123", grade: "conflict-only" });
  });
  it("extracts labeled ids (the bidwfprbl class) but NOT container ids", () => {
    expect(extractReferentAnchors("Pending Codex architectural review (ID: bidwfprbl)"))
      .toContainEqual({ kind: "labeled_id", value: "bidwfprbl", grade: "proof" });
    expect(extractReferentAnchors("review bj8gfw9po completed"))
      .toContainEqual({ kind: "labeled_id", value: "bj8gfw9po", grade: "proof" });
    expect(extractReferentAnchors("session 65e562a1 resumed; job b1uxruce6 done")).toEqual([]);
    for (const s of ["review findings posted", "review comments addressed",
                     "review artifact saved", "review feedback pending"]) {
      expect(extractReferentAnchors(s).filter(a => a.grade === "proof")).toEqual([]);
    }
  });
  it("digit rule splits the task/review label family: proof vs conflict-only", () => {
    expect(extractReferentAnchors("Task bly4ezhko: verify step running"))
      .toContainEqual({ kind: "labeled_id", value: "bly4ezhko", grade: "proof" });
    expect(extractReferentAnchors("task (bj8gfw9po) completed"))
      .toContainEqual({ kind: "labeled_id", value: "bj8gfw9po", grade: "proof" });
    expect(extractReferentAnchors("Task bidwfprbl (verify step)"))
      .toContainEqual({ kind: "labeled_id", value: "bidwfprbl", grade: "conflict-only" });
  });
  it("extracts issue refs namespace-preserved; GH#8 !== PR#8; bare #123 ignored", () => {
    expect(extractReferentAnchors("per GH#8 verdict")).toContainEqual({ kind: "issue_ref", value: "gh:8", grade: "proof" });
    expect(extractReferentAnchors("merged PR #8")).toContainEqual({ kind: "issue_ref", value: "pr:8", grade: "proof" });
    expect(extractReferentAnchors("see #123 for details")).toEqual([]);
  });
  it("does NOT extract commit SHAs, UUID fragments, hyphenated prose, headers, versions", () => {
    for (const s of ["fixed in 7c3167b", "target cdc548c6-8c47-4b3b-bf3c-54df680a2a48",
                     "keep-both would mint duplicates", "re-scoped the flip path",
                     "## Summary of write-arbitrator", "Opus 4.8 and Sonnet 5"]) {
      expect(extractReferentAnchors(s)).toEqual([]);
    }
  });
});

describe("extractReferentAnchors — real corpus shapes (U1 derivation fixtures)", () => {
  it("extracts dotted-tail tracker ids from raw corpus spellings (conflict-only)", () => {
    expect(extractReferentAnchors("The 'Rúnir-mp09' task identified a gap"))
      .toContainEqual({ kind: "tracker_id", value: "rúnir-mp09", grade: "conflict-only" });
    expect(extractReferentAnchors("the 'Rúnir-noem1.4.5' task involves renaming"))
      .toContainEqual({ kind: "tracker_id", value: "rúnir-noem1.4.5", grade: "conflict-only" });
    expect(extractReferentAnchors("The Rúnir-tfxt.6 task will be closed"))
      .toContainEqual({ kind: "tracker_id", value: "rúnir-tfxt.6", grade: "conflict-only" });
  });
  it("extracts long digit-bearing labeled ids as proof (task (a81942b2422888335))", () => {
    expect(extractReferentAnchors("efficiency' task (a81942b2422888335) concluded"))
      .toContainEqual({ kind: "labeled_id", value: "a81942b2422888335", grade: "proof" });
  });
  it("does not treat a path fragment ending in a bare labeled id as file_line (tasks/bidwfprbl.output)", () => {
    const a = extractReferentAnchors("tasks/bidwfprbl.output. Task bgljlcinf, 'Launch");
    expect(a.some(x => x.kind === "file_line")).toBe(false);
    expect(a).toContainEqual({ kind: "labeled_id", value: "bgljlcinf", grade: "conflict-only" });
  });
  it("digit-bearing labeled id yields a single proof hit, no duplicate (WEAK_LABELED_ID_RE does not co-fire: it is pure-letter only)", () => {
    // "Task bly4ezhko" is digit-bearing -> only LABELED_ID_RE matches (proof).
    // Corrected rationale (u2-report.md LOW-1): this is NOT a genuine dedupe
    // collision, since WEAK_LABELED_ID_RE requires a pure-letter slug and
    // never fires on a digit-bearing value like "bly4ezhko" in the first
    // place. The dedupe-prefer-proof path in extractReferentAnchors's `add()`
    // is exercised by the pure-letter weak/strong overlap covered elsewhere
    // (e.g. "Task bidwfprbl" is weak/conflict-only-only, "Task bly4ezhko" is
    // strong/proof-only) — there is no single raw value in this corpus that
    // both regexes match simultaneously. Kept as a single-hit regression
    // guard; no new collision test added (cheaper honest option per brief).
    const a = extractReferentAnchors("Task bly4ezhko (hygiene-batch brief)");
    const hits = a.filter(x => x.kind === "labeled_id" && x.value === "bly4ezhko");
    expect(hits).toHaveLength(1);
    expect(hits[0].grade).toBe("proof");
  });
  it("real ID: forms from the corpus (quoted labels, trailing punctuation)", () => {
    expect(extractReferentAnchors("'hygiene-batch brief' (ID: bwpmtncuj) complete"))
      .toContainEqual({ kind: "labeled_id", value: "bwpmtncuj", grade: "proof" });
    expect(extractReferentAnchors("architecture review (ID: baa4v9pcp) before p"))
      .toContainEqual({ kind: "labeled_id", value: "baa4v9pcp", grade: "proof" });
  });
  it("real continuity-report.ts:N line refs from the corpus", () => {
    expect(extractReferentAnchors("src/lifecycle/archive/continuity-report.ts:45"))
      .toContainEqual({ kind: "file_line", value: "src/lifecycle/archive/continuity-report.ts:45", grade: "proof" });
    expect(extractReferentAnchors("surreal-store.ts:1736-1743"))
      .toContainEqual({ kind: "file_line", value: "surreal-store.ts:1736-1743", grade: "proof" });
  });
});

describe("anchorRelation", () => {
  it("conflict: same file different line (the :84 vs :419 magnet)", () => {
    expect(anchorRelation(
      extractReferentAnchors("bug at continuity-report.ts:419 gaps-pending"),
      extractReferentAnchors("bug at continuity-report.ts:84 content hash"),
    )).toBe("conflict");
  });
  it("conflict: disjoint labeled ids (bidwfprbl vs bj8gfw9po), incl. the raw corpus shapes", () => {
    expect(anchorRelation(
      extractReferentAnchors("(ID: bidwfprbl) pending"),
      extractReferentAnchors("review bj8gfw9po completed"),
    )).toBe("conflict");
    expect(anchorRelation(
      extractReferentAnchors("Task bidwfprbl (verify step)"),
      extractReferentAnchors("task (bj8gfw9po) completed"),
    )).toBe("conflict");
  });
  it("shared weak-only values never prove: no 'shared' from conflict-only anchors", () => {
    expect(anchorRelation(
      extractReferentAnchors("task completed early"),
      extractReferentAnchors("task completed on time"),
    )).not.toBe("shared");
  });
  it("none: a shared tracker id ALONE does not prove (conflict-only; same-referent proof needs labeled_id/file_line/issue_ref/key)", () => {
    expect(anchorRelation(
      extractReferentAnchors("Rúnir-h3b.2 verify step running"),
      extractReferentAnchors("Rúnir-h3b.2 final test:ci green"),
    )).toBe("none");
  });
  it("conflict beats shared across kinds (file_line conflict wins; the tracker itself is same-value, neither conflict nor proof)", () => {
    expect(anchorRelation(
      extractReferentAnchors("Rúnir-x.1 fix at a.ts:10"),
      extractReferentAnchors("Rúnir-x.1 fix at a.ts:99"),
    )).toBe("conflict");
  });
  it("disjoint tracker ids force conflict (keep-both) even though tracker is conflict-only", () => {
    expect(anchorRelation(
      extractReferentAnchors("Rúnir-x.1 done"),
      extractReferentAnchors("Rúnir-x.2 done"),
    )).toBe("conflict");
  });
  it("incidentally shared program/model tracker tokens never prove (the om-2/gpt-5.5 false-proof class)", () => {
    expect(anchorRelation(
      extractReferentAnchors("OM-2 work reviewed by gpt-5.5"),
      extractReferentAnchors("OM-2 status per gpt-5.5"),
    )).not.toBe("shared");
  });
  it("none: anchors on one side only, or no proof-grade kinds shared", () => {
    expect(anchorRelation(extractReferentAnchors("a.ts:10 fixed"),
                          extractReferentAnchors("general note, no refs"))).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Rúnir-pn1l Q4 U0 (2026-07-07) — setsEqual fix regression suite.
//
// Bug (pre-fix): same-kind sets with PARTIAL overlap + a disagreeing extra id
// returned `shared` -> `proven` -> authorized retirement (candidate GH#8,GH#9
// vs incoming GH#8,GH#10 shared gh:8 via `intersects`). This violates the
// architect's rule that different stable ids force keep-both. Fix: setsEqual
// (size-equal + every member shared) replaces intersects for the conflict
// check, so ANY same-kind disagreement (not just full disjointness) conflicts.
// Equality basis stays all-grade values() — no compound-reference exception.
// ---------------------------------------------------------------------------
describe("anchorRelation — partial-overlap same-kind disagreement (Rúnir-pn1l Q4 U0 setsEqual fix)", () => {
  it("issue_ref: partial overlap + disagreeing extra id -> conflict (the architect's GH#8,GH#9 vs GH#8,GH#10 row)", () => {
    expect(anchorRelation(
      extractReferentAnchors("service port 7700; affects GH#8 and GH#9"),
      extractReferentAnchors("service port 8800; affects GH#8 and GH#10"),
    )).toBe("conflict");
  });

  it("file_line: partial overlap + disagreeing extra id -> conflict", () => {
    expect(anchorRelation(
      extractReferentAnchors("fixed a.ts:10 and b.ts:20"),
      extractReferentAnchors("fixed a.ts:10 and b.ts:30"),
    )).toBe("conflict");
  });

  it("labeled_id: partial overlap + disagreeing extra id -> conflict (Task bly4ezhko shared, second task differs)", () => {
    expect(anchorRelation(
      extractReferentAnchors("Task bly4ezhko and Task bumib4tnx both passed"),
      extractReferentAnchors("Task bly4ezhko and Task cx7dqfwjs both passed"),
    )).toBe("conflict");
  });

  it("tracker_id: partial overlap + disagreeing extra id -> conflict (conflict-only kind still forces keep-both on disagreement)", () => {
    expect(anchorRelation(
      extractReferentAnchors("Rúnir-x.1 and Rúnir-y.2 both closed"),
      extractReferentAnchors("Rúnir-x.1 and Rúnir-z.3 both closed"),
    )).toBe("conflict");
  });

  it("exact-equal same-kind sets + proof -> still shared (no regression: equal sets are unaffected by setsEqual vs intersects)", () => {
    expect(anchorRelation(
      extractReferentAnchors("GH#8 and GH#9 both verified"),
      extractReferentAnchors("GH#8 and GH#9 both closed"),
    )).toBe("shared");
  });

  it("disjoint same-kind sets -> conflict (unchanged: setsEqual also returns false for fully disjoint sets)", () => {
    expect(anchorRelation(
      extractReferentAnchors("GH#8 only"),
      extractReferentAnchors("GH#10 only"),
    )).toBe("conflict");
  });

  it("asymmetric enrichment on a DIFFERENT kind (one side empty for that kind) is NOT a conflict from that kind", () => {
    // The incoming adds a file_line anchor the candidate never mentions, but since
    // the candidate's file_line SET is empty, that kind is skipped entirely (av.size
    // === 0 -> continue) — no compound-reference exception is needed because an
    // empty set never disagrees. issue_ref still matches exactly on both sides.
    expect(anchorRelation(
      extractReferentAnchors("GH#8 verified"),
      extractReferentAnchors("GH#8 verified, see a.ts:10 for detail"),
    )).toBe("shared");
  });

  it("equal conflict-only-grade sets (shared tracker only) -> none (tracker demotion intact, no compound-reference exception)", () => {
    expect(anchorRelation(
      extractReferentAnchors("Rúnir-x.1 status update"),
      extractReferentAnchors("Rúnir-x.1 final status"),
    )).toBe("none");
  });

  it("cross-kind shared+conflicting -> conflict (a conflict-only-grade extra anchor on a DIFFERENT kind still forces keep-both, no compound-reference exception)", () => {
    expect(anchorRelation(
      extractReferentAnchors("Rúnir-x.1 fix at a.ts:10"),
      extractReferentAnchors("Rúnir-x.1 fix at a.ts:10, also Rúnir-y.2"),
    )).toBe("conflict");
  });
});

describe("anchorRelation — range semantics (Codex P2 #5)", () => {
  it("a bare line vs the same line as a range start -> conflict (different literal file_line values; conservative, not a regression)", () => {
    // src/x.ts:42 vs src/x.ts:42-50 are DIFFERENT literal file_line anchor values
    // (extractReferentAnchors does not treat a range as "containing" its start line),
    // so the two sets are neither equal nor overlapping -> conflict (keep-both). This
    // is intentionally conservative: a range reference is not proof that the bare-line
    // reference is the same claim.
    expect(anchorRelation(
      extractReferentAnchors("see src/x.ts:42 for the fix"),
      extractReferentAnchors("see src/x.ts:42-50 for the fix"),
    )).toBe("conflict");
  });
});
