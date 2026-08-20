import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRepositoryIdentity } from "./styrir-workspace-repository.js";

export const STYRIR_REQUIRED_IGNORE_RULES: readonly string[] = [
  "/.styrir/",
  "/docs/analysis/",
];

export const STYRIR_REQUIRED_EXPORT_DENY_RULES: readonly string[] = [
  "prefix:.styrir",
  "prefix:docs/analysis",
];

export type AdoptionCheckId =
  | "ignore_styrir"
  | "ignore_docs_analysis"
  | "export_deny_styrir"
  | "export_deny_docs_analysis"
  | "tracked_artifacts"
  | "styrir_toml_absent";

export type AdoptionCheck = {
  readonly id: AdoptionCheckId;
  readonly status: "pass" | "fail";
};

export type AdoptionReport = {
  readonly schemaVersion: "styrir-adoption/v1";
  readonly repoRoot: string;
  readonly ok: boolean;
  readonly checks: readonly AdoptionCheck[];
};

async function textLines(path: string): Promise<Set<string>> {
  try {
    const text = await readFile(path, "utf8");
    return new Set(text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw new Error("unable to inspect Styrir configuration boundary");
  }
}

function trackedArtifacts(repoRoot: string): Promise<boolean> {
  return new Promise((complete, reject) => {
    execFile(
      "git",
      ["-C", repoRoot, "ls-files", "-z", "--", ".styrir", "docs/analysis"],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(new Error("unable to inspect tracked artifact boundary"));
        else complete(stdout.length > 0);
      },
    );
  });
}

function check(id: AdoptionCheckId, passes: boolean): AdoptionCheck {
  return { id, status: passes ? "pass" : "fail" };
}

export async function checkStyrirAdoption(
  startPath: string,
): Promise<AdoptionReport> {
  const repository = await resolveRepositoryIdentity(startPath);
  const ignoreLines = await textLines(join(repository.root, ".gitignore"));
  const exportLines = await textLines(
    join(repository.root, "docs", "release", "styrir-export-denylist.txt"),
  );
  const hasTrackedArtifacts = await trackedArtifacts(repository.root);
  const hasUnconsumedConfig = await exists(join(repository.root, ".styrir.toml"));
  const checks: AdoptionCheck[] = [
    check("ignore_styrir", ignoreLines.has(STYRIR_REQUIRED_IGNORE_RULES[0] ?? "")),
    check(
      "ignore_docs_analysis",
      ignoreLines.has(STYRIR_REQUIRED_IGNORE_RULES[1] ?? ""),
    ),
    check(
      "export_deny_styrir",
      exportLines.has(STYRIR_REQUIRED_EXPORT_DENY_RULES[0] ?? ""),
    ),
    check(
      "export_deny_docs_analysis",
      exportLines.has(STYRIR_REQUIRED_EXPORT_DENY_RULES[1] ?? ""),
    ),
    check("tracked_artifacts", !hasTrackedArtifacts),
    check("styrir_toml_absent", !hasUnconsumedConfig),
  ];
  return {
    schemaVersion: "styrir-adoption/v1",
    repoRoot: repository.root,
    ok: checks.every((entry) => entry.status === "pass"),
    checks,
  };
}
