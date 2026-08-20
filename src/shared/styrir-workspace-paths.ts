import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export type StyrirPlatform = "darwin" | "linux";

export type StyrirRootOverrides = {
  readonly workspaceRoot?: string;
  readonly configRoot?: string;
  readonly dataRoot?: string;
  readonly stateRoot?: string;
  readonly cacheRoot?: string;
  readonly runtimeRoot?: string;
};

export type UserRoots = {
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
  readonly runtime: string;
};

export type UserRootInput = {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly tempDir?: string;
  readonly uid?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly overrides?: StyrirRootOverrides;
};

const DOT_SEGMENT = /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u;

export function validateAbsoluteOverride(name: string, value: string): string {
  if (!value.trim() || value.includes("\0") || !isAbsolute(value) ||
      DOT_SEGMENT.test(value)) {
    throw new Error(`${name} must be an absolute path without dot segments`);
  }
  return normalize(value);
}

function optionalRoot(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : validateAbsoluteOverride(name, value);
}

function xdgRoot(
  name: string,
  value: string | undefined,
): string | undefined {
  const root = optionalRoot(name, value);
  return root === undefined ? undefined : join(root, "styrir");
}

function platform(input: UserRootInput): StyrirPlatform {
  const value = input.platform ?? process.platform;
  if (value !== "darwin" && value !== "linux") {
    throw new Error(`unsupported Styrir platform: ${value}`);
  }
  return value;
}

export function resolveUserRoots(input: UserRootInput = {}): UserRoots {
  const targetPlatform = platform(input);
  const env = input.env ?? process.env;
  const home = validateAbsoluteOverride("home directory", input.homeDir ?? homedir());
  const temp = validateAbsoluteOverride("temporary directory", input.tempDir ?? tmpdir());
  const overrides = input.overrides ?? {};
  const applicationSupport = join(home, "Library", "Application Support", "Styrir");
  const linux = {
    config: join(home, ".config", "styrir"),
    data: join(home, ".local", "share", "styrir"),
    state: join(home, ".local", "state", "styrir"),
    cache: join(home, ".cache", "styrir"),
    runtime: join(temp, `styrir-${input.uid ?? process.getuid?.() ?? 0}`),
  };
  const native = targetPlatform === "darwin"
    ? {
      config: join(applicationSupport, "config"),
      data: join(applicationSupport, "data"),
      state: join(applicationSupport, "state"),
      cache: join(home, "Library", "Caches", "Styrir"),
      runtime: join(temp, "Styrir"),
    }
    : linux;

  return {
    config: optionalRoot("config root", overrides.configRoot) ??
      optionalRoot("STYRIR_CONFIG_ROOT", env["STYRIR_CONFIG_ROOT"]) ??
      xdgRoot("XDG_CONFIG_HOME", env["XDG_CONFIG_HOME"]) ?? native.config,
    data: optionalRoot("data root", overrides.dataRoot) ??
      optionalRoot("STYRIR_DATA_ROOT", env["STYRIR_DATA_ROOT"]) ??
      xdgRoot("XDG_DATA_HOME", env["XDG_DATA_HOME"]) ?? native.data,
    state: optionalRoot("state root", overrides.stateRoot) ??
      optionalRoot("STYRIR_STATE_ROOT", env["STYRIR_STATE_ROOT"]) ??
      xdgRoot("XDG_STATE_HOME", env["XDG_STATE_HOME"]) ?? native.state,
    cache: optionalRoot("cache root", overrides.cacheRoot) ??
      optionalRoot("STYRIR_CACHE_ROOT", env["STYRIR_CACHE_ROOT"]) ??
      xdgRoot("XDG_CACHE_HOME", env["XDG_CACHE_HOME"]) ?? native.cache,
    runtime: optionalRoot("runtime root", overrides.runtimeRoot) ??
      optionalRoot("STYRIR_RUNTIME_ROOT", env["STYRIR_RUNTIME_ROOT"]) ??
      xdgRoot("XDG_RUNTIME_DIR", env["XDG_RUNTIME_DIR"]) ?? native.runtime,
  };
}
