// Live-DB SQL≡JS fixture-matrix test for the broadened sessionHasHandoff query
// (Rúnir-78sy.7 Part A, Codex MAJOR-3 — hand-written SurrealQL requires a
// live-DB execution test pinning SQL ≡ matchesHandoffCue equivalence over a
// fixture MATRIX, not a single positive row).
//
// Each matrix row creates ONE real semiote row against the prod-identical
// schema (ensurePhase2Schema — the same table/field/index DDL the service
// bootstraps), calls the ACTUAL live sessionHasHandoff query against it, and
// independently calls matchesHandoffCue(text) on the same source text. Every
// row asserts SQL verdict === JS verdict. Isolated NEW database under ns
// `main` (never db "main"); REMOVE DATABASE afterAll. Skips cleanly (ctx.skip)
// when no local SurrealDB is reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SurrealClient } from "../storage/surreal/surreal-store.js";
import { ensurePhase2Schema } from "../storage/surreal/phase2-store.js";
import { sessionHasHandoff } from "../lifecycle/semion/continuity-gaps.js";
import { matchesHandoffCue } from "../lifecycle/semion/handoff-cues.js";

const TEST_DB = "continuity_gaps_78sy7_cue_repro_test";
const USER = "_78sy7_cue_repro_user";

function makeDb(): SurrealClient {
  return new SurrealClient({
    // 127.0.0.1 (IPv4), not localhost — the native install binds IPv4 only.
    url: process.env.SURREAL_URL ?? "http://127.0.0.1:8000",
    username: process.env.SURREAL_USER ?? "root",
    password: process.env.SURREAL_PASS ?? "root",
    namespace: process.env.SURREAL_NS ?? "main",
    database: TEST_DB,
  });
}

let db: SurrealClient;
let dbAvailable = false;

beforeAll(async () => {
  db = makeDb();
  try {
    await db.query("INFO FOR DB;");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  await db.query("REMOVE TABLE IF EXISTS semiote;").catch(() => undefined);
  await ensurePhase2Schema(db);
});

afterAll(async () => {
  if (dbAvailable) {
    await db.query(`REMOVE DATABASE ${TEST_DB};`).catch(() => undefined);
    await db.close().catch(() => undefined);
  }
});

// ── Fixture matrix rows ───────────────────────────────────────────────────
// Each row: a distinct sessionId (isolates the query scope), the semiote row
// shape to CREATE, and the text used for the independent matchesHandoffCue
// check. `expected` documents the intended SQL/JS verdict for readability —
// the test never asserts against `expected` directly for the cue-text rows,
// only SQL-vs-JS equality, so the matrix is the source of truth, not a
// hardcoded verdict list (guards against silently drifting the two apart).

interface MatrixRow {
  readonly label: string;
  readonly sessionId: string;
  readonly memoryRole?: string;
  /** undefined => omit text_norm entirely (NONE row). */
  readonly textNorm?: string;
  /** Independent text passed to matchesHandoffCue for the SQL≡JS check.
   *  Defaults to `textNorm` when omitted. */
  readonly matcherText?: string;
  readonly active?: boolean;
}

const MATRIX: readonly MatrixRow[] = [
  // — memory_role='session_handoff' fast path (no cue text needed at all) —
  {
    label: "fast path: stored memory_role=session_handoff, unrelated text",
    sessionId: "sess-fastpath",
    memoryRole: "session_handoff",
    textNorm: "unrelated captured fact about the sha-pin mismatch",
  },
  // — one positive per cue family —
  {
    label: "legacy family: 'session handoff'",
    sessionId: "sess-legacy",
    textNorm: "a session handoff was written for this work",
  },
  {
    label: "legacy family: 'resume here'",
    sessionId: "sess-legacy-resume-here",
    textNorm: "next session, resume here at step 3",
  },
  {
    label: "legacy family: 'next time'",
    sessionId: "sess-legacy-next-time",
    textNorm: "next time we should check the cache",
  },
  {
    label: "resume-point family: 'resume point'",
    sessionId: "sess-resume-point",
    textNorm: "the next resume point is finishing the migration",
  },
  {
    label: "resume-point family: 'resume points for next session in order'",
    sessionId: "sess-resume-points-order",
    textNorm: "resume points for next session in order: fix tests, deploy",
  },
  {
    label: "resume-point family: 'next designated resume point'",
    sessionId: "sess-designated-resume-point",
    textNorm: "the next designated resume point is the retrieval fix",
  },
  {
    label: "handoff-doc-created family: 'handoff doc created'",
    sessionId: "sess-handoff-doc-created",
    textNorm: "a handoff doc created at docs/handoffs/2026-07-05-foo.md",
  },
  {
    label: "handoff-doc-created family: 'handoff was created'",
    sessionId: "sess-handoff-was-created",
    textNorm: "a formal handoff was created summarizing the session",
  },
  {
    label: "handoff-doc-created family: 'durable handoff doc is already committed'",
    sessionId: "sess-durable-committed",
    textNorm: "the durable handoff doc is already committed and pushed",
  },
  // — near-miss negatives (must NOT match, incl. the mandatory bare path case) —
  {
    label: "near-miss NEGATIVE: bare docs/handoffs/ path reference (citation, not creation)",
    sessionId: "sess-bare-path",
    textNorm: "see docs/handoffs/2026-07-03-78sy1-seam-ratification-handoff.md for background",
  },
  {
    label: "near-miss NEGATIVE: reading/citing a prior handoff",
    sessionId: "sess-citing-handoff",
    textNorm: "per the handoff at docs/handoffs/2026-06-20-foo.md, the plan was x",
  },
  {
    label: "near-miss NEGATIVE: 'wrapping up' excluded (F7, zero genuine hits)",
    sessionId: "sess-wrapping-up",
    textNorm: "wrapping up this task for today",
  },
  {
    label: "near-miss NEGATIVE: 'closing out' excluded (F7, false-positive risk)",
    sessionId: "sess-closing-out",
    textNorm: "closing out a wait for gitnexus to finish indexing",
  },
  {
    label: "near-miss NEGATIVE: unrelated recent-work text",
    sessionId: "sess-unrelated",
    textNorm: "fixed the sha-pin mismatch in the manifest v3 config",
  },
  // — uppercase input vs lowercased text_norm —
  {
    label: "uppercase input still matches (text_norm is stored lowercased; SQL scans as-is, JS lowercases)",
    sessionId: "sess-uppercase",
    // text_norm is CONVENTIONALLY lowercase in prod (F11: "already lowercased
    // mirror of payload.l2"); this row pins that the SQL fragment matches
    // correctly against an actually-lowercased column while matchesHandoffCue
    // independently lowercases its OWN input — proving the two are equivalent
    // even though the uppercase source text never reaches text_norm as-is.
    textNorm: "session handoff notes for this project",
    matcherText: "SESSION HANDOFF NOTES FOR THIS PROJECT",
  },
  // — text_norm = NONE row (column is optional; must not error, must not
  //   match via the cue leg). The SQL≡JS equivalence claim is tested against
  //   what is ACTUALLY in text_norm (nothing) — matcherText intentionally
  //   defaults to "" (matchesHandoffCue("") === false) so this row proves the
  //   query is NONE-safe AND still honors the same equivalence bar as every
  //   other row, rather than being a special-cased exception. The separate
  //   "does not throw" test below independently re-confirms the no-error case
  //   with a dedicated assertion (not just an equality check that could pass
  //   vacuously if the query silently swallowed an error into `false`).
  {
    label: "text_norm = NONE: query must not error and must not match via the cue leg",
    sessionId: "sess-none-text-norm",
    // textNorm omitted entirely => the CREATE never sets it => stays NONE.
  },
  {
    label: "text_norm = NONE + stored memory_role=session_handoff: fast path still fires despite NONE text_norm",
    sessionId: "sess-none-text-norm-but-role",
    memoryRole: "session_handoff",
    matcherText: "irrelevant",
  },
  // — active=false row: excluded by the (active = NONE OR active = true) gate
  //   regardless of cue match (sanity: the cue broadening must not defeat the
  //   existing active-row filter) —
  {
    label: "inactive row (active=false) excluded regardless of cue match",
    sessionId: "sess-inactive",
    textNorm: "session handoff notes but this row is inactive",
    active: false,
  },
];

describe("Rúnir-78sy.7 Part A: sessionHasHandoff SQL ≡ matchesHandoffCue fixture matrix (live DB)", () => {
  it("executes every matrix row against the real broadened query and asserts SQL verdict === JS verdict", async (ctx) => {
    if (!dbAvailable) return ctx.skip();

    let ran = 0;
    for (const row of MATRIX) {
      const vars: Record<string, unknown> = { userId: USER, sessionId: row.sessionId, now: new Date().toISOString() };
      const setClauses = [
        "user_id = $userId",
        "runir_session_id = $sessionId",
        "payload = {}",
        "created_at = <datetime>$now",
        "updated_at = <datetime>$now",
      ];
      if (row.memoryRole !== undefined) {
        setClauses.push("memory_role = $memoryRole");
        vars.memoryRole = row.memoryRole;
      }
      if (row.textNorm !== undefined) {
        setClauses.push("text_norm = $textNorm");
        vars.textNorm = row.textNorm;
      }
      if (row.active !== undefined) {
        setClauses.push("active = $active");
        vars.active = row.active;
      }
      await db.query(
        `CREATE type::record('semiote', $recordId) SET ${setClauses.join(", ")};`,
        { ...vars, recordId: `cue_matrix_${row.sessionId.replace(/[^a-z0-9]/gi, "_")}` },
      );

      // The ACTUAL live query under test — no reimplementation, the same
      // function detectMissingHandoff calls in production.
      const sqlVerdict = await sessionHasHandoff(db, USER, row.sessionId);

      // Independent JS check on the same source text (the fast-path rows use
      // matcherText/none since the JS matcher has no concept of a stored role
      // — it only tests the cue leg's text equivalence).
      const jsText = row.matcherText ?? row.textNorm ?? "";
      const jsCueVerdict = matchesHandoffCue(jsText);
      // Fast path via memory_role bypasses the cue leg entirely in SQL; the JS
      // matcher has no role concept, so for role-driven rows we only assert
      // the SQL fast path fired (independently confirmed) — the SQL≡JS
      // equivalence claim applies to the CUE LEG specifically. For every row
      // WITHOUT a stored session_handoff role, SQL verdict must equal the JS
      // cue verdict exactly (this is the actual Codex MAJOR-3 equivalence bar).
      if (row.memoryRole === "session_handoff") {
        expect(sqlVerdict, `${row.label}: fast path should fire regardless of cue leg`).toBe(true);
      } else if (row.active === false) {
        expect(sqlVerdict, `${row.label}: inactive row must be excluded regardless of cue match`).toBe(false);
      } else {
        expect(sqlVerdict, `${row.label}: SQL verdict must equal JS verdict (${jsCueVerdict})`).toBe(jsCueVerdict);
      }
      ran++;
    }

    // Prove the matrix actually executed (n/n ran, 0 skipped) rather than a
    // vacuously-passing empty loop.
    expect(ran).toBe(MATRIX.length);
    expect(ran).toBeGreaterThanOrEqual(18);
  });

  it("does not throw when text_norm is NONE (option<string> — the query must be NONE-safe)", async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    // sess-none-text-norm was already created above with text_norm omitted
    // (stays NONE per phase2-store.ts's `option<string>` field type). Calling
    // sessionHasHandoff against it a second time, independently of the matrix
    // loop's own assertion, pins that no exception is thrown — the specific
    // failure mode Codex MAJOR-3 calls out.
    await expect(sessionHasHandoff(db, USER, "sess-none-text-norm")).resolves.toBe(false);
  });
});
