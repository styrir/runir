/**
 * Shared helpers for the judge-benchmark mining and labeling scripts.
 * RNG draw order and gitleaks messages stay caller-compatible.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "../../src/testing/model-benchmark/provenance.js";

/** mulberry32 — small deterministic PRNG so a sample is reproducible from the seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates with the same draw order as the previous in-place loops.
 * Copies first, so a caller can pass a sorted array and keep that array intact.
 */
export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function sha256(text: string): string {
  return sha256Text(text);
}

/** Positive probe first: a detector that cannot see a planted key proves nothing. */
export function gitleaksGate(file: string, probeFailure: string): void {
  const probeDir = mkdtempSync(join(tmpdir(), "judge-gitleaks-probe-"));
  const probe = join(probeDir, "probe.txt");
  // Synthetic probe key, joined at runtime so the repository never holds a
  // key-shaped literal that secret scanners (ours or GitHub's) would flag.
  const keyId = ["AKIA", "Q3EGUXPVJ7Z2KL4M"].join("");
  const secret = ["9Xq2+Hb7mLr4Tz8Vw1Ns", "6Kc3Yp0Fd5Ga2Je8Ro1U"].join("");
  writeFileSync(probe, `aws_access_key_id = ${keyId}\naws_secret_access_key = ${secret}\n`);
  let probeCaught = false;
  try {
    execFileSync("gitleaks", ["detect", "--no-git", "--no-banner", "--redact", "--exit-code", "1", "--source", probe], { stdio: "pipe" });
  } catch (err) {
    probeCaught = (err as { status?: number }).status === 1;
  }
  if (!probeCaught) throw new Error(probeFailure);
  try {
    execFileSync("gitleaks", ["detect", "--no-git", "--no-banner", "--redact", "--exit-code", "1", "--source", file], { stdio: "pipe" });
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new Error(status === 1 ? `gitleaks found secret-like content in ${file}; external labeling blocked` : `gitleaks failed (status ${status})`);
  }
}

export async function surrealQuery<T>(
  sql: string,
  opts: { ns: string; db: string; vars?: Record<string, unknown>; url?: string },
): Promise<T[]> {
  const url = opts.url ?? process.env.JUDGE_SURREAL_URL ?? "http://127.0.0.1:8000/sql";
  const auth = Buffer.from(`${process.env.SURREAL_USER ?? "root"}:${process.env.SURREAL_PASS ?? "root"}`).toString("base64");
  const lets = opts.vars
    ? Object.entries(opts.vars).map(([key, value]) => `LET $${key} = ${JSON.stringify(value)};`).join(" ")
    : null;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
      "surreal-ns": opts.ns,
      "surreal-db": opts.db,
    },
    body: lets === null ? sql : `${lets} ${sql}`,
  });
  if (!res.ok) throw new Error(`surreal HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ status: string; result: unknown }>;
  const last = body.at(-1);
  if (!last || last.status !== "OK") throw new Error(`surreal query failed: ${JSON.stringify(last).slice(0, 300)}`);
  return last.result as T[];
}
