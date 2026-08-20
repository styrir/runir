import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWorkspaceRetention,
  planWorkspaceRetention,
  resolveRetentionPolicy,
} from "../shared/styrir-workspace.js";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-20T00:00:00.000Z");
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

function fixture(): { root: string; workspace: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "runir-styrir-retention-"));
  disposableRoots.push(root);
  const workspace = join(root, "repo", ".styrir");
  const outside = join(root, "outside");
  for (const path of [
    join(workspace, "runs"),
    join(workspace, "logs"),
    join(workspace, "cache"),
    join(workspace, "tmp"),
    join(workspace, "analysis"),
    outside,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  return { root, workspace, outside };
}

function fileAt(path: string, ageDays: number, offsetMs = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, path);
  const timestamp = new Date(NOW.getTime() - ageDays * DAY_MS + offsetMs);
  utimesSync(path, timestamp, timestamp);
}

function candidateIds(value: unknown): string[] {
  const plan = record(value);
  return records(plan["candidates"]).map((candidate) => String(candidate["id"]));
}

function retainedReasons(value: unknown): string[] {
  const plan = record(value);
  return records(plan["retained"]).map((entry) => String(entry["reason"]));
}

afterEach(() => {
  for (const root of disposableRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Styrir retention policy", () => {
  it("uses distinct defaults and validates API-over-environment overrides", () => {
    expect(resolveRetentionPolicy({}, {})).toEqual({
      runs: 30,
      logs: 14,
      cache: 7,
      tmp: 1,
    });
    expect(resolveRetentionPolicy(
      { runs: 3 },
      {
        STYRIR_RETENTION_RUNS_DAYS: "9",
        STYRIR_RETENTION_LOGS_DAYS: "4",
        STYRIR_RETENTION_CACHE_DAYS: "2",
        STYRIR_RETENTION_TMP_DAYS: "0",
      },
    )).toEqual({ runs: 3, logs: 4, cache: 2, tmp: 0 });
    for (const value of ["", "-1", "1.5", "NaN", "9007199254740992"]) {
      expect(() => resolveRetentionPolicy(
        {},
        { STYRIR_RETENTION_RUNS_DAYS: value },
      )).toThrow(/retention/u);
    }
  });
});

describe("Styrir retention planning and apply", () => {
  it("selects only strictly expired entries for each managed class", async () => {
    const { workspace } = fixture();
    const policies: readonly (readonly [string, number])[] = [
      ["runs", 30],
      ["logs", 14],
      ["cache", 7],
      ["tmp", 1],
    ];
    for (const [managedClass, days] of policies) {
      fileAt(join(workspace, managedClass, "old"), days, -1);
      fileAt(join(workspace, managedClass, "boundary"), days);
      fileAt(join(workspace, managedClass, "new"), days, 1);
    }
    const policy = resolveRetentionPolicy({}, {});
    const plan = await planWorkspaceRetention(
      workspace,
      policy,
      NOW,
    );
    expect(candidateIds(plan)).toEqual([
      "runs/old",
      "logs/old",
      "cache/old",
      "tmp/old",
    ]);
    expect(existsSync(join(workspace, "tmp", "old"))).toBe(true);
  });

  it("retains nested freshness, symlinks, and unmanaged roots", async () => {
    const { workspace, outside } = fixture();
    const nested = join(workspace, "runs", "nested");
    mkdirSync(nested);
    fileAt(join(nested, "old"), 31);
    fileAt(join(nested, "new"), 1);
    const linked = join(workspace, "tmp", "linked");
    mkdirSync(linked);
    fileAt(join(outside, "sentinel"), 30);
    symlinkSync(join(outside, "sentinel"), join(linked, "escape"));
    fileAt(join(workspace, "analysis", "preserved"), 400);

    const plan = await planWorkspaceRetention(
      workspace,
      resolveRetentionPolicy({}, {}),
      NOW,
    );
    expect(retainedReasons(plan)).toEqual(expect.arrayContaining([
      "newer_than_cutoff",
      "symlink",
    ]));
    const result = record(await applyWorkspaceRetention(plan));
    expect(result["deletedCandidateIds"]).toEqual([]);
    expect(existsSync(join(outside, "sentinel"))).toBe(true);
    expect(existsSync(join(workspace, "analysis", "preserved"))).toBe(true);
  });

  it("deletes eligible trees bottom-up and preserves boundary entries", async () => {
    const { workspace } = fixture();
    const expired = join(workspace, "tmp", "expired", "child");
    fileAt(expired, 2);
    const expiredRoot = join(workspace, "tmp", "expired");
    const old = new Date(NOW.getTime() - 2 * DAY_MS);
    utimesSync(expiredRoot, old, old);
    fileAt(join(workspace, "tmp", "boundary"), 1);
    const plan = await planWorkspaceRetention(
      workspace,
      resolveRetentionPolicy({}, {}),
      NOW,
    );
    const before = candidateIds(plan);
    const result = record(await applyWorkspaceRetention(plan));
    expect(result["plannedCandidateIds"]).toEqual(before);
    expect(result["deletedCandidateIds"]).toEqual(["tmp/expired"]);
    expect(existsSync(expiredRoot)).toBe(false);
    expect(existsSync(join(workspace, "tmp", "boundary"))).toBe(true);
  });

  it("fails closed when candidates or the workspace change after planning", async () => {
    const { root, workspace, outside } = fixture();
    const candidate = join(workspace, "tmp", "candidate");
    fileAt(candidate, 2);
    const plan = await planWorkspaceRetention(
      workspace,
      resolveRetentionPolicy({}, {}),
      NOW,
    );
    rmSync(candidate);
    symlinkSync(join(outside, "sentinel"), candidate);
    writeFileSync(join(outside, "sentinel"), "outside");
    const changed = record(await applyWorkspaceRetention(plan));
    expect(changed["deletedCandidateIds"]).toEqual([]);
    expect(JSON.stringify(changed)).toMatch(/changed|type/u);
    expect(existsSync(join(outside, "sentinel"))).toBe(true);

    rmSync(candidate);
    const moved = `${workspace}-old`;
    renameSync(workspace, moved);
    mkdirSync(workspace, { recursive: true });
    fileAt(join(workspace, "tmp", "replacement"), 3);
    const replaced = record(await applyWorkspaceRetention(plan));
    expect(replaced["deletedCandidateIds"]).toEqual([]);
    expect(existsSync(join(workspace, "tmp", "replacement"))).toBe(true);
    expect(root).toContain("runir-styrir-retention-");
  });

  it("reports sanitized deletion failures without claiming success", async () => {
    const { workspace } = fixture();
    const candidate = join(workspace, "tmp", "failure");
    fileAt(candidate, 2);
    const plan = await planWorkspaceRetention(
      workspace,
      resolveRetentionPolicy({}, {}),
      NOW,
    );
    const result = record(await applyWorkspaceRetention(plan, {
      unlink: async () => {
        throw new Error("credential-canary /private/secret");
      },
    }));
    expect(result["deletedCandidateIds"]).toEqual([]);
    expect(result["errors"]).toEqual([
      { id: "tmp/failure", reason: "delete_failed" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/credential-canary|\/private\/secret/u);
    expect(existsSync(candidate)).toBe(true);
  });

  it("rejects unsafe roots and handles absent managed roots", async () => {
    const { root, workspace } = fixture();
    const policy = resolveRetentionPolicy({}, {});
    await expect(planWorkspaceRetention(
      `${join(root, "repo")}/../repo/.styrir`,
      policy,
      NOW,
    )).rejects.toThrow(/workspace root/u);
    const linkedRoot = join(root, "linked-workspace");
    symlinkSync(workspace, linkedRoot, "dir");
    await expect(planWorkspaceRetention(
      linkedRoot,
      policy,
      NOW,
    )).rejects.toThrow(/symlink/u);

    const empty = join(root, "empty", ".styrir");
    mkdirSync(empty, { recursive: true });
    const plan = await planWorkspaceRetention(
      empty,
      policy,
      NOW,
    );
    expect(plan["candidates"]).toEqual([]);
  });
});
