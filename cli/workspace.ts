import { parseArgs } from "node:util";
import {
  applyWorkspaceRetention,
  planWorkspaceRetention,
  resolveRetentionPolicy,
  resolveStyrirPaths,
  type RetentionOverrides,
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
  runir workspace cleanup [root options] [retention options] [--apply] [--json]

Commands:
  resolve   Resolve repository, .styrir, and user-scoped paths
  cleanup   Plan retention cleanup; mutation requires --apply

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

Retention options:
  --runs-days <n>               Default: 30
  --logs-days <n>               Default: 14
  --cache-days <n>              Default: 7
  --tmp-days <n>                Default: 1
  --now <ISO-8601>              Evaluation time; default is current time
  --apply                       Apply the exact validated plan

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

function retentionOverrides(
  values: Readonly<Record<string, string | boolean | undefined>>,
): RetentionOverrides {
  const string = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    runs: string("runs-days"),
    logs: string("logs-days"),
    cache: string("cache-days"),
    tmp: string("tmp-days"),
  };
}

function cleanupNow(value: string | boolean | undefined): Date {
  const now = typeof value === "string" ? new Date(value) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("--now must be a valid ISO-8601 timestamp");
  }
  return now;
}

async function runCleanup(
  values: Readonly<Record<string, string | boolean | undefined>>,
  io: WorkspaceIo,
): Promise<number> {
  const resolved = await resolveStyrirPaths({
    repoStart: typeof values.repo === "string" ? values.repo : undefined,
    env: io.env,
    overrides: overrides(values),
  });
  const policies = resolveRetentionPolicy(retentionOverrides(values), io.env);
  const plan = await planWorkspaceRetention(
    resolved.workspaceRoot,
    policies,
    cleanupNow(values.now),
  );
  if (values.apply !== true) {
    io.stdout(JSON.stringify({
      mode: "dry-run",
      now: plan.evaluatedAt,
      policies: plan.policies,
      candidates: plan.candidates.map((candidate) => candidate.id),
      retained: plan.retained,
    }, null, values.pretty ? 2 : undefined));
    return 0;
  }
  const result = await applyWorkspaceRetention(plan);
  io.stdout(JSON.stringify({
    mode: "apply",
    now: plan.evaluatedAt,
    policies: plan.policies,
    candidates: result.plannedCandidateIds,
    deletedCandidateIds: result.deletedCandidateIds,
    retained: result.retained,
    errors: result.errors,
  }, null, values.pretty ? 2 : undefined));
  return result.errors.length === 0 ? 0 : 2;
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
  if (command === "cleanup") {
    return runCleanup(values, io);
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
