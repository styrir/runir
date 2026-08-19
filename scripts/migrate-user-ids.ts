export type MigrationDb = {
  query<T = unknown>(
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<T[][]>;
};

type UserCount = {
  userId: string;
  count: number;
};

type InventoryTable = {
  table: string;
  counts: UserCount[];
};

export type UserIdInventory = {
  capturedAt: string;
  tables: InventoryTable[];
};

type TableOperation = {
  table: string;
  mode: "migrate" | "purge";
  from: string;
  to?: string;
  expectedCount: number;
  sql: string;
  vars: Record<string, unknown>;
};

type MigrationOperation = {
  kind: "migrate" | "purge";
  from: string;
  to?: string;
  expectedTotal: number;
  tableOperations: TableOperation[];
};

export type UserIdMigrationPlan = {
  inventory: UserIdInventory;
  warnings: string[];
  operations: MigrationOperation[];
};

type MigrationPlanOptions = {
  mappings: Array<{ from: string; to: string }>;
  purge: string[];
};

const TABLES = [
  { table: "memories", field: "payload.userId" },
  { table: "project_state", field: "user_id" },
  { table: "session_watermarks", field: "user_id" },
  { table: "rejection_log", field: "user_id" },
  { table: "consolidation_state", field: "user_id" },
  { table: "consolidation_log", field: "user_id" },
  { table: "staleness_backlog", field: "user_id" },
  { table: "entities", field: "userId" },
] as const;

function countFor(table: InventoryTable, userId: string): number {
  return table.counts.find((entry) => entry.userId === userId)?.count ?? 0;
}

function migrationSql(table: string, field: string): string {
  if (table === "memories") {
    return "UPDATE memories SET payload.userId = $toUserId, user_id = $toUserId WHERE payload.userId = $fromUserId;";
  }
  return `UPDATE ${table} SET ${field} = $toUserId WHERE ${field} = $fromUserId;`;
}

export async function collectUserIdInventory(
  db: MigrationDb,
): Promise<UserIdInventory> {
  const tables: InventoryTable[] = [];
  for (const spec of TABLES) {
    const result = await db.query<UserCount>(
      `SELECT ${spec.field} AS userId, count() AS count FROM ${spec.table} GROUP BY ${spec.field};`,
    );
    tables.push({ table: spec.table, counts: result[0] ?? [] });
  }
  return { capturedAt: new Date().toISOString(), tables };
}

export function buildUserIdMigrationPlan(
  inventory: UserIdInventory,
  options: MigrationPlanOptions,
): UserIdMigrationPlan {
  const warnings: string[] = [];
  const operations: MigrationOperation[] = [];

  for (const mapping of options.mappings) {
    const tableOperations = TABLES.flatMap((spec): TableOperation[] => {
      const table = inventory.tables.find((entry) => entry.table === spec.table);
      const expectedCount = table ? countFor(table, mapping.from) : 0;
      if (table && countFor(table, mapping.to) > 0) {
        warnings.push(
          `Target userId ${mapping.to} already exists in ${spec.table}`,
        );
      }
      return expectedCount === 0
        ? []
        : [{
            table: spec.table,
            mode: "migrate",
            from: mapping.from,
            to: mapping.to,
            expectedCount,
            sql: migrationSql(spec.table, spec.field),
            vars: {
              fromUserId: mapping.from,
              toUserId: mapping.to,
            },
          }];
    });
    operations.push({
      kind: "migrate",
      from: mapping.from,
      to: mapping.to,
      expectedTotal: tableOperations.reduce(
        (total, operation) => total + operation.expectedCount,
        0,
      ),
      tableOperations,
    });
  }

  for (const userId of options.purge) {
    const tableOperations = TABLES.flatMap((spec): TableOperation[] => {
      const table = inventory.tables.find((entry) => entry.table === spec.table);
      const expectedCount = table ? countFor(table, userId) : 0;
      return expectedCount === 0
        ? []
        : [{
            table: spec.table,
            mode: "purge",
            from: userId,
            expectedCount,
            sql: `DELETE FROM ${spec.table} WHERE ${spec.field} = $fromUserId;`,
            vars: { fromUserId: userId },
          }];
    });
    operations.push({
      kind: "purge",
      from: userId,
      expectedTotal: tableOperations.reduce(
        (total, operation) => total + operation.expectedCount,
        0,
      ),
      tableOperations,
    });
  }

  return { inventory, warnings, operations };
}

export async function applyUserIdMigrationPlan(
  db: MigrationDb,
  plan: UserIdMigrationPlan,
  options: { apply?: boolean } = {},
): Promise<{ dryRun: boolean; executedStatements: number }> {
  if (options.apply !== true) {
    return { dryRun: true, executedStatements: 0 };
  }

  let executedStatements = 0;
  for (const operation of plan.operations) {
    for (const tableOperation of operation.tableOperations) {
      await db.query(tableOperation.sql, tableOperation.vars);
      executedStatements += 1;
    }
  }
  return { dryRun: false, executedStatements };
}
