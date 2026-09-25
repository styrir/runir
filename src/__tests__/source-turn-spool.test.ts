import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
