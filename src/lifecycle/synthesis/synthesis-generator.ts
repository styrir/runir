/**
 * synthesis-generator.ts — Code-6q9
 * Generates unified synthesis notes from qualifying memory clusters via Gemini Flash.
 */

import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import type { MemoryCluster } from "../compaction/memory-clusterer.js";
import type { RawMemoryRow } from "../../capture/enrichment/memory-enricher.js";
import { callLlmGateway, stripJsonFences } from "../../shared/llm-gateway-client.js";

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

// flash-lite per the 2026-06-11 model A/B (Rúnir-d4xz): wins the JSON-out
// enrichment task class, 2-4x faster, cheaper. SYNTHESIS_MODEL overrides.
const DEFAULT_SYNTHESIS_MODEL = "vertex/gemini-3.1-flash-lite@us";
const DEFAULT_MIN_CLUSTER_SIZE = 4;
const DEFAULT_MIN_NEW_MEMORIES = 3;

function getSynthesisModel(): string {
  return process.env.SYNTHESIS_MODEL ?? DEFAULT_SYNTHESIS_MODEL;
}

function getMinClusterSize(): number {
  const v = parseInt(process.env.SYNTHESIS_MIN_CLUSTER_SIZE ?? "", 10);
  return Number.isFinite(v) ? v : DEFAULT_MIN_CLUSTER_SIZE;
}

function getMinNewMemories(): number {
  const v = parseInt(process.env.SYNTHESIS_MIN_NEW_MEMORIES ?? "", 10);
  return Number.isFinite(v) ? v : DEFAULT_MIN_NEW_MEMORIES;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SynthesisResult = {
  synthesized: number;
  updated: number;
  created: number;
  skipped: number;
  errors: string[];
  durationMs: number;
};

export type SynthesisNote = {
  id?: string;
  l0: string;
  l1: string;
  l2: string;
  clusterId: string;
  memoryIds: string[];
  entityIds: string[];
  entityNames?: string[];
  tags: string[];
  para_placement: string;
  lastMemoryCount: number;
  updateCount: number;
  createdAt?: string;
  updatedAt?: string;
};

// ---------------------------------------------------------------------------
// Qualify cluster for synthesis
// ---------------------------------------------------------------------------

export function qualifiesForSynthesis(
  cluster: MemoryCluster,
  existingSynthesis: SynthesisNote | null,
): boolean {
  const minSize = getMinClusterSize();
  const minNew = getMinNewMemories();

  if (cluster.size < minSize) return false;
  if (cluster.method === "singleton") return false;

  if (!existingSynthesis) return true;

  const delta = cluster.size - existingSynthesis.lastMemoryCount;
  return delta >= minNew;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM_PROMPT = `You are a knowledge synthesizer for a developer's personal knowledge base.

Your job: given source memory fragments, produce a single unified synthesis note in JSON.

Output ONLY valid JSON with exactly these three fields:
{
  "l0": "<5-12 word noun phrase identifying the specific topic — NOT about knowledge management>",
  "l1": "<2-5 line markdown summary using ## Context, ## Key Points, ## Status headings>",
  "l2": "<300-800 word technical prose using ## Context, ## Key Points, ## Details, ## Related>"
}

Rules:
- l0 describes WHAT THE MEMORIES ARE ABOUT (e.g. "SurrealDB RELATE syntax for typed graph edges"), never about the synthesis process itself
- l1 is self-contained — understandable without reading l0 or l2
- l2 expands on l0/l1 without repeating them verbatim
- Merge overlapping facts — do not duplicate
- Preserve exact values: version numbers, commands, config keys, file paths
- ## Related lists entity names and topic tags
- No markdown code fences around the JSON
- No commentary outside the JSON`;

export function buildSynthesisPrompt(memories: RawMemoryRow[]): { system: string; user: string } {
  const sorted = [...memories].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt))
  );

  const memoriesText = sorted.map(m => {
    const title = m.l0?.trim() || m.l2.slice(0, 60);
    return `### [${title}] (${m.createdAt})\n${m.l1 ? `Summary: ${m.l1}\n` : ""}Content: ${m.l2}`;
  }).join("\n\n---\n\n");

  return {
    system: SYNTHESIS_SYSTEM_PROMPT,
    user: `Synthesize the following ${memories.length} related memory fragments into a single JSON note:\n\n${memoriesText}`,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function callGeminiFlash(
  prompt: { system: string; user: string },
  apiKey: string,
): Promise<{ l0: string; l1: string; l2: string } | null> {
  const model = getSynthesisModel();
  try {
    // Shared gateway client (imaf.8): owns the timeout (the old bare fetch
    // could hang a synthesis pass indefinitely) and json_object mode.
    const content = await callLlmGateway({
      model,
      apiKey,
      jsonMode: true,
      temperature: 0.3,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    });
    const parsed = JSON.parse(stripJsonFences(content)) as Record<string, string>;

    return {
      l0: String(parsed.l0 ?? ""),
      l1: String(parsed.l1 ?? ""),
      l2: String(parsed.l2 ?? ""),
    };
  } catch (err) {
    // Return null on parse/network failure — caller handles
    console.error("[synthesis-generator] callGeminiFlash error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// PARA placement inference
// ---------------------------------------------------------------------------

export function inferParaPlacement(
  l2: string,
  memories: RawMemoryRow[],
): string {
  // Step 2: Archive always wins
  for (const m of memories) {
    if (m.para_hint === "archive" || m.active === false || m.supersededById) {
      return "04 Archives";
    }
  }

  // Step 3: Majority vote on para_hint
  const hints = memories.map(m => m.para_hint).filter(Boolean) as string[];
  if (hints.length > 0) {
    const counts = new Map<string, number>();
    for (const h of hints) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const [hint, count] of counts) {
      if (count / hints.length >= 0.6) {
        switch (hint) {
          case "project":  return "01 Projects";
          case "area":     return "02 Areas";
          case "resource": return "03 Resources";
          case "archive":  return "04 Archives";
        }
      }
    }
  }

  // Step 4: Regex fallback on aggregated text
  const allText = l2 + " " + memories.map(m => `${m.l2} ${m.tags?.join(" ") ?? ""} ${m.category}`).join(" ");

  // 4a. Projects — ticket/sprint/deadline references (unchanged)
  if (
    /ticket|sprint|milestone|deadline|deliverable|PR[- ]?\d|MIM-\d|Code-\w/i.test(allText) ||
    memories.some(m => m.tags?.some(t => t.startsWith("project-")))
  ) {
    return "01 Projects";
  }

  // 4b. Resources — check BEFORE Areas to prevent false positives from "always/never" in technical text
  // Strong signals: technical syntax, API patterns, schema definitions, how-to, reference
  // Note: first-person language (I prefer, we use) is NOT checked here — personal signals win Areas
  const hasFirstPersonSignal =
    /\bI (prefer|always|never|use|avoid|like|dislike|want|need)\b/i.test(allText) ||
    /\bwe (prefer|always|never|use|avoid|like|always use|never use)\b/i.test(allText) ||
    /\bmy (workflow|preference|policy|convention|standard|approach|practice)\b/i.test(allText) ||
    /\bour (workflow|preference|policy|convention|standard|approach|practice|team)\b/i.test(allText) ||
    memories.some(m => m.category === "profile" || m.category === "preferences");

  if (!hasFirstPersonSignal && (
    /how[ -]to|reference|pattern|example|snippet|tutorial|guide|documentation|cheatsheet/i.test(allText) ||
    /syntax|schema|spec|query|statement|command|expression|definition|DEFINE|SELECT|INSERT|RELATE|CREATE/i.test(allText) ||
    /library|module|package|framework|sdk|api|driver|adapter|client|endpoint/i.test(allText) ||
    /cast|type::|record\(|index|unique|relation|edge|graph|traversal/i.test(allText) ||
    memories.some(m =>
      m.category === "patterns" ||
      m.category === "entities"
    )
  )) {
    return "03 Resources";
  }

  // 4c. Areas — personal responsibility, preferences, policies
  // Require first-person or responsibility-specific signal to avoid false positives
  // "always/never" alone is NOT enough — must co-occur with a personal/ownership signal
  if (
    hasFirstPersonSignal ||
    /\bresponsibility|recurring task|maintain standard|ongoing standard\b/i.test(allText)
  ) {
    return "02 Areas";
  }

  // Default — unclassified developer notes are more likely reference material than area notes
  return "03 Resources";
}

// ---------------------------------------------------------------------------
// Upsert synthesis_notes
// ---------------------------------------------------------------------------

export async function upsertSynthesis(
  db: SurrealClient,
  cluster: MemoryCluster,
  l0: string,
  l1: string,
  l2: string,
  paraPlacement: string,
  memories: RawMemoryRow[],
  existingId?: string,
  existingUpdateCount?: number,
): Promise<string> {
  // Collect tags union
  const allTags = [...new Set(memories.flatMap(m => m.tags ?? []))];

  // Fetch canonical names for entity wikilinks (Code-b2b2)
  const entityNames: string[] = [];
  if (cluster.entityIds && cluster.entityIds.length > 0) {
    // cluster.entityIds are bare IDs (e.g. "seed-ent-surrealdb") or may include
    // a table prefix ("entities:seed-ent-surrealdb"). SurrealDB entity records use
    // backtick-quoted IDs for hyphenated strings, so we must match on meta::id(id)
    // with bare IDs stripped of any "entities:" prefix.
    const bareIds = cluster.entityIds.map(id => {
      const s = String(id);
      return s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
    });
    const entResults = await db.query<any>(
      `SELECT canonicalName FROM entities WHERE meta::id(id) IN $ids`,
      { ids: bareIds },
    );
    const entRows = entResults[0] ?? [];
    for (const row of entRows) {
      if (row.canonicalName) entityNames.push(String(row.canonicalName));
    }
  }

  if (existingId) {
    // Update existing
    const newUpdateCount = (existingUpdateCount ?? 0) + 1;
    await db.query(
      `UPDATE $id SET
         l0 = $l0,
         l1 = $l1,
         l2 = $l2,
         memoryIds = $memoryIds,
         entityIds = $entityIds,
         entityNames = $entityNames,
         tags = $tags,
         para_placement = $para_placement,
         lastMemoryCount = $lastMemoryCount,
         updateCount = $updateCount,
         updatedAt = time::now()`,
      {
        id: existingId,
        l0, l1, l2,
        memoryIds: cluster.memoryIds,
        entityIds: cluster.entityIds,
        entityNames,
        tags: allTags,
        para_placement: paraPlacement,
        lastMemoryCount: cluster.size,
        updateCount: newUpdateCount,
      },
    );
    return existingId;
  }

  // Create new
  const results = await db.query<any>(
    `CREATE synthesis_notes CONTENT {
       l0: $l0,
       l1: $l1,
       l2: $l2,
       clusterId: <string>$clusterId,
       memoryIds: $memoryIds,
       entityIds: $entityIds,
       entityNames: $entityNames,
       tags: $tags,
       para_placement: $para_placement,
       lastMemoryCount: $lastMemoryCount,
       updateCount: 0,
       createdAt: time::now(),
       updatedAt: time::now()
     }`,
    {
      l0, l1, l2,
      clusterId: String(cluster.id ?? cluster.fingerprintId),
      memoryIds: cluster.memoryIds,
      entityIds: cluster.entityIds,
      entityNames,
      tags: allTags,
      para_placement: paraPlacement,
      lastMemoryCount: cluster.size,
    },
  );

  const created = results[0]?.[0] ?? results[0];
  const newId = typeof created?.id === "object"
    ? String((created.id as any).id ?? created.id)
    : String(created?.id ?? "");

  // Update cluster.synthesisId
  if (cluster.id) {
    await db.query(
      `UPDATE $clusterId SET synthesisId = $synthId`,
      { clusterId: cluster.id, synthId: newId },
    );
  }

  return newId;
}

// ---------------------------------------------------------------------------
// Fetch source memories for a cluster
// ---------------------------------------------------------------------------

async function fetchClusterMemories(
  db: SurrealClient,
  memoryIds: string[],
): Promise<RawMemoryRow[]> {
  if (memoryIds.length === 0) return [];
  const results = await db.query<any>(
    `SELECT id,
       payload.l2 OR payload.data AS l2,
       payload.l0 AS l0,
       payload.l1 AS l1,
       payload.category AS category,
       payload.tier AS tier,
       payload.tags AS tags,
       payload.writeSource AS writeSource,
       payload.createdAt AS createdAt,
       active,
       payload.supersededById AS supersededById,
       payload.para_hint AS para_hint
     FROM memories WHERE meta::id(id) IN $ids`,
    { ids: memoryIds },
  );
  const rows = results[0] ?? [];
  return rows.map((row: any) => ({
    id: typeof row.id === "object" && row.id !== null
      ? String((row.id as any).id ?? row.id)
      : String(row.id ?? ""),
    l2: row.l2 ?? "",
    l0: row.l0 ?? "",
    l1: row.l1 ?? "",
    category: row.category ?? "cases",
    tier: row.tier ?? "working",
    tags: row.tags ?? [],
    writeSource: row.writeSource ?? "capture",
    createdAt: String(row.createdAt ?? ""),
    active: row.active,
    supersededById: row.supersededById,
    para_hint: row.para_hint,
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runSynthesis(
  db: SurrealClient,
  apiKey: string,
): Promise<SynthesisResult> {
  const startMs = Date.now();
  let synthesized = 0;
  let updated = 0;
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Fetch all clusters
  const clusterResults = await db.query<any>(`SELECT * FROM memory_clusters`);
  const clusters: MemoryCluster[] = clusterResults[0] ?? [];

  for (const cluster of clusters) {
    try {
      // Fetch existing synthesis if any
      let existingSynthesis: SynthesisNote | null = null;
      if (cluster.synthesisId) {
        const sr = await db.query<any>(
          `SELECT * FROM $id`,
          { id: cluster.synthesisId },
        );
        existingSynthesis = sr[0]?.[0] ?? null;
      }

      if (!qualifiesForSynthesis(cluster, existingSynthesis)) {
        skipped++;
        continue;
      }

      // Fetch source memories
      const memories = await fetchClusterMemories(db, cluster.memoryIds ?? []);
      if (memories.length === 0) {
        skipped++;
        continue;
      }

      const prompt = buildSynthesisPrompt(memories);
      const result = await callGeminiFlash(prompt, apiKey);
      if (!result) {
        errors.push(`cluster ${cluster.id}: LLM returned null`);
        continue;
      }

      const { l0, l1, l2 } = result;
      const paraPlacement = inferParaPlacement(l2, memories);

      await upsertSynthesis(
        db, cluster, l0, l1, l2, paraPlacement, memories,
        existingSynthesis?.id,
        existingSynthesis?.updateCount,
      );

      synthesized++;
      if (existingSynthesis) updated++;
      else created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`cluster ${cluster.id ?? cluster.fingerprintId}: ${msg}`);
    }
  }

  return {
    synthesized,
    updated,
    created,
    skipped,
    errors,
    durationMs: Date.now() - startMs,
  };
}
