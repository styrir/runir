import type { SurrealClient } from "./surreal-client.js";

export const PROCESSING_LINEAGE_TABLES = [
  "semiote",
  "noema",
  "staleness_backlog",
] as const;

export type ProcessingLineageTable = (typeof PROCESSING_LINEAGE_TABLES)[number];

type ProcessingLineageField = Readonly<{
  name: string;
  type: RegExp;
}>;

const PROCESSING_LINEAGE_FIELDS: readonly ProcessingLineageField[] = [
  { name: "processing_lineage", type: /\btype\s+(?:none\s*\|\s*object\b|option\s*<\s*object\s*>)/i },
  { name: "processing_lineage.state", type: /\btype\s+string\b/i },
  { name: "processing_lineage.origin", type: /\btype\s+string\b/i },
  { name: "processing_lineage.producer_principal_ref", type: /\btype\s+string\b/i },
  { name: "processing_lineage.producer_registration_ref", type: /\btype\s+string\b/i },
  { name: "processing_lineage.processing_policy_version", type: /\btype\s+string\b/i },
  { name: "processing_lineage.admitted_operation", type: /\btype\s+string\b/i },
  { name: "processing_lineage.target_user_id", type: /\btype\s+string\b/i },
  { name: "processing_lineage.delivery", type: /\btype\s+object\b/i },
  { name: "processing_lineage.delivery.version", type: /\btype\s+string\b/i },
  { name: "processing_lineage.delivery.disposition", type: /\btype\s+string\b/i },
  { name: "processing_lineage.delivery.restrictions", type: /\btype\s+array\s*<\s*string\s*>/i },
  { name: "processing_lineage.delivery.restrictions.*", type: /\btype\s+string\b/i },
] as const;

const EXPECTED_FIELD_NAMES = new Set(PROCESSING_LINEAGE_FIELDS.map((field) => field.name));

export type ProcessingLineageSchemaAssessment = Readonly<
  | { kind: "absent" }
  | { kind: "compatible" }
  | { kind: "partial"; missing: readonly string[] }
  | { kind: "incompatible"; fields: readonly string[] }
  | { kind: "extra"; fields: readonly string[] }
>;

export type ProcessingLineageSchemaEnsureResult = Readonly<{
  table: ProcessingLineageTable;
  created: boolean;
  /** False only for a test double that returned no INFO metadata. */
  verified: boolean;
}>;

export class ProcessingLineageSchemaError extends Error {
  readonly table: ProcessingLineageTable;
  readonly assessment: Exclude<ProcessingLineageSchemaAssessment, { kind: "absent" } | { kind: "compatible" }>;

  constructor(
    table: ProcessingLineageTable,
    assessment: Exclude<ProcessingLineageSchemaAssessment, { kind: "absent" } | { kind: "compatible" }>,
  ) {
    super(`processing lineage schema refused for ${table}: ${assessment.kind}`);
    this.name = "ProcessingLineageSchemaError";
    this.table = table;
    this.assessment = assessment;
  }
}

function isProcessingLineageTable(value: string): value is ProcessingLineageTable {
  return (PROCESSING_LINEAGE_TABLES as readonly string[]).includes(value);
}

function normalizeInfoFields(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = (value as { fields?: unknown }).fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return {};
  return Object.fromEntries(
    Object.entries(fields as Record<string, unknown>)
      .filter(([name, definition]) => typeof name === "string" && typeof definition === "string")
      .map(([name, definition]) => [name, String(definition).toLowerCase()] as const),
  );
}

function infoObject(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const first = raw[0];
  if (Array.isArray(first)) return first[0] ?? undefined;
  return first;
}

function hasInfoMetadata(raw: unknown): boolean {
  const value = infoObject(raw);
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check the exact definitions returned by `INFO FOR TABLE`.  SurrealDB emits
 * an array-element wildcard definition for `array<string>`; it is part of the
 * required hierarchy and is checked explicitly.
 */
export function assessProcessingLineageSchema(
  info: unknown,
): ProcessingLineageSchemaAssessment {
  const fields = normalizeInfoFields(infoObject(info));
  const lineageFields = Object.keys(fields).filter(
    (name) => name === "processing_lineage" || name.startsWith("processing_lineage."),
  );
  if (lineageFields.length === 0) return { kind: "absent" };

  const extra = lineageFields.filter((name) => !EXPECTED_FIELD_NAMES.has(name));
  if (extra.length > 0) return { kind: "extra", fields: extra.sort() };

  const incompatible = PROCESSING_LINEAGE_FIELDS.filter((field) => {
    const definition = fields[field.name];
    return definition !== undefined && !field.type.test(definition);
  }).map((field) => field.name);
  if (incompatible.length > 0) return { kind: "incompatible", fields: incompatible };

  const missing = PROCESSING_LINEAGE_FIELDS
    .filter((field) => fields[field.name] === undefined)
    .map((field) => field.name);
  if (missing.length > 0) return { kind: "partial", missing };
  return { kind: "compatible" };
}

export function processingLineageSchemaStatements(
  table: ProcessingLineageTable,
): readonly string[] {
  if (!isProcessingLineageTable(table)) throw new TypeError("processing lineage table is unsupported");
  return PROCESSING_LINEAGE_FIELDS.map(
    (field) => `DEFINE FIELD IF NOT EXISTS ${field.name} ON TABLE ${table} TYPE ${field.name === "processing_lineage" ? "option<object>" : field.name.endsWith("restrictions") ? "array<string>" : field.name.endsWith("restrictions.*") ? "string" : field.name === "processing_lineage.delivery" ? "object" : "string"};`,
  );
}

/**
 * Ensure the optional lineage hierarchy without silently accepting an old
 * incompatible definition.  The caller must create the table first.
 */
export async function ensureProcessingLineageSchema(
  db: SurrealClient,
  table: ProcessingLineageTable,
): Promise<ProcessingLineageSchemaEnsureResult> {
  const beforeRaw = await db.query("INFO FOR TABLE " + table + ";");
  const before = assessProcessingLineageSchema(beforeRaw);
  if (before.kind === "partial" || before.kind === "incompatible" || before.kind === "extra") {
    throw new ProcessingLineageSchemaError(table, before);
  }
  if (before.kind === "compatible") return { table, created: false, verified: true };

  await db.query(processingLineageSchemaStatements(table).join("\n"));
  // The repository's unit doubles return `[[]]` for every query and cannot
  // model INFO metadata. A real SurrealClient response for an existing table
  // is an object; retain the explicit unverified bit for that test-only seam.
  if (!hasInfoMetadata(beforeRaw)) return { table, created: true, verified: false };
  const afterRaw = await db.query("INFO FOR TABLE " + table + ";");
  const after = assessProcessingLineageSchema(afterRaw);
  if (after.kind !== "compatible") {
    if (after.kind === "absent") {
      throw new Error(`processing lineage schema was not created for ${table}`);
    }
    throw new ProcessingLineageSchemaError(table, after);
  }
  return { table, created: true, verified: true };
}
