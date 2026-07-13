/**
 * vault-daily-notes.test.ts — Code-dsbz
 * Tests for daily notes generation with session grouping.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runVaultExport } from "../lifecycle/archive/vault-exporter.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";

// ---------------------------------------------------------------------------
// Minimal mock client for daily notes tests
// ---------------------------------------------------------------------------

class DailyNotesMockClient {
  constructor(private readonly memories: any[] = []) {}

  async query(sql: string): Promise<any[][]> {
    if (sql.includes("FROM semiote") && sql.includes("(active = NONE OR active = true)")) {
      return [this.memories];
    }
    if (sql.includes("FROM semiote") && sql.includes("active = false")) {
      return [[]];
    }
    if (sql.includes("synthesis_notes")) {
      return [[]];
    }
    if (sql.includes("FROM entities")) {
      return [[]];
    }
    if (sql.includes("meta::id")) {
      return [[{ count: 0 }]];
    }
    return [[]];
  }
}

function makeMemory(overrides: Record<string, unknown> = {}): any {
  return {
    id: { id: randomUUID() },
    payload: {
      l2: "A test memory",
      l0: "Test Memory Title",
      l1: "Summary",
      category: "cases",
      tier: "working",
      tags: [],
      scope: "user",
      userId: "default",
      confidence: 0.9,
      createdAt: "2026-03-28T10:00:00Z",
      updatedAt: "2026-03-28T10:00:00Z",
      active: true,
      source: "memory-hybrid",
      writeSource: "capture",
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeDailyNotes — session grouping", () => {
  const tmpBase = join(tmpdir(), `daily-notes-test-${randomUUID()}`);

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("creates a daily note file for memories on a given date", async () => {
    const memory = makeMemory({ createdAt: "2026-03-28T10:00:00Z" });
    const db = new DailyNotesMockClient([memory]) as unknown as SurrealClient;
    await runVaultExport(db, tmpBase, { userId: "default" });

    const notePath = join(tmpBase, "05 Daily Notes", "2026", "2026-03-28.md");
    const content = await readFile(notePath, "utf-8");
    expect(content).toContain("# 2026-03-28");
    expect(content).toContain("A test memory");
  });

  it("groups memories with sessionId under ### Session: heading", async () => {
    const sessionId = "abcdefgh12345678";
    const memory = makeMemory({
      createdAt: "2026-03-28T10:00:00Z",
      sessionId,
    });
    const db = new DailyNotesMockClient([memory]) as unknown as SurrealClient;
    await runVaultExport(db, tmpBase, { userId: "default" });

    const notePath = join(tmpBase, "05 Daily Notes", "2026", "2026-03-28.md");
    const content = await readFile(notePath, "utf-8");
    // Should show sliced sessionId (first 8 chars)
    expect(content).toContain("### Session: abcdefgh");
    expect(content).toContain("A test memory");
  });

  it("shows non-session memories under ### Standalone Captures heading", async () => {
    const memory = makeMemory({
      createdAt: "2026-03-28T10:00:00Z",
      // No sessionId
    });
    const db = new DailyNotesMockClient([memory]) as unknown as SurrealClient;
    await runVaultExport(db, tmpBase, { userId: "default" });

    const notePath = join(tmpBase, "05 Daily Notes", "2026", "2026-03-28.md");
    const content = await readFile(notePath, "utf-8");
    expect(content).toContain("### Standalone Captures");
    expect(content).toContain("A test memory");
  });

  it("groups multiple session memories from same session under one heading", async () => {
    const sessionId = "sess1234abcdefgh";
    const mem1 = makeMemory({ createdAt: "2026-03-28T10:00:00Z", sessionId, l2: "First session memory" });
    const mem2 = makeMemory({ createdAt: "2026-03-28T10:01:00Z", sessionId, l2: "Second session memory" });
    const db = new DailyNotesMockClient([mem1, mem2]) as unknown as SurrealClient;
    await runVaultExport(db, tmpBase, { userId: "default" });

    const notePath = join(tmpBase, "05 Daily Notes", "2026", "2026-03-28.md");
    const content = await readFile(notePath, "utf-8");
    // Should have exactly one session heading
    const headingMatches = content.match(/### Session: sess1234/g) ?? [];
    expect(headingMatches).toHaveLength(1);
    expect(content).toContain("First session memory");
    expect(content).toContain("Second session memory");
  });

  it("handles memories across multiple dates correctly", async () => {
    const mem1 = makeMemory({ createdAt: "2026-03-27T10:00:00Z", l2: "Memory on 27th" });
    const mem2 = makeMemory({ createdAt: "2026-03-28T10:00:00Z", l2: "Memory on 28th" });
    const db = new DailyNotesMockClient([mem1, mem2]) as unknown as SurrealClient;
    await runVaultExport(db, tmpBase, { userId: "default" });

    const note27 = await readFile(join(tmpBase, "05 Daily Notes", "2026", "2026-03-27.md"), "utf-8");
    const note28 = await readFile(join(tmpBase, "05 Daily Notes", "2026", "2026-03-28.md"), "utf-8");
    expect(note27).toContain("Memory on 27th");
    expect(note28).toContain("Memory on 28th");
    expect(note27).not.toContain("Memory on 28th");
  });
});
