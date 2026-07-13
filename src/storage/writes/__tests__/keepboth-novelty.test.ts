import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Rúnir-pn1l.13.4 U6 (13.5 fold-in) — novelty pre-check on the merge-band keep-both
// guard's `conflicting-subjects` leg.
//
// The change (`mergeKeepBothReason` in write-signals.ts): the `conflicting-subjects`
// leg returns "conflicting-subjects" ONLY when isAdditiveContent(candidate.l2,
// incomingText) is true; otherwise it falls through to the remaining legs / merge.
// The distinct-occasion and ambiguous-slot-change-no-cue legs are UNCHANGED (KTD7);
// U5's unconditional band-level anchor-conflict veto is untouched; the guard stays
// behind RUNIR_MERGE_KEEPBOTH_GUARD (default OFF, not changed here).
//
// mergeKeepBothReason is exported from the write-arbitrator façade (and defined in
// write-signals.ts) but this suite exercises it through arbitrateWrite, with the
// guard flag ON. House pattern mirrors merge-keepboth-guard.test.ts /
// referent-gate-arbitration.test.ts (mocked store + makeCandidate/arb).
//
// FIXTURE NOTE — updated by the keepboth-fixture-fix session (pn1l.13.4). The
// original fixture had a hydration bug: resolveIncomingText() fetched
// applied.result.l2 whenever DB-hydrated, and on every one of these 26 guard rows
// applied.result.id === guard.target_id (the applied lane merged directly into the
// very record the guard flagged as candidate), so incomingText was always the
// POST-MERGE target text, byte-identical to candidateText, with no tags captured at
// all. FIXED: keepboth-derivation.json now hydrates incomingText from the packet's
// own incoming_text_trunc (genuinely distinct from candidateText on all 26 rows) and
// candidateTags from the live DB payload.tags of the target. incomingTags is honestly
// `null` on every row: the shadow packet schema (supersede_shadow table DEFINE FIELD
// list, src/storage/surreal/surreal-store.ts) never persisted incoming tags at write
// time — only incoming_text_trunc. Real incoming tags DID exist and drove
// conflictingSubjects to fire in production
// (docs/plans/2026-07-05-001-feat-referent-identity-matcher-plan.md:27), but those
// specific values are unrecoverable from this corpus; they are not fabricated here.
//
// FEASIBILITY GATE RESULT (re-run against the fixed, non-identical fixture): even
// forcing the STRONGEST possible incoming-tags case (synthetic disjoint subject tags
// on every row, guaranteeing conflictingSubjects() would return true if reached), 0 of
// 9 dup_recapture rows and 0 of 17 clean_distinct rows ever reach mergeKeepBothReason
// / isAdditiveContent through arbitrateWrite. The reason is structural, not a tag
// artifact: candidateText in this corpus is the DB's CURRENT (post-merge) text for a
// record the real production system already merged the incoming into, so on 23/26
// rows the normalized incomingText is literally a substring of the normalized
// candidateText (verified by inspection). The merge-band's containment-skip
// ("existing memory already contains incoming detail" in `resolveDecision`) or
// the merge-resolves-to-existing-text skip fires BEFORE mergeKeepBothReason is
// ever called, on every single row — real production merges structurally leave no
// row in this corpus where the candidate DB snapshot represents genuine PRE-arbitration
// state. This is unfixable without inventing a candidate text the DB does not contain,
// which would violate the referent-identity invariant the whole matcher is built on
// (candidate text is ALWAYS the live DB fetch, never inferred/synthesized). So the
// fixture — even now correctly non-identical and correctly tagged on the candidate
// side — STILL cannot be swept per-row as a positive/negative discriminator for THIS
// leg; it demonstrates a different, earlier-band mechanism absorbs same-fact
// re-captures. Genuinely-distinct-fact PROTECTION and the U6 novelty-gate DELTA remain
// proven by the synthetic controls below (Groups 1-3), which carry the real
// distinguishing signal (novel content / distinct-occasion anchors / anchor conflict /
// non-novel paraphrase) needed to actually reach and exercise mergeKeepBothReason.

vi.mock("../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  logSupersedeShadow: vi.fn().mockResolvedValue(undefined),
  ensureSupersedeShadowTable: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class { query = vi.fn().mockResolvedValue([[]]); },
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import {
  findSimilarMemories,
  supersedeMemory,
  updateMemoryText,
} from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

function makeDb() { return { query: vi.fn().mockResolvedValue([[]]) } as any; }
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(o: Partial<SimilarCandidate> & { l2: string }): SimilarCandidate {
  const now = new Date().toISOString();
  // 0.90 lands in the merge band [mergeThreshold 0.85, skipThreshold 0.95) so pass 5 runs.
  return { id: "seed-id", similarity: 0.90, createdAt: now, updatedAt: now, ...o };
}
async function arb(opts: {
  text: string;
  candidate: SimilarCandidate;
  incomingTags?: string[];
}) {
  (findSimilarMemories as Mock).mockResolvedValue([opts.candidate]);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(),
    text: opts.text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...(opts.incomingTags ? { metadata: { tags: opts.incomingTags } } : {}),
  });
}

// Disjoint subject-tag pairs → conflictingSubjects() true → the guard's
// conflicting-subjects leg is ENTERED (so the U6 novelty gate is what decides).
const CAND_SUBJECT_TAGS = ["project:atlas", "person:priya-nair"];
const INC_SUBJECT_TAGS = ["project:bifrost", "subject:marcus-webb"];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
  (supersedeMemory as Mock).mockResolvedValue(undefined);
  (updateMemoryText as Mock).mockResolvedValue(undefined);
});
afterEach(() => {
  delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — conflicting-subjects STILL fires when the incoming is genuinely novel.
// The U6 gate must not break protection of distinct cross-entity facts.
// ─────────────────────────────────────────────────────────────────────────────
describe("U6 — conflicting-subjects + NOVEL incoming still keeps both (flag ON)", () => {
  beforeEach(() => { process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1"; });

  it("cross-entity with novel content → CREATE, reason names conflicting-subjects", async () => {
    const candidate = makeCandidate({
      l2: "Priya Nair is the on-call lead for the Atlas platform team.",
      tags: CAND_SUBJECT_TAGS,
    });
    const r = await arb({
      text:
        "Marcus Webb now leads the entire Bifrost infrastructure migration and " +
        "observability rollout across three separate regions.",
      candidate,
      incomingTags: INC_SUBJECT_TAGS,
    });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/conflicting-subjects/);
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — the U6 delta: conflicting-subjects + NON-novel same-fact text is now
// SILENT (falls through), whereas pre-U6 it returned "conflicting-subjects".
// ─────────────────────────────────────────────────────────────────────────────
describe("U6 — conflicting-subjects + non-novel same-fact re-capture is SILENT", () => {
  // A synthetic same-fact pair: the two texts are a low-novelty paraphrase (models
  // "tags drifted across re-extractions of the same fact"), isAdditiveContent=false.
  const CAND_TEXT = "The deploy target is the staging cluster in region us-east.";
  const INC_TEXT = "Deploy target is the staging cluster in us-east region.";

  it("guard ON: non-novel + subject-tag conflict → NOT a conflicting-subjects create", async () => {
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
    const candidate = makeCandidate({ l2: CAND_TEXT, tags: CAND_SUBJECT_TAGS });
    const r = await arb({ text: INC_TEXT, candidate, incomingTags: INC_SUBJECT_TAGS });
    // The leg is entered (tags conflict) but falls through because content is not novel.
    expect(r.reason ?? "").not.toMatch(/conflicting-subjects/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("guard OFF (default): same pair still merge-updates byte-for-byte", async () => {
    const candidate = makeCandidate({ l2: CAND_TEXT, tags: CAND_SUBJECT_TAGS });
    const r = await arb({ text: INC_TEXT, candidate, incomingTags: INC_SUBJECT_TAGS });
    expect(r.outcome).toBe("merge-update");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — legs U6 did NOT touch are NOT novelty-gated (regression fences).
// ─────────────────────────────────────────────────────────────────────────────
describe("U6 — untouched legs are not pre-checked (flag ON)", () => {
  beforeEach(() => { process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1"; });

  it("distinct-occasion low-novelty pair still fires distinct-occasion (NOT novelty-gated)", async () => {
    // Shared subject (project:atlas) + different same-type occasion anchor (Q1 vs Q2),
    // low novelty. The distinct-occasion leg must fire regardless of isAdditiveContent.
    const candidate = makeCandidate({
      l2: "Q1 Atlas standup covered the Postgres migration timeline.",
      tags: ["project:atlas"],
    });
    const r = await arb({
      text: "Q2 Atlas standup covered the Postgres migration timeline.",
      candidate,
      incomingTags: ["project:atlas"],
    });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/distinct-occasion/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("ambiguous-slot-change-no-cue low-novelty pair still fires that leg (NOT novelty-gated)", async () => {
    // Shared subject (project:atlas) + shared slot tags (>=2) with a changed subject
    // value, no currentness cue, low novelty → ambiguous-slot-change-no-cue.
    const SLOT_TAGS = ["project:atlas", "role:on-call-lead"];
    const candidate = makeCandidate({
      l2: "Priya Nair is the on-call lead for Atlas.",
      tags: [...SLOT_TAGS, "person:priya-nair"],
    });
    const r = await arb({
      text: "Marcus Webb is the on-call lead for Atlas.",
      candidate,
      incomingTags: [...SLOT_TAGS, "subject:marcus-webb"],
    });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/ambiguous-slot-change-no-cue/);
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("U5 anchor-conflict veto keeps both even with the guard flag OFF and low novelty", async () => {
    // Conflicting file:line anchors, low novelty. U5's band-level veto (flag-independent)
    // must keep both regardless of U6's novelty gate.
    const candidate = makeCandidate({
      l2: "parser bug: continuity-report.ts:84",
    });
    const r = await arb({ text: "parser bug: continuity-report.ts:419", candidate });
    expect(r.outcome).toBe("create");
    expect(r.reason).toMatch(/referent-anchor-conflict/);
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4 — keepboth-derivation fixture sweep (post-fixture-fix). incomingText is now
// the packet's real incoming_text_trunc (genuinely non-identical to candidateText on
// all 26 rows) and candidateTags is the live DB payload.tags of the target.
// incomingTags is honestly null (unrecoverable from this corpus — see header note).
//
// FEASIBILITY-GATE FINDING: even feeding the STRONGEST synthetic case (forced disjoint
// subject tags on both sides, guaranteeing conflictingSubjects() would fire if
// mergeKeepBothReason were reached), 0 of 9 dup_recapture rows and 0 of 17
// clean_distinct rows ever reach mergeKeepBothReason through arbitrateWrite. On 23/26
// rows the normalized incomingText is a literal substring of the normalized
// candidateText (the DB candidate is the production system's OWN post-merge output —
// the applied lane already merged the incoming into this exact record), so the
// merge-band's containment-skip ("existing memory already contains incoming detail")
// or the merge-resolves-to-existing-text skip fires first, every time. This is a
// structural property of this corpus (candidate DB snapshots are post-merge, not
// pre-arbitration), not something further tag/text engineering on the fixture can fix
// without inventing candidate text the DB does not contain — which would violate the
// referent-identity invariant (candidate text is ALWAYS the live DB fetch). So this
// fixture is used ONLY as an honest negative corpus (real same-fact and real
// distinct-fact text both get absorbed upstream, never mint a wrongful keep-both);
// it cannot serve as a per-row positive/negative discriminator for mergeKeepBothReason
// itself. That discrimination is proven by the synthetic controls in Groups 1-3, which
// use handcrafted pre-arbitration candidate/incoming pairs carrying the actual
// distinguishing signal this leg consumes.
// ─────────────────────────────────────────────────────────────────────────────
interface KeepBothRow {
  rowId: string;
  incomingText: string;
  candidateText: string;
  incomingTags: string[] | null;
  candidateTags: string[] | null;
  guardLeg: string;
  verdict: "clean_distinct" | "dup_recapture";
  expectedFire: boolean;
  incomingTagsUnavailable: boolean;
  postHocLimited: boolean;
}
const FIXTURE_PATH = resolve(
  "src/storage/writes/__tests__/fixtures/referent-identity/keepboth-derivation.json",
);
const keepBothRows: KeepBothRow[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("U6 — keepboth-derivation fixture sweep (flag ON)", () => {
  beforeEach(() => { process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1"; });

  it("fixture shape invariants (KTD7): 9 dup_recapture, all conflicting-subjects; 17 clean_distinct", () => {
    const dup = keepBothRows.filter((r) => r.verdict === "dup_recapture");
    const clean = keepBothRows.filter((r) => r.verdict === "clean_distinct");
    expect(keepBothRows.length).toBe(26);
    expect(dup.length).toBe(9);
    expect(clean.length).toBe(17);
    expect(dup.every((r) => r.guardLeg === "conflicting-subjects")).toBe(true);
    expect(dup.every((r) => r.expectedFire === false)).toBe(true);
    expect(clean.every((r) => r.expectedFire === true)).toBe(true);
    // Fixture-fix (pn1l.13.4): incoming is now the packet's real incoming_text_trunc —
    // no longer byte-identical to candidateText on any row.
    expect(keepBothRows.every((r) => r.incomingText !== r.candidateText)).toBe(true);
    // Candidate tags are real (live DB payload.tags); incoming tags are honestly absent
    // (never captured by the shadow logger — see header note, not fabricated).
    expect(keepBothRows.every((r) => Array.isArray(r.candidateTags) && r.candidateTags.length > 0)).toBe(true);
    expect(keepBothRows.every((r) => r.incomingTags === null && r.incomingTagsUnavailable === true)).toBe(true);
  });

  it("all 9 dup_recapture rows → guard SILENT (absorbed upstream, no keep-both create)", async () => {
    const dup = keepBothRows.filter((r) => r.verdict === "dup_recapture");
    expect(dup.length).toBe(9);
    const keptBoth: string[] = [];
    for (const row of dup) {
      (supersedeMemory as Mock).mockClear();
      (updateMemoryText as Mock).mockClear();
      // Feed the row's real (now non-identical) text with disjoint synthetic subject
      // tags (the strongest case for a wrongful keep-both). The guard must never mint
      // a duplicate: on this corpus the merge-band containment-skip absorbs the real
      // incoming text before mergeKeepBothReason is ever reached (feasibility-gate
      // finding above), and even if it were reached, U6's novelty gate would silence
      // the non-novel leg.
      const candidate = makeCandidate({ l2: row.candidateText, tags: CAND_SUBJECT_TAGS });
      const r = await arb({
        text: row.incomingText,
        candidate,
        incomingTags: INC_SUBJECT_TAGS,
      });
      if (r.outcome === "create" && /keep-both guard/.test(r.reason ?? "")) {
        keptBoth.push(`${row.rowId}: ${r.reason}`);
      }
      expect(supersedeMemory).not.toHaveBeenCalled();
    }
    expect(keptBoth).toEqual([]);
  });

  it("no fixture row produces a conflicting-subjects keep-both (all absorbed by an earlier band)", async () => {
    const wronglyFired: string[] = [];
    for (const row of keepBothRows) {
      const candidate = makeCandidate({ l2: row.candidateText, tags: CAND_SUBJECT_TAGS });
      const r = await arb({
        text: row.incomingText,
        candidate,
        incomingTags: INC_SUBJECT_TAGS,
      });
      if (/conflicting-subjects/.test(r.reason ?? "")) wronglyFired.push(row.rowId);
    }
    expect(wronglyFired).toEqual([]);
  });
});
