import { createHash } from "node:crypto";
import { SCORING_CONTRACT_VERSION, type BenchmarkCase } from "./types.js";
import { DEFAULT_CAPTURE_PROMPT } from "../../domain/memory/prompts.js";

export { SCORING_CONTRACT_VERSION };

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|bearer|credential|password|secret|^token$)/i;

/**
 * Produce a deterministic JSON representation: object keys are sorted, array
 * order is preserved, and unsupported/non-finite values are rejected.
 *
 * This is deliberately small and dependency-free because these hashes become
 * compatibility evidence in an offline artifact. It is not a general-purpose
 * serializer for arbitrary JavaScript objects.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, "$"));
}

function canonicalValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    throw new Error(`Cannot canonicalize bigint at ${path}`);
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`Cannot canonicalize unsupported value at ${path}`);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error(`Refusing to canonicalize secret-like field at ${path}.${key}`);
      }
      const entry = record[key];
      // JSON-compatible canonical data omits undefined object properties, like
      // JSON.stringify does, while still rejecting unsupported array values.
      if (entry === undefined) continue;
      out[key] = canonicalValue(entry, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`Cannot canonicalize value at ${path}`);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hash a canonical, key-sorted JSON value. Secret-like object keys are rejected. */
export function canonicalHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFixture(fixture: unknown): unknown {
  const parsed = typeof fixture === "string" ? JSON.parse(fixture) : fixture;
  const root = Array.isArray(parsed) ? { cases: parsed } : parsed;
  if (!isRecord(root) || !Array.isArray(root.cases)) {
    throw new Error("Fixture content must be a case array or an object with a cases array");
  }

  // Case IDs and gold IDs are semantic identities. Their file order is not
  // evidence, so normalize those arrays while preserving message order.
  const cases = root.cases.map((entry) => {
    if (!isRecord(entry)) return entry;
    const copy: Record<string, unknown> = { ...entry };
    const gold = isRecord(entry.gold) ? { ...entry.gold } : entry.gold;
    if (isRecord(gold) && Array.isArray(gold.facts)) {
      gold.facts = gold.facts.map((fact) => {
        if (!isRecord(fact) || !Array.isArray(fact.mustContain)) return fact;
        return { ...fact, mustContain: [...fact.mustContain].sort() };
      }).sort((a, b) => {
        const aid = isRecord(a) && typeof a.id === "string" ? a.id : "";
        const bid = isRecord(b) && typeof b.id === "string" ? b.id : "";
        return aid.localeCompare(bid);
      });
      copy.gold = gold;
    }
    return copy;
  });
  cases.sort((a, b) => {
    const aid = isRecord(a) && typeof a.id === "string" ? a.id : "";
    const bid = isRecord(b) && typeof b.id === "string" ? b.id : "";
    return aid.localeCompare(bid);
  });
  return { ...root, cases };
}

/** Hash normalized fixture content without including its filesystem path. */
export function fixtureContentHashFor(fixture: BenchmarkCase[] | string | unknown): string {
  return canonicalHash(normalizeFixture(fixture));
}

/** Hash the production template before replacing `{SESSION_TIMESTAMP}`. */
export function promptTemplateHashFor(template = DEFAULT_CAPTURE_PROMPT): string {
  return sha256Text(template);
}
