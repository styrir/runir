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

  it.each([
    ["http://127.0.0.1/path", "http://[IP_1]/path"],
    ["http://127.0.0.1:7700/path", "http://[IP_1]:7700/path"],
    ["https://[2001:db8::1]/path", "https://[[IP_1]]/path"],
    ["https://[2001:db8::1]:7700/path", "https://[[IP_1]]:7700/path"],
  ])("keeps IP URL redaction a fixed point: %s", (raw, expected) => {
    const redacted = redactSourceTurn(raw);
    expect(redacted).toBe(expected);
    expect(redactSourceTurn(redacted)).toBe(redacted);
  });

  it.each(["[IP_1]", "[[IP_12]]"])("sanitizes marker-host URLs: %s", (host) => {
    for (const port of ["", ":7700", ":0", ":65535"]) {
      const clean = `https://${host}${port}/path`;
      expect(redactSourceTurn(`${clean}?private=synthetic#private`)).toBe(clean);
      expect(redactSourceTurn(clean)).toBe(clean);
    }
    for (const secret of ["sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA", "password=hunter2long", "token=AAAAAAAAAAAAAAAAAAAA"]) {
      expect(redactSourceTurn(`https://${host}/${secret}`)).toBe("[URL_1]");
    }
    for (const pii of ["person@example.test", "555-123-4567", "123-45-6789", "192.0.2.10", "2001:db8::1"]) {
      const redacted = redactSourceTurn(`https://${host}/${pii}`);
      expect(redacted).toContain(`https://${host}/`);
      expect(redacted).not.toContain(pii);
    }
  });

  it.each([
    "http://user:synthetic@[IP_1]/path",
    "http://user@[IP_1]/path",
    "http://@[IP_1]/path",
    "http://[IP_1].example.test/path",
    "http://[[IP_1]].example.test/path",
    "http://[IP_1]:65536/path",
    "http://[IP_1]:-1/path",
    "http://[IP_1]:1.5/path",
    "http://[IP_1]:+80/path",
    "http://[IP_1]:/path",
    "http://[IP_1]:7700.evil/path",
    "http://[[IP_1]/path",
    "http://[IP_1]]/path",
    "http://[IP_x]/path",
    "http://[ip_1]/path",
    "http://[IP_1]\\evil/path",
  ])("fails closed for invalid marker authorities: %s", (value) => {
    expect(redactSourceTurn(value)).toBe("[URL_1]");
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
