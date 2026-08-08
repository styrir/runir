import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

describe("repository-generated artifact boundary", () => {
  it("keeps Styrir workspaces and legacy analysis output untracked", () => {
    const tracked = execFileSync(
      "git",
      ["ls-files", "-z", "--", ".styrir", "docs/analysis"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(tracked).toBe("");
  });

  it("shares the ignore and export boundary with every clone", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/u);
    expect(gitignore).toContain("/.styrir/");
    expect(gitignore).toContain("/docs/analysis/");

    const denylist = readFileSync(
      join(ROOT, "docs/release/styrir-export-denylist.txt"),
      "utf8",
    ).split(/\r?\n/u);
    expect(denylist).toContain("prefix:.styrir");
    expect(denylist).toContain("prefix:docs/analysis");
  });
});

describe("agent-guidance progressive disclosure", () => {
  it("keeps Beads details in the conditional in-repo guidance file", () => {
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    const planning = readFileSync(
      join(ROOT, "docs/agent-guidance/planning-beads-and-handoffs.md"),
      "utf8",
    );

    expect(agents).toContain("docs/agent-guidance/planning-beads-and-handoffs.md");
    expect(agents).not.toContain("BEGIN BEADS");
    expect(agents).not.toContain("Beads Issue Tracker");
    expect(claude).not.toContain("Beads");
    expect(claude).not.toContain("Use `bd`");
    expect(planning).toContain("database: `runir_product`");
    expect(planning).toContain("issue prefix: `Rúnir-`");

    for (const text of [agents, claude, planning]) {
      expect(text).not.toMatch(/~\/|\/Users\/|agent-ops|runir-archive/u);
    }
  });
});
