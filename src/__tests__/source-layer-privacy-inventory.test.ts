import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectField, scrubFieldValue, verifyInventory, type Inventory } from "../../scripts/source-layer/privacy-inventory.js";
import { applyScrub, validateApplyOptions, validateBackup } from "../../scripts/source-layer/scrub.js";

const secret = "Bearer AAAAAAAAAAAAAAAAAAAAAAAA";
const base = { identity: { namespace: "throwaway", database: "scratch" }, inventoryHash: "a".repeat(64),
  inventoryCreatedAt: new Date().toISOString(), backupPath: "/tmp/synthetic-backup",
  checkpointPath: "/tmp/synthetic-checkpoint", hmacKey: "synthetic-key", confirmed: true };

describe("Slice 3 count-only policy", () => {
  it("counts fact secrets while retaining fact email and redacted spans", () => {
    const fact = `alice@example.com ${secret}`;
    const count = inspectField("semiote", "payload.rawSpan", { text: fact });
    expect(count).toMatchObject({ present: 1, withText: 1, wouldChange: 1, assertionFailures: 0 });
    expect(count.byKind.BEARER_TOKEN).toBe(1);
    const after = scrubFieldValue("semiote", "payload.rawSpan", { text: fact }) as { text: string };
    expect(after.text).toContain("alice@example.com");
    expect(after.text).not.toContain(secret);
  });

  it("removes payload source and trace text while retaining receipt binding", () => {
    expect(inspectField("semiote", "payload.raw_source_text", "ordinary source").wouldChange).toBe(1);
    expect(scrubFieldValue("semiote", "payload.raw_source_text", "ordinary source")).toBeUndefined();
    expect(scrubFieldValue("retrieval_trace", "capture_receipt", {
      retrievalTraceId: "trace", sessionId: "session", memoryIds: ["memory"],
      prompt: `prompt ${secret}`, answer: "answer", unknown: "private",
    })).toEqual({ retrievalTraceId: "trace", sessionId: "session", memoryIds: ["memory"] });
    expect(inspectField("retrieval_trace", "capture_receipt", { prompt: "ordinary" }).wouldChange).toBe(1);
  });

  it("redacts source PII but keeps ordinary fact PII", () => {
    expect(scrubFieldValue("session_turn_chunk", "content", "alice@example.com")).not.toContain("alice@example.com");
    expect(scrubFieldValue("semiote", "payload.l2", "alice@example.com")).toBe("alice@example.com");
  });

  it("requires confirmation, fresh inventory, backup path and HMAC key", () => {
    expect(() => validateApplyOptions({ ...base, confirmed: false })).toThrow();
    expect(() => validateApplyOptions({ ...base, backupPath: "" })).toThrow();
    expect(() => validateApplyOptions({ ...base, hmacKey: "" })).toThrow();
    expect(() => validateApplyOptions({ ...base, vaultRoot: "/tmp/synthetic-vault" })).toThrow("vault backup required");
    expect(() => validateApplyOptions({ ...base, inventoryCreatedAt: "2000-01-01T00:00:00Z" })).toThrow();
    expect(() => validateApplyOptions(base)).not.toThrow();
  });

  it("refuses a nonexistent backup before querying the database", async () => {
    let queried = false;
    await expect(applyScrub({ query: async () => { queried = true; return []; }, queryTransaction: async () => {} },
      { ...base, backupPath: "/tmp/runir277-synthetic-missing-backup-never-create" })).rejects.toThrow();
    expect(queried).toBe(false);
  });

  it("verify catches planted legacy fields", () => {
    const result = { version: 1, namespace: "throwaway", database: "scratch", rows: {}, hash: "a",
      fields: { "semiote.payload.raw_source_text": { present: 1, withText: 1, wouldChange: 1, assertionFailures: 0, byKind: {} } } } satisfies Inventory;
    expect(verifyInventory(result)).toBe(false);
    for (const field of ["noema.canonical.text", "noema.canonical.l0", "noema.canonical.l1", "noema.canonical.factKey",
      "noema.canonical.stableClaim.subject", "noema.canonical.stableClaim.predicate", "noema.canonical.stableClaim.value",
      "noema.stable_claim.subject", "noema.stable_claim.predicate", "noema.stable_claim.value", "noema.fact_key", "noema.fact_key_seed",
      "semiote.text_norm", "noema.canonical_norm", "noema.embedding"]) {
      const inspected = field.endsWith("embedding") ? { present: 1, withText: 0, wouldChange: 1, assertionFailures: 0, byKind: {} }
        : inspectField(field.startsWith("noema") ? "noema" : "semiote", field.split(".").slice(1).join("."), secret);
      expect(verifyInventory({ ...result, fields: { [field]: inspected } })).toBe(false);
    }
  });

  it("refuses absent, public, and repository-local backup files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runir277-backups-"));
    const privateFile = join(dir, "private.surql");
    const publicFile = join(dir, "public.surql");
    const repoFile = join(process.cwd(), ".styrir", `backup-refusal-${dir.split("/").at(-1)}.surql`);
    const repoRootFile = join(process.cwd(), `backup-refusal-${dir.split("/").at(-1)}.surql`);
    try {
      await writeFile(privateFile, "synthetic", { mode: 0o600 });
      await writeFile(publicFile, "synthetic", { mode: 0o644 });
      await writeFile(repoFile, "synthetic", { mode: 0o600 });
      await writeFile(repoRootFile, "synthetic", { mode: 0o600 });
      expect(await validateBackup(privateFile)).toBeUndefined();
      await expect(validateBackup(join(dir, "missing.surql"))).rejects.toThrow();
      await expect(validateBackup(publicFile)).rejects.toThrow("private file");
      await chmod(publicFile, 0o640);
      await expect(validateBackup(publicFile)).rejects.toThrow("private file");
      await expect(validateBackup(repoFile)).rejects.toThrow("outside repository");
      await expect(validateBackup(repoRootFile)).rejects.toThrow("outside repository");
    } finally { await rm(dir, { recursive: true, force: true }); await rm(repoFile, { force: true }); await rm(repoRootFile, { force: true }); }
  });
});
