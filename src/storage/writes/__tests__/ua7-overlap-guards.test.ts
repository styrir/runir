import { describe, expect, it } from "vitest";
import { DEFAULT_ARBITRATION_CONFIG, type SimilarCandidate } from "../../../domain/memory/types.js";
import { resolveDecision } from "../write-arbitrator.js";
import { wouldSupersedeTexts } from "../write-signals.js";

const now = Date.parse("2026-09-25T10:00:00Z");
const candidate = (l2: string, tags: string[] = []): SimilarCandidate => ({
  id: "old", l2, tags, similarity: 0.9, createdAt: new Date(now - 60_000).toISOString(),
});
function decide(text: string, old: SimilarCandidate, tags: string[] = [], f2 = false, fusion = false) {
  return resolveDecision(text, [], [old], [], DEFAULT_ARBITRATION_CONFIG, tags,
    false, false, false, undefined, undefined, 0, false, false, {}, now,
    false, false, now, f2, fusion);
}

describe("ua7 live overlap guards", () => {
  const oldTags = ["project:atlas", "role:tech-lead", "person:priya-nair"];
  const newTags = ["project:atlas", "role:tech-lead", "subject:marcus-webb", "update"];

  it("keeps an unproven F2 overlap when enabled and preserves the old retirement when disabled", () => {
    const old = candidate("Priya Nair is the tech lead for Atlas.", oldTags);
    const incoming = "Marcus Webb is the new Atlas tech lead, replacing Priya.";
    expect(wouldSupersedeTexts(old.l2, incoming)).toBe(false);
    expect(decide(incoming, old, newTags).outcome).toBe("supersede");
    const guarded = decide(incoming, old, newTags, true);
    expect(guarded.outcome).toBe("create");
    expect(guarded.reason).toContain("F2 value-change guard");
    expect(guarded.candidate).toBeUndefined();
  });

  it("still supersedes a true value change on an unproven, tagged F2 path", () => {
    const old = candidate("Atlas backend is Postgres.", ["project:atlas", "slot:backend"]);
    const incoming = "Atlas backend is SurrealDB.";
    const tags = ["project:atlas", "slot:backend", "update"];
    expect(wouldSupersedeTexts(old.l2, incoming)).toBe(true);
    expect(decide(incoming, old, tags, true).outcome).toBe("supersede");
  });

  it("preserves proven F1 retirement", () => {
    const old = { ...candidate("Atlas backend is Postgres."), factKey: "atlas:backend" };
    const incoming = "Atlas backend is SurrealDB.";
    const result = resolveDecision(incoming, [], [old], [], DEFAULT_ARBITRATION_CONFIG,
      [], false, false, false, undefined, undefined, 0, false, false,
      { factKey: "atlas:backend" }, now, false, false, now, true, false);
    expect(result.outcome).toBe("supersede");
    expect(result.supersedeSignal).toBe("deterministic_text");
  });

  it("turns sentence fusion into create only with W3 enabled", () => {
    const old = candidate("Atlas uses Postgres.");
    const incoming = "Atlas has a backup server.";
    expect(decide(incoming, old).outcome).toBe("merge-update");
    const guarded = decide(incoming, old, [], false, true);
    expect(guarded.outcome).toBe("create");
    expect(guarded.candidate).toBeUndefined();
    expect(guarded.reason).toContain("merge fusion guard");
  });

  it("preserves stored containment skip and incoming containment merge", () => {
    const old = candidate("Atlas uses Postgres. Atlas has backups.");
    expect(decide("Atlas uses Postgres.", old, [], false, true).outcome).toBe("skip");
    const short = candidate("Atlas uses Postgres.");
    expect(decide("Atlas uses Postgres. Atlas has backups.", short, [], false, true).outcome).toBe("merge-update");
  });

  it("keeps both sides of the longer-text fallback when W3 is enabled", () => {
    const old = candidate("A".repeat(650) + ".");
    const incoming = "B".repeat(650) + ".";
    expect(decide(incoming, old).outcome).toBe("merge-update");
    expect(decide(incoming, old, [], false, true).outcome).toBe("create");
    expect(decide("A".repeat(650) + ".", candidate("B".repeat(651) + "."), [], false, true).outcome).toBe("create");
  });
});
