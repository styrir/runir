import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_20X4K } from "../../__tests__/fixtures/capture-20x4k.js";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import { prepareSourceTurn } from "../../capture/source-turn-identity.js";
import { upsertSourceTurn } from "../../storage/surreal/session-turn-store.js";
import { markFactSourceLink, reconcileSourceTurnLinks } from "../../storage/surreal/source-turn-link-store.js";

export const OMITTED_QUALIFIER_ID = "adjudicated-omitted-qualifier-1";
export const OMITTED_QUALIFIER = "only on Tuesday";
export const CORRECTION_CASE = {
  older: "The synthetic release window is Monday.",
  newer: "The synthetic release window is Friday at midnight.",
  subject: "synthetic release window",
  predicate: "is scheduled for",
  olderValue: "Monday",
  newerValue: "Friday at midnight",
  query: "What is the current synthetic release window?",
} as const;
export const CLIENTS = ["claude", "codex", "pi", "grok"] as const;
export const SCOPED_CASES = [
  { id: "session", scope: "session" as const, sessionId: "scoped-s", teamId: undefined, projectKey: undefined, path: "src/session.ts" },
  { id: "team", scope: "team" as const, sessionId: "scoped-t", teamId: "synthetic-T", projectKey: undefined, path: "src/team.ts" },
  { id: "project", scope: "project" as const, sessionId: "scoped-p", teamId: undefined, projectKey: "synthetic-P", path: "src/project.ts" },
  { id: "other-user", scope: "user" as const, sessionId: "scoped-b", teamId: undefined, projectKey: undefined, path: "src/other.ts" },
];

export async function seedScopedFixtures(db: SurrealClient, hmacKey: string): Promise<void> {
  for (const item of SCOPED_CASES) {
    const owner = item.id === "other-user" ? "synthetic-B" : "synthetic-A";
    const turn = prepareSourceTurn({ userId: owner, client: item.id === "team" ? "grok" : "pi", sessionId: item.sessionId,
      sessionEpoch: "scope-e", turnKey: `pi:${item.id}`, role: "user", content: `Synthetic ${item.id} scoped turn`,
      occurredAt: "2026-01-01T00:00:00Z", scope: item.scope, teamId: item.teamId, projectKey: item.projectKey, path: item.path }, hmacKey);
    const id = `scope_${item.id.replace(/-/g, "_")}`;
    await db.query(`CREATE type::record('semiote', $id) CONTENT {
      user_id: $userId, scope: $scope, session_id: $sessionId, team_id: $teamId,
      project_key: $projectKey, path: $path, payload: { l2: 'synthetic scoped fact' },
      created_at: time::now(), updated_at: time::now()
    };`, { id, userId: owner, scope: item.scope, sessionId: item.sessionId, teamId: item.teamId,
      projectKey: item.projectKey, path: item.path });
    await upsertSourceTurn(db, turn);
    await markFactSourceLink(db, id, owner, turn, "pending", item.id === "session");
    await reconcileSourceTurnLinks(db, turn);
  }
}

export type Canaries = { secrets: string[]; sourcePii: string[]; safe: string[]; pairedEmail: string };
export async function loadSyntheticFixtures(): Promise<{ canaries: Canaries; hashes: Record<string, string>; inputCounts: Record<string, number> }> {
  const bytes = await readFile(join(process.cwd(), "test/fixtures/source-redaction/canaries.json"));
  const canaries = JSON.parse(bytes.toString("utf8")) as Canaries;
  const captureBytes = Buffer.from(JSON.stringify(CAPTURE_20X4K));
  return { canaries,
    hashes: { canaries: createHash("sha256").update(bytes).digest("hex"), capture20x4k: createHash("sha256").update(captureBytes).digest("hex") },
    inputCounts: { secretCanaries: canaries.secrets.length, sourcePiiCanaries: canaries.sourcePii.length, safeStrings: canaries.safe.length, captureTurns: CAPTURE_20X4K.length },
  };
}

export { CAPTURE_20X4K };

/** The per-run synthetic HMAC key that measure.ts generates into the process env. */
export function syntheticHmacKey(): string {
  const key = process.env.RUNIR_SOURCE_HMAC_KEY;
  if (!key) throw new Error("synthetic HMAC key not configured");
  return key;
}
