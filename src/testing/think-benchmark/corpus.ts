import {
  THINK_MAX_EVIDENCE_ITEMS,
  THINK_MAX_EVIDENCE_TEXT_CHARS,
} from "../../recall/orchestrator/think-synthesis.js";
import type { ThinkBenchmarkCase } from "./types.js";

export function validateThinkCorpus(value: unknown): ThinkBenchmarkCase[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Think corpus must be a non-empty array");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`case ${index} must be an object`);
    const item = entry as ThinkBenchmarkCase;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id)) throw new Error(`case ${index} has an invalid or duplicate id`);
    ids.add(item.id);
    if (typeof item.question !== "string" || !item.question.trim()) throw new Error(`case ${item.id} needs a question`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0 || item.evidence.length > THINK_MAX_EVIDENCE_ITEMS) {
      throw new Error(`case ${item.id} evidence must contain 1-${THINK_MAX_EVIDENCE_ITEMS} items`);
    }
    if (!item.gold || !Array.isArray(item.gold.supportedClaims) || !Array.isArray(item.gold.forbiddenContains) || !Array.isArray(item.gold.requiredGapContains)) {
      throw new Error(`case ${item.id} has invalid gold`);
    }
    if (typeof item.gold.answerExpected !== "boolean") {
      throw new Error(`case ${item.id} gold.answerExpected must be boolean`);
    }
    const evidenceIds = new Set<string>();
    for (const evidence of item.evidence) {
      if (typeof evidence.id !== "string" || !evidence.id || evidenceIds.has(evidence.id)) {
        throw new Error(`case ${item.id} has an invalid or duplicate evidence id`);
      }
      if (typeof evidence.text !== "string" || !evidence.text.trim()) {
        throw new Error(`case ${item.id} evidence ${evidence.id} needs text`);
      }
      if (evidence.text.length > THINK_MAX_EVIDENCE_TEXT_CHARS) {
        throw new Error(`case ${item.id} evidence ${evidence.id} exceeds the production text bound`);
      }
      evidenceIds.add(evidence.id);
    }
    const claimIds = new Set<string>();
    for (const claim of item.gold.supportedClaims) {
      if (typeof claim.id !== "string" || !claim.id || claimIds.has(claim.id)) {
        throw new Error(`case ${item.id} has an invalid or duplicate gold claim id`);
      }
      if (!Array.isArray(claim.mustContain) || claim.mustContain.length === 0 ||
          claim.mustContain.some((term) => typeof term !== "string" || !term.trim())) {
        throw new Error(`case ${item.id} claim ${claim.id} needs non-empty mustContain terms`);
      }
      if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0 ||
          claim.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
        throw new Error(`case ${item.id} claim ${claim.id} references missing evidence`);
      }
      claimIds.add(claim.id);
    }
    if ([...item.gold.forbiddenContains, ...item.gold.requiredGapContains]
      .some((term) => typeof term !== "string" || !term.trim())) {
      throw new Error(`case ${item.id} trap and gap terms must be non-empty strings`);
    }
    return item;
  });
}
