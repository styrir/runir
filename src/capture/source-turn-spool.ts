import { createReadStream } from "node:fs";
import { mkdir, open, stat, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProvenSourceTurn, type SourceTurn } from "./source-turn-identity.js";
import { redactSourceTurn } from "../shared/source-redaction.js";

type SpoolEntry = { op: "put"; turn: SourceTurn; queuedAt?: string } | { op: "done" | "forget"; id: string };
type Pending = { offset: number; length: number; queuedAt: string; bytes: number; userId: string; sessionId: string; hmac: string };

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
  private readonly forgotten = new Set<string>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private serial: Promise<unknown> = Promise.resolve();
  private appendQueue: Array<{ turns: SourceTurn[]; resolve: (accepted: boolean[]) => void }> = [];
  private appendWriter: Promise<void> | undefined;
  private syncs = 0;
  private initialized = false;
  private readonly counts = { appended: 0, replayed: 0, appendFailures: 0, persistFailures: 0, conflicts: 0 };

  constructor(directory = process.env.RUNIR_SOURCE_SPOOL_DIR
    ?? join(homedir(), "Library", "Application Support", "Runir", "source-spool"),
    private readonly syncFile: (handle: FileHandle) => Promise<void> = (handle) => handle.sync()) {
    this.file = join(directory, "turns.jsonl");
  }

  syncCount(): number { return this.syncs; }

  private sequence<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async appendLines(lines: Iterable<string>): Promise<Array<{ offset: number; length: number }>> {
    const handle = await open(this.file, "a", 0o600);
    let synced = false;
    try {
      let offset = (await handle.stat()).size;
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
              this.pending.set(entry.turn.id, {
                offset, length, queuedAt: entry.queuedAt ?? entry.turn.occurredAt,
                bytes: Buffer.byteLength(entry.turn.content), userId: entry.turn.userId,
                sessionId: entry.turn.sessionId, hmac: entry.turn.contentHmac,
              });
            } else if (entry.op !== "put") {
              if (entry.op === "forget") this.forgotten.add(entry.id);
              this.pending.delete(entry.id);
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
    try {
      for (const turn of turns) {
        if (!isProvenSourceTurn(turn) && redactSourceTurn(turn.content) !== turn.content) throw new Error("unredacted source turn");
      }
      await this.initialize();
      return await new Promise<boolean[]>((resolve) => {
        this.appendQueue.push({ turns, resolve });
        this.startAppendWriter();
      });
    } catch {
      this.counts.appendFailures += turns.length;
      return turns.map(() => false);
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
          const accepted = batch.map(({ turns }) => turns.map((turn) => {
            if (this.forgotten.has(turn.id)) return false;
            const priorHmac = this.pending.get(turn.id)?.hmac ?? staged.get(turn.id)?.contentHmac;
            if (priorHmac && priorHmac !== turn.contentHmac) {
              this.counts.conflicts++;
              return false;
            }
            if (!priorHmac) staged.set(turn.id, turn);
            return true;
          }));
          const fresh = [...staged.values()];
          if (fresh.length) {
            const queuedAt = new Date().toISOString();
            const positions = await this.appendLines(fresh.map((turn) => `${JSON.stringify({ op: "put", turn, queuedAt })}\n`));
            fresh.forEach((turn, index) => {
              this.pending.set(turn.id, {
                ...positions[index], queuedAt, bytes: Buffer.byteLength(turn.content),
                userId: turn.userId, sessionId: turn.sessionId, hmac: turn.contentHmac,
              });
              this.counts.appended++;
            });
          }
          batch.forEach((request, index) => request.resolve(accepted[index]!));
        });
      } catch {
        for (const request of batch) {
          this.counts.appendFailures += request.turns.length;
          request.resolve(request.turns.map(() => false));
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
      for (const id of ids) { this.forgotten.add(id); this.pending.delete(id); }
      return ids.map((id) => this.inFlight.get(id));
    });
    await Promise.all(writes.map((writing) => writing?.catch(() => undefined)));
  }

  async forgetSession(userId: string, sessionId: string): Promise<void> {
    await this.initialize();
    await this.forget([...this.pending.entries()]
      .filter(([, entry]) => entry.userId === userId && entry.sessionId === sessionId)
      .map(([id]) => id));
  }

  async forgetUser(userId: string): Promise<void> {
    await this.initialize();
    await this.forget([...this.pending.entries()]
      .filter(([, entry]) => entry.userId === userId)
      .map(([id]) => id));
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
