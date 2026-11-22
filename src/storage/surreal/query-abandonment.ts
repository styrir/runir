import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks database work whose caller has stopped waiting (vk-2993).
 *
 * Recall races its database legs against timeouts and returns a fallback when
 * a timeout wins, but the losing work keeps running. Without a marker, that
 * work keeps sending queries and, after a dropped connection, re-sends them.
 * Each re-sent query runs to completion on the server even though nobody
 * reads the result. Work started inside {@link runAbandonable} can be
 * abandoned, after which {@link SurrealClient.query} refuses to send or
 * re-send its queries.
 */
type AbandonScope = { abandoned: boolean; parent?: AbandonScope };

const scopes = new AsyncLocalStorage<AbandonScope>();

export class AbandonedQueryError extends Error {
  override name = "AbandonedQueryError";
  constructor() {
    super("query not sent: its caller already gave up waiting (timed out)");
  }
}

/**
 * Starts `work` in a scope that can be abandoned. Scopes nest: abandoning an
 * outer scope also abandons work started in scopes inside it.
 */
export function runAbandonable<T>(work: () => Promise<T>): { promise: Promise<T>; abandon: () => void } {
  const scope: AbandonScope = { abandoned: false, parent: scopes.getStore() };
  const promise = scopes.run(scope, async () => work());
  return { promise, abandon: () => { scope.abandoned = true; } };
}

/**
 * Races `work` against a timer. When the timer wins, the work is abandoned (its
 * remaining queries are not sent or re-sent) and the race rejects with
 * `timeoutMessage`. Every timeout around database work should go through here
 * or through withTimeoutFlagged with a function argument.
 */
export async function raceAbandonable<T>(work: () => Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  const { promise, abandon } = runAbandonable(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abandon(); reject(new Error(timeoutMessage)); }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the current async context belongs to abandoned work. */
export function isCurrentWorkAbandoned(): boolean {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.abandoned) return true;
  }
  return false;
}
