// Query text helpers: tokenizing, taxonomy expansion and app-side BM25 scoring.
// Split out of memory-query.ts (vk-2996).
import { BM25_B, BM25_K1 } from "../../domain/memory/types";
import { EMPTY_PROFILE, type TaxonomyExpansionFacet } from "../policy/ranking-profile.js";

export const BM25_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "how", "i", "if", "in", "into",
  "is", "it", "its", "let", "me", "my", "of", "on", "or", "our", "should", "that", "the", "their", "them", "there",
  "these", "they", "this", "those", "to", "up", "us", "was", "we", "what", "when", "where", "which", "who", "why",
  "will", "with", "you", "your",
]);

export function tokenizeText(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}_]+/gu);
  return tokens ?? [];
}

export function significantQueryTokens(text: string): string[] {
  const tokens = tokenizeText(text);
  const filtered = tokens.filter((token) => token.length > 2 && !BM25_STOPWORDS.has(token));
  return filtered.length > 0 ? Array.from(new Set(filtered)) : Array.from(new Set(tokens));
}

const MAX_TAXONOMY_EXPANSION_TERMS = 4;

// Taxonomy expansion facets are tenant data (Rúnir-mmg2): they encode the runir
// tenant's career/education query-expansion tuning, so they live in a per-tenant
// ranking profile and are passed into expandRetrievalQuery as a parameter. With
// no profile the facet list is empty → no expansion (queryText unchanged).
// The TaxonomyExpansionFacet type is imported from ../policy/ranking-profile.js.

export function expandRetrievalQuery(
  queryText: string,
  taxonomyExpansionFacets: readonly TaxonomyExpansionFacet[] = EMPTY_PROFILE.taxonomyExpansionFacets,
): string {
  const tokens = significantQueryTokens(queryText);
  const matchingFacets = taxonomyExpansionFacets.filter((facet) =>
    tokens.some((token) => facet.signals.has(token)),
  );
  if (matchingFacets.length === 0) {
    return queryText;
  }

  const existingTokens = new Set(tokenizeText(queryText));
  const additions: string[] = [];
  const addedTokens = new Set<string>();
  const maxFacetTerms = Math.max(...matchingFacets.map((facet) => facet.terms.length));
  for (let termIndex = 0; termIndex < maxFacetTerms; termIndex += 1) {
    for (const facet of matchingFacets) {
      const term = facet.terms[termIndex];
      if (term === undefined) {
        continue;
      }
      const termTokens = tokenizeText(term);
      if (termTokens.every((token) => existingTokens.has(token) || addedTokens.has(token))) {
        continue;
      }
      additions.push(term);
      for (const token of termTokens) {
        addedTokens.add(token);
      }
      if (additions.length >= MAX_TAXONOMY_EXPANSION_TERMS) {
        break;
      }
    }
    if (additions.length >= MAX_TAXONOMY_EXPANSION_TERMS) {
      break;
    }
  }

  if (additions.length === 0) {
    return queryText;
  }
  return `${queryText}\n${additions.join(" ")}`;
}

export function countTermFrequency(tokens: string[], term: string): number {
  let tf = 0;
  for (const token of tokens) {
    if (token === term) {
      tf += 1;
    }
  }
  return tf;
}

export function bm25Score(
  tf: number,
  docLength: number,
  avgDocLength: number,
  totalDocs: number,
  docFreq: number,
): number {
  if (tf <= 0 || totalDocs <= 0 || docFreq <= 0) {
    return 0;
  }
  const safeAvgDl = avgDocLength > 0 ? avgDocLength : 1;
  const safeDl = docLength > 0 ? docLength : 1;

  const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (safeDl / safeAvgDl));
  if (denom <= 0) {
    return 0;
  }
  return idf * ((tf * (BM25_K1 + 1)) / denom);
}
