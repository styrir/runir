// Layer 0 is opt-in (default OFF) until the live write-integrity probe gates it on,
// mirroring the RUNIR_RECALL_RELEVANCE_FLOOR convention (ship dark, flip via plist).
export function cueGateEnabled(): boolean {
  return process.env.RUNIR_SUPERSEDE_CUE_GATE === "1";
}
// Rúnir-pn1l Layer 2 — opt-in (default OFF), mirroring the Layer 0 gate. Read only
// in `arbitrateWrite`; `resolveDecision` stays pure and receives the resolved flag.
export function judgeGateEnabled(): boolean {
  return process.env.RUNIR_SUPERSEDE_JUDGE_GATE === "1";
}
// Rúnir-pn1l.13.7 D1 — dark flag; flag ALONE gates F2→judge escalation (availability
// is a resolution concern). Independent of RUNIR_SUPERSEDE_JUDGE_GATE.
export function f2JudgeConfirmEnabled(): boolean {
  return process.env.RUNIR_SUPERSEDE_F2_JUDGE_CONFIRM === "1";
}
// Rúnir-pn1l.5 — merge-band keep-both guard, opt-in (default OFF), ship-dark like the supersede
// gates. Read in arbitrateWrite; resolveDecision receives the resolved flag as a param.
export function mergeKeepBothGuardEnabled(): boolean {
  return process.env.RUNIR_MERGE_KEEPBOTH_GUARD === "1";
}
// Rúnir-pn1l.10 — additive-aware skip guard, opt-in (default OFF), ship-dark. Read in
// arbitrateWrite; resolveDecision receives the resolved flag as a param.
export function additiveSkipGuardEnabled(): boolean {
  return process.env.RUNIR_ADDITIVE_SKIP_GUARD === "1";
}
// Rúnir-pn1l.13.2 — shadow would-decision logging, default-OFF. When ON, a second pure
// resolveDecision call is computed (with all 5 flip-bundle flags forced ON) alongside a
// baseline (all flags OFF) and the results are written to supersede_shadow for adjudication.
// OBSERVE-ONLY: applied behavior is byte-identical regardless of this flag.
export function supersedeShadowEnabled(): boolean {
  return process.env.RUNIR_SUPERSEDE_SHADOW === "1";
}
// Rúnir-pn1l.2 — supersede-only temporal+durability pre-guard, opt-in (default OFF),
// ship-dark like the other supersession gates. Read in arbitrateWrite; the pure
// resolvers receive the resolved flag + incoming valid-time/tier as params.
export function supersedeTemporalGuardEnabled(): boolean {
  return process.env.RUNIR_SUPERSEDE_TEMPORAL_GUARD === "1";
}
// Rúnir-h435.1 [R1-1, R2-3] — atomicFactIdentity proof authority quarantine.
// DEFAULT-OFF: when unset/≠"1", the key:atomicFactIdentity arm is demoted to
// shadow/WOULD-lane observation only (applied lane skips that arm). ON = proof
// authority for applied retirements (gated on slice-3 bar). Read ONLY in
// arbitrateWrite; resolveDecision stays pure and receives the bool as a param.
export function atomicFactIdentityProofEnabled(): boolean {
  return process.env.RUNIR_ATOMICFACT_IDENTITY_PROOF === "1";
}
