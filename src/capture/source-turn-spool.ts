import { createReadStream } from "node:fs";
import { mkdir, open, stat, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProvenSourceTurn, type SourceTurn } from "./source-turn-identity.js";
import { redactSourceTurn } from "../shared/source-redaction.js";

type SpoolEntry = { op: "put"; turn: SourceTurn; queuedAt?: string }
  | { op: "done" | "forget"; id: string }
  | { op: "extracted"; id: string; userId: string; sessionId: string; hmac: string; keyFingerprint: string };
type Pending = { offset: number; length: number; queuedAt: string; bytes: number; userId: string; sessionId: string; hmac: string };
type AppendResult = { accepted: boolean[]; fresh: boolean[] };

export type SourceSpoolCounters = {
  appended: number;
  replayed: number;
  appendFailures: number;
  persistFailures: number;
  conflicts: number;
  pending: number;
  pendingBytes: number;
  oldestPendingAt?: string;
  oldestPendingAgeMs?: number;
};

/** Fsynced journal with bounded resident turn bodies. Pending metadata points to
 * journal offsets; drain reads one body at a time, up to its 1,000 / 64 MiB window. */
export class SourceTurnSpool {
  private readonly file: string;
  private readonly pending = new Map<string, Pending>();
  private readonly knownIds = new Set<string>();
  private knownIdsSeeded = false;
  private readonly forgotten = new Set<string>();
  private readonly extracted = new Map<string, { userId: string; sessionId: string; hmac: string; keyFingerprint: string }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private serial: Promise<unknown> = Promise.resolve();
  private appendQueue: Array<{ turns: SourceTurn[]; resolve: (result: AppendResult) => void }> = [];
  private appendWriter: Promise<void> | undefined;
  private syncs = 0;
  private rollbackFailed = false;
  private initialized = false;
  private readonly counts = { appended: 0, replayed: 0, appendFailures: 0, persistFailures: 0, conflicts: 0 };

  constructor(directory = process.env.RUNIR_SOURCE_SPOOL_DIR
    ?? join(homedir(), "Library", "Application Support", "Runir", "source-spool"),
    private readonly syncFile: (handle: FileHandle) => Promise<void> = (handle) => handle.sync()) {
    this.file = join(directory, "turns.jsonl");
  }

  syncCount(): number { return this.syncs; }

  /** Only a completed extraction is eligible for replay suppression. */
  async isExtracted(turn: SourceTurn): Promise<boolean> {
    return (await this.extractedBatch([turn]))[0] ?? false;
  }

  async extractedBatch(turns: SourceTurn[]): Promise<boolean[]> {
    await this.initialize();
    return this.sequence(async () => turns.map((turn) => {
      const marker = this.extracted.get(turn.id);
      return marker?.userId === turn.userId && marker.hmac === turn.contentHmac
        && marker.keyFingerprint === turn.keyFingerprint;
    }));
  }

  /** The database snapshot is taken once, in journal order. New puts and markers
   * then extend the set. Tombstoned ids remain known for a live-row check. */
  async seedKnownIds(load: () => Promise<Array<{ id: string }>>): Promise<void> {
    await this.initialize();
    await this.sequence(async () => {
      if (this.knownIdsSeeded) return;
      for (const row of await load()) {
        this.knownIds.add(row.id);
      }
      this.knownIdsSeeded = true;
    });
  }

  async seenCandidates(turns: SourceTurn[]): Promise<Array<{ known: boolean; extracted: boolean; forgotten: boolean }>> {
    await this.initialize();
    return this.sequence(async () => turns.map((turn) => {
      const marker = this.extracted.get(turn.id);
      return { known: !this.knownIdsSeeded || this.knownIds.has(turn.id), forgotten: this.forgotten.has(turn.id),
        extracted: !this.forgotten.has(turn.id)
        && marker?.userId === turn.userId && marker.hmac === turn.contentHmac
        && marker.keyFingerprint === turn.keyFingerprint };
    }));
  }

  /** Acceptance is provisional until commitCapture has fsynced the journal. */
  async reserveCapture(turns: SourceTurn[]): Promise<AppendResult> {
    await this.initialize();
    return this.sequence(async () => {
      const accepted = turns.map((turn) => {
        if (this.forgotten.has(turn.id)) return false;
        return true;
      });
      return { accepted, fresh: turns.map((turn, index) => accepted[index]!
        && (!this.pending.has(turn.id) || this.pending.get(turn.id)?.hmac !== turn.contentHmac)
        && turns.findIndex((item) => item.id === turn.id) === index) };
    });
  }

  async commitCapture(turns: SourceTurn[], completed: SourceTurn[]): Promise<void> {
    if (!turns.length && !completed.length) return;
    await this.initialize();
    try { await this.sequence(async () => {
      const staged = new Map<string, SourceTurn>();
      for (const turn of turns) {
        if (this.forgotten.has(turn.id)) continue;
        const prior = this.pending.get(turn.id)?.hmac ?? staged.get(turn.id)?.contentHmac;
        if (!prior || prior !== turn.contentHmac) staged.set(turn.id, turn);
      }
      const puts = [...staged.values()];
      const markers = completed.filter((turn) => !this.forgotten.has(turn.id));
      if (!puts.length && !markers.length) return;
      const queuedAt = new Date().toISOString();
      const positions = await this.appendLines([
        ...puts.map((turn) => `${JSON.stringify({ op: "put", turn, queuedAt })}\n`),
        ...markers.map((turn) => `${JSON.stringify({ op: "extracted", id: turn.id,
          userId: turn.userId, sessionId: turn.sessionId, hmac: turn.contentHmac,
          keyFingerprint: turn.keyFingerprint })}\n`),
      ]);
      puts.forEach((turn, index) => {
        this.pending.set(turn.id, { ...positions[index]!, queuedAt, bytes: Buffer.byteLength(turn.content),
          userId: turn.userId, sessionId: turn.sessionId, hmac: turn.contentHmac });
        this.knownIds.add(turn.id);
        this.counts.appended++;
      });
      for (const turn of markers) {
        this.knownIds.add(turn.id);
        this.extracted.set(turn.id, { userId: turn.userId, sessionId: turn.sessionId,
          hmac: turn.contentHmac, keyFingerprint: turn.keyFingerprint });
      }
    }); }
    catch (error) { this.counts.appendFailures += turns.length; throw error; }
  }

  async markExtracted(turns: SourceTurn[]): Promise<void> {
    if (!turns.length) return;
    await this.initialize();
    await this.sequence(async () => {
      const fresh = turns.filter((turn) => !this.forgotten.has(turn.id) &&
        (this.extracted.get(turn.id)?.hmac !== turn.contentHmac
          || this.extracted.get(turn.id)?.userId !== turn.userId
          || this.extracted.get(turn.id)?.keyFingerprint !== turn.keyFingerprint));
      if (!fresh.length) return;
      await this.appendLines(fresh.map((turn) => `${JSON.stringify({ op: "extracted", id: turn.id,
        userId: turn.userId, sessionId: turn.sessionId, hmac: turn.contentHmac, keyFingerprint: turn.keyFingerprint })}\n`));
      for (const turn of fresh) this.extracted.set(turn.id, {
        userId: turn.userId, sessionId: turn.sessionId, hmac: turn.contentHmac, keyFingerprint: turn.keyFingerprint,
      });
      for (const turn of fresh) this.knownIds.add(turn.id);
    });
  }

  private sequence<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async appendLines(lines: Iterable<string>): Promise<Array<{ offset: number; length: number }>> {
    if (this.rollbackFailed) throw new Error("source spool rollback failed");
    const handle = await open(this.file, "a", 0o600);
    let synced = false;
    let initialOffset: number | undefined;
    try {
      let offset = (await handle.stat()).size;
      initialOffset = offset;
      const positions: Array<{ offset: number; length: number }> = [];
      const chunks: string[] = [];
      for (const line of lines) {
        const length = Buffer.byteLength(line);
        positions.push({ offset, length });
        offset += length;
        chunks.push(line);
      }
      if (!chunks.length) return positions;
      await handle.writeFile(chunks.join(""), "utf8");
      await this.syncFile(handle);
      this.syncs++;
      synced = true;
      return positions;
    } catch (error) {
      // Unsynced marker bytes must not be carried into a later successful sync.
      if (initialOffset !== undefined) {
        try { await handle.truncate(initialOffset); }
        catch { this.rollbackFailed = true; }
      }
      throw error;
    } finally {
      // A close error after fsync cannot revoke a durable append.
      if (synced) await handle.close().catch(() => undefined);
      else await handle.close();
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.sequence(async () => {
      if (this.initialized) return;
      const dir = this.file.slice(0, this.file.lastIndexOf("/"));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = (await stat(this.file)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let offset = 0;
      let remainder = Buffer.alloc(0);
      if (size) {
        for await (const chunk of createReadStream(this.file) as AsyncIterable<Buffer>) {
          const data = Buffer.concat([remainder, chunk]);
          let start = 0;
          for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
            const length = end - start + 1;
            const entry = JSON.parse(data.subarray(start, end).toString("utf8")) as SpoolEntry;
            if (entry.op === "put" && !this.forgotten.has(entry.turn.id)) {
              this.knownIds.add(entry.turn.id);
              this.pending.set(entry.turn.id, {
                offset, length, queuedAt: entry.queuedAt ?? entry.turn.occurredAt,
                bytes: Buffer.byteLength(entry.turn.content), userId: entry.turn.userId,
                sessionId: entry.turn.sessionId, hmac: entry.turn.contentHmac,
              });
            } else if (entry.op === "extracted") {
              this.knownIds.add(entry.id);
              if (!this.forgotten.has(entry.id)) this.extracted.set(entry.id, {
                userId: entry.userId, sessionId: entry.sessionId, hmac: entry.hmac, keyFingerprint: entry.keyFingerprint,
              });
            } else if (entry.op !== "put") {
              this.knownIds.add(entry.id);
              if (entry.op === "forget") this.forgotten.add(entry.id);
              this.pending.delete(entry.id);
              if (entry.op === "forget") this.extracted.delete(entry.id);
            }
            offset += length;
            start = end + 1;
          }
          remainder = data.subarray(start);
        }
        if (remainder.length) await truncate(this.file, offset);
      }
      this.counts.replayed += this.pending.size;
      this.initialized = true;
    });
  }

  async append(turn: SourceTurn): Promise<boolean> {
    return (await this.appendBatch([turn]))[0] ?? false;
  }

  async appendBatch(turns: SourceTurn[]): Promise<boolean[]> {
    return (await this.appendBatchWithFresh(turns)).accepted;
  }

  async appendBatchWithFresh(turns: SourceTurn[]): Promise<AppendResult> {
    try {
      for (const turn of turns) {
        if (!isProvenSourceTurn(turn) && redactSourceTurn(turn.content) !== turn.content) throw new Error("unredacted source turn");
      }
      await this.initialize();
      return await new Promise<AppendResult>((resolve) => {
        this.appendQueue.push({ turns, resolve });
        this.startAppendWriter();
      });
    } catch {
      this.counts.appendFailures += turns.length;
      return { accepted: turns.map(() => false), fresh: turns.map(() => false) };
    }
  }

  private startAppendWriter(): void {
    if (this.appendWriter) return;
    const writer = this.flushAppends();
    this.appendWriter = writer;
    void writer.finally(() => {
      this.appendWriter = undefined;
      if (this.appendQueue.length) this.startAppendWriter();
    });
  }

  private async flushAppends(): Promise<void> {
    // Allow simultaneous requests to join the same buffer. Requests arriving
    // during an in-flight sync are handled by the next iteration.
    await Promise.resolve();
    while (this.appendQueue.length) {
      const batch = this.appendQueue.splice(0);
      try {
        await this.sequence(async () => {
          const staged = new Map<string, SourceTurn>();
          const freshByRequest: boolean[][] = [];
          const accepted = batch.map(({ turns }) => {
            const fresh: boolean[] = [];
            freshByRequest.push(fresh);
            return turns.map((turn, turnIndex) => {
            if (this.forgotten.has(turn.id)) { fresh[turnIndex] = false; return false; }
            const priorHmac = this.pending.get(turn.id)?.hmac ?? staged.get(turn.id)?.contentHmac;
            if (priorHmac && priorHmac !== turn.contentHmac) {
              this.counts.conflicts++;
              fresh[turnIndex] = false;
              return false;
            }
            fresh[turnIndex] = !priorHmac;
            if (!priorHmac) staged.set(turn.id, turn);
            return true;
            });
          });
          const fresh = [...staged.values()];
          if (fresh.length) {
            const queuedAt = new Date().toISOString();
            const positions = await this.appendLines(fresh.map((turn) => `${JSON.stringify({ op: "put", turn, queuedAt })}\n`));
            fresh.forEach((turn, index) => {
              this.pending.set(turn.id, {
                ...positions[index], queuedAt, bytes: Buffer.byteLength(turn.content),
                userId: turn.userId, sessionId: turn.sessionId, hmac: turn.contentHmac,
              });
              this.knownIds.add(turn.id);
              this.counts.appended++;
            });
          }
          batch.forEach((request, index) => request.resolve({ accepted: accepted[index]!, fresh: freshByRequest[index]! }));
        });
      } catch {
        for (const request of batch) {
          this.counts.appendFailures += request.turns.length;
          request.resolve({ accepted: request.turns.map(() => false), fresh: request.turns.map(() => false) });
        }
      }
    }
  }

  private async readTurn(entry: Pending): Promise<SourceTurn> {
    const handle = await open(this.file, "r");
    try {
      const body = Buffer.allocUnsafe(entry.length);
      let read = 0;
      while (read < body.length) {
        const result = await handle.read(body, read, body.length - read, entry.offset + read);
        if (!result.bytesRead) throw new Error("source spool journal truncated");
        read += result.bytesRead;
      }
      const line = JSON.parse(body.toString("utf8")) as SpoolEntry;
      if (line.op !== "put") throw new Error("source spool journal offset mismatch");
      return line.turn;
    } finally { await handle.close(); }
  }

  async drain(write: (turn: SourceTurn) => Promise<unknown>, maxTurns = 1_000): Promise<void> {
    await this.initialize();
    const window = [...this.pending.entries()];
    let processed = 0;
    let bytes = 0;
    const done: string[] = [];
    const releases: Array<() => void> = [];
    for (const [id, entry] of window) {
      if (processed >= Math.min(maxTurns, 1_000) || bytes + entry.bytes > 64 * 1024 * 1024) break;
      processed++;
      bytes += entry.bytes;
      let resolve!: () => void;
      const registered = new Promise<void>((done) => { resolve = done; });
      const eligible = await this.sequence(async () => {
        if (!this.pending.has(id) || this.forgotten.has(id)) return false;
        this.inFlight.set(id, registered);
        return true;
      });
      if (!eligible) continue;
      try {
        const turn = await this.readTurn(entry);
        await write(turn);
        done.push(id);
      } catch (error) {
        this.counts.persistFailures++;
        if (error instanceof Error && error.name === "SourceTurnConflictError") this.counts.conflicts++;
      } finally {
        releases.push(() => { resolve(); this.inFlight.delete(id); });
      }
    }
    try {
      await this.sequence(async () => {
        const eligible = done.filter((id) => this.pending.has(id) && !this.forgotten.has(id));
        if (eligible.length) {
          await this.appendLines(eligible.map((id) => `${JSON.stringify({ op: "done", id })}\n`));
          eligible.forEach((id) => this.pending.delete(id));
        }
      });
    } catch { this.counts.persistFailures += done.length; }
    finally { releases.forEach((release) => release()); }
  }

  async forget(ids: string[]): Promise<void> {
    await this.initialize();
    await this.appendWriter;
    const writes = await this.sequence(async () => {
      if (ids.length) await this.appendLines(ids.map((id) => `${JSON.stringify({ op: "forget", id })}\n`));
      for (const id of ids) { this.knownIds.add(id); this.forgotten.add(id); this.pending.delete(id); this.extracted.delete(id); }
      return ids.map((id) => this.inFlight.get(id));
    });
    await Promise.all(writes.map((writing) => writing?.catch(() => undefined)));
  }

  async forgetSession(userId: string, sessionId: string): Promise<void> {
    await this.initialize();
    await this.forget([...new Set([
      ...[...this.pending.entries()].filter(([, entry]) => entry.userId === userId && entry.sessionId === sessionId).map(([id]) => id),
      ...[...this.extracted.entries()].filter(([, entry]) => entry.userId === userId && entry.sessionId === sessionId).map(([id]) => id),
    ])]);
  }

  async forgetUser(userId: string): Promise<void> {
    await this.initialize();
    await this.forget([...new Set([
      ...[...this.pending.entries()].filter(([, entry]) => entry.userId === userId).map(([id]) => id),
      ...[...this.extracted.entries()].filter(([, entry]) => entry.userId === userId).map(([id]) => id),
    ])]);
  }

  snapshot(): SourceSpoolCounters {
    const pending = [...this.pending.values()];
    return {
      ...this.counts, pending: pending.length,
      pendingBytes: pending.reduce((sum, item) => sum + item.bytes, 0),
      oldestPendingAt: pending[0]?.queuedAt,
      oldestPendingAgeMs: pending[0] ? Math.max(0, Date.now() - Date.parse(pending[0].queuedAt)) : undefined,
    };
  }

  async journalBytes(): Promise<number> {
    try { return (await stat(this.file)).size; }
    catch { return 0; }
  }
}
