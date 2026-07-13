import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  proveReferentIdentity,
} from "../referent-identity.js";
import type { ReferentKeys } from "../referent-identity.js";

describe("proveReferentIdentity — key equality proofs", () => {
  const base = { candidateText: "unrelated candidate text body", incomingText: "unrelated incoming text body", atomicAuthority: true };

  it("factKey equal -> proven key:factKey", () => {
    const keys: ReferentKeys = { factKey: "same-fact-key" };
    expect(proveReferentIdentity({ ...base, candidateKeys: keys, incomingKeys: keys,
      atomicAuthority: true,
    })).toEqual({
      verdict: "proven",
      proof: "key:factKey",
    });
  });

  it("noemaClaimKey is NOT a ReferentKeys field (Rúnir-pn1l Q4 U0, 2026-07-07): removed from the proof list", () => {
    // Rúnir-pn1l Q4 U0: noemaClaimKey was dropped from ReferentKeys/proveReferentIdentity
    // (never service-populated at write time -> only ever client-injectable via /memory/store
    // metadata -> spoofable proof of identity). The type no longer HAS the field, so a
    // caller passing it through an untyped object must see it silently ignored, not proven.
    const keys = { noemaClaimKey: "same-claim-key" } as unknown as ReferentKeys;
    expect(proveReferentIdentity({ ...base, candidateKeys: keys, incomingKeys: keys,
      atomicAuthority: true,
    })).toEqual({
      verdict: "unproven",
    });
  });

  it("atomicFactIdentity equal -> proven key:atomicFactIdentity", () => {
    const keys: ReferentKeys = { atomicFactIdentity: "subject|predicate" };
    expect(proveReferentIdentity({ ...base, candidateKeys: keys, incomingKeys: keys,
      atomicAuthority: true,
    })).toEqual({
      verdict: "proven",
      proof: "key:atomicFactIdentity",
    });
  });

  it("empty/undefined keys never prove (nonEmptyEqual)", () => {
    const emptyKeys: ReferentKeys = { factKey: "" };
    expect(
      proveReferentIdentity({ ...base, candidateKeys: emptyKeys, incomingKeys: emptyKeys,
      atomicAuthority: true,
    }),
    ).toEqual({ verdict: "unproven" });
    expect(
      proveReferentIdentity({ ...base, candidateKeys: {}, incomingKeys: {},
      atomicAuthority: true,
    }),
    ).toEqual({ verdict: "unproven" });
  });

  it("continuitySubjectKey equality ALONE yields unproven (supporting-only, KTD6)", () => {
    const keys: ReferentKeys = { continuitySubjectKey: "same-subject" };
    expect(proveReferentIdentity({ ...base, candidateKeys: keys, incomingKeys: keys,
      atomicAuthority: true,
    })).toEqual({
      verdict: "unproven",
    });
  });
});

describe("proveReferentIdentity — anchors and precedence", () => {
  it("anchor conflict beats factKey equality", () => {
    const keys: ReferentKeys = { factKey: "same-fact-key" };
    const result = proveReferentIdentity({
      candidateText: "bug at continuity-report.ts:419 needs a fix",
      incomingText: "bug at continuity-report.ts:84 needs a fix",
      candidateKeys: keys,
      incomingKeys: keys,
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "conflict", conflict: "anchor-conflict" });
  });

  it("shared proof-grade anchor -> proven anchor-shared", () => {
    const result = proveReferentIdentity({
      candidateText: "Task bly4ezhko: step H3 passed for the build",
      incomingText: "Task bly4ezhko: the final gate passed with 0 failures",
      candidateKeys: {},
      incomingKeys: {},
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "proven", proof: "anchor-shared" });
  });

  it("unrelated texts with no keys/anchors -> unproven default", () => {
    const result = proveReferentIdentity({
      candidateText: "completely unrelated statement about weather patterns today",
      incomingText: "an entirely different note about lunch plans tomorrow",
      candidateKeys: {},
      incomingKeys: {},
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "unproven" });
  });

  it("high text overlap with EMPTY keys and NO anchors -> unproven (no text-similarity proof arm, Codex P1)", () => {
    // A symmetric high-overlap reword with no keys and no anchors must NOT prove
    // identity: near-verbatim was removed as a proof arm because it fired on value
    // swaps (staging→production) and retired co-valid facts. Text heuristics may
    // only force keep-both, never positively permit supersession.
    const candidateText =
      "New technical gotcha: requesty 400s occur with max_tokens=1 on reasoning-capable models because reasoning tokens count against the budget.";
    const incomingText =
      "New technical gotcha: requesty 400s occur with max_tokens=1 on reasoning-capable models because reasoning tokens count against the budget, confirmed.";
    const result = proveReferentIdentity({
      candidateText,
      incomingText,
      candidateKeys: {},
      incomingKeys: {},
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "unproven" });
  });
});

// ---------------------------------------------------------------------------
// Rúnir-pn1l Q4 U0 (2026-07-07) — grade-specific rows (brief §4, Codex P2 #4,
// verified correct in prework). These exercise the interaction between
// proof-grade and conflict-only-grade labeled_id/tracker_id values under the
// setsEqual fix: a shared proof-grade value alone is not sufficient to prove
// when the all-grade sets disagree, and a shared conflict-only value alone
// never proves at all.
// ---------------------------------------------------------------------------
describe("proveReferentIdentity — grade-specific rows (Rúnir-pn1l Q4 U0)", () => {
  it("shared proof-grade labeled_id but all-grade sets differ -> conflict (Task bly4ezhko review alphabrief vs betabrief)", () => {
    // Candidate labeled_id anchors: {alphabrief: conflict-only, bly4ezhko: proof}.
    // Incoming labeled_id anchors: {betabrief: conflict-only, bly4ezhko: proof}.
    // All-grade sets {alphabrief, bly4ezhko} vs {betabrief, bly4ezhko} DIFFER despite
    // the shared proof-grade bly4ezhko -> setsEqual fails -> conflict (not shared).
    const result = proveReferentIdentity({
      candidateText: "Task bly4ezhko review alphabrief",
      incomingText: "Task bly4ezhko review betabrief",
      candidateKeys: {},
      incomingKeys: {},
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "conflict", conflict: "anchor-conflict" });
  });

  it("proof on one side only, weak/conflict-only on the other -> unproven ((ID: bidwfprbl) vs Task bidwfprbl)", () => {
    // Both sides extract the SAME labeled_id value "bidwfprbl" (all-grade sets are
    // equal, so setsEqual passes -> not a conflict), but the candidate's is proof-grade
    // (explicit "ID:" label) while the incoming's is conflict-only (bare "Task X" with
    // no digit -> WEAK_LABELED_ID_RE). The proof-grade intersection is empty (only one
    // side has a proof-grade hit for this value) -> unproven, not proven.
    const result = proveReferentIdentity({
      candidateText: "(ID: bidwfprbl)",
      incomingText: "Task bidwfprbl",
      candidateKeys: {},
      incomingKeys: {},
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "unproven" });
  });

  it("equal conflict-only tracker_id, no proof arm -> unproven (Rúnir-h3b.2 vs Rúnir-h3b.2)", () => {
    // tracker_id is CONFLICT-ONLY by design (never proof-grade), so an identical
    // tracker id on both sides yields an equal all-grade set (no conflict) but zero
    // proof-grade intersection -> unproven, never proven from a tracker id alone.
    const result = proveReferentIdentity({
      candidateText: "Rúnir-h3b.2",
      incomingText: "Rúnir-h3b.2",
      candidateKeys: {},
      incomingKeys: {},
      atomicAuthority: true,
    });
    expect(result).toEqual({ verdict: "unproven" });
  });
});

// ---------------------------------------------------------------------------
// Step 3 — derivation sweep (the unit's real teeth). Runs proveReferentIdentity
// on every row of supersede-derivation.json with EMPTY keys, forcing
// provable:true rows to prove by text/anchor alone.
// ---------------------------------------------------------------------------
interface SupersedeDerivationRow {
  rowId: string;
  incomingText: string;
  candidateText: string;
  wouldSignal: string | null;
  label: "over_supersede" | "correct_supersede";
  expected: "block" | "allow";
  provable: true | false | "key-dependent";
  classNote: string;
}

const FIXTURE_PATH = resolve(
  "src/storage/writes/__tests__/fixtures/referent-identity/supersede-derivation.json",
);
const derivationRows: SupersedeDerivationRow[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("proveReferentIdentity — derivation sweep (supersede-derivation.json, keyless)", () => {
  it("every expected:block row yields unproven or conflict (0/46 may prove)", () => {
    // Rúnir-pn1l Q4 U0 (Codex code-review, 2026-07-07): 46, not 45 — see the
    // referent-gate-arbitration.test.ts arbitration-level sweep comment for the
    // full rationale (row 7ac4a2 reclassified from allow/provable:true to
    // block/provable:false).
    const blockRows = derivationRows.filter((r) => r.expected === "block");
    expect(blockRows.length).toBe(46);
    const wronglyProven: Array<{ rowId: string; verdict: unknown }> = [];
    for (const row of blockRows) {
      const verdict = proveReferentIdentity({
        candidateText: row.candidateText,
        incomingText: row.incomingText,
        candidateKeys: {},
        incomingKeys: {},
      atomicAuthority: true,
    });
      if (verdict.verdict === "proven") {
        wronglyProven.push({ rowId: row.rowId, verdict });
      }
    }
    expect(wronglyProven).toEqual([]);
  });

  it("no provable:true allow row remains (Rúnir-pn1l Q4 U0, 2026-07-07): every keyless-allow row now needs key fuel", () => {
    // Rúnir-pn1l Q4 U0 setsEqual fix: the formerly-sole keyless-provable allow row
    // (7ac4a2, anchor-shared on labeled_id "bly4ezhko") ALSO has an incoming text that
    // mentions a second, distinct labeled_id ("bumib4tnx") the candidate never mentions.
    // Under the corrected all-grade setsEqual rule (any same-kind disagreement forces
    // keep-both, no compound-reference exception — see referent-anchors.test.ts's
    // partial-overlap suite), this is now correctly a `labeled_id` CONFLICT. Codex
    // code-review (2026-07-07): the row does NOT move to provable:"key-dependent" as
    // originally reclassified — proveReferentIdentity short-circuits on anchor conflict
    // BEFORE the key-equality loop (referent-identity.ts:264-268), so no key fuel can
    // ever prove it. It moved to expected:"block"/provable:false instead (see the
    // arbitration-level sweep in referent-gate-arbitration.test.ts, now 46 block rows).
    const provableTrueRows = derivationRows.filter((r) => r.expected === "allow" && r.provable === true);
    expect(provableTrueRows.map((r) => r.rowId).sort()).toEqual([]);
  });

  it("emits a summary (non-asserting) for provable:key-dependent rows — keyless unproven is expected", () => {
    const keyDependentRows = derivationRows.filter((r) => r.provable === "key-dependent");
    // 4 architect key-dependent rows + w86qf7ub (no text-similarity proof arm; needs key
    // fuel). 7ac4a2 is NOT here — Codex code-review (2026-07-07): proveReferentIdentity
    // checks anchorRelation FIRST and short-circuits on conflict BEFORE the key-equality
    // loop (referent-identity.ts:264-268), so once the setsEqual fix conflicts its
    // {bly4ezhko} vs {bly4ezhko,bumib4tnx} labeled_id sets, no amount of key fuel can ever
    // make it prove — it moved to expected:block/provable:false in the fixture and is
    // asserted (as a live regression guard) in the 46-block-row arbitration sweep instead
    // of parked in this non-asserting summary.
    expect(keyDependentRows.length).toBe(5);
    for (const row of keyDependentRows) {
      const verdict = proveReferentIdentity({
        candidateText: row.candidateText,
        incomingText: row.incomingText,
        candidateKeys: {},
        incomingKeys: {},
      atomicAuthority: true,
    });
      console.log(
        JSON.stringify({ step: "key_dependent_summary", rowId: row.rowId, keylessVerdict: verdict.verdict, classNote: row.classNote }),
      );
    }
  });
});
