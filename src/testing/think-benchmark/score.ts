import type {
  ThinkBenchmarkCase,
  ThinkQualityScores,
} from "./types.js";
import type { ThinkSynthesis } from "../../recall/orchestrator/think-synthesis.js";

function includesTerm(value: string, term: string): boolean {
  return value.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

function fraction(numerator: number, denominator: number, emptyValue = 1): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

/**
 * Deterministic human-gold scoring. It intentionally does not ask another
 * model to judge the answer: every point can be traced to a frozen claim,
 * evidence id, forbidden phrase, or required gap phrase.
 */
export function scoreThinkSynthesis(
  benchmarkCase: ThinkBenchmarkCase,
  synthesis: ThinkSynthesis,
  schemaValid: boolean,
): ThinkQualityScores {
  const answer = synthesis.answer ?? "";
  const outputClaims = synthesis.claims;
  const matchesForOutput = outputClaims.map((outputClaim) =>
    benchmarkCase.gold.supportedClaims.filter((goldClaim) =>
      goldClaim.mustContain.length > 0 &&
      goldClaim.mustContain.every((term) => includesTerm(outputClaim.text, term))));
  const matchedClaimIds = new Set(
    matchesForOutput
      .filter((claims) => claims.length === 1)
      .map((claims) => claims[0]!.id),
  );
  const matchedClaims = benchmarkCase.gold.supportedClaims.filter((claim) => matchedClaimIds.has(claim.id));
  const requiredEvidenceIds = [...new Set(
    benchmarkCase.gold.supportedClaims.flatMap((claim) => claim.evidenceIds),
  )];
  const citedEvidenceIds = [...new Set(synthesis.citations.map((citation) => citation.id))];
  const citedRequired = requiredEvidenceIds.filter((id) => citedEvidenceIds.includes(id));
  const claimAddressableText = [answer, ...outputClaims.map((claim) => claim.text)].join("\n");
  const forbiddenMatches = benchmarkCase.gold.forbiddenContains.filter((term) =>
    includesTerm(claimAddressableText, term));
  const citationAttempts = outputClaims.reduce(
    (sum, claim) => sum + claim.citations.length + claim.droppedCitations.length,
    0,
  );
  const validClaimCitations = outputClaims.reduce((sum, claim) => sum + claim.citations.length, 0);
  const supportedClaimCitations = outputClaims.reduce((sum, outputClaim, index) => {
    const matches = matchesForOutput[index]!;
    if (matches.length !== 1) return sum;
    const allowedEvidence = new Set(matches[0]!.evidenceIds);
    return sum + outputClaim.citations.filter((citation) => allowedEvidence.has(citation.id)).length;
  }, 0);
  const unsupportedOutputClaims = outputClaims.filter((outputClaim, index) => {
    if (matchesForOutput[index]!.length !== 1) return true;
    const allowedEvidence = new Set(matchesForOutput[index]![0]!.evidenceIds);
    return outputClaim.citations.length === 0 ||
      outputClaim.citations.some((citation) => !allowedEvidence.has(citation.id));
  });
  const answerShapeCorrect = benchmarkCase.gold.answerExpected
    ? synthesis.answer !== null && answer.trim().length > 0
    : synthesis.answer === null;
  const gapText = synthesis.gaps.join("\n");
  const requiredGapsMatched = benchmarkCase.gold.requiredGapContains.filter((term) =>
    includesTerm(gapText, term));
  const gapAccuracy = answerShapeCorrect &&
    requiredGapsMatched.length === benchmarkCase.gold.requiredGapContains.length
    ? 1
    : 0;
  const unsupportedByClaims = fraction(
    unsupportedOutputClaims.length,
    outputClaims.length,
    benchmarkCase.gold.answerExpected ? 1 : 0,
  );

  return {
    schemaValid,
    answerCompleteness: fraction(
      matchedClaims.length,
      benchmarkCase.gold.supportedClaims.length,
      benchmarkCase.gold.answerExpected ? 0 : 1,
    ),
    unsupportedClaimRate: forbiddenMatches.length ? 1 : unsupportedByClaims,
    citationValidity: fraction(validClaimCitations, citationAttempts, benchmarkCase.gold.answerExpected ? 0 : 1),
    citationPrecision: fraction(supportedClaimCitations, validClaimCitations, benchmarkCase.gold.answerExpected ? 0 : 1),
    citationCompleteness: fraction(citedRequired.length, requiredEvidenceIds.length),
    gapAccuracy,
    abstentionCorrect: benchmarkCase.gold.answerExpected === (synthesis.answer !== null) ? 1 : 0,
    matchedClaimIds: matchedClaims.map((claim) => claim.id),
    missingClaimIds: benchmarkCase.gold.supportedClaims
      .filter((claim) => !matchedClaims.includes(claim))
      .map((claim) => claim.id),
    citedEvidenceIds,
    missingEvidenceIds: requiredEvidenceIds.filter((id) => !citedEvidenceIds.includes(id)),
    forbiddenMatches,
  };
}
