/**
 * imaf.2: @hono/node-server's serve() returns a node http.Server with NO error
 * listener — a listen-time failure (EADDRINUSE when another instance holds the
 * port) was an uncaught 'error' event → process crash → launchd KeepAlive
 * restart → re-collide (49 crash-loop entries observed 2026-06). Exit
 * DELIBERATELY with a clear line instead.
 *
 * Standalone module (no service import graph) so the double-bind unit test can
 * import it without booting storage clients.
 */
export function attachServerErrorHandler(
  httpServer: NodeJS.EventEmitter,
  port: number,
  exit: (code: number) => void = process.exit,
): void {
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`runir-service: port ${port} is already in use — is another instance running? Exiting.`);
    } else {
      console.error("runir-service: HTTP server error:", err);
    }
    exit(1);
  });
}
