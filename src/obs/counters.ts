/**
 * Observability counters — Sink-B (structured stderr).
 *
 * Production lane for the overlay/RYW counters described in
 * `.omc/plans/2026-04-29-runir-yod0.3-overlay-execution.md` §3 / §4 and
 * ADR 0009 §Observability sink. Emits one line per `recordCounter`
 * invocation in the form:
 *
 *   metric=<name> count=<n> tenant=<userId> ts=<epochMs>
 *
 * PM2 captures stderr to `~/.pm2/logs/runir-error.log` in production; an
 * external scraper (vector / promtail / structured-log SaaS) consumes the
 * file. The emitter interface here is deliberately decoupled from any
 * specific shipping target — a future OpenTelemetry exporter replaces the
 * stderr writer at this seam without touching call-sites.
 *
 * On-call alert thresholds (consumed by `docs/runbooks/overlay-on-call.md`
 * once `Rúnir-yod0.3.20` lands):
 *   - `overlay_evictions_per_tenant{userId=…}` > 100/min sustained 5min →
 *     page storage on-call (multi-tenant LRU starvation).
 *   - `(memory_committed - memory_indexed) / memory_committed` > 5% over a
 *     60-second window → page platform on-call (async-index-failure
 *     phantom-commit; see ADR 0009 §Phantom-prevention rules).
 *
 * Canonical anchor: `~/Documents/Obsidian Vault/1. Projects/Styrir/Runir/
 * Rúnir architectural improvement plan.md` §Priority 1 "fix read-your-writes"
 * — observability lane.
 */

export interface CounterEmitter {
  emit(line: string): void;
}

export interface CounterRecordOptions {
  /** Optional label set. Reserved keys: `tenant`. Other labels are
   *  rendered as `key=value` pairs after `count`. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Optional clock for deterministic test injection. */
  readonly now?: () => number;
}

const DEFAULT_EMITTER: CounterEmitter = {
  emit: (line) => {
    process.stderr.write(line + "\n");
  },
};

let activeEmitter: CounterEmitter = DEFAULT_EMITTER;

/** Override the emitter (test seam). Returns a restore function. */
export function setCounterEmitter(emitter: CounterEmitter): () => void {
  const prior = activeEmitter;
  activeEmitter = emitter;
  return () => {
    activeEmitter = prior;
  };
}

/** Reset the emitter to the default `process.stderr` writer. */
export function resetCounterEmitter(): void {
  activeEmitter = DEFAULT_EMITTER;
}

/**
 * Record a counter delta. Emits exactly one line in the structured-stderr
 * format described above. The `metric` and label values must not contain
 * whitespace or `=`; callers are responsible for sanitization upstream
 * (the emitter does not validate to keep the hot path branchless).
 */
export function recordCounter(
  metric: string,
  count: number,
  options: CounterRecordOptions = {},
): void {
  const ts = options.now ? options.now() : Date.now();
  const parts: string[] = [`metric=${metric}`, `count=${count}`];
  if (options.labels) {
    if (options.labels.tenant !== undefined) {
      parts.push(`tenant=${options.labels.tenant}`);
    }
    for (const [key, value] of Object.entries(options.labels)) {
      if (key === "tenant") continue;
      parts.push(`${key}=${value}`);
    }
  }
  parts.push(`ts=${ts}`);
  activeEmitter.emit(parts.join(" "));
}

/** Convenience: emit `overlay_evictions_per_tenant{userId=...}` += 1. */
export function recordOverlayEvictionPerTenant(userId: string, count = 1, now?: () => number): void {
  recordCounter("overlay_evictions_per_tenant", count, { labels: { tenant: userId }, now });
}

/** Convenience: emit `overlay_evictions_global` += 1 (registry-level Pass 1). */
export function recordOverlayEvictionGlobal(count = 1, now?: () => number): void {
  recordCounter("overlay_evictions_global", count, { now });
}

/** Convenience: emit `memory_committed` += 1. */
export function recordMemoryCommitted(userId: string, count = 1, now?: () => number): void {
  recordCounter("memory_committed", count, { labels: { tenant: userId }, now });
}

/** Convenience: emit `memory_indexed` += 1. */
export function recordMemoryIndexed(userId: string, count = 1, now?: () => number): void {
  recordCounter("memory_indexed", count, { labels: { tenant: userId }, now });
}

export interface CommittedIndexedDriftInput {
  readonly committedCount: number;
  readonly indexedCount: number;
  readonly thresholdRatio?: number;
}

export interface CommittedIndexedDriftReport {
  /** `(committed - indexed) / committed`; clamped to 0 when committed is 0. */
  readonly ratio: number;
  /** True iff `ratio > thresholdRatio` (default 0.05 = 5%). */
  readonly breach: boolean;
  /** True iff the contract `committed >= indexed` is preserved. */
  readonly contractHolds: boolean;
}

/**
 * Compute the committed-vs-indexed drift ratio. Used by the platform on-call
 * drift alert: `breach === true` over a sustained 60-second window means
 * the durable write succeeded but the async vector/FTS index never landed —
 * the canonical async-index-failure phantom-commit failure mode (ADR 0009
 * §Phantom-prevention rules row 2). Threshold default 5%; caller may pass
 * a tighter value for stricter alerting.
 */
export function committedIndexedDrift(
  input: CommittedIndexedDriftInput,
): CommittedIndexedDriftReport {
  const threshold = input.thresholdRatio ?? 0.05;
  const contractHolds = input.committedCount >= input.indexedCount;
  if (input.committedCount === 0) {
    return { ratio: 0, breach: false, contractHolds };
  }
  const delta = input.committedCount - input.indexedCount;
  const ratio = delta / input.committedCount;
  return {
    ratio,
    breach: ratio > threshold,
    contractHolds,
  };
}

// ── Unified pipeline-drop counter (Rúnir-imaf.9) ─────────────────────────────

export type PipelineDropStage = "extract" | "segment" | "entity" | "staleness" | "session-end";
export type PipelineDropScope = "batch" | "element";

const PIPELINE_LABEL_SAFE = /^[^\s=]+$/;

/**
 * ONE counter for every silently-dropped capture-pipeline unit. The four
 * historical names (extract_/segment_/entity_/staleness_batch_dropped) had
 * mixed per-element vs whole-batch semantics, so "how many facts did we drop
 * and why" was unanswerable from one query. Now:
 *
 *   metric=capture_batch_dropped stage=<extract|segment|entity|staleness|session-end>
 *     scope=<batch|element> reason=<...> model=<...> [extra...]
 *
 * scope=batch — one LLM call's whole output lost (fetch/timeout/HTTP/parse),
 * or (stage=session-end) the whole session-end handler pipeline aborted on an
 * unhandled throw and degraded to a fail-open skip instead of a 500.
 * scope=element — one unit inside an otherwise-valid reply skipped
 * (e.g. staleness malformed_entry).
 *
 * Fully guarded: observability must never break a never-throws pipeline
 * contract. Labels are sanitized (whitespace/`=` corrupt the line grammar).
 */
export function recordPipelineDrop(
  stage: PipelineDropStage,
  scope: PipelineDropScope,
  reason: string,
  model: string,
  extra?: Record<string, string>,
): void {
  try {
    const labels: Record<string, string> = {
      stage,
      scope,
      reason,
      model: PIPELINE_LABEL_SAFE.test(model) ? model : "unknown",
    };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === "string" && v.length > 0 && PIPELINE_LABEL_SAFE.test(v)) labels[k] = v;
      }
    }
    recordCounter("capture_batch_dropped", 1, { labels });
  } catch {
    // Swallow: a failing counter sink must not break any pipeline fallback.
  }
}
