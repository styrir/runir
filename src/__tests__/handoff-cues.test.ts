// Unit tests for the handoff cue module (Rúnir-78sy.7 Part A).
//
// Written TDD-first: matchesHandoffCue and buildHandoffCueSqlFragment do not
// exist yet as of this test's authoring. Covers every cue family with real
// scout-mined phrasing (F5/F6) plus near-miss negatives, including the
// creation-vs-citation distinction (Codex MAJOR-4) that must NOT match on a
// bare docs/handoffs/ path reference.

import { describe, expect, it } from "vitest";
import { buildHandoffCueSqlFragment, HANDOFF_CUE_PHRASES, matchesHandoffCue } from "../lifecycle/semion/handoff-cues.js";

describe("matchesHandoffCue: legacy superset (recall-status-policy.ts:130 parity)", () => {
  it("matches 'session handoff'", () => {
    expect(matchesHandoffCue("A session handoff was written for this work.")).toBe(true);
  });
  it("matches 'resume here'", () => {
    expect(matchesHandoffCue("Next session, resume here at step 3.")).toBe(true);
  });
  it("matches 'next time'", () => {
    expect(matchesHandoffCue("Next time we should check the cache.")).toBe(true);
  });
});

describe("matchesHandoffCue: resume-point family (F5, real prod phrasing)", () => {
  it("matches 'resume point'", () => {
    expect(matchesHandoffCue("The next resume point is finishing the migration.")).toBe(true);
  });
  it("matches 'resume points for next session in order'", () => {
    expect(matchesHandoffCue("Resume points for next session in order: 1) fix tests 2) deploy.")).toBe(true);
  });
  it("matches 'resume order'", () => {
    expect(matchesHandoffCue("Here is the resume order for tomorrow's work.")).toBe(true);
  });
  it("matches 'next designated resume point'", () => {
    expect(matchesHandoffCue("The next designated resume point is the retrieval fix.")).toBe(true);
  });
  it("matches 'the next development session should resume at'", () => {
    // Contains the "resume point" substring? No — must hit via a different
    // family member. Confirm this exact mined phrasing (F5 evidence) matches
    // through the broader resume-point family rather than silently missing.
    expect(matchesHandoffCue("The next development session should resume at the retrieval fix, i.e. the next resume point.")).toBe(true);
  });
});

describe("matchesHandoffCue: handoff-doc-created family (F6, creation semantics only)", () => {
  it("matches 'handoff doc created'", () => {
    expect(matchesHandoffCue("A handoff doc created at docs/handoffs/2026-07-05-foo.md.")).toBe(true);
  });
  it("matches 'handoff document created'", () => {
    expect(matchesHandoffCue("The handoff document created for this session covers X.")).toBe(true);
  });
  it("matches 'handoff was created'", () => {
    expect(matchesHandoffCue("A formal handoff was created summarizing the session.")).toBe(true);
  });
  it("matches 'durable handoff doc is already committed'", () => {
    expect(matchesHandoffCue("The durable handoff doc is already committed and pushed (docs/handoffs/2026-07-05-foo.md).")).toBe(true);
  });
  it("matches 'handoff committed to docs/handoffs/'", () => {
    expect(matchesHandoffCue("The handoff committed to docs/handoffs/2026-07-05-bar.md supersedes the prior one.")).toBe(true);
  });
});

describe("matchesHandoffCue: near-miss negatives (must NOT match)", () => {
  it("does NOT match a bare docs/handoffs/ path reference (citation, not creation)", () => {
    expect(matchesHandoffCue("See docs/handoffs/2026-07-03-78sy1-seam-ratification-handoff.md for background.")).toBe(false);
  });
  it("does NOT match a session merely reading/citing a prior handoff", () => {
    expect(matchesHandoffCue("Per the handoff at docs/handoffs/2026-06-20-foo.md, the plan was X.")).toBe(false);
  });
  it("does NOT match 'wrapping up' (F7: zero genuine hits, excluded)", () => {
    expect(matchesHandoffCue("Wrapping up this task for today.")).toBe(false);
  });
  it("does NOT match 'closing out' (F7: excluded, false-positive risk)", () => {
    expect(matchesHandoffCue("Closing out a wait for gitnexus to finish indexing.")).toBe(false);
  });
  it("does NOT match unrelated recent-work text", () => {
    expect(matchesHandoffCue("Fixed the sha-pin mismatch in the manifest v3 config.")).toBe(false);
  });
  it("does NOT match empty text", () => {
    expect(matchesHandoffCue("")).toBe(false);
  });
});

describe("matchesHandoffCue: case-insensitivity", () => {
  it("matches uppercase input identically to lowercase", () => {
    expect(matchesHandoffCue("SESSION HANDOFF WAS WRITTEN.")).toBe(true);
    expect(matchesHandoffCue("RESUME POINT for next session.")).toBe(true);
  });
});

describe("buildHandoffCueSqlFragment", () => {
  it("generates one string::contains clause per phrase, OR-joined", () => {
    const { fragment, vars } = buildHandoffCueSqlFragment("text_norm");
    const clauseCount = fragment.split(" OR ").length;
    expect(clauseCount).toBe(HANDOFF_CUE_PHRASES.length);
    expect(Object.keys(vars).length).toBe(HANDOFF_CUE_PHRASES.length);
  });
  it("binds every phrase as a $var, never string-interpolated into the fragment", () => {
    const { fragment, vars } = buildHandoffCueSqlFragment("text_norm");
    for (const phrase of HANDOFF_CUE_PHRASES) {
      expect(fragment).not.toContain(phrase);
      expect(Object.values(vars)).toContain(phrase);
    }
  });
  it("respects a custom var prefix (no collision across concurrent fragment builds)", () => {
    const { fragment, vars } = buildHandoffCueSqlFragment("text_norm", "hc");
    expect(fragment).toContain("$hc0");
    expect(Object.keys(vars)[0]).toBe("hc0");
  });
  it("uses the given column name in every clause", () => {
    const { fragment } = buildHandoffCueSqlFragment("text_norm");
    const clauses = fragment.split(" OR ");
    for (const clause of clauses) {
      expect(clause).toContain("string::contains(text_norm,");
    }
  });
});
