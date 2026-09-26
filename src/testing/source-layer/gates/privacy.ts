import { FIELDS, TABLES, fieldValue, readPage, strings } from "../../../../scripts/source-layer/privacy-inventory.js";
import type { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import type { Canaries } from "../fixtures.js";
import type { GateResult } from "../types.js";

export async function privacyGate(db: SurrealClient, canaries: Canaries, outputs: { recallJson: unknown; logs: string; vaultTexts: string[] }): Promise<GateResult> {
  const counts: Record<string, number> = { turn: 0, chunk: 0, fact: 0, rawSourcePresent: 0, secretHits: 0, sourcePiiHits: 0, factPiiSurvival: 0, safeSurvival: 0, embeddingNonNumeric: 0, logBytes: outputs.logs.length };
  const secretIndexes = new Set<number>();
  const piiIndexes = new Set<number>();
  const safeIndexes = new Set<number>();
  const scan = (value: unknown, source: boolean) => {
    for (const text of strings(value)) {
      canaries.secrets.forEach((v, i) => { if (text.includes(v)) secretIndexes.add(i); });
      if (source) canaries.sourcePii.forEach((v, i) => { if (text.includes(v)) piiIndexes.add(i); });
      else if (text.includes(canaries.pairedEmail)) counts.factPiiSurvival++;
      canaries.safe.forEach((v, i) => { if (text.includes(v)) safeIndexes.add(i); });
    }
  };
  for (const table of TABLES) {
    let cursor = "";
    while (true) {
      const page = await readPage(db, table, cursor, 100);
      if (!page.length) break;
      for (const row of page) {
        if (table === "session_turn") counts.turn++;
        if (table === "session_turn_chunk") counts.chunk++;
        if (table === "semiote") counts.fact++;
        if (table === "semiote" && fieldValue(row, "payload.raw_source_text") != null) counts.rawSourcePresent++;
        for (const field of FIELDS[table]) {
          const value = fieldValue(row, field);
          if (field === "embedding") {
            if (value != null && (!Array.isArray(value) || !value.every((n) => typeof n === "number"))) counts.embeddingNonNumeric++;
          } else scan(value, table === "session_turn" || table === "session_turn_chunk");
        }
        cursor = String((row.id as { id?: string })?.id ?? row.id ?? cursor).replace(/^.*:/, "");
      }
      if (page.length < 100) break;
    }
  }
  // Recall may legitimately contain a fact's retained PII; source excerpts
  // are checked separately by the retrieval gate while all secrets remain banned.
  scan(outputs.recallJson, false);
  scan(outputs.logs, true);
  for (const file of outputs.vaultTexts) scan(file, false);
  counts.secretHits = secretIndexes.size;
  counts.sourcePiiHits = piiIndexes.size;
  counts.safeSurvival = safeIndexes.size;
  for (const i of secretIndexes) counts[`secretCanaryIndex${i}`] = 1;
  for (const i of piiIndexes) counts[`sourcePiiCanaryIndex${i}`] = 1;
  const pass = counts.turn > 0 && counts.chunk > 0 && counts.fact > 0 && counts.rawSourcePresent === 0
    && counts.secretHits === 0 && counts.sourcePiiHits === 0 && counts.embeddingNonNumeric === 0
    && counts.logBytes > 0 && counts.safeSurvival === canaries.safe.length;
  return { id: "privacy.inventory", family: "privacy", status: pass ? "pass" : "fail", counts };
}
