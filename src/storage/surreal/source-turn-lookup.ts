import type { SurrealClient } from "./surreal-store.js";

export type LinkedTurnLookup = {
  userId: string;
  scope: "user" | "session" | "team" | "project" | "all";
  teamId?: string;
  projectKey?: string;
  sessionId?: string;
  path?: string;
  factId: string;
  maxChunks: number;
};

export type LinkedTurn = {
  link: "primary" | "evidence_only";
  nonEquivalent: boolean;
  turn: Record<string, unknown>;
  chunks: Array<Record<string, unknown>>;
};

/** A bounded, tenant-checked read of links belonging to an already selected fact. */
export async function lookupLinkedTurns(db: Pick<SurrealClient, "query">, input: LinkedTurnLookup): Promise<LinkedTurn[]> {
  if (input.scope === "all") throw new Error("all-scope linked-turn lookup is undefined until Slice 5");
  if (!input.userId || !input.factId || !Number.isSafeInteger(input.maxChunks) || input.maxChunks < 1 || input.maxChunks > 64)
    throw new Error("invalid linked-turn lookup bounds");
  const factId = input.factId.replace(/^semiote:/, "");
  const facts = await db.query<Record<string, unknown>>(
    "SELECT user_id, scope, team_id, project_key, session_id, path, source_turn_id, source_turn_link_state FROM type::record('semiote', $factId) WHERE user_id = $userId;",
    { factId, userId: input.userId },
  );
  const fact = facts[0]?.[0];
  if (!fact || !visible(fact, input)) return [];
  const links: Array<{ id: string; link: LinkedTurn["link"] }> = [];
  if (fact.source_turn_link_state === "linked" && typeof fact.source_turn_id === "string")
    links.push({ id: fact.source_turn_id, link: "primary" });
  const evidence = await db.query<{ turn_id?: string }>(
    "SELECT turn_id FROM source_turn_evidence WHERE user_id = $userId AND fact_id = $factId AND link_state = 'linked' AND non_equivalent = true LIMIT 16;",
    { userId: input.userId, factId },
  );
  for (const row of evidence[0] ?? []) if (typeof row.turn_id === "string") links.push({ id: row.turn_id, link: "evidence_only" });
  const result: LinkedTurn[] = [];
  for (const item of links) {
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM type::record('session_turn', $turnId) WHERE user_id = $userId;",
      { turnId: item.id, userId: input.userId },
    );
    const turn = rows[0]?.[0];
    if (!turn || !visible(turn, input) || !compatible(fact, turn)) continue;
    const chunks = await db.query<Record<string, unknown>>(
      "SELECT * FROM session_turn_chunk WHERE user_id = $userId AND turn_id = $turnId ORDER BY chunk_index LIMIT $limit;",
      { userId: input.userId, turnId: item.id, limit: input.maxChunks },
    );
    result.push({ link: item.link, nonEquivalent: item.link === "evidence_only", turn, chunks: chunks[0] ?? [] });
  }
  return result;
}

function compatible(fact: Record<string, unknown>, turn: Record<string, unknown>): boolean {
  if (fact.user_id !== turn.user_id || fact.scope !== turn.scope) return false;
  for (const key of ["team_id", "project_key", "path"] as const)
    if (fact[key] != null && turn[key] !== fact[key]) return false;
  if (fact.scope === "session" && fact.session_id !== turn.session_id) return false;
  return true;
}

function visible(row: Record<string, unknown>, input: LinkedTurnLookup): boolean {
  if (row.user_id !== input.userId) return false;
  if (row.scope === "session" && (input.scope !== "session" || !input.sessionId || row.session_id !== input.sessionId)) return false;
  if (row.scope === "team" && (input.scope !== "team" || !input.teamId || row.team_id !== input.teamId)) return false;
  if (row.scope === "project" && (input.scope !== "project" || !input.projectKey || row.project_key !== input.projectKey)) return false;
  if (row.team_id != null && row.team_id !== input.teamId) return false;
  if (row.project_key != null && row.project_key !== input.projectKey) return false;
  if (row.path != null && row.path !== input.path) return false;
  return true;
}
