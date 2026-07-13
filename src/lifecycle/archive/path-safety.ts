// Shared vault/report write-containment guard (Rúnir-78sy.5).
//
// A single tested implementation of "this relative path must resolve inside the
// root directory" — used by BOTH the vault exporter's VaultWriter and the
// continuity report writer so DB-/date-controlled path segments can never escape
// the output root (Codex brief-review F8: extract + test, do not replicate).

import { isAbsolute, join, relative, resolve } from "node:path";

export class PathEscapeError extends Error {}

/**
 * Resolves `relPath` against `root` and asserts the result is strictly inside
 * `root`. Returns the joined absolute path on success; throws (via `makeError`,
 * or `PathEscapeError` by default) when the path is the root itself, escapes via
 * `..`, or is absolute. Callers pass `makeError` to preserve their own error type.
 */
export function assertWithinRoot(root: string, relPath: string, makeError?: (message: string) => Error): string {
  const fail = (): never => {
    const message = `refusing write outside root: ${relPath}`;
    throw makeError ? makeError(message) : new PathEscapeError(message);
  };
  // Reject an absolute segment outright (bad DB-/date-controlled input) rather
  // than let join() silently contain it under root (Codex F5).
  if (isAbsolute(relPath)) fail();
  const fullPath = join(root, relPath);
  const rel = relative(resolve(root), resolve(fullPath));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) fail();
  return fullPath;
}
