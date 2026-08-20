import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStyrirAdoption } from "../shared/styrir-workspace.js";

const disposableRoots: string[] = [];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a record");
  }
  return Object.fromEntries(Object.entries(value));
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value.map(record);
}

type RepositoryOptions = {
  readonly ignoreRules?: boolean;
  readonly exportRules?: boolean;
  readonly trackedArtifacts?: boolean;
  readonly styrirToml?: boolean;
};

function adoptionRepository(options: RepositoryOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "runir-styrir-adoption-"));
  disposableRoots.push(root);
  execFileSync("git", ["init", "-q", root]);
  if (options.ignoreRules !== false) {
    writeFileSync(join(root, ".gitignore"), "/.styrir/\n/docs/analysis/\n");
  }
  if (options.exportRules !== false) {
    const release = join(root, "docs", "release");
    mkdirSync(release, { recursive: true });
    writeFileSync(
      join(release, "styrir-export-denylist.txt"),
      "prefix:.styrir\nprefix:docs/analysis\n",
    );
  }
  if (options.styrirToml) {
    writeFileSync(join(root, ".styrir.toml"), "schema_version = 1\n");
  }
  if (options.trackedArtifacts) {
    const generated = [
      join(root, ".styrir", "forced.txt"),
      join(root, "docs", "analysis", "forced.md"),
    ];
    for (const path of generated) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "forced generated artifact");
    }
    execFileSync("git", [
      "-C", root, "add", "-f",
      ".styrir/forced.txt",
      "docs/analysis/forced.md",
    ]);
  }
  return root;
}

function failedCheckIds(report: Record<string, unknown>): string[] {
  return records(report["checks"])
    .filter((check) => check["status"] === "fail")
    .map((check) => String(check["id"]));
}

afterEach(() => {
  for (const root of disposableRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Styrir repository adoption", () => {
  it("passes a repository with every reusable boundary", async () => {
    const report = record(await checkStyrirAdoption(adoptionRepository()));
    expect(report["ok"]).toBe(true);
    expect(failedCheckIds(report)).toEqual([]);
    expect(records(report["checks"]).map((check) => check["id"])).toEqual([
      "ignore_styrir",
      "ignore_docs_analysis",
      "export_deny_styrir",
      "export_deny_docs_analysis",
      "tracked_artifacts",
      "styrir_toml_absent",
    ]);
  });

  it("returns all missing-boundary failures together", async () => {
    const report = record(await checkStyrirAdoption(
      adoptionRepository({
        ignoreRules: false,
        exportRules: false,
        styrirToml: true,
      }),
    ));
    expect(report["ok"]).toBe(false);
    expect(failedCheckIds(report)).toEqual([
      "ignore_styrir",
      "ignore_docs_analysis",
      "export_deny_styrir",
      "export_deny_docs_analysis",
      "styrir_toml_absent",
    ]);
  });

  it("rejects forced tracked artifacts despite ignore rules", async () => {
    const report = record(await checkStyrirAdoption(
      adoptionRepository({ trackedArtifacts: true }),
    ));
    expect(report["ok"]).toBe(false);
    expect(failedCheckIds(report)).toContain("tracked_artifacts");
    expect(JSON.stringify(report)).not.toContain("forced generated artifact");
  });

  it("passes the current repository without leaking environment secrets", async () => {
    const canary = "credential-canary-adoption";
    const previous = process.env["RUNIR_API_KEY"];
    process.env["RUNIR_API_KEY"] = canary;
    try {
      const report = record(await checkStyrirAdoption(process.cwd()));
      expect(report["ok"]).toBe(true);
      expect(JSON.stringify(report)).not.toContain(canary);
    } finally {
      if (previous === undefined) delete process.env["RUNIR_API_KEY"];
      else process.env["RUNIR_API_KEY"] = previous;
    }
  });
});
