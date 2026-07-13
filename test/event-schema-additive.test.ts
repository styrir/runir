import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const SCHEMA_PATH = join(REPO_ROOT, "schemas/event.schema.json");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures/events");

interface Variant {
  title?: string;
  additionalProperties?: boolean | object;
  required?: string[];
  properties?: { type?: { const?: string } };
}

interface EventSchema {
  oneOf: Variant[];
}

function loadSchema(): EventSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as EventSchema;
}

function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
}

describe("event.schema.json — Schema-CI Gate 10 invariants (Rúnir-yod0.3.14b)", () => {
  it("schema parses and contains the 5 expected variants", () => {
    const schema = loadSchema();
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf.length).toBe(5);
    const titles = schema.oneOf.map((v) => v.title);
    expect(titles.sort()).toEqual([
      "memory_committed",
      "memory_indexed",
      "recall_decision",
      "stage_end",
      "stage_start",
    ]);
  });

  it("new variants enforce additionalProperties:false (additive-only freeze, ADR 0008)", () => {
    const schema = loadSchema();
    for (const variant of schema.oneOf) {
      expect(
        variant.additionalProperties,
        `variant ${variant.title} must declare additionalProperties:false`,
      ).toBe(false);
    }
  });

  it("each variant uses a unique discriminator (type const)", () => {
    const schema = loadSchema();
    const consts = schema.oneOf.map((v) => v.properties?.type?.const);
    expect(new Set(consts).size).toBe(consts.length);
    expect(consts.every((c) => typeof c === "string")).toBe(true);
  });

  it("Gate 10 parity — fixtures count equals oneOf variant count", () => {
    const schema = loadSchema();
    const fixtures = listFixtures();
    expect(fixtures.length).toBe(schema.oneOf.length);
  });

  it("every fixture validates against the schema (ajv)", () => {
    // ajv@6 ships draft-07 by default. The schema declares draft-2020-12 in its $schema
    // metadata field but uses only the (compatible) subset oneOf/required/additionalProperties/
    // properties/const/enum/integer/string. Strip $schema before compile so ajv@6 doesn't try
    // to dereference the draft-2020 meta-schema.
    const { $schema: _drop, ...compilable } = loadSchema() as { $schema?: string } & EventSchema;
    void _drop;
    const ajv = new Ajv({ allErrors: true, schemaId: "$id" });
    const validate = ajv.compile(compilable);
    for (const fixture of listFixtures()) {
      const data = JSON.parse(readFileSync(join(FIXTURES_DIR, fixture), "utf-8"));
      const ok = validate(data);
      expect(ok, `fixture ${fixture} failed schema: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("memory_committed fixture round-trips the OverlayLockKey shape", () => {
    const data = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "memory-committed-001.json"), "utf-8"),
    );
    expect(data.type).toBe("memory_committed");
    expect(data.outcome).toBe("create");
    expect(Object.keys(data.lockKey).sort()).toEqual([
      "continuitySubjectKey",
      "factKey",
    ]);
  });

  it("memory_indexed fixture has no overlap fields beyond memoryId (decoupled-from-committed contract)", () => {
    const data = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "memory-indexed-001.json"), "utf-8"),
    );
    expect(data.type).toBe("memory_indexed");
    expect(Object.keys(data).sort()).toEqual(["indexedAtMs", "memoryId", "type"]);
  });
});
