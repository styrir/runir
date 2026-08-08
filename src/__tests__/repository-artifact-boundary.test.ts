import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  it("keeps Beads/Dolt and handoff details in separate conditional guides", () => {
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    const beads = readFileSync(
      join(ROOT, "docs/agent-guidance/beads-and-dolt.md"),
      "utf8",
    );
    const handoffs = readFileSync(
      join(ROOT, "docs/agent-guidance/handoffs.md"),
      "utf8",
    );
    const shell = readFileSync(
      join(ROOT, "docs/agent-guidance/non-interactive-shell.md"),
      "utf8",
    );

    expect(agents).toContain("Do not add large procedural, reference, or");
    expect(agents).toContain("docs/agent-guidance/styrir-workspace.md");
    expect(agents).toContain("docs/agent-guidance/beads-and-dolt.md");
    expect(agents).toContain("docs/agent-guidance/handoffs.md");
    expect(agents).toContain("docs/agent-guidance/non-interactive-shell.md");
    expect(agents).not.toContain("```");
    expect(agents).not.toContain("planning-beads-and-handoffs.md");
    expect(existsSync(
      join(ROOT, "docs/agent-guidance/planning-beads-and-handoffs.md"),
    )).toBe(false);
    expect(existsSync(join(ROOT, "docs/styrir-workspace-layout.md"))).toBe(false);
    expect(agents).not.toContain("BEGIN BEADS");
    expect(agents).not.toContain("Beads Issue Tracker");
    expect(claude).not.toContain("Beads");
    expect(claude).not.toContain("Use `bd`");
    expect(claude).not.toContain("## Generated workspace");
    expect(beads).toContain("database: `runir_product`");
    expect(beads).toContain("issue prefix: `Rúnir-`");
    expect(handoffs).not.toMatch(/\bbd\s/u);
    expect(handoffs).toContain("what is implemented, what is only proposed");
    expect(shell).toContain("BatchMode=yes");

    for (const text of [agents, claude, beads, handoffs, shell]) {
      expect(text).not.toMatch(/~\/|\/Users\/|agent-ops|runir-archive/u);
    }
  });
});
