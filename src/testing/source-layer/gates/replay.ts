import { appendFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceTurnSpool } from "../../../capture/source-turn-spool.js";
import { prepareSourceTurn } from "../../../capture/source-turn-identity.js";
import { upsertSourceTurn } from "../../../storage/surreal/session-turn-store.js";
import { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import type { GateResult } from "../types.js";
import { syntheticHmacKey } from "../fixtures.js";

const makeTurn = (key: string) => prepareSourceTurn({ userId: "synthetic-A", client: "pi", sessionId: "replay",
  sessionEpoch: "epoch-1", turnKey: `pi:${key}`, role: "user", content: `Synthetic replay turn ${key}`,
  occurredAt: "2026-01-01T00:00:00Z", scope: "user" }, syntheticHmacKey());

export async function replaySpoolGates(options: {
  db: SurrealClient; databaseUrl: string; namespace: string; database: string; spool: SourceTurnSpool;
  routeSnapshot: () => Promise<{ pending: number; pendingBytes: number; oldestPendingAgeMs?: number }>;
}): Promise<GateResult[]> {
  const dir = await mkdtemp(join(tmpdir(), "runir-slice4-replay-"));
  const results: GateResult[] = [];
  try {
    const spool = new SourceTurnSpool(dir);
    const first = makeTurn("first");
    const second = makeTurn("second");
    const accepted = await spool.appendBatch([first, first, second]);
    const pendingBeforeFork = spool.snapshot().pending;
    const fork = prepareSourceTurn({ userId: "synthetic-A", client: "pi", sessionId: "replay-fork",
      sessionEpoch: "epoch-1", turnKey: "pi:fork", role: "user", content: "Synthetic fork turn",
      occurredAt: "2026-01-01T00:00:00Z", scope: "user" }, syntheticHmacKey());
    const forkAccepted = await spool.append(fork);
    const pendingAfterFork = spool.snapshot().pending;
    const resendAccepted = await spool.append(first);
    const pendingAfterResend = spool.snapshot().pending;
    results.push({ id: "replay.pi_resend_fork", family: "replay", status: accepted.every(Boolean)
      && pendingBeforeFork === 2 && forkAccepted && pendingAfterFork === 3 && resendAccepted
      && pendingAfterResend === 3 && first.turnKey.startsWith("native:") && fork.turnKey.startsWith("native:") ? "pass" : "fail",
    counts: { pendingBeforeFork, pendingAfterFork, pendingAfterResend, nativeKeys: Number(first.turnKey.startsWith("native:")) + Number(fork.turnKey.startsWith("native:")) } });
    const journal = join(dir, "turns.jsonl");
    await appendFile(journal, '{"op":"put","turn":');
    const reopened = new SourceTurnSpool(dir);
    await reopened.initialize();
    const restored = reopened.snapshot();
    const written: string[] = [];
    await reopened.drain(async (turn) => { written.push(turn.id); });
    results.push({ id: "replay.torn_line_restart", family: "replay", status: restored.pending === 3 && written.length === 3 ? "pass" : "fail",
      counts: { replayed: restored.replayed, drained: written.length, loss: 3 - written.length } });
    const outageDir = await mkdtemp(join(tmpdir(), "runir-slice4-outage-"));
    const outage = new SourceTurnSpool(outageDir);
    const outageTurn = makeTurn("outage");
    const outageAccepted = await outage.append(outageTurn);
    const unreachable = new SurrealClient({ url: options.databaseUrl, username: "root", password: "synthetic-invalid-password",
      namespace: options.namespace, database: options.database });
    await outage.drain((turn) => upsertSourceTurn(unreachable, turn));
    const failed = outage.snapshot();
    await unreachable.close().catch(() => undefined);
    await outage.drain((turn) => upsertSourceTurn(options.db, turn));
    const stored = Number((await options.db.query<Record<string, unknown>>(
      "SELECT id FROM type::record('session_turn', $id) WHERE user_id = 'synthetic-A' AND session_id = 'replay';",
      { id: outageTurn.id }))[0]?.length ?? 0);
    results.push({ id: "replay.partial_db_outage", family: "replay", status: outageAccepted && failed.persistFailures === 1
      && failed.pending === 1 && stored === 1 && outage.snapshot().pending === 0 ? "pass" : "fail",
      counts: { appended: Number(outageAccepted), persistFailures: failed.persistFailures, pendingDuringOutage: failed.pending,
        stored, pendingAfterRecovery: outage.snapshot().pending, loss: Number(outageAccepted) - stored } });
    const forgetDir = await mkdtemp(join(tmpdir(), "runir-slice4-forget-"));
    const forgotten = new SourceTurnSpool(forgetDir);
    await forgotten.append(makeTurn("forget"));
    await forgotten.forgetSession("synthetic-A", "replay");
    let resurrected = 0;
    await forgotten.drain(async () => { resurrected++; });
    results.push({ id: "replay.tombstone_pending", family: "replay", status: resurrected === 0 && forgotten.snapshot().pending === 0 ? "pass" : "fail",
      counts: { resurrected, pending: forgotten.snapshot().pending } });
    const overflow = Array.from({ length: 1001 }, (_, i) => prepareSourceTurn({ userId: "synthetic-queue", client: "pi",
      sessionId: "bounded-drain", sessionEpoch: "e", turnKey: `pi:queue-${i}`, role: "user",
      content: `Synthetic queue turn ${i}`, occurredAt: new Date().toISOString(), scope: "user" }, syntheticHmacKey()));
    const acceptedOverflow = await options.spool.appendBatch(overflow);
    const acceptedCount = acceptedOverflow.filter(Boolean).length;
    await new Promise((done) => setTimeout(done, 2));
    const beforeDrain = options.spool.snapshot();
    const exposed = await options.routeSnapshot();
    const beforeFirst = options.spool.snapshot().pending;
    let firstDrainBytes = 0;
    await options.spool.drain((turn) => { firstDrainBytes += Buffer.byteLength(turn.content); return upsertSourceTurn(options.db, turn); });
    const firstDrained = beforeFirst - options.spool.snapshot().pending;
    let drains = 1;
    while (options.spool.snapshot().pending > 0 && drains < 8) {
      await options.spool.drain((turn) => upsertSourceTurn(options.db, turn));
      drains++;
    }
    const queueStored = Number((await options.db.query<{ total: number }>(
      "SELECT count() AS total FROM session_turn WHERE user_id = 'synthetic-queue' AND session_id = 'bounded-drain' GROUP ALL;"))[0]?.[0]?.total ?? 0);
    results.push({ id: "replay.queue_bounded_drain", family: "replay", status: acceptedCount === overflow.length
      && beforeDrain.pending >= overflow.length && beforeDrain.pendingBytes > 0 && (beforeDrain.oldestPendingAgeMs ?? 0) > 0
      && exposed.pending >= overflow.length && exposed.pendingBytes > 0 && (exposed.oldestPendingAgeMs ?? 0) > 0
      && firstDrained > 0 && firstDrained <= 1000 && firstDrainBytes <= 64 * 1024 * 1024
      && options.spool.snapshot().pending === 0 && queueStored === acceptedCount ? "pass" : "fail",
      counts: { submitted: overflow.length, accepted: acceptedCount, refused: overflow.length - acceptedCount,
        pendingBefore: beforeDrain.pending, routePending: exposed.pending, firstDrained, drains, stored: queueStored, loss: acceptedCount - queueStored },
      metrics: { pendingBytes: beforeDrain.pendingBytes, routePendingBytes: exposed.pendingBytes,
        oldestPendingAgeMs: beforeDrain.oldestPendingAgeMs ?? 0, firstDrainBytes, firstDrainLimitBytes: 64 * 1024 * 1024 },
      note: "queue_64mib_case_omitted" });
    const failureDir = await mkdtemp(join(tmpdir(), "runir-slice4-append-failure-"));
    try {
      const broken = new SourceTurnSpool(failureDir);
      await mkdir(join(failureDir, "turns.jsonl"));
      const before = broken.snapshot().appendFailures;
      const ok = await broken.append(makeTurn("failure"));
      const delta = broken.snapshot().appendFailures - before;
      results.push({ id: "replay.append_failure", family: "replay", status: !ok && delta === 1 ? "pass" : "fail",
        counts: { appendFailuresDelta: delta, accepted: Number(ok) }, note: "direct_spool_fault" });
    } finally { await rm(failureDir, { recursive: true, force: true }); }
    await stat(journal);
    await rm(outageDir, { recursive: true, force: true });
    await rm(forgetDir, { recursive: true, force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
  return results;
}
