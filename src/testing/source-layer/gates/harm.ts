import type { GateResult } from "../types.js";

export function harmGates(e: { crossScopePass: boolean; correctionPass: boolean; injectionPass: boolean;
  shadowPass: boolean; sourceFailurePass: boolean }): GateResult[] {
  return [
    { id: "harm.cross_scope_lookup", family: "harm", status: e.crossScopePass ? "pass" : "fail", counts: { passed: Number(e.crossScopePass) } },
    { id: "harm.annotation_correction", family: "harm", status: e.correctionPass ? "pass" : "fail", counts: { passed: Number(e.correctionPass) } },
    { id: "harm.injection_boundary", family: "harm", status: e.injectionPass ? "pass" : "fail", counts: { passed: Number(e.injectionPass) } },
    { id: "harm.shadow_absent", family: "harm", status: e.shadowPass ? "pass" : "fail", counts: { passed: Number(e.shadowPass) } },
    { id: "harm.source_failure", family: "harm", status: e.sourceFailurePass ? "pass" : "fail", counts: { passed: Number(e.sourceFailurePass) } },
  ];
}
