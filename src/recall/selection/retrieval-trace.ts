/**
 * Retrieval Trace — Observable pipeline diagnostics
 *
 * Tracks entry IDs through each retrieval stage, computes drops,
 * score ranges, and timing. Zero overhead when not used.
 */

import type { OverlayLockKey } from "../../storage/writes/overlay-supersession.js";
import type { RetrievalRecipeTraceMetadata } from "../policy/policy-types.js";

// ============================================================================
// Types
// ============================================================================

export interface RetrievalStageResult {
  /** Stage name, e.g. "vector_search", "bm25_search", "rrf_fusion" */
  name: string;
  /** Number of entries entering this stage */
  inputCount: number;
  /** Number of entries surviving this stage */
  outputCount: number;
  /** IDs that were present in input but not in output */
  droppedIds: string[];
  /** [min, max] score range of surviving entries, null if no scores */
  scoreRange: [number, number] | null;
  /** Wall-clock duration of this stage in milliseconds */
  durationMs: number;
}

/**
 * Lifecycle event extension (Rúnir-yod0.4.1 / arch1.03.0).
 *
 * `RetrievalTrace.lifecycleEvents` is an OPTIONAL companion stream of
 * structured events emitted alongside the per-stage stats. Schema is
 * frozen by ADR 0008 (`docs/adr/0008-trace-schema-freeze.md`); JSON
 * Schema mirror lives at `schemas/event.schema.json`.
 *
 * Three variants are pinned at v1:
 *  - `stage_start`     — emitted when a stage begins (mirrors `startStage`)
 *  - `stage_end`       — emitted when a stage closes (mirrors `endStage`)
 *  - `recall_decision` — emitted when the selection layer commits a result
 *
 * The union is purely additive on `RetrievalTrace`; existing consumers that
 * never read `lifecycleEvents` continue to compile and run unchanged.
 */
export type TraceLifecycleEventStageStart = {
  readonly type: "stage_start";
  readonly stage: string;
  readonly inputCount: number;
  readonly tStartedMs: number;
};

export type TraceLifecycleEventStageEnd = {
  readonly type: "stage_end";
  readonly stage: string;
  readonly outputCount: number;
  readonly droppedCount: number;
  readonly durationMs: number;
};

export type TraceLifecycleEventRecallDecision = {
  readonly type: "recall_decision";
  readonly decision: "accept" | "drop" | "supersede" | "merge";
  readonly entryId: string;
  readonly reason?: string;
};

/**
 * `memory_committed` — emitted on the synchronous return path of
 * `arbitrateWrite` after the durable DB write resolves and the overlay
 * `put` completes. Pinned to the same JS microtask as the durable resolve
 * (no `setImmediate`, no `queueMicrotask`, no deferring `.then`); see
 * `Rúnir-yod0.3.15` synchrony test pair and ADR 0009 §Synchrony.
 */
export type TraceMemoryCommittedEvent = {
  readonly type: "memory_committed";
  readonly memoryId: string;
  readonly lockKey: OverlayLockKey;
  readonly outcome: "create" | "merge-update" | "supersede";
  readonly committedAtMs: number;
};

/**
 * `memory_indexed` — emitted asynchronously when vector / FTS index
 * visibility lands for a previously committed memory. Decoupled from
 * `memory_committed` so a phantom-commit (durable resolve succeeded but
 * async index write failed) is observable as
 * `count(memory_committed) > count(memory_indexed)`. See ADR 0009
 * §Phantom-prevention rules.
 */
export type TraceMemoryIndexedEvent = {
  readonly type: "memory_indexed";
  readonly memoryId: string;
  readonly indexedAtMs: number;
};

export type TraceLifecycleEvent =
  | TraceLifecycleEventStageStart
  | TraceLifecycleEventStageEnd
  | TraceLifecycleEventRecallDecision
  | TraceMemoryCommittedEvent
  | TraceMemoryIndexedEvent;

export interface RetrievalTrace {
  /** The original search query */
  query: string;
  /** Retrieval mode used */
  mode: "hybrid" | "vector" | "bm25";
  /** Detected intent label that selected the retrieval route */
  intentLabel?: string;
  /** Recipe metadata surfaced for A3 trace/debug visibility */
  recipe?: RetrievalRecipeTraceMetadata;
  /** Timestamp when retrieval started (epoch ms) */
  startedAt: number;
  /** Per-stage results in pipeline order */
  stages: RetrievalStageResult[];
  /** Number of results after all stages */
  finalCount: number;
  /** Total wall-clock time in milliseconds */
  totalMs: number;
  /** Optional lifecycle event stream — see TraceLifecycleEvent above. */
  lifecycleEvents?: TraceLifecycleEvent[];
}

// ============================================================================
// TraceCollector
// ============================================================================

interface PendingStage {
  name: string;
  inputIds: Set<string>;
  startTime: number;
}

export class TraceCollector {
  private readonly _startTime: number;
  private readonly _stages: RetrievalStageResult[] = [];
  private _pending: PendingStage | null = null;

  constructor() {
    this._startTime = Date.now();
  }

  /**
   * Begin tracking a pipeline stage.
   * @param name - Stage identifier (e.g. "vector_search")
   * @param entryIds - IDs of entries entering this stage
   */
  startStage(name: string, entryIds: string[]): void {
    // Auto-close any unclosed previous stage (defensive)
    if (this._pending) {
      this.endStage([...this._pending.inputIds]);
    }
    this._pending = {
      name,
      inputIds: new Set(entryIds),
      startTime: Date.now(),
    };
  }

  /**
   * End the current stage.
   * @param survivingIds - IDs of entries that survived this stage
   * @param scores - Optional scores for surviving entries (parallel to survivingIds)
   */
  endStage(survivingIds: string[], scores?: number[]): void {
    if (!this._pending) return;

    const { name, inputIds, startTime } = this._pending;
    const survivingSet = new Set(survivingIds);

    const droppedIds: string[] = [];
    for (const id of inputIds) {
      if (!survivingSet.has(id)) {
        droppedIds.push(id);
      }
    }

    let scoreRange: [number, number] | null = null;
    if (scores && scores.length > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const s of scores) {
        if (s < min) min = s;
        if (s > max) max = s;
      }
      scoreRange = [min, max];
    }

    this._stages.push({
      name,
      inputCount: inputIds.size,
      outputCount: survivingIds.length,
      droppedIds,
      scoreRange,
      durationMs: Date.now() - startTime,
    });

    this._pending = null;
  }

  /**
   * Finalize the trace and produce the complete RetrievalTrace object.
   */
  finalize(query: string, mode: string): RetrievalTrace {
    // Auto-close any unclosed stage
    if (this._pending) {
      this.endStage([...this._pending.inputIds]);
    }

    const lastStage = this._stages[this._stages.length - 1];
    return {
      query,
      mode: mode as "hybrid" | "vector" | "bm25",
      startedAt: this._startTime,
      stages: this._stages,
      finalCount: lastStage ? lastStage.outputCount : 0,
      totalMs: Date.now() - this._startTime,
    };
  }

  /**
   * Produce a human-readable summary of the trace.
   */
  summarize(): string {
    const lines: string[] = [];
    lines.push(`Retrieval trace (${this._stages.length} stages):`);
    for (const stage of this._stages) {
      const dropped = stage.inputCount - stage.outputCount;
      const scoreStr = stage.scoreRange
        ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
        : "";
      lines.push(
        `  ${stage.name}: ${stage.inputCount} -> ${stage.outputCount} (-${dropped}) ${stage.durationMs}ms${scoreStr}`,
      );
      if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 5) {
        lines.push(`    dropped: ${stage.droppedIds.join(", ")}`);
      } else if (stage.droppedIds.length > 5) {
        lines.push(
          `    dropped: ${stage.droppedIds.slice(0, 5).join(", ")} (+${stage.droppedIds.length - 5} more)`,
        );
      }
    }
    const lastStage = this._stages[this._stages.length - 1];
    const totalMs = Date.now() - this._startTime;
    lines.push(
      `  total: ${totalMs}ms, final count: ${lastStage ? lastStage.outputCount : 0}`,
    );
    return lines.join("\n");
  }

  /** Access collected stages (read-only). */
  get stages(): readonly RetrievalStageResult[] {
    return this._stages;
  }
}
