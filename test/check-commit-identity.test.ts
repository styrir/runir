import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHECK = path.resolve(__dirname, "../scripts/check-commit-identity.sh");
const COMMIT_MSG_HOOK = path.resolve(__dirname, "../.githooks/commit-msg");
const OK_EMAIL = "304483768+styrir@users.noreply.github.com";

let repo: string;

function git(args: string[], email = OK_EMAIL) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "styrir",
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "styrir",
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(file: string, content: string, message: string, email = OK_EMAIL) {
  writeFileSync(path.join(repo, file), content);
  git(["add", file], email);
  git(["commit", "-q", "-m", message], email);
}

function check(...args: string[]) {
  return spawnSync(CHECK, args, { cwd: repo, encoding: "utf8" });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "commit-identity-"));
  git(["init", "-q", "-b", "main"]);
  commit("a.txt", "a\n", "base");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("check-commit-identity.sh", () => {
  it("accepts commits by the styrir noreply identities with no co-authors", () => {
    commit("b.txt", "b\n", "second", "styrir@users.noreply.github.com");
    expect(check("HEAD").status).toBe(0);
  });

  it("rejects a Co-authored-by trailer in any case", () => {
    commit("b.txt", "b\n", "change\n\nco-authored-by: Cursor <cursoragent@cursor.com>");
    const r = check("HEAD~1..HEAD");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Co-authored-by trailer/);
  });

  it("rejects an author email outside the allowlist", () => {
    commit("b.txt", "b\n", "change", "someone@example.com");
    const r = check("HEAD~1..HEAD");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/someone@example\.com is not allowed/);
  });

  it("rejects added lines or messages containing a local private term", () => {
    writeFileSync(path.join(repo, ".git/info/private-terms"), "# local only\nsecretname\n");
    commit("b.txt", "hello SecretName\n", "change");
    expect(check("HEAD~1..HEAD").status).toBe(1);
    expect(check("HEAD~1").status).toBe(0);
  });
});

describe(".githooks/commit-msg", () => {
  function runHook(message: string, email = OK_EMAIL) {
    const msgFile = path.join(repo, "MSG");
    writeFileSync(msgFile, message);
    return spawnSync(COMMIT_MSG_HOOK, [msgFile], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "styrir", GIT_AUTHOR_EMAIL: email },
    });
  }

  it("accepts a plain message from an allowed identity", () => {
    expect(runHook("change\n").status).toBe(0);
  });

  it("rejects a co-author trailer", () => {
    expect(runHook("change\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n").status).toBe(1);
  });

  it("rejects a disallowed author email", () => {
    expect(runHook("change\n", "me@example.com").status).toBe(1);
  });
});
