// Preflight shared by the OM live smokes (vk-2997).
//
// Resolves RUNIR_USER_ID and RUNIR_API_KEY the way the extension does: the
// process environment first, then RUNIR_ENV_FILE (default ~/Code/runir/.env).
// Exits 2 naming everything missing, so an unconfigured smoke never reports
// success. Prints which source each came from, never the values.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readDotEnvValue(filePath, key) {
  try {
    const prefix = `${key}=`;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(prefix)) continue;
      const raw = trimmed.slice(prefix.length).trim();
      const unquoted = raw.match(/^(["'])(.*)\1$/)?.[2] ?? raw;
      return unquoted.trim() || undefined;
    }
  } catch {
    // Missing or unreadable file: treated as not set.
  }
  return undefined;
}

/** Exits 2 unless both the tenant and the API key resolve; returns their sources. */
export function requireLiveConfig(name) {
  const envFile = process.env.RUNIR_ENV_FILE ?? join(homedir(), "Code", "runir", ".env");
  const sources = {};
  const missing = [];
  for (const key of ["RUNIR_USER_ID", "RUNIR_API_KEY"]) {
    if (process.env[key]?.trim()) sources[key] = "environment";
    else if (readDotEnvValue(envFile, key)) sources[key] = "RUNIR_ENV_FILE";
    else missing.push(key);
  }
  if (missing.length > 0) {
    console.error(
      `${name}: ${missing.join(" and ")} not set; checked the environment and RUNIR_ENV_FILE (${envFile})`,
    );
    process.exit(2);
  }
  console.log(`${name}: tenant from ${sources.RUNIR_USER_ID}, API key from ${sources.RUNIR_API_KEY}`);
  return sources;
}
