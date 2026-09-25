import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectField, inventory, scrubFieldValue, verifyInventory, type Inventory } from "../../scripts/source-layer/privacy-inventory.js";
import { applyScrub, validateApplyOptions, validateBackup } from "../../scripts/source-layer/scrub.js";
import { ownedVaultFiles } from "../../scripts/source-layer/vault-ownership.js";

const secret = "Bearer AAAAAAAAAAAAAAAAAAAAAAAA";
const base = { identity: { namespace: "throwaway", database: "scratch" }, inventoryHash: "a".repeat(64),
  inventoryCreatedAt: new Date().toISOString(), backupPath: "/tmp/synthetic-backup",
  checkpointPath: "/tmp/synthetic-checkpoint", hmacKey: "synthetic-key", confirmed: true };

describe("Slice 3 count-only policy", () => {
  it("owns only exporter-written 99 Meta names and folder shapes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "runir277-meta-vault-"));
    const owned = [
      "99 Meta/export-manifest.json", "99 Meta/legacy-memories-snapshot.json",
      "99 Meta/00 Inbox/cases/items.json", "99 Meta/01 Projects/my-project/items.json",
      "99 Meta/02 Areas/profile/items.json", "99 Meta/03 Resources/patterns/items.json",
      "99 Meta/04 Archives/superseded/items.json",
    ];
    const personal = [
      "99 Meta/02 Areas/items.json", "99 Meta/02 Areas/personal/items.json",
      "99 Meta/02 Areas/profile/deep/items.json", "99 Meta/00 Inbox/personal/items.json",
      "99 Meta/01 Projects/Not A Slug/items.json", "99 Meta/05 Daily Notes/day/items.json",
      "99 Meta/06 Entities/person/items.json", "99 Meta/07 Continuity/project/items.json",
      "99 Meta/08 Maps/map/items.json", "99 Meta/personal.json",
    ];
    try {
      for (const path of [...owned, ...personal]) {
        const file = join(vault, path);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, secret);
      }
      const result = await ownedVaultFiles({ query: async () => [[]] }, vault);
      expect(result.files).toEqual(owned.map((path) => join(vault, path)).sort());
      expect(result.ownerFilesSkipped).toBe(personal.length);
    } finally { await rm(vault, { recursive: true, force: true }); }
  });

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

  it("counts only owner files and refuses empty owned vaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runir277-owner-vault-"));
    const vault = join(dir, "vault");
    const backupPath = join(dir, "backup.surql");
    const vaultBackupPath = join(dir, "vault.tar");
    try {
      await mkdir(join(vault, "02 Areas"), { recursive: true });
      await writeFile(join(vault, "02 Areas", "personal.md"), secret);
      await writeFile(join(vault, "02 Areas", "forged.md"), `---\nid: missing\ncategory: profile\ntier: durable\ntags: []\nconfidence: 1\nscope: user\ncreatedAt: now\nupdatedAt: now\nactive: true\nwriteSource: capture\n---\n${secret}`);
      await writeFile(backupPath, "synthetic", { mode: 0o600 });
      await writeFile(vaultBackupPath, "synthetic", { mode: 0o600 });
      const db = { query: async () => [[]], queryTransaction: async () => undefined };
      const result = await inventory(db, base.identity, vault);
      expect(result.rows).toMatchObject({ vault_files: 0, owner_files_skipped: 2 });
      expect(result.fields["vault.file"].wouldChange).toBe(0);
      expect(verifyInventory(result)).toBe(true);
      await expect(applyScrub(db, { ...base, inventoryHash: result.hash, backupPath, vaultBackupPath,
        vaultRoot: vault, checkpointPath: join(dir, "checkpoint.json") })).rejects.toThrow("no Rúnir-owned files");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("counts each affected derived field once per row", async () => {
    const row = { id: "semiote:one", payload: { l2: secret, raw_source_text: secret },
      text_norm: secret, embedding: [0.5] };
    const db = { query: async (sql: string, vars?: { cursor?: string }) =>
      sql.includes("FROM semiote") && sql.includes("$cursor") && !vars?.cursor ? [[row]] : [[]] };
    const result = await inventory(db, base.identity, undefined, async () => [0.1]);
    expect(result.fields["semiote.text_norm"]).toMatchObject({ present: 1, wouldChange: 1 });
    expect(result.fields["semiote.embedding"]).toMatchObject({ present: 1, wouldChange: 1 });
    expect(Object.values(result.fields).every(({ present, wouldChange }) => wouldChange <= present)).toBe(true);
  });

  it("counts derived changes inside legacy JSON payloads only when fact text changes", async () => {
    const rows = [
      { id: "memories:one", payload: JSON.stringify({ l2: "clean fact", raw_source_text: secret }), text_norm: "kept", embedding: [0.7] },
      { id: "memories:two", payload: JSON.stringify({ l2: `fact\nSource:\n${secret}` }), text_norm: "old", embedding: [0.8] },
    ];
    const db = { query: async (sql: string, vars?: { cursor?: string }) =>
      sql.includes("FROM memories") && sql.includes("$cursor") && !vars?.cursor ? [rows] : [[]] };
    const result = await inventory(db, base.identity);
    expect(result.fields["memories.payload.raw_source_text"].present).toBe(1);
    expect(result.fields["memories.text_norm"].wouldChange).toBe(1);
    expect(result.fields["memories.embedding"].wouldChange).toBe(1);
  });

  it("walks a synthetic 10k-file vault within the CI bound", async () => {
    const vault = await mkdtemp(join(tmpdir(), "runir277-perf-vault-"));
    try {
      await mkdir(join(vault, ".obsidian"));
      await writeFile(join(vault, ".obsidian", "hidden.md"), secret);
      await symlink(join(vault, ".obsidian"), join(vault, "linked"));
      await mkdir(join(vault, "99 Meta"));
      await writeFile(join(vault, "99 Meta", "export-manifest.json"), "{}");
      const total = 10_000;
      let next = 0;
      await Promise.all(Array.from({ length: 32 }, async () => {
        while (next < total) await writeFile(join(vault, `personal-${next++}.md`), "personal note");
      }));
      const started = performance.now();
      const result = await ownedVaultFiles({ query: async () => [[]] }, vault);
      const elapsedMs = performance.now() - started;
      console.info(`synthetic 10k vault walk: ${Math.round(elapsedMs)} ms`);
      expect(result.files).toEqual([join(vault, "99 Meta", "export-manifest.json")]);
      expect(result.ownerFilesSkipped).toBe(total);
      expect(elapsedMs).toBeLessThan(120_000);
    } finally { await rm(vault, { recursive: true, force: true }); }
  }, 150_000);

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
