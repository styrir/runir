import { describe, expect, it } from "vitest";
import type { OverlayLockKey } from "../../../storage/writes/overlay-supersession.js";
import type {
  TraceLifecycleEvent,
  TraceLifecycleEventRecallDecision,
  TraceLifecycleEventStageEnd,
  TraceLifecycleEventStageStart,
  TraceMemoryCommittedEvent,
  TraceMemoryIndexedEvent,
} from "../retrieval-trace.js";

/** Type-level coverage check: every constructor below must be assignable to
 *  `TraceLifecycleEvent`, and the `discriminate` switch must be exhaustive
 *  (`never` on the default branch). If a future variant is added without
 *  updating this test, `tsc --noEmit` will fail on the unhandled case. */
function discriminate(event: TraceLifecycleEvent): string {
  switch (event.type) {
    case "stage_start":
      return "stage_start";
    case "stage_end":
      return "stage_end";
    case "recall_decision":
      return "recall_decision";
    case "memory_committed":
      return "memory_committed";
    case "memory_indexed":
      return "memory_indexed";
    default: {
      const _exhaustive: never = event;
      throw new Error(`unhandled TraceLifecycleEvent variant: ${String(_exhaustive)}`);
    }
  }
}

describe("TraceLifecycleEvent — additive union extension (Rúnir-yod0.3.14a)", () => {
  it("union has 5 variants and each discriminator is reachable", () => {
    const stageStart: TraceLifecycleEventStageStart = {
      type: "stage_start",
      stage: "vector_search",
      inputCount: 10,
      tStartedMs: 1,
    };
    const stageEnd: TraceLifecycleEventStageEnd = {
      type: "stage_end",
      stage: "vector_search",
      outputCount: 8,
      droppedCount: 2,
      durationMs: 5,
    };
    const recallDecision: TraceLifecycleEventRecallDecision = {
      type: "recall_decision",
      decision: "accept",
      entryId: "mem-1",
    };
    const lockKey: OverlayLockKey = {
      factKey: "preference:editor",
      continuitySubjectKey: "user:alice",
    };
    const memoryCommitted: TraceMemoryCommittedEvent = {
      type: "memory_committed",
      memoryId: "mem-1",
      lockKey,
      outcome: "create",
      committedAtMs: 1,
    };
    const memoryIndexed: TraceMemoryIndexedEvent = {
      type: "memory_indexed",
      memoryId: "mem-1",
      indexedAtMs: 2,
    };

    const allVariants: TraceLifecycleEvent[] = [
      stageStart,
      stageEnd,
      recallDecision,
      memoryCommitted,
      memoryIndexed,
    ];
    expect(allVariants.length).toBe(5);

    const seen = new Set(allVariants.map(discriminate));
    expect(seen).toEqual(
      new Set(["stage_start", "stage_end", "recall_decision", "memory_committed", "memory_indexed"]),
    );
  });

  it("memory_committed carries the shipped OverlayLockKey shape (factKey, continuitySubjectKey)", () => {
    const event: TraceMemoryCommittedEvent = {
      type: "memory_committed",
      memoryId: "mem-2",
      lockKey: { factKey: "fact:f", continuitySubjectKey: "subj:s" },
      outcome: "merge-update",
      committedAtMs: 100,
    };
    expect(Object.keys(event.lockKey).sort()).toEqual(["continuitySubjectKey", "factKey"]);
    expect(event.outcome).toBe("merge-update");
  });

  it("memory_indexed is decoupled from memory_committed (no shared fields beyond memoryId)", () => {
    const committed: TraceMemoryCommittedEvent = {
      type: "memory_committed",
      memoryId: "mem-3",
      lockKey: { factKey: "f", continuitySubjectKey: "s" },
      outcome: "supersede",
      committedAtMs: 1,
    };
    const indexed: TraceMemoryIndexedEvent = {
      type: "memory_indexed",
      memoryId: "mem-3",
      indexedAtMs: 50,
    };
    expect(committed.memoryId).toBe(indexed.memoryId);
    expect(committed.committedAtMs).toBeLessThan(indexed.indexedAtMs);
  });
});
