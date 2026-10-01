/** Process lifetime count-only capture source-link observations. */
const counts = {
  factsWithValidSourceIndex: 0,
  factsWithoutValidSourceIndex: 0,
  linksPending: 0,
  linksUnavailable: 0,
  completedTurnDrops: 0,
};

export type SourceLinkMetric = keyof typeof counts;

export function countSourceLink(metric: SourceLinkMetric, amount = 1): void {
  counts[metric] += amount;
}

export function sourceLinkMetricsSnapshot(): Readonly<typeof counts> {
  return { ...counts };
}
