/**
 * Graceful shutdown for the local service.
 *
 * The old SIGTERM/SIGINT handlers closed the DB but NEVER closed the HTTP
 * server, so the process kept the listening socket open and lingered until
 * launchd's SIGKILL — which, combined with the Volta-shim fork, is how a
 * restart could leave an orphan squatting :7700. This stops accepting
 * connections, releases the port, and exits promptly so launchd can restart
 * cleanly, with a force-exit backstop if close hangs.
 *
 * Dependency-injected so it is unit-testable without booting the app;
 * registerShutdownHandlers (server.ts) wires the real server handle, db.close,
 * consolidation stopper, and process.exit.
 */
export interface ShutdownDeps {
  server?: { close: (cb?: (err?: Error) => void) => void };
  stopConsolidation?: () => void;
  closeDb: () => unknown | Promise<unknown>;
  exit: (code: number) => void;
  log?: (msg: string) => void;
  /** Force-exit if graceful close hasn't completed within this window. */
  timeoutMs?: number;
}

export async function performGracefulShutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  deps.log?.(`runir-service: ${signal} received, shutting down`);
  const forceExit = setTimeout(() => {
    deps.log?.("runir-service: shutdown timed out, forcing exit");
    deps.exit(1);
  }, deps.timeoutMs ?? 5000);
  // Don't let the backstop timer keep the event loop alive on its own.
  (forceExit as { unref?: () => void }).unref?.();

  // Each step is best-effort: a failure in one must not block the others or
  // prevent the process from exiting and releasing the port.
  try { deps.stopConsolidation?.(); } catch { /* best-effort */ }
  try { deps.server?.close(); } catch { /* best-effort */ }
  try { await deps.closeDb(); } catch { /* best-effort */ }

  clearTimeout(forceExit);
  deps.exit(0);
}
