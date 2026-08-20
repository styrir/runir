import { parseArgs } from "node:util";
import {
  resolveStyrirPaths,
  type StyrirRootOverrides,
} from "../src/shared/styrir-workspace.js";

type WorkspaceIo = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

const defaultIo: WorkspaceIo = {
  env: process.env,
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
};

export function workspaceUsage(): string {
  return `runir workspace - resolve and maintain Styrir workspace paths

Usage:
  runir workspace resolve [root options] [--json] [--pretty]

Commands:
  resolve   Resolve repository, .styrir, and user-scoped paths

Override precedence:
  CLI flag > matching STYRIR_* environment > XDG variable > platform default

Root options:
  --repo <path>
  --workspace-root <path>       STYRIR_WORKSPACE_ROOT
  --config-root <path>          STYRIR_CONFIG_ROOT
  --data-root <path>            STYRIR_DATA_ROOT
  --state-root <path>           STYRIR_STATE_ROOT
  --cache-root <path>           STYRIR_CACHE_ROOT
  --runtime-root <path>         STYRIR_RUNTIME_ROOT

Output:
  --json       Emit machine-readable JSON
  --pretty     Indent JSON output
  --help       Show this help`;
}

function overrides(
  values: Readonly<Record<string, string | boolean | undefined>>,
): StyrirRootOverrides {
  return {
    workspaceRoot: typeof values["workspace-root"] === "string"
      ? values["workspace-root"]
      : undefined,
    configRoot: typeof values["config-root"] === "string"
      ? values["config-root"]
      : undefined,
    dataRoot: typeof values["data-root"] === "string"
      ? values["data-root"]
      : undefined,
    stateRoot: typeof values["state-root"] === "string"
      ? values["state-root"]
      : undefined,
    cacheRoot: typeof values["cache-root"] === "string"
      ? values["cache-root"]
      : undefined,
    runtimeRoot: typeof values["runtime-root"] === "string"
      ? values["runtime-root"]
      : undefined,
  };
}

function printResolved(
  value: Awaited<ReturnType<typeof resolveStyrirPaths>>,
  pretty: boolean,
  io: WorkspaceIo,
): void {
  io.stdout(JSON.stringify(value, null, pretty ? 2 : undefined));
}

export async function runWorkspaceCommand(
  argv: readonly string[],
  io: WorkspaceIo = defaultIo,
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(workspaceUsage());
    return 0;
  }
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: false,
    options: {
      repo: { type: "string" },
      "workspace-root": { type: "string" },
      "config-root": { type: "string" },
      "data-root": { type: "string" },
      "state-root": { type: "string" },
      "cache-root": { type: "string" },
      "runtime-root": { type: "string" },
      "runs-days": { type: "string" },
      "logs-days": { type: "string" },
      "cache-days": { type: "string" },
      "tmp-days": { type: "string" },
      now: { type: "string" },
      apply: { type: "boolean" },
      json: { type: "boolean" },
      pretty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.stdout(workspaceUsage());
    return 0;
  }
  if (command !== "resolve") {
    io.stderr(`workspace command is not implemented: ${command}`);
    return 1;
  }
  const resolved = await resolveStyrirPaths({
    repoStart: values.repo,
    env: io.env,
    overrides: overrides(values),
  });
  printResolved(resolved, values.pretty ?? false, io);
  return 0;
}
