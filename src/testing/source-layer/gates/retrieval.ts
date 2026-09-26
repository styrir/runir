import type { GateResult } from "../types.js";

export function retrievalGate(sourceExcerptCount: number, recallCalls: number, factHits: { identifier: number; quote: number; paraphrase: number }): GateResult {
  const off = sourceExcerptCount === 0;
  return { id: "retrieval.annotation_exact", family: "retrieval", status: off ? "pending_fail_closed" : "fail",
    counts: { recallCalls, sourceExcerpts: sourceExcerptCount, exactCases: 2, paraphraseCasesReported: 1,
      claudeNativeIdentifierFactHit: factHits.identifier, claudeNativeQuoteFactHit: factHits.quote,
      claudeNativeParaphraseFactHit: factHits.paraphrase },
    note: off ? "annotation_pending_slice5" : "recall_off_source_emitted" };
}
