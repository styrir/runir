import { serve } from "@hono/node-server";
import { createReviewStudioApp } from "./app.js";

type CliOptions = {
  readonly roots: string[];
  readonly port: number;
  readonly trace: boolean;
  readonly runirBaseUrl: string;
  readonly runirUserId?: string;
  readonly runirApiKey?: string;
};

export const DEFAULT_RUNIR_BASE_URL = "http://127.0.0.1:7700/";

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const roots: string[] = [];
  let port = 7711;
  let trace = false;
  let runirBaseUrl = env.RUNIR_BASE_URL ?? DEFAULT_RUNIR_BASE_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires an explicit artifact directory");
      roots.push(value);
      index += 1;
    } else if (arg === "--port") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error("--port requires an integer from 1 to 65535");
      }
      port = parsed;
      index += 1;
    } else if (arg === "--trace") {
      trace = true;
    } else if (arg === "--runir-base-url") {
      const value = argv[index + 1];
      if (!value) throw new Error("--runir-base-url requires an explicit fixed loopback URL");
      runirBaseUrl = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run review-studio -- --root <artifact-dir> [--root <artifact-dir>] [--port 7711] [--trace --runir-base-url http://127.0.0.1:7700/]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (roots.length === 0) {
    throw new Error("Review Studio requires at least one explicit --root artifact directory.");
  }
  if (!trace) return { roots, port, trace: false, runirBaseUrl };

  const runirUserId = env.RUNIR_USER_ID;
  const runirApiKey = env.RUNIR_API_KEY;
  if (typeof runirUserId !== "string" || runirUserId.trim().length === 0) {
    throw new Error("Trace mode requires an explicit RUNIR_USER_ID; no default user is permitted.");
  }
  if (typeof runirApiKey !== "string" || runirApiKey.trim().length === 0) {
    throw new Error("Trace mode requires an explicit RUNIR_API_KEY; no credential default is permitted.");
  }
  return {
    roots,
    port,
    trace: true,
    runirBaseUrl,
    runirUserId,
    runirApiKey,
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && /(?:^|[\\/])review-studio[\\/]server\.(?:ts|js)$/u.test(entry);
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const studio = createReviewStudioApp({
      artifactRoots: options.roots,
      port: options.port,
      ...(options.trace
        ? {
            traceBackend: {
              runirBaseUrl: options.runirBaseUrl,
              runirUserId: options.runirUserId!,
              runirApiKey: options.runirApiKey!,
            },
          }
        : {}),
    });
    serve({ fetch: studio.app.fetch, hostname: "127.0.0.1", port: options.port });
    process.stdout.write(
      `Review Studio listening at ${studio.security.binding.canonicalOrigin} (roots: ${options.roots.length}; ${options.trace ? "trace proxy enabled" : "file-only"})\n`,
    );
  } catch (error) {
    process.stderr.write(`Review Studio failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs };
