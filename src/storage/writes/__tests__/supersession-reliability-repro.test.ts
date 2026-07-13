import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Mock dag-guard before importing write-arbitrator
vi.mock("../../lifecycle/semion/dag-guard.js", () => ({
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
}));

// Mock surreal-store
vi.mock("../../surreal/surreal-store.js", () => ({
  findSimilarMemories: vi.fn().mockResolvedValue([]),
  updateMemoryText: vi.fn().mockResolvedValue(undefined),
  upsertMemory: vi.fn().mockResolvedValue("new-id"),
  supersedeMemory: vi.fn().mockResolvedValue(undefined),
  SurrealClient: class {
    query = vi.fn().mockResolvedValue([[]]);
  },
}));

import { arbitrateWrite } from "../write-arbitrator.js";
import {
  findSimilarMemories,
  updateMemoryText,
  supersedeMemory,
} from "../../surreal/surreal-store.js";
import type { RecentWrite, SimilarCandidate } from "../../../domain/memory/types.js";

function makeDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}
function makeVec(seed: number, len = 8): number[] {
  return Array.from({ length: len }, (_, i) => (i === seed % len ? 1 : 0));
}
function makeCandidate(overrides: Partial<SimilarCandidate> = {}): SimilarCandidate {
  const now = new Date().toISOString();
  return { id: "existing-id", l2: "existing memory text", similarity: 0.9, createdAt: now, updatedAt: now, ...overrides };
}
async function arb(
  text: string,
  candidate: SimilarCandidate,
  tags?: string[],
  extraMetadata?: Record<string, unknown>,
) {
  (findSimilarMemories as Mock).mockResolvedValue([candidate]);
  const embedding = makeVec(0);
  return arbitrateWrite({
    db: makeDb(),
    text,
    userId: "u1",
    embedding,
    scope: "user",
    source: "memory_store",
    recentWrites: new Map<string, RecentWrite[]>(),
    embedText: vi.fn().mockResolvedValue(embedding),
    ...((tags || extraMetadata)
      ? { metadata: { ...(tags ? { tags } : {}), ...extraMetadata } }
      : {}),
  });
}

// Rúnir-pn1l.13.4 (U5): F1 (deterministic_text) is now NOMINATE-ONLY — a same-key value
// change retires the candidate ONLY with a proven referent identity. In production a
// same-subject value correction carries a shared atomicFact {subject, predicate} (stable
// across the value change), which proves identity via key:atomicFactIdentity. These F1
// tests thread that shared atomicFact so the correction proves and supersedes (the pair's
// intent: "a genuine value-change correction supersedes across the band"). Keyless text-only
// pairs are covered as blocked in referent-gate-arbitration.test.ts.
const ATLAS_DATASTORE_FACT = { subject: "Atlas primary datastore", predicate: "is" };
function proveIdentity(): Record<string, unknown> {
  return { atomicFact: { ...ATLAS_DATASTORE_FACT, value: "SurrealDB" } };
}

// F1 REGRESSION GATE — a same-subject-key value change must supersede across the
// FULL similarity band, deterministically, instead of flipping skip/merge at 0.95.
describe("Rúnir-w077 F1 — skip band no longer swallows corrections", () => {
  beforeEach(() => {
  process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF = "1"; // Rúnir-h435.1 [R1-1] applied atomic authority for F1 fixtures
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });

  it("merge band (cosine 0.93): value-change correction SUPERSEDES", async () => {
    const r = await arb(
      "Atlas primary datastore is Postgres",
      makeCandidate({ similarity: 0.93, l2: "Atlas primary datastore is SurrealDB", atomicFact: { ...ATLAS_DATASTORE_FACT, value: "SurrealDB" } }),
      undefined,
      proveIdentity(),
    );
    expect(r.outcome).toBe("supersede");
  });

  it("skip band (cosine 0.96): SAME correction now SUPERSEDES (was silently skipped)", async () => {
    const r = await arb(
      "Atlas primary datastore is Postgres",
      makeCandidate({ similarity: 0.96, l2: "Atlas primary datastore is SurrealDB", atomicFact: { ...ATLAS_DATASTORE_FACT, value: "SurrealDB" } }),
      undefined,
      proveIdentity(),
    );
    // Same input as the 0.93 row → SAME outcome now. The 0.95 coin-flip is gone.
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // Codex guard rows: F1 must not turn reworded/aliased DUPLICATES into churn.
  it("alias reword (Postgres → PostgreSQL, cosine 0.97): NOT superseded (substring → dup)", async () => {
    const r = await arb(
      "Atlas primary datastore is PostgreSQL",
      makeCandidate({ similarity: 0.97, l2: "Atlas primary datastore is Postgres" }),
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("exact duplicate (cosine 0.99): skips, never supersedes", async () => {
    const r = await arb(
      "Atlas primary datastore is SurrealDB",
      makeCandidate({ similarity: 0.99, l2: "Atlas primary datastore is SurrealDB" }),
    );
    expect(r.outcome).toBe("skip");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });
});

// F2 REGRESSION GATE — role handoff. The extractor tags the correction (`update`)
// and the candidate carries slot tags; arbitration must supersede cleanly, not
// append a compound. Mirrors the live extractor output (probe 2026-06-21).
describe("Rúnir-w077 F2 — tagged corrections supersede; ambiguous/untagged stay safe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
  });

  it("role handoff (shared slot tags + update marker): SUPERSEDES cleanly", async () => {
    const r = await arb(
      "Marcus Webb is the new Atlas tech lead, replacing Priya.",
      makeCandidate({
        similarity: 0.88,
        l2: "Priya Nair is the tech lead for the Atlas project.",
        tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
      }),
      ["subject:marcus-webb", "project:atlas", "role:tech-lead", "update"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled(); // no compound append
  });

  it("datastore migration (correction names old value + update marker): SUPERSEDES", async () => {
    const r = await arb(
      "Update: Atlas has migrated off SurrealDB; the primary datastore is now Postgres.",
      makeCandidate({
        similarity: 0.96,
        l2: "The Atlas project has been initiated with SurrealDB as the primary datastore.",
        tags: ["project:atlas", "datastore:surrealdb", "status:active"],
      }),
      ["project:atlas", "datastore:postgres", "update"],
    );
    expect(r.outcome).toBe("supersede");
  });

  it("co-valid same-subject facts (update marker but NOT a correction): does NOT supersede", async () => {
    // Two distinct preferences. The marker is present but there is no shared
    // slot and the incoming does not name the candidate's value → must not
    // delete the co-valid fact. Coexistence (create), never supersede.
    const r = await arb(
      "The user prefers reduced motion.",
      makeCandidate({
        similarity: 0.88,
        l2: "The user prefers dark mode.",
        tags: ["preference:dark-mode"],
      }),
      ["preference:reduced-motion", "update"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("cross-entity named tech (Speki update names SurrealDB; candidate is Atlas): NO supersede", async () => {
    // Codex precision case: a correction about a DIFFERENT subject that merely
    // names a shared tech must not supersede the co-valid fact. They share only
    // "surrealdb" (the named value) — no other context token → blocked.
    const r = await arb(
      "Update: Speki migrated off SurrealDB to Postgres.",
      makeCandidate({
        similarity: 0.9,
        l2: "Atlas uses SurrealDB for audit logs.",
        tags: ["project:atlas", "datastore:surrealdb"],
      }),
      ["project:speki", "datastore:postgres", "update"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("cross-entity sharing subsystem nouns (audit/logs) + conflicting project tags: NO supersede", async () => {
    // Codex round-2 case: even when the two facts share "audit"/"logs" AND the
    // named tech, the disjoint subject tags (project:atlas vs project:speki)
    // prove different entities → the conflicting-subject guard blocks it.
    const r = await arb(
      "Update: Speki migrated audit logs off SurrealDB to Postgres.",
      makeCandidate({
        similarity: 0.9,
        l2: "Atlas uses SurrealDB for audit logs.",
        tags: ["project:atlas", "datastore:surrealdb"],
      }),
      ["project:speki", "datastore:postgres", "update"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("role handoff with NO correction tag: stays conservative (no false supersede)", async () => {
    const r = await arb(
      "Marcus Webb is the Atlas tech lead",
      makeCandidate({
        similarity: 0.88,
        l2: "Priya Nair is the Atlas tech lead",
        tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
      }),
    );
    // Without the extractor's correction marker we cannot tell handoff from a
    // second co-valid person → must not supersede.
    expect(r.outcome).not.toBe("supersede");
  });
});

// Rúnir-pn1l LAYER 0 — the deterministic CUED functional-slot gate. Generic failure
// mode: the extractor DROPS the correction marker (nondeterministic), so F2's
// tag-driven supersede never fires and the corrected fact coexists with the stale one
// (tag-drop → coexistence → stale recall). Layer 0 un-gates the slot/named-value paths
// from the marker WHEN the incoming TEXT carries a currentness/replacement cue
// ("replacing", "migrated", "the new", "is now", ...), while keeping the structural
// slot conflict + the conflicting-subject (cross-entity) guard. Behind
// RUNIR_SUPERSEDE_CUE_GATE (default OFF) until the live write-integrity probe gates it on.
describe("Rúnir-pn1l Layer 0 — cued tag-free supersession (RUNIR_SUPERSEDE_CUE_GATE)", () => {
  const PRIOR = process.env.RUNIR_SUPERSEDE_CUE_GATE;
  beforeEach(() => {
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
  });
  afterEach(() => {
  delete process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF;
    if (PRIOR === undefined) delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
    else process.env.RUNIR_SUPERSEDE_CUE_GATE = PRIOR;
  });

  it("THE FIX: cued role handoff, slot tags present, NO correction marker → SUPERSEDES", async () => {
    const r = await arb(
      "Marcus Webb is the new Atlas tech lead, replacing Priya.",
      makeCandidate({
        similarity: 0.88,
        l2: "Priya Nair is the tech lead for the Atlas project.",
        tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
      }),
      ["subject:marcus-webb", "project:atlas", "role:tech-lead"], // NO `update` marker
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
    expect(updateMemoryText).not.toHaveBeenCalled();
  });

  it("SCOPE: cued datastore migration WITHOUT marker → NOT superseded by Layer 0 (named-value deferred)", async () => {
    // Layer 0 increment-1 is the deterministic SLOT-conflict path only. A tag-free
    // named-value change ("migrated off SurrealDB") is ambiguous (replace vs retain)
    // and is deferred to the extractor marker (w077) or the future Layer 2 judge.
    const r = await arb(
      "Atlas has migrated off SurrealDB; the primary datastore is now Postgres.",
      makeCandidate({
        similarity: 0.96,
        l2: "The Atlas project has been initiated with SurrealDB as the primary datastore.",
        tags: ["project:atlas", "datastore:surrealdb", "status:active"],
      }),
      ["project:atlas", "datastore:postgres"], // NO `update` marker
    );
    expect(r.outcome).not.toBe("supersede");
  });

  it("GUARD: cue naming the old value in a RETENTION context, no marker → NOT superseded", async () => {
    // Codex round-2 holdout: an additive sentence that NAMES the old value while
    // keeping it ("SurrealDB remains") must not supersede via the named-value path —
    // which is exactly why named-value is marker-only in Layer 0.
    const r = await arb(
      "Atlas is now using Postgres for analytics; SurrealDB remains for audit logs.",
      makeCandidate({
        similarity: 0.92,
        l2: "Atlas uses SurrealDB for audit logs.",
        tags: ["project:atlas", "datastore:surrealdb"],
      }),
      ["project:atlas", "datastore:postgres"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("GUARD: cue present but NO slot conflict (different preference) → does NOT supersede", async () => {
    // The cue alone is necessary, not sufficient — the structural slot/value
    // conflict is still required, so a cued but co-valid fact stays.
    const r = await arb(
      "The user now prefers reduced motion.",
      makeCandidate({
        similarity: 0.9,
        l2: "The user prefers dark mode.",
        tags: ["preference:dark-mode"],
      }),
      ["preference:reduced-motion"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("GUARD: cue + 2 shared slot tags but SAME subject/value (scope distinction) → does NOT supersede", async () => {
    // Codex over-fire holdout: a currentness cue + two shared slot tags is NOT a
    // correction when no value actually changed (same project, same datastore;
    // differs only in free-text use). Must stay co-valid (create), never supersede.
    const r = await arb(
      "Atlas is now using Postgres for analytics.",
      makeCandidate({
        similarity: 0.92,
        l2: "Atlas uses Postgres for app data.",
        tags: ["project:atlas", "datastore:postgres"],
      }),
      ["project:atlas", "datastore:postgres"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("GUARD: cued CROSS-ENTITY (Speki migration names Atlas tech) → conflicting-subject blocks it", async () => {
    const r = await arb(
      "Speki migrated off SurrealDB to Postgres.",
      makeCandidate({
        similarity: 0.9,
        l2: "Atlas uses SurrealDB for audit logs.",
        tags: ["project:atlas", "datastore:surrealdb"],
      }),
      ["project:speki", "datastore:postgres"], // cue present, disjoint subject
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("GUARD: bare handoff with NO cue and NO marker → still conservative even with gate ON", async () => {
    const r = await arb(
      "Marcus Webb is the Atlas tech lead",
      makeCandidate({
        similarity: 0.88,
        l2: "Priya Nair is the Atlas tech lead",
        tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
      }),
    );
    // No currentness cue → structurally undecidable (co-lead vs replacement) → keep both.
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("OPT-IN: with the gate OFF, the cued handoff stays conservative (zero default-behavior change)", async () => {
    delete process.env.RUNIR_SUPERSEDE_CUE_GATE; // simulate prod default
    const r = await arb(
      "Marcus Webb is the new Atlas tech lead, replacing Priya.",
      makeCandidate({
        similarity: 0.88,
        l2: "Priya Nair is the tech lead for the Atlas project.",
        tags: ["project:atlas", "role:tech-lead", "person:priya-nair"],
      }),
      ["subject:marcus-webb", "project:atlas", "role:tech-lead"],
    );
    expect(r.outcome).not.toBe("supersede");
  });
});

// Rúnir-pn1l.9 — generalize the directional-transition currentness GRAMMAR so it
// recognizes natural correction phrasing the literal-regex list missed. Generic
// failure mode: the transition cues required the direction preposition to sit
// IMMEDIATELY after switch/move/transition ("switched to"), so an intervening
// adverb ("switching AWAY from", "moved directly away from", "switched directly
// over to") and the "away" direction itself were never matched — a real product
// defect (preference-drift gold=supersede SKIPPED, Scout A). The fix expresses the
// abandonment/transition grammar generally (optional adverb + `away` direction +
// "in favor of" / "dropped|ditched X for" abandonment framing), NOT row keywords.
// w077 invariant unchanged: a cue is necessary-not-sufficient — the same-slot value
// change (sharesSlotTags + subjectsChanged) is still required, additive refinements
// (subjectsChanged=false) and bare "now also" must still keep-both.
describe("Rúnir-pn1l.9 — directional-transition cue grammar (UNSEEN-paraphrase holdouts)", () => {
  const PRIOR = process.env.RUNIR_SUPERSEDE_CUE_GATE;
  beforeEach(() => {
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([]);
    (updateMemoryText as Mock).mockResolvedValue(undefined);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
    process.env.RUNIR_SUPERSEDE_CUE_GATE = "1";
  });
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.RUNIR_SUPERSEDE_CUE_GATE;
    else process.env.RUNIR_SUPERSEDE_CUE_GATE = PRIOR;
  });

  // POSITIVE HOLDOUTS — unseen paraphrases (NOT the cassette "switching away from
  // Dracula"); each is a same-slot value change that the broadened grammar must
  // recognize as a currentness cue and therefore SUPERSEDE on the slot path.
  it("'moved away from Postgres to MySQL' (adverb before direction) → SUPERSEDES", async () => {
    const r = await arb(
      "Dana Cole moved away from Postgres to MySQL for the Atlas store.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole uses Postgres for the Atlas store.",
        tags: ["project:atlas", "person:dana-cole", "subject:postgres"],
      }),
      ["project:atlas", "person:dana-cole", "subject:mysql"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("'transitioned away from Jenkins to GitHub Actions' → SUPERSEDES", async () => {
    const r = await arb(
      "The team transitioned away from Jenkins to GitHub Actions for CI.",
      makeCandidate({
        similarity: 0.9,
        l2: "The team uses Jenkins for CI.",
        tags: ["project:atlas", "domain:ci", "subject:jenkins"],
      }),
      ["project:atlas", "domain:ci", "subject:github-actions"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("'switched directly over to Vim' (adverb before 'over to') → SUPERSEDES", async () => {
    const r = await arb(
      "Dana Cole switched directly over to Vim as the editor.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole uses VS Code as the editor.",
        tags: ["preference:editor", "person:dana-cole"],
      }),
      ["preference:editor", "person:dana-cole", "subject:vim"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("'dropped Redux in favor of Zustand' (abandonment framing) → SUPERSEDES", async () => {
    const r = await arb(
      "Dana Cole dropped Redux in favor of Zustand for state management.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole uses Redux for state management.",
        tags: ["domain:state-mgmt", "person:dana-cole", "subject:redux"],
      }),
      ["domain:state-mgmt", "person:dana-cole", "subject:zustand"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  it("'ditched Slack for Discord' (abandonment framing) → SUPERSEDES", async () => {
    const r = await arb(
      "Dana Cole ditched Slack for Discord as the chat tool.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole uses Slack as the chat tool.",
        tags: ["preference:chat", "person:dana-cole", "subject:slack"],
      }),
      ["preference:chat", "person:dana-cole", "subject:discord"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // The cassette-shaped phrasing (proves the original defect closes too).
  it("'now prefers Solarized, switching away from Dracula' → SUPERSEDES", async () => {
    const r = await arb(
      "Dana Cole now prefers the Solarized editor color scheme, switching away from Dracula.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole prefers the Dracula editor color scheme.",
        tags: ["preference:ui-theme", "person:dana-cole"],
      }),
      ["preference:ui-theme", "person:dana-cole", "subject:solarized"],
    );
    expect(r.outcome).toBe("supersede");
    expect(supersedeMemory).toHaveBeenCalled();
  });

  // NEGATIVE HOLDOUTS — w077 invariant: a cue is necessary-not-sufficient. These
  // must keep-both (never supersede), even with the broadened grammar + gate ON.
  it("w077: additive 'X remains the lead; Y also joined' (subjectsChanged=false) → keep both", async () => {
    const r = await arb(
      "Priya Nair remains the on-call lead; Marcus Webb also joined the rotation.",
      makeCandidate({
        similarity: 0.9,
        l2: "Priya Nair is the on-call lead for Atlas.",
        tags: ["project:atlas", "role:on-call-lead", "person:priya-nair"],
      }),
      ["project:atlas", "role:on-call-lead", "person:priya-nair"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("w077: bare 'now also uses a second monitor' (additive, no abandonment) → keep both", async () => {
    const r = await arb(
      "Dana Cole now also uses a second monitor.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole uses a standing desk.",
        tags: ["preference:workspace", "person:dana-cole"],
      }),
      ["preference:workspace", "person:dana-cole", "subject:second-monitor"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("w077: cue-less same-slot value change (no transition framing) → keep both", async () => {
    const r = await arb(
      "Marcus Webb is the on-call lead for Atlas.",
      makeCandidate({
        similarity: 0.9,
        l2: "Priya Nair is the on-call lead for Atlas.",
        tags: ["project:atlas", "role:on-call-lead", "person:priya-nair"],
      }),
      ["project:atlas", "role:on-call-lead", "person:marcus-webb"],
    );
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("OPT-IN: directional-transition cue with the gate OFF stays conservative", async () => {
    delete process.env.RUNIR_SUPERSEDE_CUE_GATE; // simulate prod default
    const r = await arb(
      "Dana Cole moved away from Postgres to MySQL for the Atlas store.",
      makeCandidate({
        similarity: 0.9,
        l2: "Dana Cole uses Postgres for the Atlas store.",
        tags: ["project:atlas", "datastore:postgres", "person:dana-cole"],
      }),
      ["project:atlas", "datastore:mysql", "person:dana-cole"],
    );
    expect(r.outcome).not.toBe("supersede");
  });

  // ── OVER-MATCH NEGATIVES (Codex REVISE MUST-FIX) ──────────────────────────
  // Each phrase was a false positive in the broadened-but-undertightened patterns.
  // Assertions cover (a) does NOT supersede on the cue path AND (b) with
  // RUNIR_MERGE_KEEPBOTH_GUARD=1 does NOT suppress the ambiguous-slot-change-no-cue
  // keep-both (the false cue would suppress the guard, letting a bare handoff
  // wrongly merge-fold). Both are needed because hasCurrentnessCue is used
  // independently at :795 (cueGate), :663 (mergeKeepBothReason), :634 (isJudgeWorthy).

  it("OVER-MATCH: 'switch users to admin' — direct object between switch and to → NOT a cue", async () => {
    // (a) does NOT supersede
    const candidate = makeCandidate({
      similarity: 0.9,
      l2: "The admin panel manages user roles.",
      tags: ["project:atlas", "role:admin", "person:priya-nair"],
    });
    const incoming = ["project:atlas", "role:admin", "person:marcus-webb"];
    const r = await arb("The team will switch users to admin in Atlas.", candidate, incoming);
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    // (b) RUNIR_MERGE_KEEPBOTH_GUARD=1: false cue must NOT suppress the keep-both guard
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([candidate]);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
    const r2 = await arb("The team will switch users to admin in Atlas.", candidate, incoming);
    expect(r2.outcome).toBe("create");
    expect(r2.reason).toMatch(/ambiguous-slot-change-no-cue/);
    delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  });

  it("OVER-MATCH: 'moved on the proposal' — 'on' without 'to' → NOT a cue", async () => {
    const candidate = makeCandidate({
      similarity: 0.9,
      l2: "The team is reviewing the Atlas proposal.",
      tags: ["project:atlas", "role:reviewer", "person:priya-nair"],
    });
    const incoming = ["project:atlas", "role:reviewer", "person:marcus-webb"];
    // (a)
    const r = await arb("Marcus Webb moved on the proposal for Atlas.", candidate, incoming);
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    // (b)
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([candidate]);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
    const r2 = await arb("Marcus Webb moved on the proposal for Atlas.", candidate, incoming);
    expect(r2.outcome).toBe("create");
    expect(r2.reason).toMatch(/ambiguous-slot-change-no-cue/);
    delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  });

  it("OVER-MATCH: 'dropped the ball for the team' — idiomatic, not abandonment → NOT a cue", async () => {
    const candidate = makeCandidate({
      similarity: 0.9,
      l2: "Priya Nair leads the Atlas delivery.",
      tags: ["project:atlas", "role:delivery-lead", "person:priya-nair"],
    });
    const incoming = ["project:atlas", "role:delivery-lead", "person:marcus-webb"];
    // (a)
    const r = await arb("Marcus Webb dropped the ball for the team on delivery.", candidate, incoming);
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    // (b)
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([candidate]);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
    const r2 = await arb("Marcus Webb dropped the ball for the team on delivery.", candidate, incoming);
    expect(r2.outcome).toBe("create");
    expect(r2.reason).toMatch(/ambiguous-slot-change-no-cue/);
    delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  });

  it("OVER-MATCH: 'argued in favor of Postgres' — opinion, not replacement → NOT a cue", async () => {
    const candidate = makeCandidate({
      similarity: 0.9,
      l2: "The Atlas database is SurrealDB.",
      tags: ["project:atlas", "domain:database", "person:priya-nair"],
    });
    const incoming = ["project:atlas", "domain:database", "person:marcus-webb"];
    // (a)
    const r = await arb("Marcus Webb argued in favor of Postgres for Atlas.", candidate, incoming);
    expect(r.outcome).not.toBe("supersede");
    expect(supersedeMemory).not.toHaveBeenCalled();
    // (b)
    vi.clearAllMocks();
    (findSimilarMemories as Mock).mockResolvedValue([candidate]);
    (supersedeMemory as Mock).mockResolvedValue(undefined);
    process.env.RUNIR_MERGE_KEEPBOTH_GUARD = "1";
    const r2 = await arb("Marcus Webb argued in favor of Postgres for Atlas.", candidate, incoming);
    expect(r2.outcome).toBe("create");
    expect(r2.reason).toMatch(/ambiguous-slot-change-no-cue/);
    delete process.env.RUNIR_MERGE_KEEPBOTH_GUARD;
  });
});
