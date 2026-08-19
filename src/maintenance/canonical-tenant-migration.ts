export type TenantMigrationDb = {
  queryTransaction(
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<unknown>;
};

export type TenantUpdateStatement = {
  label: "semiote" | "noema" | "entities" | "project_state";
  sql: string;
  vars: {
    fromUserId: string;
    toUserId: string;
  };
};

export type TenantUpdateInput = {
  from: string;
  to: string;
  nonCollidingEntityIds?: string[];
  nonCollidingProjectStateIds?: string[];
};

type EntityMergeRow = {
  id?: unknown;
  userId?: string;
  kind?: string;
  scope?: string;
  sessionId?: string;
  canonicalName: string;
  nameNorm: string;
  aliases?: string[];
  aliasesNorm?: string[];
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
  description?: string;
  updatedAt?: string;
};

type ProjectStateRow = {
  id: unknown;
  user_id: string;
  updated_at?: unknown;
  updatedAt?: unknown;
  supporting_memory_ids?: unknown;
  [key: string]: unknown;
};

export type CanonicalProjectStateMerge = {
  targetId: string;
  content: Record<string, unknown>;
};

function uniqueStrings(...values: Array<string[] | undefined>): string[] {
  return [...new Set(values.flatMap((value) => value ?? []))];
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const rendered =
    typeof value === "string"
      ? value
      : value !== null &&
          typeof value === "object" &&
          "toString" in value
        ? String(value)
        : "";
  const parsed = Date.parse(rendered);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function earlier(a: string, b: string): string {
  return timestamp(a) <= timestamp(b) ? a : b;
}

function later(a: string, b: string): string {
  return timestamp(a) >= timestamp(b) ? a : b;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function canonicalEntityKey(row: EntityMergeRow): string {
  return JSON.stringify([
    row.nameNorm,
    row.kind ?? null,
    row.scope ?? null,
    row.sessionId ?? null,
  ]);
}

export function canonicalProjectStateKey(row: ProjectStateRow): string {
  return JSON.stringify([row.project_key ?? null, row.path ?? null]);
}

export function buildTenantUpdateStatements(
  input: TenantUpdateInput,
): TenantUpdateStatement[] {
  const vars = { fromUserId: input.from, toUserId: input.to };
  return [
    {
      label: "semiote",
      sql: "UPDATE semiote SET user_id = $toUserId, payload.userId = $toUserId WHERE user_id = $fromUserId OR payload.userId = $fromUserId;",
      vars,
    },
    {
      label: "noema",
      sql: "UPDATE noema SET user_id = $toUserId WHERE user_id = $fromUserId;",
      vars,
    },
    {
      label: "entities",
      sql: "UPDATE entities SET userId = $toUserId WHERE userId = $fromUserId;",
      vars,
    },
    {
      label: "project_state",
      sql: "UPDATE project_state SET user_id = $toUserId WHERE user_id = $fromUserId;",
      vars,
    },
  ];
}

export function mergeEntityForCanonicalTenant(
  source: EntityMergeRow,
  target: EntityMergeRow,
): EntityMergeRow {
  return {
    canonicalName: target.canonicalName,
    nameNorm: target.nameNorm,
    aliases: uniqueStrings(target.aliases, source.aliases),
    aliasesNorm: uniqueStrings(target.aliasesNorm, source.aliasesNorm),
    confidence: Math.max(source.confidence, target.confidence),
    firstSeenAt: earlier(source.firstSeenAt, target.firstSeenAt),
    lastSeenAt: later(source.lastSeenAt, target.lastSeenAt),
    description: target.description || source.description,
  };
}

export function mergeProjectStateForCanonicalTenant(
  source: ProjectStateRow,
  target: ProjectStateRow,
  canonicalUserId: string,
): CanonicalProjectStateMerge {
  const sourceUpdatedAt = source.updated_at ?? source.updatedAt;
  const targetUpdatedAt = target.updated_at ?? target.updatedAt;
  const selected =
    timestamp(sourceUpdatedAt) > timestamp(targetUpdatedAt) ? source : target;
  const { id: _selectedId, ...selectedContent } = selected;

  return {
    targetId: String(target.id),
    content: {
      ...selectedContent,
      user_id: canonicalUserId,
      supporting_memory_ids: uniqueStrings(
        stringArray(source.supporting_memory_ids),
        stringArray(target.supporting_memory_ids),
      ),
    },
  };
}

export async function applyTenantUpdateStatements(
  db: TenantMigrationDb,
  statements: TenantUpdateStatement[],
  options: { apply?: boolean } = {},
): Promise<{ dryRun: boolean; executedStatements: number }> {
  if (options.apply !== true) {
    return { dryRun: true, executedStatements: 0 };
  }
  if (statements.length === 0) {
    return { dryRun: false, executedStatements: 0 };
  }

  await db.queryTransaction(
    statements.map(({ sql }) => sql).join("\n"),
    statements[0]?.vars,
  );
  return { dryRun: false, executedStatements: statements.length };
}
