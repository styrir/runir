import { pathToFileURL } from "node:url";
import type { EntityRecord } from "../src/domain/memory/types.js";
import { mergeEntities } from "../src/entities/entity-store.js";
import {
  applyTenantUpdateStatements,
  buildTenantUpdateStatements,
  canonicalEntityKey,
  canonicalProjectStateKey,
  mergeEntityForCanonicalTenant,
  mergeProjectStateForCanonicalTenant,
} from "../src/maintenance/canonical-tenant-migration.js";
import {
  applySemioteDedupeGroups,
  buildSemioteDedupeGroups,
  findSemioteDuplicateIds,
  type SemioteIdentityRow,
} from "../src/maintenance/semiote-tenant-dedupe.js";
import {
  extractId,
  SurrealClient,
} from "../src/storage/surreal/surreal-store.js";

type EntityRow = EntityRecord & { id: unknown };
type ProjectStateRow = {
  id: unknown;
  user_id: string;
  project_key?: string;
  path?: string;
  updated_at?: unknown;
  updatedAt?: unknown;
  supporting_memory_ids?: unknown;
  [key: string]: unknown;
};
type MigrationArgs = {
  from: string;
  to: string;
  apply: boolean;
};

const USAGE = "usage: migrate-canonical-tenant --from <tenant> --to <tenant> [--apply]";

function parseArgs(argv: string[]): MigrationArgs {
  let from = "";
  let to = "";
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from") from = argv[index + 1] ?? "";
    if (argument === "--to") to = argv[index + 1] ?? "";
    if (argument === "--apply") apply = true;
  }
  if (!from || !to || from === to) {
    throw new Error(USAGE);
  }
  return { from, to, apply };
}

async function assertServiceStopped(): Promise<void> {
  try {
    const response = await fetch("http://127.0.0.1:7700/health", {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      throw new Error("refusing apply while Rúnir is accepting writes");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "refusing apply while Rúnir is accepting writes"
    ) {
      throw error;
    }
  }
}

function createClient(): SurrealClient {
  return new SurrealClient({
    url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "",
    namespace: process.env.SURREAL_NS ?? "main",
    database: process.env.SURREAL_DB ?? "main",
  });
}

async function runMigration(args: MigrationArgs): Promise<void> {
  if (args.apply) await assertServiceStopped();
  const db = createClient();

  try {
    const [entityResult, projectResult, semioteResult] = await Promise.all([
      db.query<EntityRow>(
        "SELECT * FROM entities WHERE userId IN [$fromUserId, $toUserId];",
        { fromUserId: args.from, toUserId: args.to },
      ),
      db.query<ProjectStateRow>(
        "SELECT * FROM project_state WHERE user_id IN [$fromUserId, $toUserId];",
        { fromUserId: args.from, toUserId: args.to },
      ),
      db.query<SemioteIdentityRow>(
        "SELECT id, user_id, payload.factKey AS factKey, text_norm AS textNorm, updated_at AS updatedAt FROM semiote WHERE user_id IN [$fromUserId, $toUserId];",
        { fromUserId: args.from, toUserId: args.to },
      ),
    ]);

    const entities = entityResult[0] ?? [];
    const targetEntities = new Map(
      entities
        .filter((row) => row.userId === args.to)
        .map((row) => [canonicalEntityKey(row), row]),
    );
    const entityCollisions = entities
      .filter(
        (row) =>
          row.userId === args.from &&
          targetEntities.has(canonicalEntityKey(row)),
      )
      .map((source) => ({
        source,
        target: targetEntities.get(canonicalEntityKey(source)) as EntityRow,
      }));

    const projectStates = projectResult[0] ?? [];
    const targetProjectStates = new Map(
      projectStates
        .filter((row) => row.user_id === args.to)
        .map((row) => [canonicalProjectStateKey(row), row]),
    );
    const projectStateCollisions = projectStates
      .filter(
        (row) =>
          row.user_id === args.from &&
          targetProjectStates.has(canonicalProjectStateKey(row)),
      )
      .map((source) => ({
        source,
        target: targetProjectStates.get(
          canonicalProjectStateKey(source),
        ) as ProjectStateRow,
      }));

    const semioteRows = semioteResult[0] ?? [];
    const semioteDedupeGroups = buildSemioteDedupeGroups(
      semioteRows,
      args.from,
      args.to,
    );
    const textDuplicates = findSemioteDuplicateIds(
      semioteRows,
      "textNorm",
      args.from,
      args.to,
    );
    if (textDuplicates.length > 0) {
      throw new Error(
        `refusing migration with normalized-text collisions: ${textDuplicates.length}`,
      );
    }

    const summary = {
      from: args.from,
      to: args.to,
      dryRun: !args.apply,
      sourceCounts: {
        semiote: semioteRows.filter((row) => row.user_id === args.from).length,
        entities: entities.filter((row) => row.userId === args.from).length,
        projectState: projectStates.filter((row) => row.user_id === args.from).length,
      },
      entityCollisions: entityCollisions.map(({ source, target }) => ({
        sourceId: String(source.id),
        targetId: String(target.id),
      })),
      projectStateCollisions: projectStateCollisions.map(
        ({ source, target }) => ({
          sourceId: String(source.id),
          targetId: String(target.id),
        }),
      ),
      semioteDedupeGroups: semioteDedupeGroups.map((group) => ({
        winnerId: group.winnerId,
        loserIds: group.loserIds,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!args.apply) return;

    for (const { source, target } of entityCollisions) {
      await mergeEntities(
        db,
        extractId(target.id),
        extractId(source.id),
        mergeEntityForCanonicalTenant(source, target),
      );
    }

    for (const { source, target } of projectStateCollisions) {
      const merged = mergeProjectStateForCanonicalTenant(
        source,
        target,
        args.to,
      );
      await db.queryTransaction(
        "UPDATE type::record('project_state', $targetId) CONTENT $content;\nDELETE type::record('project_state', $sourceId);",
        {
          targetId: extractId(merged.targetId),
          sourceId: extractId(source.id),
          content: merged.content,
        },
      );
    }

    await applySemioteDedupeGroups(db, semioteDedupeGroups);
    await applyTenantUpdateStatements(
      db,
      buildTenantUpdateStatements(args),
      { apply: true },
    );

    const verification = await db.query<{ table: string; count: number }>(
      `RETURN [
        { table: "semiote", count: count(SELECT id FROM semiote WHERE user_id = $fromUserId OR payload.userId = $fromUserId) },
        { table: "noema", count: count(SELECT id FROM noema WHERE user_id = $fromUserId) },
        { table: "entities", count: count(SELECT id FROM entities WHERE userId = $fromUserId) },
        { table: "project_state", count: count(SELECT id FROM project_state WHERE user_id = $fromUserId) }
      ];`,
      { fromUserId: args.from },
    );
    const residue = verification[0]?.filter((row) => row.count !== 0) ?? [];
    if (residue.length > 0) {
      throw new Error(`authoritative source residue: ${JSON.stringify(residue)}`);
    }
  } finally {
    await db.close();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes("--help")) {
  console.log(USAGE);
} else if (isMain) {
  await runMigration(parseArgs(process.argv.slice(2)));
}
