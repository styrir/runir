/**
 * vault-exporter-synthesis.test.ts — Code-dh0
 * Tests for synthesis note reading/writing in vault-exporter.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  fetchSynthesisNotes,
  writeSynthesisFile,
  runVaultExport,
  slugify,
  stripL1Headings,
  VaultWriter,
} from "../lifecycle/archive/vault-exporter.js";
import type { SurrealClient } from "../storage/surreal/surreal-store.js";
import type { SynthesisNoteExport } from "../lifecycle/archive/vault-exporter.js";

const UUID1 = "11111111-1111-1111-1111-111111111111";
const UUID2 = "22222222-2222-2222-2222-222222222222";

function makeSynthesis(overrides: Partial<SynthesisNoteExport> = {}): SynthesisNoteExport {
  return {
    id: "synth001",
    l0: "JWT Token Expiry Configuration",
    l1: "## Context\nFixed JWT expiry.\n\n## Key Points\n- Set to 3600s",
    l2: "## Context\nFull synthesis about JWT configuration...",
    clusterId: "cluster001",
    memoryIds: [UUID1, UUID2],
    entityIds: ["ent1"],
    tags: ["jwt", "auth"],
    para_placement: "02 Areas",
    lastMemoryCount: 2,
    updateCount: 1,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-28T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MockSurrealClient for synthesis tests
// ---------------------------------------------------------------------------

class MockSurrealClientWithSynthesis {
  constructor(
    private readonly activeRows: any[] = [],
    private readonly archivedRows: any[] = [],
    private readonly entities: any[] = [],
    private readonly mentionCounts: Record<string, number> = {},
    private readonly synthNotes: any[] = [],
  ) {}

  async query(sql: string, vars?: Record<string, unknown>): Promise<any[][]> {
    if (sql.includes("synthesis_notes")) {
      return [this.synthNotes];
    }
    if (sql.includes("FROM semiote") && sql.includes("(active = NONE OR active = true)")) {
      return [this.activeRows];
    }
    if (sql.includes("FROM semiote") && sql.includes("active = false")) {
      return [this.archivedRows];
    }
    if (sql.includes("FROM entities") && !sql.includes("entity_edges")) {
      return [this.entities];
    }
    if (sql.includes("GROUP BY in")) {
      // Rúnir-78sy.6 C3: the batched aggregation, multi-row {in, count} shape.
      return [Object.entries(this.mentionCounts).map(([in_, count]) => ({ in: in_, count }))];
    }
    return [[]];
  }
}

// ---------------------------------------------------------------------------
// fetchSynthesisNotes
// ---------------------------------------------------------------------------

describe("fetchSynthesisNotes", () => {
  it("returns records ordered by para_placement, l0", async () => {
    const rows = [
      { id: "syn2", l0: "B Title", l1: "", l2: "", clusterId: "c2", memoryIds: [], entityIds: [], tags: [], para_placement: "02 Areas", lastMemoryCount: 2, updateCount: 0 },
      { id: "syn1", l0: "A Title", l1: "", l2: "", clusterId: "c1", memoryIds: [], entityIds: [], tags: [], para_placement: "01 Projects", lastMemoryCount: 3, updateCount: 0 },
    ];
    const db = { query: async () => [rows] } as unknown as SurrealClient;
    const results = await fetchSynthesisNotes(db);
    expect(results).toHaveLength(2);
    // Returned in DB order (we trust ORDER BY in query)
    expect(results[0]!.id).toBe("syn2");
    expect(results[1]!.id).toBe("syn1");
  });

  it("maps memoryIds array correctly", async () => {
    const rows = [{
      id: "syn1",
      l0: "Title",
      l1: "",
      l2: "",
      clusterId: "c1",
      memoryIds: ["memories:mem1", "memories:mem2"],
      entityIds: [],
      tags: [],
      para_placement: "02 Areas",
      lastMemoryCount: 2,
      updateCount: 0,
    }];
    const db = { query: async () => [rows] } as unknown as SurrealClient;
    const results = await fetchSynthesisNotes(db);
    expect(results[0]!.memoryIds).toHaveLength(2);
    expect(results[0]!.memoryIds[0]).toBe("memories:mem1");
  });

  it("returns empty array when no synthesis_notes", async () => {
    const db = { query: async () => [[]] } as unknown as SurrealClient;
    const results = await fetchSynthesisNotes(db);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// writeSynthesisFile
// ---------------------------------------------------------------------------

describe("writeSynthesisFile", () => {
  const tmpBase = join(tmpdir(), `vault-synth-test-${randomUUID()}`);

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("writes markdown file with l0 as h1", async () => {
    const synthesis = makeSynthesis();
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    // createdAt is "2026-03-01T00:00:00Z" -> date part "2026-03-01"
    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    expect(content).toContain(`# ${synthesis.l0}`);
  });

  it("includes l1 as overview and l2 as body", async () => {
    const synthesis = makeSynthesis();
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    expect(content).toContain("Fixed JWT expiry.");
    expect(content).toContain("Set to 3600s");
    expect(content).toContain(synthesis.l2);
  });

  it("writes to para_placement subfolder/synthesis/", async () => {
    const synthesis = makeSynthesis({ para_placement: "01 Projects" });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, "01 Projects", "synthesis", filename);
    await access(filePath); // throws if not found
  });

  it("includes frontmatter with type: synthesis", async () => {
    const synthesis = makeSynthesis();
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    expect(content).toContain("type: synthesis");
    expect(content).toContain(`clusterId: ${synthesis.clusterId}`);
  });

  it("filename uses YYYY-MM-DD date from createdAt not a random hex suffix", async () => {
    const synthesis = makeSynthesis({ id: "abcdefghijklmnop", l0: "JWT Token Config", createdAt: "2025-11-03T00:00:00Z" });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    // Should use date 2025-11-03, NOT the first 8 chars of the id "abcdefgh"
    const expectedFilename = "jwt-token-config-2025-11-03.md";
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", expectedFilename);
    await access(filePath);
  });

  it("filename falls back to synthId prefix when createdAt is absent", async () => {
    const synthesis = makeSynthesis({ id: "abcdefghijklmnop", l0: "JWT Token Config", createdAt: undefined });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const expectedFilename = "jwt-token-config-abcdefgh.md";
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", expectedFilename);
    await access(filePath);
  });
});

// ---------------------------------------------------------------------------
// runVaultExport with synthesis
// ---------------------------------------------------------------------------

describe("runVaultExport with synthesis", () => {
  const tmpBase = join(tmpdir(), `vault-synth-export-${randomUUID()}`);

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("skips raw export for memories covered by synthesis", async () => {
    const coveredMemId = UUID1;

    const rawMemory = {
      id: { id: coveredMemId },
      payload: {
        l2: "Raw memory content - should be covered",
        l0: "Covered Memory",
        l1: "Summary",
        category: "cases",
        tier: "working",
        tags: [],
        scope: "user",
        userId: "default",
        confidence: 0.9,
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
        active: true,
        source: "memory-hybrid",
        writeSource: "capture",
      },
    };

    const synthNote = {
      id: "syn1",
      l0: "Synthesis covering this memory",
      l1: "Summary",
      l2: "Full body",
      clusterId: "cluster1",
      memoryIds: [coveredMemId],
      entityIds: [],
      tags: [],
      para_placement: "02 Areas",
      lastMemoryCount: 1,
      updateCount: 0,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-28T00:00:00Z",
    };

    const db = new MockSurrealClientWithSynthesis(
      [rawMemory], [], [], {}, [synthNote]
    ) as unknown as SurrealClient;

    await runVaultExport(db, tmpBase, { userId: "default" });

    // Synthesis file should exist — filename uses createdAt date
    const synthFilename = `${slugify(synthNote.l0)}-2026-03-01.md`;
    const synthPath = join(tmpBase, "02 Areas", "synthesis", synthFilename);
    await access(synthPath);

    // Raw memory should NOT be in 02 Areas/cases/ (it's covered by synthesis)
    const casesDir = join(tmpBase, "02 Areas", "cases");
    try {
      await access(casesDir);
      // If folder exists, the items.json should NOT contain our covered memory
      const items = await readFile(join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"), "utf-8").catch(() => "[]");
      const parsed = JSON.parse(items);
      const ids = parsed.map((m: any) => m.id);
      expect(ids).not.toContain(coveredMemId);
    } catch {
      // Folder doesn't exist at all -> good, covered memory was skipped
    }
  });

  it("falls back to raw memories when no synthesis exists", async () => {
    const memory = {
      id: { id: UUID1 },
      payload: {
        l2: "Raw memory — no synthesis",
        l0: "Memory Without Synthesis",
        l1: "Summary",
        category: "cases",
        tier: "working",
        tags: [],
        scope: "user",
        userId: "default",
        confidence: 0.9,
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
        active: true,
        source: "memory-hybrid",
        writeSource: "capture",
      },
    };

    const db = new MockSurrealClientWithSynthesis(
      [memory], [], [], {}, [] // empty synthNotes
    ) as unknown as SurrealClient;

    const result = await runVaultExport(db, tmpBase, { userId: "default" });

    // Memory should be exported to the raw folder
    const casesItems = await readFile(
      join(tmpBase, "99 Meta", "02 Areas", "cases", "items.json"),
      "utf-8",
    );
    const parsed = JSON.parse(casesItems);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(UUID1);

    // synthesisNotesExported should be 0
    expect(result.synthesisNotesExported).toBe(0);
  });

  it("synthesisNotesExported count is correct", async () => {
    // Notes must reference tenant-owned memory ids to be exported — empty
    // memoryIds notes are skipped under tenant validation (Rúnir-78sy.2).
    const makeOwnedMemory = (id: string) => ({
      id: { id },
      payload: {
        l2: "Covered memory body",
        l0: "Covered memory",
        l1: "",
        category: "cases",
        tier: "working",
        tags: [],
        scope: "user",
        userId: "default",
        confidence: 0.9,
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
        active: true,
        source: "memory-hybrid",
        writeSource: "capture",
      },
    });
    const synthNotes = [
      {
        id: "syn1",
        l0: "First Synthesis",
        l1: "",
        l2: "",
        clusterId: "c1",
        memoryIds: [UUID1],
        entityIds: [],
        tags: [],
        para_placement: "02 Areas",
        lastMemoryCount: 4,
        updateCount: 0,
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-28T00:00:00Z",
      },
      {
        id: "syn2",
        l0: "Second Synthesis",
        l1: "",
        l2: "",
        clusterId: "c2",
        memoryIds: [UUID2],
        entityIds: [],
        tags: [],
        para_placement: "01 Projects",
        lastMemoryCount: 5,
        updateCount: 1,
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-28T00:00:00Z",
      },
    ];

    const db = new MockSurrealClientWithSynthesis(
      [makeOwnedMemory(UUID1), makeOwnedMemory(UUID2)], [], [], {}, synthNotes
    ) as unknown as SurrealClient;

    const result = await runVaultExport(db, tmpBase, { userId: "default" });
    expect(result.synthesisNotesExported).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// stripL1Headings
// ---------------------------------------------------------------------------

describe("stripL1Headings", () => {
  it("stripL1Headings removes ## heading lines and keeps body text", () => {
    const input =
      "## Context\nImplementation details.\n\n## Key Points\n- Bullet one\n\n## Status\nReady.";
    const result = stripL1Headings(input);
    expect(result).toBe("Implementation details.\n\n- Bullet one\n\nReady.");
    expect(result).not.toContain("##");
  });
});

// ---------------------------------------------------------------------------
// writeSynthesisFile — bug fix tests
// ---------------------------------------------------------------------------

describe("writeSynthesisFile bug fixes", () => {
  const tmpBase = join(tmpdir(), `vault-synth-bugfix-${randomUUID()}`);

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("writeSynthesisFile ## Summary has non-empty content when l1 is provided", async () => {
    const synthesis = makeSynthesis({
      l1: "## Context\nActual content here.",
    });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    expect(content).toContain("## Summary");
    const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n---|\n##)/);
    expect(summaryMatch).not.toBeNull();
    expect(summaryMatch![1]).toContain("Actual content here.");
  });

  it("writeSynthesisFile produces exactly one ## Context heading", async () => {
    const synthesis = makeSynthesis({
      l1: "## Context\nL1 context text.\n\n## Key Points\n- point",
      l2: "## Context\nL2 full context.\n\n## Key Points\n- detail\n\n## Related\nSurrealDB",
    });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    const contextMatches = content.match(/^## Context/gm) ?? [];
    const keyPointsMatches = content.match(/^## Key Points/gm) ?? [];
    expect(contextMatches).toHaveLength(1);
    expect(keyPointsMatches).toHaveLength(1);
  });

  it("writeSynthesisFile uses [[wikilinks]] for entityNames in ## Related section", async () => {
    const synthesis = makeSynthesis({
      entityNames: ["SurrealDB", "RELATE statement"],
      l2: "## Context\nDetail.\n\n## Related\nSurrealDB, Graph Traversal, RELATE statement",
    });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    expect(content).toContain("[[SurrealDB]]");
    expect(content).toContain("[[RELATE statement]]");
    // "Graph Traversal" is NOT in entityNames, so should remain unlinked
    expect(content).not.toContain("[[Graph Traversal]]");
    // Verify bare "SurrealDB" does not appear unlinked in Related section
    const relatedSection = content.split("## Related")[1]?.split("---")[0] ?? "";
    expect(relatedSection).not.toMatch(/(?<!\[\[)SurrealDB(?!\]\])/);
  });

  it("writeSynthesisFile does not add wikilinks when entityNames is empty", async () => {
    const synthesis = makeSynthesis({
      entityNames: [],
      l2: "## Related\nSurrealDB, entity_edges",
    });
    await writeSynthesisFile(new VaultWriter(tmpBase), synthesis);

    const filename = `${slugify(synthesis.l0)}-2026-03-01.md`;
    const filePath = join(tmpBase, synthesis.para_placement, "synthesis", filename);
    const content = await readFile(filePath, "utf-8");

    expect(content).not.toContain("[[");
  });
});
