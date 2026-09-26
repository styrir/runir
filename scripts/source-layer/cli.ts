#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SurrealClient } from "../../src/storage/surreal/surreal-store.js";
import { inventory, verifyInventory, type Inventory } from "./privacy-inventory.js";
import { applyScrub, formatScrubFailure, validateBackup } from "./scrub.js";
import { resolveEmbeddingProvider } from "../../src/shared/config.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.startsWith("--") || !args[0] ? "inventory" : args[0];
  if (!["inventory", "apply", "verify"].includes(command)) throw new Error("unknown command");
  const namespace = process.env.SURREAL_NS ?? "";
  const database = process.env.SURREAL_DB ?? "";
  if (!namespace || !database) throw new Error("SURREAL_NS and SURREAL_DB required");
  const identity = { namespace, database };
  const output = resolve(flag(args, "--inventory") ?? ".styrir/pipelines/source-layer/inventory.json");
  const vaultRoot = flag(args, "--vault");
  if (!vaultRoot) throw new Error("--vault is required");
  if (command === "apply") {
    if (!args.includes("--confirm")) throw new Error("apply requires --confirm");
    const backup = flag(args, "--backup");
    if (!backup) throw new Error("apply requires --backup");
    await validateBackup(backup);
    const vaultBackup = flag(args, "--vault-backup");
    if (!vaultBackup) throw new Error("apply requires --vault-backup");
    await validateBackup(vaultBackup);
  }
  const db = new SurrealClient({ url: process.env.SURREAL_URL ?? "http://localhost:8000",
    username: process.env.SURREAL_USER ?? "root", password: process.env.SURREAL_PASS ?? "",
    namespace, database });
  try {
    if (command === "inventory") {
      const result = await inventory(db, identity, vaultRoot);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(), result }), { mode: 0o600 });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "verify") {
      const result = await inventory(db, identity, vaultRoot, (text) => resolveEmbeddingProvider().embedDocument(text));
      process.stdout.write(`${JSON.stringify({ fields: result.fields, rows: result.rows, passed: verifyInventory(result) })}\n`);
      if (!verifyInventory(result)) process.exitCode = 1;
      return;
    }
    const backupPath = flag(args, "--backup") ?? "";
    const saved = JSON.parse(await readFile(output, "utf8")) as { createdAt: string; result: Inventory };
    if (saved.result.namespace !== namespace || saved.result.database !== database) throw new Error("inventory target mismatch");
    const result = await applyScrub(db, { identity, inventoryHash: saved.result.hash,
      inventoryCreatedAt: saved.createdAt, backupPath, vaultBackupPath: flag(args, "--vault-backup"),
      checkpointPath: resolve(flag(args, "--checkpoint") ?? ".styrir/pipelines/source-layer/scrub-checkpoint.json"),
      vaultRoot, hmacKey: process.env.RUNIR_SOURCE_HMAC_KEY ?? "",
      allowEmptyVault: args.includes("--allow-empty-vault"),
      batchSize: Number(flag(args, "--batch-size") ?? "100"), confirmed: true });
    process.stdout.write(`${JSON.stringify({ fields: result.fields, rows: result.rows, passed: true })}\n`);
  } finally { await db.close(); }
}

main().catch((error: unknown) => { process.stderr.write(`${formatScrubFailure(error)}\n`); process.exitCode = 1; });
