export interface RelevanceScore {
  id: string;
  relevance: number;
}

export interface Top1Case {
  expectedCurrentId: string;
  top1Id: string;
}

export interface StaleCheck {
  top1Id: string;
  staleIds: readonly string[];
}

export function ndcgAt5(ranking: readonly RelevanceScore[]): number {
  if (ranking.length === 0) return 0;

  const k = 5;
  const top = ranking.slice(0, k);

  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    dcg += top[i].relevance / Math.log2(i + 2);
  }

  if (dcg === 0) return 0;

  const sorted = [...ranking].sort((a, b) => b.relevance - a.relevance).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < sorted.length; i++) {
    idcg += sorted[i].relevance / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;

  return dcg / idcg;
}

export function boundaryFlipRate(
  baseline: readonly string[],
  reranked: readonly string[],
  windowSize: number,
): number {
  if (windowSize <= 0 || baseline.length === 0 || reranked.length === 0) return 0;

  const w = Math.min(windowSize, baseline.length, reranked.length);
  const baselineSet = new Set(baseline.slice(0, w));
  const rerankedSet = new Set(reranked.slice(0, w));

  let changed = 0;
  for (const id of rerankedSet) {
    if (!baselineSet.has(id)) changed++;
  }

  return changed / w;
}

export function top1CurrentStateAccuracy(results: readonly Top1Case[]): number {
  if (results.length === 0) return 0;
  const correct = results.filter((r) => r.top1Id === r.expectedCurrentId).length;
  return correct / results.length;
}

export function stalePickRate(results: readonly StaleCheck[]): number {
  if (results.length === 0) return 0;
  const stale = results.filter((r) => r.staleIds.includes(r.top1Id)).length;
  return stale / results.length;
}
