import type { SurrealClient } from "../../../storage/surreal/surreal-store.js";
import { lookupLinkedTurns } from "../../../storage/surreal/source-turn-lookup.js";
import { OMITTED_QUALIFIER } from "../fixtures.js";
import type { GateResult } from "../types.js";

export async function storageGate(db: SurrealClient, factId: string, userId: string, expected: { turnId: string; epoch: string; fingerprint: string }): Promise<GateResult> {
  const links = await lookupLinkedTurns(db, { factId, userId, scope: "user", maxChunks: 64 });
  const match = links.some((row) => row.link === "primary" && row.turn.id != null
    && String(row.turn.id).endsWith(expected.turnId) && row.turn.session_epoch === expected.epoch
    && row.turn.key_fingerprint === expected.fingerprint && row.turn.identity_quality !== "content_only"
    && row.chunks.some((chunk) => String(chunk.content).includes(OMITTED_QUALIFIER)));
  return { id: "storage.omitted_qualifier", family: "storage", status: match ? "pass" : "fail",
    counts: { linkedRows: links.length, qualifierMatches: Number(match) } };
}
