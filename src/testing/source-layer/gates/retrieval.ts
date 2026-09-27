import type { GateResult } from "../types.js";

export type RetrievalGateEvidence = {
  offQualifier: boolean; shadowQualifier: boolean; onQualifier: boolean;
  offOrder: string[]; shadowOrder: string[]; onOrder: string[];
  onExcerptCount: number; paraphraseFactHit: number;
};

export function retrievalGate(e: RetrievalGateEvidence): GateResult {
  const orderSame = JSON.stringify(e.offOrder) === JSON.stringify(e.shadowOrder)
    && JSON.stringify(e.offOrder) === JSON.stringify(e.onOrder);
  return { id: "retrieval.annotation_exact", family: "retrieval",
    status: !e.offQualifier && !e.shadowQualifier && e.onQualifier && e.onExcerptCount > 0 && orderSame ? "pass" : "fail",
    counts: { offQualifier: Number(e.offQualifier), shadowQualifier: Number(e.shadowQualifier),
      onQualifier: Number(e.onQualifier), onExcerpts: e.onExcerptCount, orderSame: Number(orderSame),
      paraphraseFactHit: e.paraphraseFactHit } };
}
