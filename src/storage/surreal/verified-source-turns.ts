import { createHmac } from "node:crypto";
import { extractId, type SurrealClient } from "./surreal-store.js";
import { sourceKeyFingerprint } from "../../capture/source-turn-identity.js";

export type SourceBoundary = { userId: string; sessionId?: string };
export type VerifiedSource = {
  factId: string;
  turnId: string;
  text: string;
  client: string;
  role: "user" | "assistant";
  occurredAt?: string;
  identityQuality: string;
  truncated: boolean;
};

type Row = Record<string, any>;
const idOf = (value: unknown) => value == null ? "" : extractId(value);
const value = (v: unknown) => v === undefined || v === null ? undefined : String(v);
const scopeOf = (v: unknown) => !v || v === "NONE" ? "user" : v;

/** The shared Slice 5 eligibility predicate. Never use evidence-only links. */
export function verifiedSourceEligible(fact: Row, turn: Row, text: string, boundary: SourceBoundary, hmacKey: string): boolean {
  if (!hmacKey || !fact || !turn || !boundary.userId) return false;
  if (fact.active !== true || (fact.invalid_at ?? fact.payload?.invalidAt) != null || fact.superseded_by != null
    || fact.payload?.isStale === true || fact.payload?.supersededById != null) return false;
  if (fact.source_turn_link_state !== "linked" && fact.source_turn_link_state !== "legacy") return false;
  if (fact.source_turn_link_state === "legacy" && (turn.identity_quality !== "legacy_payload" || turn.retention_class !== "linked")) return false;
  if (!fact.source_turn_id || idOf(fact.source_turn_id) !== idOf(turn.id)) return false;
  if (fact.user_id !== boundary.userId || turn.user_id !== fact.user_id) return false;
  if (turn.role !== "user" && turn.role !== "assistant") return false;
  if (scopeOf(fact.scope) !== scopeOf(turn.scope)) return false;
  if (fact.team_id != null && fact.team_id !== turn.team_id) return false;
  if (fact.project_key != null && fact.project_key !== turn.project_key) return false;
  if (turn.path != null && turn.path !== fact.path) return false;
  if (scopeOf(turn.scope) === "session" && (!boundary.sessionId || turn.session_id !== boundary.sessionId || turn.session_id !== fact.session_id)) return false;
  const fingerprint = sourceKeyFingerprint(hmacKey);
  if (fact.source_turn_key_fingerprint !== fingerprint || turn.key_fingerprint !== fingerprint) return false;
  const actualHmac = createHmac("sha256", hmacKey).update(text).digest("hex");
  return fact.source_turn_hmac === turn.content_hmac && turn.content_hmac === actualHmac;
}

/** Three bounded SQL reads for the selected facts, turns, then their complete chunks. */
export async function readVerifiedSourceTurns(
  db: Pick<SurrealClient, "query">, factIds: string[], boundary: SourceBoundary,
  hmacKey = process.env.RUNIR_SOURCE_HMAC_KEY ?? "",
): Promise<Map<string, VerifiedSource>> {
  const result = new Map<string, VerifiedSource>();
  const ids = [...new Set(factIds.map(idOf).filter(Boolean))].slice(0, 200);
  if (!ids.length || !hmacKey) return result;
  const facts = (await db.query<Row>(
    `SELECT * FROM semiote WHERE user_id = $userId AND record::id(id) IN $ids;`,
    { userId: boundary.userId, ids },
  ))[0] ?? [];
  const candidates = facts.filter((f) => (f.source_turn_link_state === "linked" || f.source_turn_link_state === "legacy")
    && typeof f.source_turn_id === "string" && f.active === true && (f.invalid_at ?? f.payload?.invalidAt) == null
    && f.superseded_by == null && f.payload?.isStale !== true && f.payload?.supersededById == null);
  const turnIds = [...new Set(candidates.map((f) => idOf(f.source_turn_id)))];
  if (!turnIds.length) return result;
  const turns = (await db.query<Row>(
    `SELECT * FROM session_turn WHERE user_id = $userId AND record::id(id) IN $turnIds;`,
    { userId: boundary.userId, turnIds },
  ))[0] ?? [];
  const turnById = new Map(turns.map((t) => [idOf(t.id), t]));
  const chunks = (await db.query<Row>(
    `SELECT turn_id, chunk_index, content FROM session_turn_chunk WHERE user_id = $userId AND turn_id IN $turnIds ORDER BY turn_id, chunk_index;`,
    { userId: boundary.userId, turnIds },
  ))[0] ?? [];
  const chunksById = new Map<string, Row[]>();
  for (const chunk of chunks) {
    const key = value(chunk.turn_id);
    if (!key) continue;
    const list = chunksById.get(key) ?? [];
    list.push(chunk);
    chunksById.set(key, list);
  }
  for (const fact of candidates) {
    const turnId = idOf(fact.source_turn_id);
    const turn = turnById.get(turnId);
    if (!turn) continue;
    const rows = chunksById.get(turnId) ?? [];
    if (!Number.isSafeInteger(turn.chunk_count) || turn.chunk_count < 1 || turn.chunk_count > 64 || rows.length !== turn.chunk_count) continue;
    rows.sort((a, b) => a.chunk_index - b.chunk_index);
    if (rows.some((r, i) => r.chunk_index !== i || typeof r.content !== "string")) continue;
    const text = rows.map((r) => r.content).join("");
    if (!verifiedSourceEligible(fact, turn, text, boundary, hmacKey)) continue;
    result.set(idOf(fact.id), {
      factId: idOf(fact.id), turnId, text, client: String(turn.client ?? ""), role: turn.role,
      occurredAt: turn.identity_quality === "content_only" || turn.identity_quality === "legacy_payload" ? undefined : value(turn.occurred_at),
      identityQuality: String(turn.identity_quality ?? ""), truncated: turn.truncated === true,
    });
  }
  return result;
}
