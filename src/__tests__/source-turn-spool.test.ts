import { appendFile, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceTurnSpool } from "../capture/source-turn-spool.js";
import { prepareSourceTurn } from "../capture/source-turn-identity.js";

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runir-source-spool-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const turn = () => prepareSourceTurn({
  userId: "synthetic", client: "pi", sessionId: "s", turnKey: "pi:a", role: "user",
  content: "synthetic source text", occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
}, "synthetic-key");

describe("durable source spool", () => {
  it("commits put and extraction marker in one sync, with restart replay", async () => {
    const path = await directory();
    const item = turn();
    const spool = new SourceTurnSpool(path);
    expect((await spool.reserveCapture([item])).accepted).toEqual([true]);
    expect(spool.syncCount()).toBe(0);
    await spool.commitCapture([item], [item]);
    expect(spool.syncCount()).toBe(1);
    const restarted = new SourceTurnSpool(path);
    expect(await restarted.isExtracted(item)).toBe(true);
    expect(await restarted.seenCandidates([item])).toEqual([{ known: true, extracted: true, forgotten: false }]);
  });

  it("commits failed extraction puts once and leaves retry eligible", async () => {
    const path = await directory();
    const item = turn();
    const spool = new SourceTurnSpool(path);
    await spool.reserveCapture([item]);
    await spool.commitCapture([item], []);
    expect(spool.syncCount()).toBe(1);
    expect(await new SourceTurnSpool(path).isExtracted(item)).toBe(false);
  });

  it("supersedes an unextracted put with changed text and marks the new body durably", async () => {
    const path = await directory();
    const oldTurn = turn();
    const changed = prepareSourceTurn({ userId: "synthetic", client: "pi", sessionId: "s",
      turnKey: "pi:a", role: "user", content: "changed synthetic source text",
      occurredAt: "2026-09-25T00:00:00.000Z", scope: "user" }, "synthetic-key");
    const spool = new SourceTurnSpool(path);
    await spool.commitCapture([oldTurn], []); // put-only after an extraction failure
    expect((await spool.reserveCapture([changed])).accepted).toEqual([true]);
    await spool.commitCapture([changed], [changed]);
    const replay = new SourceTurnSpool(path);
    expect(await replay.isExtracted(changed)).toBe(true);
    expect(await replay.isExtracted(oldTurn)).toBe(false);
    const drained: string[] = [];
    await replay.drain(async (item) => { drained.push(item.content); return "inserted"; });
    expect(drained).toEqual([changed.content]);
    expect((await replay.reserveCapture([changed])).accepted).toEqual([true]);
    expect(await replay.isExtracted(changed)).toBe(true);
  });

  it("keeps a pre-sync crash retry eligible and a post-sync crash complete", async () => {
    const path = await directory();
    const item = turn();
    const interrupted = new SourceTurnSpool(path, async (handle) => {
      await handle.truncate(0); // Simulate losing all unsynced bytes on crash.
      throw new Error("crash before sync");
    });
    await expect(interrupted.commitCapture([item], [item])).rejects.toThrow();
    const retry = new SourceTurnSpool(path);
    expect(await retry.isExtracted(item)).toBe(false);
    await retry.commitCapture([item], [item]);
    expect(await new SourceTurnSpool(path).isExtracted(item)).toBe(true);
  });

  it("removes failed marker bytes before a durable put-only fallback", async () => {
    const path = await directory();
    const item = turn();
    let attempts = 0;
    const spool = new SourceTurnSpool(path, async (handle) => {
      if (++attempts === 1) throw new Error("synthetic commit failure");
      await handle.sync();
    });
    await expect(spool.commitCapture([item], [item])).rejects.toThrow("synthetic commit failure");
    await spool.commitCapture([item], []);
    const restarted = new SourceTurnSpool(path);
    expect(await restarted.isExtracted(item)).toBe(false);
    expect(restarted.snapshot().pending).toBe(1);
    await restarted.commitCapture([], [item]);
    expect(await new SourceTurnSpool(path).isExtracted(item)).toBe(true);
  });

  it("treats an id as unresolved until the seed completes", async () => {
    const spool = new SourceTurnSpool(await directory());
    const item = turn();
    expect(await spool.seenCandidates([item])).toEqual([{ known: true, extracted: false, forgotten: false }]);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const loading = new Promise<void>((resolve) => { entered = resolve; });
    const seeding = spool.seedKnownIds(async () => { entered(); await blocked; return []; });
    await loading;
    const racingCapture = spool.seenCandidates([item]);
    release();
    await seeding;
    expect(await racingCapture).toEqual([{ known: false, extracted: false, forgotten: false }]);
    expect(await spool.seenCandidates([item])).toEqual([{ known: false, extracted: false, forgotten: false }]);
  });

  it("seeds known ids once and keeps forgotten ids unresolved", async () => {
    const spool = new SourceTurnSpool(await directory());
    const item = turn();
    let loads = 0;
    await spool.seedKnownIds(async () => { loads++; return [{ id: item.id,
      userId: item.userId, hmac: item.contentHmac, keyFingerprint: item.keyFingerprint }]; });
    await spool.seedKnownIds(async () => { loads++; return []; });
    expect(loads).toBe(1);
    expect(await spool.seenCandidates([item])).toEqual([{ known: true, extracted: false, forgotten: false }]);
    await spool.forget([item.id]);
    expect(await spool.seenCandidates([item])).toEqual([{ known: true, extracted: false, forgotten: true }]);
  });

  it("trusts a matching marker over a stale startup row snapshot", async () => {
    const spool = new SourceTurnSpool(await directory());
    const item = turn();
    await spool.commitCapture([item], [item]);
    await spool.seedKnownIds(async () => [{ id: item.id, userId: "other",
      hmac: item.contentHmac, keyFingerprint: item.keyFingerprint }]);
    expect(await spool.seenCandidates([item])).toEqual([{ known: true, extracted: true, forgotten: false }]);
  });
  it("retains known ids beyond the former 4096-entry boundary", async () => {
    const spool = new SourceTurnSpool(await directory());
    const item = turn();
    await spool.seedKnownIds(async () => [item, ...Array.from({ length: 5_000 }, (_, index) => ({ id: `other-${index}` }))]);
    expect(await spool.seenCandidates([item])).toEqual([{ known: true, extracted: false, forgotten: false }]);
  });
  it("marks only one concurrent append of the same turn as fresh", async () => {
    const spool = new SourceTurnSpool(await directory());
    const [first, retry] = await Promise.all([
      spool.appendBatchWithFresh([turn()]), spool.appendBatchWithFresh([turn()]),
    ]);
    expect(first.accepted).toEqual([true]);
    expect(retry.accepted).toEqual([true]);
    expect([first.fresh[0], retry.fresh[0]].sort()).toEqual([false, true]);
    expect(spool.snapshot().appended).toBe(1);
  });

  it("marks extraction separately from persistence and clears it on session forget", async () => {
    const spool = new SourceTurnSpool(await directory());
    const item = turn();
    expect(await spool.append(item)).toBe(true);
    await spool.drain(async () => "inserted");
    expect(await spool.isExtracted(item)).toBe(false);
    await spool.markExtracted([item]);
    expect(await spool.isExtracted(item)).toBe(true);
    await spool.forgetSession(item.userId, item.sessionId);
    expect(await spool.isExtracted(item)).toBe(false);
  });
  it("replays an extraction-complete marker after restart", async () => {
    const path = await directory();
    const item = turn();
    const first = new SourceTurnSpool(path);
    await first.append(item);
    await first.markExtracted([item]);
    const restarted = new SourceTurnSpool(path);
    expect(await restarted.isExtracted(item)).toBe(true);
  });
  it("fsyncs before acceptance, replays after a restart and tombstones after persistence", async () => {
    const path = await directory();
    const first = new SourceTurnSpool(path);
    expect(await first.append(turn())).toBe(true);
    expect(await first.journalBytes()).toBeGreaterThan(0);
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(replay.snapshot()).toMatchObject({ pending: 1, replayed: 1 });
    const seen: string[] = [];
    await replay.drain(async (item) => { seen.push(item.id); });
    expect(seen).toEqual([turn().id]);
    const final = new SourceTurnSpool(path);
    await final.initialize();
    expect(final.snapshot().pending).toBe(0);
  });

  it("group commits concurrent appends and resolves each only after its own sync", async () => {
    const path = await directory();
    let syncs = 0;
    let entered!: () => void;
    let release!: () => void;
    const atFirstSync = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const spool = new SourceTurnSpool(path, async (handle) => {
      syncs++;
      if (syncs === 1) { entered(); await hold; }
      await handle.sync();
    });
    const first = spool.append(turn());
    await atFirstSync;
    const secondTurn = prepareSourceTurn({ userId: "synthetic", client: "pi", sessionId: "s",
      turnKey: "pi:b", role: "user", content: "second synthetic source", occurredAt: "2026-09-25T00:00:00.000Z",
      scope: "user" }, "synthetic-key");
    let secondDone = false;
    const second = spool.append(secondTurn).then((accepted) => { secondDone = true; return accepted; });
    release();
    expect(await first).toBe(true);
    expect(secondDone).toBe(false);
    expect(await second).toBe(true);
    expect(syncs).toBe(2);
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(replay.snapshot().pending).toBe(2);
  });

  it("uses at most two syncs for concurrent requests and rejects a mismatched proof", async () => {
    const spool = new SourceTurnSpool(await directory());
    const turns = Array.from({ length: 12 }, (_, index) => prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "group", turnKey: `pi:${index}`,
      role: "user", content: `source ${index}`, occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-key"));
    expect((await Promise.all(turns.map((item) => spool.append(item)))).every(Boolean)).toBe(true);
    expect(spool.syncCount()).toBeLessThanOrEqual(2);
    const forged = { ...turns[0]!, content: "password: synthetic-secret-value", redactionProof: turns[0]!.redactionProof };
    expect(await spool.append(forged)).toBe(false);
  });

  it("rejects every waiter when its shared sync fails", async () => {
    const spool = new SourceTurnSpool(await directory(), async () => { throw new Error("synthetic sync failure"); });
    const turns = Array.from({ length: 4 }, (_, index) => prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "failure", turnKey: `pi:${index}`,
      role: "user", content: `source ${index}`, occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-key"));
    expect(await Promise.all(turns.map((item) => spool.append(item)))).toEqual([false, false, false, false]);
    expect(spool.snapshot()).toMatchObject({ pending: 0, appended: 0, appendFailures: 4 });
  });

  it("syncs a drain window once and replays every turn if the done sync fails", async () => {
    const path = await directory();
    let syncs = 0;
    const spool = new SourceTurnSpool(path, async (handle) => {
      syncs++;
      if (syncs === 2) throw new Error("synthetic crash before done sync");
      await handle.sync();
    });
    const turns = [turn(), prepareSourceTurn({ userId: "synthetic", client: "pi", sessionId: "s",
      turnKey: "pi:b", role: "user", content: "second source", occurredAt: "2026-09-25T00:00:00.000Z",
      scope: "user" }, "synthetic-key")];
    expect((await spool.appendBatch(turns)).every(Boolean)).toBe(true);
    const durableBytes = (await stat(join(path, "turns.jsonl"))).size;
    await spool.drain(async () => undefined);
    expect(syncs).toBe(2);
    await truncate(join(path, "turns.jsonl"), durableBytes);
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(replay.snapshot().pending).toBe(2);
    await replay.drain(async () => undefined);
    const final = new SourceTurnSpool(path);
    await final.initialize();
    expect(final.snapshot().pending).toBe(0);
  });

  it("does not complete forget until its tombstone is synced", async () => {
    const path = await directory();
    let syncs = 0;
    let entered!: () => void;
    let release!: () => void;
    const atTombstoneSync = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const spool = new SourceTurnSpool(path, async (handle) => {
      syncs++;
      if (syncs === 2) { entered(); await hold; }
      await handle.sync();
    });
    await spool.append(turn());
    let completed = false;
    const forgetting = spool.forgetSession("synthetic", "s").then(() => { completed = true; });
    await atTombstoneSync;
    expect(completed).toBe(false);
    release();
    await forgetting;
    expect(syncs).toBe(2);
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(replay.snapshot().pending).toBe(0);
  });

  it("retains a failed write for replay and honors a forget tombstone", async () => {
    const path = await directory();
    const spool = new SourceTurnSpool(path);
    await spool.append(turn());
    await spool.drain(async () => { throw new Error("synthetic DB failure"); });
    expect(spool.snapshot()).toMatchObject({ pending: 1, persistFailures: 1 });
    await spool.forget([turn().id]);
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(replay.snapshot().pending).toBe(0);
  });

  it("refuses same-ID different-HMAC text while the turn is pending", async () => {
    const path = await directory();
    const spool = new SourceTurnSpool(path);
    const original = turn();
    expect(await spool.append(original)).toBe(true);
    const conflict = { ...original, content: "different synthetic text", contentHmac: "different-synthetic-hmac" };
    expect(await spool.append(conflict)).toBe(false);
    expect(spool.snapshot()).toMatchObject({ pending: 1, conflicts: 1 });
  });

  it("counts failed appends and never accepts an unfsynced turn", async () => {
    const path = await directory();
    const file = join(path, "occupied");
    await writeFile(file, "synthetic");
    const spool = new SourceTurnSpool(file);
    expect(await spool.append(turn())).toBe(false);
    expect(spool.snapshot()).toMatchObject({ appendFailures: 1, pending: 0 });
  });

  it("waits for an in-flight write before the forget tombstone and rejects replay", async () => {
    const path = await directory();
    const spool = new SourceTurnSpool(path);
    await spool.append(turn());
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const draining = spool.drain(async () => { started(); await writing; });
    await begun;
    let forgot = false;
    const forgetting = spool.forget([turn().id]).then(() => { forgot = true; });
    await Promise.resolve();
    expect(forgot).toBe(false);
    finish();
    await Promise.all([draining, forgetting]);
    expect(spool.snapshot().pending).toBe(0);
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(await replay.append(turn())).toBe(false);
  });

  it("serializes forget after eligibility and before the body write", async () => {
    const path = await directory();
    const spool = new SourceTurnSpool(path);
    await spool.append(turn());
    const rows = new Set<string>();
    let release!: () => void;
    let entered!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const atRead = new Promise<void>((resolve) => { entered = resolve; });
    const original = spool["readTurn"].bind(spool);
    spool["readTurn"] = async (entry) => { entered(); await pause; return original(entry); };
    const draining = spool.drain(async (item) => { rows.add(item.id); });
    await atRead;
    const forgetting = spool.forget([turn().id]).then(() => { rows.delete(turn().id); });
    release();
    await Promise.all([draining, forgetting]);
    expect(rows.size).toBe(0);
    expect(spool.snapshot().pending).toBe(0);
  });

  it("spools beyond the 1,000-turn worker batch without dropping a turn", async () => {
    const path = await directory();
    const spool = new SourceTurnSpool(path);
    const turns = Array.from({ length: 1_001 }, (_, index) => prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "full-queue", turnKey: `pi:${index}`,
      role: "user", content: `synthetic turn ${index}`, occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-key"));
    expect((await spool.appendBatch(turns)).every(Boolean)).toBe(true);
    expect(spool.snapshot().pending).toBe(1_001);
    expect(spool.snapshot().pendingBytes).toBe(turns.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0));
    expect(spool.snapshot().oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
    const restarted = new SourceTurnSpool(path);
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({ pending: 1_001, replayed: 1_001 });
    expect([...restarted["pending"].values()].every((item) => !("turn" in item))).toBe(true);
    let written = 0;
    await spool.drain(async () => { written++; });
    expect(written).toBe(1_000);
    expect(spool.snapshot().pending).toBe(1);
    await spool.drain(async () => { written++; });
    expect(written).toBe(1_001);
    expect(spool.snapshot().pending).toBe(0);
  });

  it("limits each journal drain window to 64 MiB without rejecting fsynced appends", async () => {
    const spool = new SourceTurnSpool(await directory());
    const turns = Array.from({ length: 260 }, (_, index) => prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "byte-window", turnKey: `pi:${index}`,
      role: "user", content: "x".repeat(256 * 1024),
      occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-key"));
    expect((await spool.appendBatch(turns)).every(Boolean)).toBe(true);
    expect(spool.snapshot().pendingBytes).toBeGreaterThan(64 * 1024 * 1024);
    let written = 0;
    await spool.drain(async () => { written++; });
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(260);
    await spool.drain(async () => { written++; });
    expect(written).toBe(260);
    expect(spool.snapshot().pendingBytes).toBe(0);
  });

  it("truncates an unacknowledged torn final line before the next append", async () => {
    const path = await directory();
    const first = new SourceTurnSpool(path);
    await first.append(turn());
    await appendFile(join(path, "turns.jsonl"), '{"op":"put","turn":');
    const replay = new SourceTurnSpool(path);
    await replay.initialize();
    expect(replay.snapshot().pending).toBe(1);
    const next = prepareSourceTurn({
      userId: "synthetic", client: "pi", sessionId: "s", turnKey: "pi:b", role: "assistant",
      content: "another synthetic turn", occurredAt: "2026-09-25T00:00:00.000Z", scope: "user",
    }, "synthetic-key");
    expect(await replay.append(next)).toBe(true);
    const final = new SourceTurnSpool(path);
    await final.initialize();
    expect(final.snapshot().pending).toBe(2);
  });
});
