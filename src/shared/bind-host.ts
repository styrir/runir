/**
 * Bind host for the HTTP server (Rúnir-o75n.1).
 *
 * Lives in its own module (not config.ts) deliberately: config.ts is partially
 * mocked by many test files, and adding exports there breaks those factory
 * mocks via runtime.ts's transitive import.
 */

/**
 * Defaults to loopback-only so a fresh install is never exposed on all
 * interfaces by accident. Set RUNIR_HOST=0.0.0.0 to restore all-interfaces
 * binding (set RUNIR_API_KEY first).
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.RUNIR_HOST?.trim();
  return host ? host : "127.0.0.1";
}
