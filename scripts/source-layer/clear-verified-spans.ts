#!/usr/bin/env node
/** Operator-only, count-only span removal. Never executes from the measurement harness. */
import { SurrealClient, extractId } from "../../src/storage/surreal/surreal-store.js";
import { readVerifiedSourceTurns } from "../../src/storage/surreal/verified-source-turns.js";

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !["--apply", "--i-have-owner-approval"].includes(arg))) throw new Error("unknown flag");
const apply = args.has("--apply");
const namespace = process.env.SURREAL_NS ?? "";
const database = process.env.SURREAL_DB ?? "";
const key = process.env.RUNIR_SOURCE_HMAC_KEY ?? "";
if (!namespace || !database || !key) throw new Error("database target and source HMAC key required in environment");
if ((namespace === "main" || database === "main") && (!apply || !args.has("--i-have-owner-approval")))
  throw new Error("main requires --apply and --i-have-owner-approval");
if (apply && !args.has("--i-have-owner-approval")) throw new Error("apply requires --i-have-owner-approval");

const db = new SurrealClient({ url: process.env.SURREAL_URL ?? "http://localhost:8000",
  username: process.env.SURREAL_USER ?? "root", password: process.env.SURREAL_PASS ?? "",
  namespace, database });
let scanned = 0;
let eligible = 0;
let cleared = 0;
try {
  let offset = 0;
  const candidates: Array<{ id: unknown; user_id: string; session_id?: string }> = [];
  for (;;) {
    const rows = (await db.query<{ id: unknown; user_id: string; session_id?: string }>(
      `SELECT id, user_id, session_id FROM semiote
       WHERE payload.rawSpan != NONE OR payload.rawSpans != NONE ORDER BY id LIMIT 100 START $offset;`, { offset },
    ))[0] ?? [];
    if (!rows.length) break;
    offset += rows.length;
    scanned += rows.length;
    candidates.push(...rows);
    if (rows.length < 100) break;
  }
  for (const row of candidates) {
      const factId = extractId(row.id);
      const verified = await readVerifiedSourceTurns(db, [factId], { userId: row.user_id, sessionId: row.session_id }, key);
      if (!verified.has(factId)) continue;
      eligible++;
      if (apply) {
        await db.query(`UPDATE type::record('semiote', $id) SET payload.rawSpan = NONE, payload.rawSpans = NONE WHERE user_id = $userId;`,
          { id: factId, userId: row.user_id });
        cleared++;
      }
  }
  process.stdout.write(JSON.stringify({ scanned, eligible, cleared, dryRun: !apply }) + "\n");
} finally { await db.close(); }
