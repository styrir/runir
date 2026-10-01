import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyMinniGetEventsResponse,
  serializeMinniSummaryContract,
  type SummaryBuildResult,
} from "../src/domain/memory/minni-summary-contract.js";
import { buildMinniSummaryContract } from "../src/domain/memory/minni-summary-builder.js";

type GoldenCase = Readonly<{
  id: string;
  classification: "synthetic";
  producer_response: Readonly<{
    items: readonly Record<string, unknown>[];
    localOnlyWithheld: number;
  }>;
  builder_input: Readonly<{
    summary: string;
    lineages: readonly Record<string, unknown>[];
    claims: readonly Record<string, unknown>[];
    conclusion?: "bounded" | "abstained";
  }>;
  expected: SummaryBuildResult;
  forbidden_fields: readonly string[];
  forbidden_states: readonly string[];
  forbidden_values?: readonly string[];
}>;

type GoldenFixture = Readonly<{
  schema_version: 1;
  artifact_kind: "synthetic-minni-summary-hand-labeled-goldens";
  contract_version: "runir.minni.summary/v1";
  source_candidate_ids: readonly string[];
  oracle_policy: Readonly<{
    classification: "synthetic";
    labels: "hand-labeled structured claims and expected refusal/contracts";
    meaning_inference: "none";
    model_or_provider: "none";
    expected_is_regenerated: false;
  }>;
  cases: readonly GoldenCase[];
}>;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/minni-summary-contract/v1.json", import.meta.url), "utf8"),
) as GoldenFixture;

function containsOwnKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsOwnKey(item, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([entryKey, entryValue]) =>
    entryKey === key || containsOwnKey(entryValue, key));
}

function claimStates(result: SummaryBuildResult): readonly string[] {
  return result.ok ? result.contract.claims.map((claim) => claim.state) : [];
}

describe("Minni summary B hand-labeled goldens", () => {
  it("loads exactly the accepted synthetic case set with static, non-regenerated oracles", () => {
    expect(fixture.schema_version).toBe(1);
    expect(fixture.artifact_kind).toBe("synthetic-minni-summary-hand-labeled-goldens");
    expect(fixture.contract_version).toBe("runir.minni.summary/v1");
    expect(fixture.oracle_policy).toEqual({
      classification: "synthetic",
      labels: "hand-labeled structured claims and expected refusal/contracts",
      meaning_inference: "none",
      model_or_provider: "none",
      expected_is_regenerated: false,
    });
    expect(fixture.cases).toHaveLength(15);
    expect(fixture.source_candidate_ids).toEqual(fixture.cases.map((item) => item.id));
    expect(new Set(fixture.cases.map((item) => item.id)).size).toBe(15);
    expect(fixture.cases.every((item) => item.classification === "synthetic")).toBe(true);
  });

  it("pins the accepted clipped-linkage and code-layout literals independently", () => {
    const clipped = fixture.cases.find((item) => item.id === "clipped_command");
    expect(clipped?.builder_input.claims[0]).toMatchObject({ scope_linkage_unknown: true });
    expect(clipped?.expected).toMatchObject({
      ok: true,
      contract: {
        evidence: [{
          uncertainties: ["ocr_source", "source_clip_unknown", "source_completeness_unknown"],
        }],
        claims: [{
          uncertainties: [
            "ocr_source",
            "source_clip_unknown",
            "source_completeness_unknown",
            "scope_linkage_unknown",
          ],
        }],
      },
    });

    const code = fixture.cases.find((item) => item.id === "code_layout");
    const acceptedCode = "if ready:\n    run()\nelse:\n    stop()";
    expect(code?.producer_response.items[0]?.text).toBe(acceptedCode);
    expect(code?.builder_input.summary).toBe(acceptedCode);
    expect(code?.builder_input.claims[0]?.statement).toBe(acceptedCode);
    expect(code?.expected).toMatchObject({
      ok: true,
      contract: {
        summary: acceptedCode,
        claims: [{ statement: acceptedCode }],
      },
    });
    expect(code?.forbidden_values).toContain("if ready: run() else: stop()");
  });

  for (const golden of fixture.cases) {
    it(`exactly maps ${golden.id} through A1, A2, and serialization`, () => {
      const classified = classifyMinniGetEventsResponse(golden.producer_response);
      const built = buildMinniSummaryContract({
        ...golden.builder_input,
        evidence: classified,
      });

      expect(built).toEqual(golden.expected);

      if (built.ok) {
        const serialized = serializeMinniSummaryContract(built.contract);
        expect(serialized).toEqual(golden.expected.contract);
        expect(JSON.parse(JSON.stringify(serialized))).toEqual(golden.expected.contract);
      }

      for (const forbiddenField of golden.forbidden_fields) {
        expect(containsOwnKey(built, forbiddenField)).toBe(false);
      }
      for (const forbiddenState of golden.forbidden_states) {
        expect(claimStates(built)).not.toContain(forbiddenState);
      }
      for (const forbiddenValue of golden.forbidden_values ?? []) {
        expect(JSON.stringify(built)).not.toContain(forbiddenValue);
      }
    });
  }
});
