import type { BenchmarkCase, ParsedExtraction, QualityScores } from "./types.js";

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAll(haystack: string, needles: string[]): boolean {
  const h = norm(haystack);
  return needles.every((n) => h.includes(norm(n)));
}

/**
 * Score extracted facts against human gold. Greedy one-to-one matching on mustContain.
 * Does not use any candidate model as a judge.
 */
export function scoreExtraction(
  parsed: ParsedExtraction,
  benchCase: BenchmarkCase,
): QualityScores {
  const goldFacts = benchCase.gold.facts.filter((g) => g.required !== false);
  const extracted = parsed.facts;

  if (benchCase.gold.abstain) {
    const abstentionCorrect = extracted.length === 0;
    return {
      schemaValid: parsed.schemaValid,
      atomicPrecision: extracted.length === 0 ? 1 : 0,
      atomicRecall: 1, // no required gold facts
      hallucinationRate: extracted.length === 0 ? 0 : 1,
      omissionRate: 0,
      granularityCompliance: null,
      evidenceFidelity: null,
      abstentionCorrect,
      correctionHandling: null,
      matchedGoldIds: [],
      unmatchedExtracted: extracted.length,
      unmatchedGold: 0,
    };
  }

  const matchedGoldIds: string[] = [];
  const usedExtracted = new Set<number>();

  for (const g of goldFacts) {
    let bestIdx = -1;
    for (let i = 0; i < extracted.length; i++) {
      if (usedExtracted.has(i)) continue;
      const fact = extracted[i]!;
      if (containsAll(fact.l2, g.mustContain)) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx >= 0) {
      usedExtracted.add(bestIdx);
      matchedGoldIds.push(g.id);
    }
  }

  const matched = matchedGoldIds.length;
  const unmatchedGold = goldFacts.length - matched;
  const unmatchedExtracted = extracted.length - usedExtracted.size;

  const atomicPrecision =
    extracted.length === 0 ? (goldFacts.length === 0 ? 1 : 0) : matched / extracted.length;
  const atomicRecall = goldFacts.length === 0 ? 1 : matched / goldFacts.length;
  const hallucinationRate =
    extracted.length === 0 ? 0 : unmatchedExtracted / extracted.length;
  const omissionRate = goldFacts.length === 0 ? 0 : unmatchedGold / goldFacts.length;

  // Granularity: if independentClaimCount set, prefer |facts| close to that count when schema valid
  let granularityCompliance: number | null = null;
  if (benchCase.gold.independentClaimCount !== undefined && parsed.schemaValid) {
    const want = benchCase.gold.independentClaimCount;
    const got = extracted.length;
    granularityCompliance = got === 0 && want === 0 ? 1 : got === 0 ? 0 : Math.min(got, want) / Math.max(got, want);
  }

  // Evidence: source_turn_index in range when present
  let evidenceFidelity: number | null = null;
  if (extracted.length > 0) {
    let ok = 0;
    let considered = 0;
    for (const f of extracted) {
      if (f.source_turn_index === undefined) continue;
      considered++;
      if (
        typeof f.source_turn_index === "number" &&
        f.source_turn_index >= 0 &&
        f.source_turn_index < benchCase.messages.length
      ) {
        ok++;
      }
    }
    evidenceFidelity = considered === 0 ? null : ok / considered;
  }

  let correctionHandling: number | null = null;
  if (benchCase.family === "correction") {
    // All required gold must match and no merged old+new hallucination preferred via recall/precision
    correctionHandling = atomicRecall !== null && atomicPrecision !== null
      ? Math.min(atomicRecall, atomicPrecision)
      : null;
  }

  return {
    schemaValid: parsed.schemaValid,
    atomicPrecision,
    atomicRecall,
    hallucinationRate,
    omissionRate,
    granularityCompliance,
    evidenceFidelity,
    abstentionCorrect: null,
    correctionHandling,
    matchedGoldIds,
    unmatchedExtracted,
    unmatchedGold,
  };
}
