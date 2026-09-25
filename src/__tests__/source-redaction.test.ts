import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VaultWriter } from "../lifecycle/archive/vault-exporter.js";
import {
  assertNoSecrets,
  redactFact,
  redactFactText,
  redactSourceTurn,
  RedactionAssertionError,
  SOURCE_REDACTION_VERSION,
} from "../shared/source-redaction.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/source-redaction/canaries.json", import.meta.url), "utf8")) as {
  secrets: string[]; sourcePii: string[]; safe: string[]; pairedEmail: string;
};

describe("source redaction v1", () => {
  it("removes each synthetic secret kind from fact and source text", () => {
    expect(SOURCE_REDACTION_VERSION).toBe(1);
    for (const secret of fixture.secrets) {
      expect(redactFactText(`Remember ${secret}.`)).not.toContain(secret);
      expect(redactSourceTurn(`Remember ${secret}.`)).not.toContain(secret);
    }
  });

  it("keeps safe code, relative paths, names, and safe URLs", () => {
    for (const safe of fixture.safe) {
      expect(redactFactText(safe)).toBe(safe);
      expect(redactSourceTurn(safe)).toBe(safe);
    }
  });

  it("uses split policy for the same email in a fact and source turn", () => {
    const fact = redactFact({ l2: `Email ${fixture.pairedEmail}`, raw_source_text: `Email ${fixture.pairedEmail}` });
    expect(fact.l2).toContain(fixture.pairedEmail);
    expect(fact).not.toHaveProperty("raw_source_text");
    expect(redactSourceTurn(`Email ${fixture.pairedEmail}`)).not.toContain(fixture.pairedEmail);
    for (const pii of fixture.sourcePii) expect(redactSourceTurn(pii)).not.toContain(pii);
  });

  it("keeps source markers stable within a turn and strips URL query and fragment", () => {
    const source = redactSourceTurn("/Users/alice/a /Users/alice/b /Users/bob/c https://docs.example.test/api/v1?token=synthetic#private");
    expect(source.match(/\[USER_1\]/g)).toHaveLength(2);
    expect(source.match(/\[USER_2\]/g)).toHaveLength(1);
    expect(source).toContain("https://docs.example.test/api/v1");
    expect(source).not.toContain("?token=");
    expect(source).not.toContain("#private");
  });

  it("removes appended source excerpts and rejects secrets on a second pass", () => {
    expect(redactFactText("safe fact\n\nSource:\nraw excerpt")).toBe("safe fact");
    expect(() => assertNoSecrets(fixture.secrets[0])).toThrow(RedactionAssertionError);
    expect(() => assertNoSecrets(redactFactText(fixture.secrets[0]))).not.toThrow();
    expect(() => redactFactText("Authorization: Basic QUFBQUFBQUFBQUFBQUFBQQ=="))
      .toThrow(RedactionAssertionError);
  });

  it("VaultWriter keeps canaries out of file content and relative filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "runir-slice1-"));
    try {
      const writer = new VaultWriter(root);
      const canary = fixture.secrets[5];
      await writer.write(`notes/${canary}.md`, `Fact ${canary}`);
      const [relativePath] = writer.produced;
      expect(relativePath.includes(canary)).toBe(false);
      expect((await readFile(join(root, relativePath), "utf8")).includes(canary)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
