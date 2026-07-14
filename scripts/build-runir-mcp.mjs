#!/usr/bin/env node
/**
 * Bundle the canonical MCP adapter (src/mcp) into both client packages as
 * byte-identical self-contained ESM artifacts (Rúnir-sh1 Slice 2).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/mcp/index.ts");
const outDir = join(root, "dist/mcp");
const outFile = join(outDir, "runir-mcp.mjs");
const targets = [
  join(root, "plugins/runir-claudecode/mcp/runir-mcp.mjs"),
  join(root, "plugins/runir-codex/mcp/runir-mcp.mjs"),
];

mkdirSync(outDir, { recursive: true });

const build = spawnSync(
  "npx",
  [
    "--yes",
    "esbuild",
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    `--outfile=${outFile}`,
  ],
  { cwd: root, encoding: "utf8" },
);

if (build.status !== 0) {
  process.stderr.write(build.stdout || "");
  process.stderr.write(build.stderr || "");
  process.exit(build.status ?? 1);
}

const artifact = readFileSync(outFile);
const hash = createHash("sha256").update(artifact).digest("hex");

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, artifact);
}

// Gate 12: both package copies must be byte-identical.
const digests = targets.map((t) =>
  createHash("sha256").update(readFileSync(t)).digest("hex"),
);
if (new Set(digests).size !== 1 || digests[0] !== hash) {
  console.error("runir-mcp checksum mismatch across package copies");
  process.exit(1);
}

console.log(`built runir-mcp.mjs (${artifact.length} bytes)`);
console.log(`sha256 ${hash}`);
for (const t of targets) console.log(`  → ${t.replace(root + "/", "")}`);
