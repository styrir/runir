import type { GateResult } from "../types.js";

export function harmGates(crossScopePass: boolean, sourceExcerptCount: number): GateResult[] {
  return [
    { id: "harm.cross_scope_lookup", family: "harm", status: crossScopePass ? "pass" : "fail", counts: { foreignExcerpts: Number(!crossScopePass) } },
    { id: "harm.annotation_correction", family: "harm", status: sourceExcerptCount === 0 ? "pending_fail_closed" : "fail",
      counts: { correctionCases: 1, sourceExcerpts: sourceExcerptCount }, note: "annotation_pending_slice5" },
  ];
}
