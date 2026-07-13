/**
 * Rúnir-h435.1 Unit B — B-5 atomic primary labeling view (type-level + runtime sentinel).
 *
 * Existing toPrimaryLabelingView is UNTOUCHED; this exercises ONLY toAtomicPrimaryLabelingView.
 */
import { describe, it, expect } from "vitest";
import {
  toAtomicPrimaryLabelingView,
  type AtomicShadowLabelingDto,
  type AtomicPrimaryLabelingView,
} from "../../../../scripts/g004/shadow_adjudication_types.js";

const SENTINEL = "ZZZ_ATOMIC_SENTINEL_H435_B5_UNIQUE";

function makeDto(): AtomicShadowLabelingDto {
  return {
    write_event_id: "we-1",
    activation_class: "safety_activation",
    isolated_outcome: "supersede",
    isolated_matched_id: "cand-1",
    isolated_referent_proof: `key:atomicFactIdentity:${SENTINEL}`,
    isolated_guard_keep_both_reason: `guard:${SENTINEL}`,
    isolated_unresolved: null,
    applied_outcome: "create",
    applied_matched_id: null,
    lane_clock_ms: 1_700_000_000_000,
    signal: `deterministic_text:${SENTINEL}`,
    nomination_dispositions: [
      {
        nomination_candidate_id: "cand-1",
        disposition: "proven-retired",
      },
      {
        nomination_candidate_id: "cand-2",
        disposition: "proven-not-selected",
        selected_candidate_id: "cand-1",
        selected_signal: `deterministic_text:${SENTINEL}`,
      },
    ],
    incoming_snapshot: {
      text: "primary engine: Dragonfly for Atlas",
      tags: ["update"],
      atomicFact: {
        subject: SENTINEL,
        predicate: SENTINEL,
        value: SENTINEL,
      },
      canonicalIdentity: `${SENTINEL}|${SENTINEL}`,
      canonicalTriple: {
        subject: SENTINEL,
        predicate: SENTINEL,
        value: SENTINEL,
      },
      tier: "ephemeral",
      validAt: "2026-02-01T00:00:00.000Z",
    },
    candidate_snapshot: {
      id: "cand-1",
      text: "primary engine: SurrealDB for Atlas",
      tags: ["subject:atlas"],
      atomicFact: {
        subject: SENTINEL,
        predicate: SENTINEL,
        value: SENTINEL,
      },
      tier: "durable",
      validAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      referentKeys: {
        factKey: `fk:${SENTINEL}`,
        continuitySubjectKey: `cs:${SENTINEL}`,
        atomicFactIdentity: `${SENTINEL}|${SENTINEL}`,
      },
    },
  };
}

describe("B-5 toAtomicPrimaryLabelingView", () => {
  it("B-5 runtime: unique sentinels in every excluded field are absent from rendered view (recursive)", () => {
    const view = toAtomicPrimaryLabelingView(makeDto());
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SENTINEL);
    // Content survives
    expect(view.incoming_snapshot.text).toContain("Dragonfly");
    expect(view.candidate_snapshot?.text).toContain("SurrealDB");
    expect(view.write_event_id).toBe("we-1");
    expect(view.isolated_outcome).toBe("supersede");
  });

  it("B-5 type-level: stripped fields are not on the view shape", () => {
    const view: AtomicPrimaryLabelingView = toAtomicPrimaryLabelingView(makeDto());
    // @ts-expect-error activation_class must not exist on AtomicPrimaryLabelingView
    const _a = view.activation_class;
    // @ts-expect-error isolated_referent_proof must not exist
    const _b = view.isolated_referent_proof;
    // @ts-expect-error signal must not exist
    const _c = view.signal;
    // @ts-expect-error nomination_dispositions must not exist
    const _d = view.nomination_dispositions;
    // @ts-expect-error nested raw atomicFact must not exist on incoming
    const _e = view.incoming_snapshot.atomicFact;
    // @ts-expect-error nested canonicalIdentity must not exist
    const _f = view.incoming_snapshot.canonicalIdentity;
    // @ts-expect-error nested canonicalTriple must not exist
    const _g = view.incoming_snapshot.canonicalTriple;
    // @ts-expect-error nested candidate atomicFact must not exist
    const _h = view.candidate_snapshot?.atomicFact;
    // @ts-expect-error nested referentKeys must not exist
    const _i = view.candidate_snapshot?.referentKeys;
    void _a;
    void _b;
    void _c;
    void _d;
    void _e;
    void _f;
    void _g;
    void _h;
    void _i;
    expect(view.incoming_snapshot.text).toBeTruthy();
  });
});
