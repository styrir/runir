import { z } from "zod";
import {
  THINK_MAX_EVIDENCE_ITEMS,
  THINK_RETRIEVAL_TOP_K,
} from "../../recall/orchestrator/think-synthesis.js";
import { scoreThinkRetrieval } from "./score.js";
import type { ThinkBenchmarkCase, ThinkRetrievalGold } from "./types.js";

const retrievalMemorySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(4_000),
}).strict();

const retrievalCaseSchema = z.object({
  caseId: z.string().min(1),
  relevantIds: z.array(z.string().min(1)),
  distractorIds: z.array(z.string().min(1)),
}).strict();

const retrievalScoresSchema = z.object({
  recall: z.number().nullable(),
  precision: z.number(),
  firstRelevantRank: z.number().int().positive().nullable(),
  meanRelevantRank: z.number().positive().nullable(),
  retainedRecall: z.number().nullable(),
  retrievedRelevantIds: z.array(z.string().min(1)),
  retrievedDistractorIds: z.array(z.string().min(1)),
  missingRelevantIds: z.array(z.string().min(1)),
}).strict();

const retrievalFixtureSchema = z.object({
  schemaVersion: z.literal("runir-think-retrieval-fixture/v1"),
  retrievalWindow: z.number().int().positive(),
  synthesisCap: z.number().int().positive(),
  memories: z.array(retrievalMemorySchema).min(1),
  cases: z.array(retrievalCaseSchema).min(1),
  attributionProbe: z.object({
    caseId: z.string().min(1),
    selectedIds: z.array(z.string().min(1)),
    retainedIds: z.array(z.string().min(1)),
    expected: retrievalScoresSchema,
  }).strict(),
}).strict();

export type ThinkRetrievalFixture = z.infer<typeof retrievalFixtureSchema>;

function uniqueIds(ids: readonly string[], label: string): Set<string> {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error(`${label} contains duplicate ids`);
  }
  return unique;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

export function retrievalGoldForCase(
  fixture: ThinkRetrievalFixture,
  caseId: string,
): ThinkRetrievalGold {
  const gold = fixture.cases.find((item) => item.caseId === caseId);
  if (!gold) throw new Error(`retrieval fixture is missing case ${caseId}`);
  return {
    relevantIds: gold.relevantIds,
    distractorIds: gold.distractorIds,
  };
}

export function validateThinkRetrievalFixture(
  value: unknown,
  benchmarkCases: readonly ThinkBenchmarkCase[],
): ThinkRetrievalFixture {
  const fixture = retrievalFixtureSchema.parse(value);
  if (fixture.retrievalWindow !== THINK_RETRIEVAL_TOP_K) {
    throw new Error(`retrieval fixture window must equal ${THINK_RETRIEVAL_TOP_K}`);
  }
  if (fixture.synthesisCap !== THINK_MAX_EVIDENCE_ITEMS) {
    throw new Error(`retrieval fixture synthesis cap must equal ${THINK_MAX_EVIDENCE_ITEMS}`);
  }
  if (fixture.memories.length <= fixture.retrievalWindow) {
    throw new Error("retrieval fixture corpus must exceed the retrieval window");
  }

  const memoryIds = uniqueIds(fixture.memories.map((memory) => memory.id), "retrieval memories");

  const fixtureCaseIds = uniqueIds(fixture.cases.map((item) => item.caseId), "retrieval cases");
  const benchmarkCaseIds = uniqueIds(benchmarkCases.map((item) => item.id), "benchmark cases");
  if (!sameIds(fixtureCaseIds, benchmarkCaseIds)) {
    throw new Error("retrieval fixture cases must match the Think benchmark corpus");
  }

  const memoriesById = new Map(fixture.memories.map((memory) => [memory.id, memory]));
  for (const benchmarkCase of benchmarkCases) {
    const gold = retrievalGoldForCase(fixture, benchmarkCase.id);
    const relevantIds = uniqueIds(gold.relevantIds, `retrieval case ${benchmarkCase.id} relevant ids`);
    const distractorIds = uniqueIds(gold.distractorIds, `retrieval case ${benchmarkCase.id} distractor ids`);
    const expectedRelevantIds = new Set(
      benchmarkCase.gold.supportedClaims.flatMap((claim) => claim.evidenceIds),
    );
    if (!sameIds(relevantIds, expectedRelevantIds)) {
      throw new Error(`retrieval case ${benchmarkCase.id} relevant ids do not match synthesis gold`);
    }
    if ([...relevantIds].some((id) => distractorIds.has(id))) {
      throw new Error(`retrieval case ${benchmarkCase.id} has overlapping attribution`);
    }
    if (!sameIds(new Set([...relevantIds, ...distractorIds]), memoryIds)) {
      throw new Error(`retrieval case ${benchmarkCase.id} must attribute every seeded id`);
    }
    for (const evidence of benchmarkCase.evidence) {
      const seeded = memoriesById.get(evidence.id);
      if (!seeded || seeded.text !== evidence.text) {
        throw new Error(`retrieval case ${benchmarkCase.id} evidence ${evidence.id} is not seeded exactly`);
      }
    }
    for (const id of relevantIds) {
      if (!memoryIds.has(id)) throw new Error(`retrieval relevant id ${id} is not seeded`);
    }
  }

  const probeScores = scoreThinkRetrieval(
    retrievalGoldForCase(fixture, fixture.attributionProbe.caseId),
    fixture.attributionProbe.selectedIds,
    fixture.attributionProbe.retainedIds,
  );
  if (JSON.stringify(probeScores) !== JSON.stringify(fixture.attributionProbe.expected)) {
    throw new Error("retrieval attribution probe does not match its frozen scores");
  }

  return fixture;
}
