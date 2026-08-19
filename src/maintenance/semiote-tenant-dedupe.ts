import type { TenantMigrationDb } from "./canonical-tenant-migration.js";

export type SemioteIdentityRow = {
  id: unknown;
  user_id: string;
  factKey?: string;
  textNorm?: string;
  updatedAt?: unknown;
};

export type SemioteDedupeGroup = {
  factKey: string;
  winnerId: string;
  loserIds: string[];
};

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function bareRecordId(value: unknown): string {
  if (typeof value === "object" && value !== null && "id" in value) {
    return String(value.id);
  }
  return String(value)
    .replace(/^[^:]+:/, "")
    .replace(/^⟨(.*)⟩$/, "$1");
}

export function findSemioteDuplicateIds(
  rows: SemioteIdentityRow[],
  field: "factKey" | "textNorm",
  from: string,
  to: string,
): string[] {
  const canonical = new Set(
    rows
      .filter((row) => row.user_id === to && row[field])
      .map((row) => row[field]),
  );
  return rows
    .filter(
      (row) =>
        row.user_id === from &&
        row[field] !== undefined &&
        canonical.has(row[field]),
    )
    .map((row) => bareRecordId(row.id))
    .sort();
}

export function buildSemioteDedupeGroups(
  rows: SemioteIdentityRow[],
  from: string,
  to: string,
): SemioteDedupeGroup[] {
  const byFactKey = new Map<string, SemioteIdentityRow[]>();
  for (const row of rows) {
    if (!row.factKey) continue;
    const group = byFactKey.get(row.factKey) ?? [];
    group.push(row);
    byFactKey.set(row.factKey, group);
  }

  const groups: SemioteDedupeGroup[] = [];
  for (const [factKey, group] of byFactKey) {
    if (
      !group.some((row) => row.user_id === from) ||
      !group.some((row) => row.user_id === to)
    ) {
      continue;
    }
    const sorted = [...group].sort(
      (left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt),
    );
    const winner = sorted[0];
    if (!winner) continue;
    groups.push({
      factKey,
      winnerId: bareRecordId(winner.id),
      loserIds: sorted.slice(1).map((row) => bareRecordId(row.id)).sort(),
    });
  }
  return groups.sort((left, right) => left.factKey.localeCompare(right.factKey));
}

export async function applySemioteDedupeGroups(
  db: TenantMigrationDb,
  groups: SemioteDedupeGroup[],
): Promise<number> {
  if (groups.length === 0) return 0;
  const statements: string[] = [];
  const vars: Record<string, unknown> = {
    now: new Date().toISOString(),
    reason: "canonical_tenant_migration_fact_key_collision",
  };

  groups.forEach((group, groupIndex) => {
    const winnerKey = `winner${groupIndex}`;
    vars[winnerKey] = group.winnerId;
    group.loserIds.forEach((loserId, loserIndex) => {
      const loserKey = `loser${groupIndex}_${loserIndex}`;
      vars[loserKey] = loserId;
      statements.push(
        `UPDATE type::record('semiote', $${loserKey}) SET
          active = false, inactive_at = <datetime>$now,
          inactive_reason = $reason, superseded_by = $${winnerKey},
          payload.active = false, payload.inactiveAt = $now,
          payload.inactiveReason = $reason,
          payload.supersededById = $${winnerKey}, payload.updatedAt = $now,
          updated_at = <datetime>$now;`,
      );
    });
    statements.push(
      `UPDATE type::record('semiote', $${winnerKey}) SET
        active = true, inactive_at = NONE, inactive_reason = NONE,
        payload.active = true, payload.inactiveAt = NONE,
        payload.inactiveReason = NONE, payload.updatedAt = $now,
        updated_at = <datetime>$now;`,
    );
  });

  await db.queryTransaction(statements.join("\n"), vars);
  return statements.length;
}
