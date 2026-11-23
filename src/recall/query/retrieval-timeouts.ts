// Timeout races for recall's database legs; a lost race abandons the work's queries.
// Split out of memory-query.ts (vk-2996).
import { runAbandonable } from "../../storage/surreal/query-abandonment.js";

/** Races a promise against a timeout, reporting whether the timeout fired. Callers
 *  need to distinguish a COMPLETED result (even an empty one) from a TIMED-OUT one:
 *  the annotation-noema leg must run only after a completed-empty RRF, never after
 *  an RRF timeout — otherwise two stacked 8s waits return zero hits (Rúnir-yxwe).
 *
 *  Pass `work` as a function that starts the work, not as a started promise, when
 *  it queries the database: a lost race then marks the work abandoned, so its
 *  remaining queries are not sent and are never re-sent after a reconnect (vk-2993). */
export function withTimeoutFlagged<T>(
  work: Promise<T> | (() => Promise<T>),
  ms: number,
  fallback: T | (() => T),
  label: string,
  warn?: (msg: string) => void,
): Promise<{ value: T; timedOut: boolean }> {
  let abandon: (() => void) | undefined;
  let promise: Promise<T>;
  if (typeof work === "function") {
    const started = runAbandonable(work);
    promise = started.promise;
    abandon = started.abandon;
  } else {
    promise = work;
  }
  // The timer MUST be cleared when the race settles: a lost race does not cancel
  // setTimeout, so the warn callback still fired ms later on every SUCCESSFUL call
  // — the log filled with phantom "timed out after 5000ms/8000ms" lines from
  // requests that completed in well under a second, which repeatedly misdirected
  // perf debugging toward timeouts that never happened.
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false })),
    new Promise<{ value: T; timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => {
        abandon?.();
        warn?.(`memory-hybrid: ${label} timed out after ${ms}ms, returning fallback`);
        // Resolve the fallback lazily so an expensive default (e.g. building the
        // entity-leg trace) is only constructed when the timeout actually fires,
        // not on every hot-path recall that completes in time.
        resolve({ value: typeof fallback === "function" ? (fallback as () => T)() : fallback, timedOut: true });
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Races a promise against a timeout. On timeout, resolves to the fallback value
 *  (lazily, when the fallback is a thunk). See withTimeoutFlagged for passing
 *  `work` as a function so a lost race abandons its database queries. */
export function withTimeout<T>(
  work: Promise<T> | (() => Promise<T>),
  ms: number,
  fallback: T | (() => T),
  label: string,
  warn?: (msg: string) => void,
): Promise<T> {
  return withTimeoutFlagged(work, ms, fallback, label, warn).then((r) => r.value);
}
