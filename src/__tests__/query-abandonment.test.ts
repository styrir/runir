import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AbandonedQueryError,
  isCurrentWorkAbandoned,
  raceAbandonable,
  runAbandonable,
} from "../storage/surreal/query-abandonment.js";
import { annotateSelectedFacts } from "../recall/source-excerpts.js";
import { enrichLinkedExactQaHits, withTimeoutFlagged } from "../recall/query/memory-query.js";

// vk-2993: work whose caller gave up must not keep querying. These tests use a
// fake client that, like SurrealClient.query, refuses queries from abandoned
// work, and count what would have reached the database.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDb(firstQueryMs: number) {
  const seen = { sent: 0, refused: 0 };
  const db = {
    async query(): Promise<unknown[][]> {
      if (isCurrentWorkAbandoned()) { seen.refused++; throw new AbandonedQueryError(); }
      seen.sent++;
      if (seen.sent === 1) {
        await sleep(firstQueryMs);
        // One linked fact, so readVerifiedSourceTurns goes on to look up its turn.
        return [[{ id: "semiote:f1", source_turn_link_state: "linked", source_turn_id: "session_turn:t1",
          user_id: "u1", active: true }]];
      }
      return [[]];
    },
  };
  return { db, seen };
}

describe("runAbandonable", () => {
  it("abandons work started in nested scopes when the outer scope is abandoned", async () => {
    const observed: boolean[] = [];
    const outer = runAbandonable(async () => {
      const inner = runAbandonable(async () => {
        observed.push(isCurrentWorkAbandoned());
        await sleep(50);
        observed.push(isCurrentWorkAbandoned());
      });
      await inner.promise;
    });
    await sleep(10);
    outer.abandon();
    await outer.promise;
    expect(observed).toEqual([false, true]);
  });

  it("does not mark sibling or later work abandoned", async () => {
    const first = runAbandonable(async () => { await sleep(20); return isCurrentWorkAbandoned(); });
    const second = runAbandonable(async () => { await sleep(20); return isCurrentWorkAbandoned(); });
    first.abandon();
    expect(await first.promise).toBe(true);
    expect(await second.promise).toBe(false);
    expect(isCurrentWorkAbandoned()).toBe(false);
  });

  it("raceAbandonable rejects on timeout and abandons the work", async () => {
    let abandonedAfter: boolean | undefined;
    await expect(raceAbandonable(async () => { await sleep(60); abandonedAfter = isCurrentWorkAbandoned(); }, 10, "late"))
      .rejects.toThrow("late");
    await sleep(80);
    expect(abandonedAfter).toBe(true);
  });

  it("withTimeoutFlagged abandons function work but leaves a started promise alone", async () => {
    let fnAbandoned: boolean | undefined;
    const race = await withTimeoutFlagged(async () => { await sleep(60); fnAbandoned = isCurrentWorkAbandoned(); return 1; }, 10, 0, "fn");
    expect(race.timedOut).toBe(true);
    await sleep(80);
    expect(fnAbandoned).toBe(true);
  });
});

describe("source lookups abandoned by their 500 ms timeout", () => {
  let priorMode: string | undefined;
  let priorKey: string | undefined;
  beforeEach(() => {
    priorMode = process.env.RUNIR_SOURCE_RECALL;
    priorKey = process.env.RUNIR_SOURCE_HMAC_KEY;
    process.env.RUNIR_SOURCE_RECALL = "on";
    process.env.RUNIR_SOURCE_HMAC_KEY = "synthetic-key";
  });
  afterEach(() => {
    if (priorMode === undefined) delete process.env.RUNIR_SOURCE_RECALL; else process.env.RUNIR_SOURCE_RECALL = priorMode;
    if (priorKey === undefined) delete process.env.RUNIR_SOURCE_HMAC_KEY; else process.env.RUNIR_SOURCE_HMAC_KEY = priorKey;
  });

  it("linked exact-QA enrichment sends no further queries after its timeout", async () => {
    const { db, seen } = fakeDb(700);
    const hits = [{ id: "f1", text: "Badge identifier is stored", score: 1 }];
    const result = await enrichLinkedExactQaHits(db as never, hits, "What is the exact badge identifier?", "u1");
    expect(result).toBe(hits);
    await sleep(400);
    expect(seen).toEqual({ sent: 1, refused: 1 });
  });

  it("excerpt annotation sends no further queries after its timeout", async () => {
    const { db, seen } = fakeDb(700);
    const out = await annotateSelectedFacts({
      db: db as never, selected: [{ id: "f1", text: "Badge identifier is stored", score: 1 }],
      renderedText: ["Badge identifier is stored"], boundary: { userId: "u1" }, mode: "on",
    });
    expect(out.excerpts).toEqual([]);
    await sleep(400);
    expect(seen).toEqual({ sent: 1, refused: 1 });
  });

  it("a lookup that beats its timeout still runs every query", async () => {
    const { db, seen } = fakeDb(10);
    await annotateSelectedFacts({
      db: db as never, selected: [{ id: "f1", text: "x", score: 1 }],
      renderedText: ["x"], boundary: { userId: "u1" }, mode: "on",
    });
    expect(seen).toEqual({ sent: 2, refused: 0 });
  });
});
