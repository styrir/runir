// Continuity builder (Rúnir-78sy.3, Archeion v2 Phase 2).
//
// Step 4.5 in runConsolidationForScope (scope==='user' pass): per enrolled
// project, bind runir evidence via three unioned candidates, fetch semiotes
// newer than the build cursor, and — when there is new evidence — make ONE
// bounded LLM call synthesizing the §7 continuity list fields from {warmed
// project_state, new semiote texts, top noema claims}. The result is CAS-written
// to project_continuity_state (valid_at stamped, version += 1) and the cursor
// advances ONLY after a successful synthesis commits.
//
// Discipline (staleness-pass, staleness-pass.ts:170-300): deterministic inputs
// assembled first, skip the LLM entirely at 0 new semiotes, degrade-never-throw
// — an LLM failure writes a carry-forward + warmer-merge fallback via CAS but
// PARKS the cursor so the same evidence is re-synthesized next tick. Bounded by
// a per-run project cap + a step budget.

import {
  canonicalizeWorkspaceId,
  projectKeyFromGitRemote,
  projectKeyFromProjectId,
} from "../../identity/canonical-context.js";
import type {
  ContinuitySynthesisFields,
  ProjectContinuityStateRecord,
  ProjectContinuityStateWrite,
  ProjectEnrollmentRecord,
} from "../../domain/memory/continuity.js";
import type { ProjectStateRecord } from "../../domain/memory/lifecycle.js";
import { callLlmGateway, stripJsonFences } from "../../shared/llm-gateway-client.js";
import { resolveLlmTimeoutMs } from "../../shared/config.js";
import {
  compareAndSwapProjectContinuityState,
  getProjectContinuityState,
  listProjectEnrollments,
  readContinuityBuildCursor,
  writeContinuityBuildCursor,
} from "../../storage/surreal/continuity-state-store.js";
import { extractId, getProjectStateByProjectKey, type SurrealClient } from "../../storage/surreal/surreal-store.js";

/** Default extractor model — see resolveContinuityModel. */
const DEFAULT_CONTINUITY_MODEL = "openai/gpt-5.4-mini";

/** RUNIR_CONTINUITY_MODEL ?? RUNIR_EXTRACTOR_MODEL ?? extractor default.
 *  Mirrors getStalenessModel's env-override pattern; falls back to the same
 *  extraction default the capture lane resolves (config source of truth). */
export function resolveContinuityModel(): string {
  const fromEnv = process.env.RUNIR_CONTINUITY_MODEL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const extractor = process.env.RUNIR_EXTRACTOR_MODEL;
  if (typeof extractor === "string" && extractor.length > 0) return extractor;
  return DEFAULT_CONTINUITY_MODEL;
}

function resolveMaxProjectsPerRun(): number {
  const n = Number(process.env.RUNIR_CONTINUITY_MAX_PROJECTS_PER_RUN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

function resolveContinuityBudgetMs(): number {
  const n = Number(process.env.CONSOLIDATION_CONTINUITY_BUDGET_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 60_000;
}

export interface ContinuityBuildDeps {
  db: SurrealClient;
  userId: string;
  apiKey: string;
  logger?: (msg: string) => void;
}

export interface ContinuityBuildResult {
  built: number;
  fallbacks: number;
  projectsConsidered: number;
}

// ── Binding-key derivation (three candidates, unioned) ───────────────────────

export interface ContinuityBindingKeys {
  /** (0) enrollment.projectId → project:<lowercased> (project_key equality). */
  projectIdKey?: string;
  /** (1) enrollment.repoRemote → git:<fp24(normalizeGitRemoteUrl)> (equality). */
  gitRemoteKey?: string;
  /** (2) enrollment.repoRootFingerprint → runir_session.workspace_fingerprint. */
  repoRootFingerprint?: string;
}

/**
 * Derives the three binding candidates from an enrollment row. Candidate (0)
 * takes precedence in project_key equality (deriveProjectKey prefers projectId
 * over the git branches). The keys are unioned by the evidence query, not
 * mutually exclusive: a project can bind by BOTH project_key and workspace
 * fingerprint.
 */
export function deriveContinuityBindingKeys(enrollment: {
  projectId?: string;
  repoRemote?: string;
  repoRootFingerprint?: string;
}): ContinuityBindingKeys {
  const keys: ContinuityBindingKeys = {};
  const projectId = enrollment.projectId?.trim();
  if (projectId) keys.projectIdKey = projectKeyFromProjectId(projectId);
  const repoRemote = enrollment.repoRemote?.trim();
  if (repoRemote) keys.gitRemoteKey = projectKeyFromGitRemote(repoRemote);
  const repoRootFingerprint = enrollment.repoRootFingerprint?.trim();
  if (repoRootFingerprint) keys.repoRootFingerprint = repoRootFingerprint;
  return keys;
}

/**
 * Shared WHERE-fragment assembly for the binding-key union (rule of three,
 * Rúnir-78sy.9 Codex P2) — extracted from the copy-pasted `projectKeys`/
 * `conditions`/`vars` block in continuity-gaps.ts's fetchRecentlyEndedSessions,
 * this file's fetchNewSemiotes, and continuity-evidence-store.ts's
 * fetchAnchoredCandidateSessions. Produces the `project_key IN $projectKeys`
 * leg (projectIdKey + gitRemoteKey unioned) and, when `workspaceFingerprintColumn`
 * is given, the `<column> = $wf` leg for candidate (2) — the two sites that
 * query `runir_session` directly pass `"workspace_fingerprint"`;
 * fetchNewSemiotes resolves candidate (2) itself (session-id lookup, then
 * `runir_session_id IN`) and omits it here. Returns `null` when no candidate
 * key is present (mirrors each site's prior early-return). The produced SQL
 * conditions/vars are byte-identical to what each site built inline.
 */
export function buildBindingConditions(
  keys: ContinuityBindingKeys,
  workspaceFingerprintColumn?: string,
): { conditions: string[]; vars: Record<string, unknown> } | null {
  const projectKeys: string[] = [];
  if (keys.projectIdKey) projectKeys.push(keys.projectIdKey);
  if (keys.gitRemoteKey) projectKeys.push(keys.gitRemoteKey);
  const wf = workspaceFingerprintColumn ? keys.repoRootFingerprint : undefined;
  if (projectKeys.length === 0 && !wf) return null;

  const conditions: string[] = [];
  const vars: Record<string, unknown> = {};
  if (projectKeys.length > 0) {
    conditions.push("project_key IN $projectKeys");
    vars.projectKeys = projectKeys;
  }
  if (wf) {
    conditions.push(`${workspaceFingerprintColumn} = $wf`);
    vars.wf = wf;
  }
  return { conditions, vars };
}

// ── Evidence fetch ───────────────────────────────────────────────────────────

export interface EvidenceSemiote {
  id: string;
  text: string; // payload.l2 (canonical fact) or payload.l1 (summary)
  createdAt: string; // payload.createdAt — JS ISO string, cursor-comparable
  sessionId?: string;
}

/**
 * Fetches active semiotes bound to the project via the three unioned candidates,
 * newer than `cursor` (strict lexicographic `>` on payload.createdAt), OLDEST
 * first and capped at `limit`. Mirrors the dedup_state watermark contract
 * (consolidation.ts:221-323): the cursor filter and ORDER BY are pushed INTO the
 * query and the fetch cap equals the synthesis cap, so every fetched row is
 * folded — nothing is dropped between fetch and synthesis and the newest
 * post-cursor rows can never be excluded from an oversized subset. The ASC sort
 * on payload.createdAt is not index-backed but is correct; a defensive app-side
 * re-sort guards against any storage-layer reorder. Returns ascending, so the
 * tail is the newest of THIS batch (the built_through drained-backlog anchor).
 *
 * Exported (Rúnir-78sy.12) so the live regression test can execute the REAL
 * SQL directly — the mocked-db builder tests cannot catch SurrealDB parse
 * errors (the ORDER-BY-idiom-in-projection bug shipped exactly this way).
 */
export async function fetchNewSemiotes(
  db: SurrealClient,
  userId: string,
  keys: ContinuityBindingKeys,
  cursor: string | null,
  limit: number,
): Promise<EvidenceSemiote[]> {
  // Candidate (0)+(1): project_key IN <projectIdKey, gitRemoteKey> (shared
  // assembly, Codex P2). Candidate (2) is resolved separately below (session-
  // id lookup, not a direct fingerprint condition here) so the fingerprint
  // column is omitted from this call.
  const projectKeyBinding = buildBindingConditions(keys);

  // Candidate (2): repoRootFingerprint → runir_session ids whose
  // workspace_fingerprint matches → semiote.runir_session_id.
  let sessionIds: string[] = [];
  if (keys.repoRootFingerprint) {
    const sessionResults = await db.query<{ id: unknown }>(
      `SELECT id FROM runir_session
         WHERE user_id = $userId AND workspace_fingerprint = $wf;`,
      { userId, wf: keys.repoRootFingerprint },
    );
    sessionIds = (sessionResults[0] ?? [])
      .map((r) => (typeof r.id === "string" ? r.id : String((r.id as any)?.id ?? r.id)))
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }

  if (!projectKeyBinding && sessionIds.length === 0) return [];

  // Union: project_key IN <keys> OR runir_session_id IN <sessionIds>.
  const conditions: string[] = [...(projectKeyBinding?.conditions ?? [])];
  const vars: Record<string, unknown> = { userId, limit, ...(projectKeyBinding?.vars ?? {}) };
  if (sessionIds.length > 0) {
    conditions.push("runir_session_id IN $sessionIds");
    vars.sessionIds = sessionIds;
  }

  // Bind $cursor only when non-null (first run omits the clause). Strict `>`
  // pushed into SQL so an oversized post-cursor cohort keeps its OLDEST rows
  // under the LIMIT (dropping newest-and-skipping-forever is the F1 defect).
  const cursorClause = cursor !== null ? " AND payload.createdAt > $cursor" : "";
  if (cursor !== null) vars.cursor = cursor;

  // Rúnir-78sy.12: SurrealDB v3 requires the ORDER BY idiom to appear in the
  // projection — `ORDER BY payload.createdAt` against a bare `payload` field
  // parse-errors ("Missing order idiom `payload.createdAt` in statement
  // selection"), live-verified. Project the order key under an alias and
  // order by the alias; `payload` stays selected as-is (the mapper below
  // still reads r.payload?.createdAt, unaffected).
  const results = await db.query<{
    id: unknown;
    session_id?: string | null;
    payload: { l1?: string; l2?: string; data?: string; createdAt?: string };
  }>(
    `SELECT id, session_id, payload, payload.createdAt AS created_at FROM semiote
       WHERE payload.userId = $userId
       AND (active = NONE OR active = true)
       AND (${conditions.join(" OR ")})${cursorClause}
       ORDER BY created_at ASC
       LIMIT $limit;`,
    vars,
  );

  const rows = results[0] ?? [];
  const mapped: EvidenceSemiote[] = rows.map((r) => ({
    id: extractId(r.id),
    text: (r.payload?.l2 ?? r.payload?.l1 ?? r.payload?.data ?? "").trim(),
    createdAt: r.payload?.createdAt ?? "",
    sessionId: r.session_id ?? undefined,
  }));

  // Text/createdAt-nonempty guard + defensive app-side re-sort ascending so the
  // tail is the newest of this batch (built_through anchor). The cursor filter
  // is already applied in SQL; the app-side re-sort is belt-and-suspenders.
  return mapped
    .filter((m) => m.text.length > 0 && m.createdAt.length > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Reads up to `limit` top noema canonical claims for the bound project keys. */
async function fetchTopNoemaClaims(
  db: SurrealClient,
  userId: string,
  supportingSemioteIds: string[],
  limit: number,
): Promise<string[]> {
  if (supportingSemioteIds.length === 0) return [];
  // Rúnir-78sy.12: same SurrealDB v3 ORDER-BY-idiom-in-projection requirement
  // as fetchNewSemiotes — authority/confidence must be selected (even though
  // unused by the mapper below) or the query parse-errors ("Missing order
  // idiom `authority` in statement selection"), live-verified.
  const results = await db.query<{ canonical_text?: string | null }>(
    `SELECT canonical_text, authority, confidence FROM noema
       WHERE user_id = $userId
       AND (active = NONE OR active = true)
       AND support_semiote_ids CONTAINSANY $ids
       ORDER BY authority DESC, confidence DESC
       LIMIT $limit;`,
    { userId, ids: supportingSemioteIds, limit },
  );
  return (results[0] ?? [])
    .map((r) => (r.canonical_text ?? "").trim())
    .filter((t) => t.length > 0);
}

// ── Synthesis ────────────────────────────────────────────────────────────────

const EMPTY_FIELDS: ContinuitySynthesisFields = {
  currentFocus: [],
  latestProgress: [],
  nextSteps: [],
  blockers: [],
  openLoops: [],
  unfiledIntentions: [],
  pendingVerification: [],
  recentlyChangedArtifacts: [],
  likelyStaleBeads: [],
  activeAgentRuns: [],
};

const FIELD_KEYS = Object.keys(EMPTY_FIELDS) as Array<keyof ContinuitySynthesisFields>;

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter((s) => s.length > 0).slice(0, 25);
}

function parseSynthesisFields(raw: string): ContinuitySynthesisFields {
  const parsed = JSON.parse(stripJsonFences(raw)) as Record<string, unknown>;
  const out: ContinuitySynthesisFields = { ...EMPTY_FIELDS };
  for (const key of FIELD_KEYS) {
    out[key] = coerceStringArray(parsed[key]);
  }
  return out;
}

const SYNTHESIS_SYSTEM_PROMPT = [
  "You maintain a project's continuity state for a developer-memory service.",
  "Given the current continuity snapshot, newly captured facts, and top durable",
  "claims for ONE project, synthesize the up-to-date continuity lists. Output a",
  "single JSON object with EXACTLY these string-array keys (empty array if none):",
  "currentFocus, latestProgress, nextSteps, blockers, openLoops,",
  "unfiledIntentions, pendingVerification, recentlyChangedArtifacts,",
  "likelyStaleBeads, activeAgentRuns. Each item is a terse phrase. Prefer the",
  "newest evidence; carry forward still-relevant prior items; drop resolved ones.",
  "Do not invent facts not supported by the inputs.",
].join(" ");

function buildSynthesisUserPrompt(
  priorState: ProjectContinuityStateRecord | null,
  warmedProjectState: ProjectStateRecord | null,
  newTexts: string[],
  noemaClaims: string[],
): string {
  const snapshot = priorState
    ? JSON.stringify({
        currentFocus: priorState.currentFocus,
        latestProgress: priorState.latestProgress,
        nextSteps: priorState.nextSteps,
        blockers: priorState.blockers,
        openLoops: priorState.openLoops,
        unfiledIntentions: priorState.unfiledIntentions,
        pendingVerification: priorState.pendingVerification,
        recentlyChangedArtifacts: priorState.recentlyChangedArtifacts,
        likelyStaleBeads: priorState.likelyStaleBeads,
        activeAgentRuns: priorState.activeAgentRuns,
      })
    : "(none)";
  // Fresh per-turn warmer signal (project_state) — cheap deterministic hints the
  // LLM should fold on top of the prior continuity snapshot.
  const warmed = warmedProjectState
    ? JSON.stringify({
        currentFocus: warmedProjectState.currentFocus ?? "",
        latestProgress: warmedProjectState.latestProgress ?? "",
        nextSteps: warmedProjectState.nextSteps,
        blockers: warmedProjectState.blockers,
      })
    : "(none)";
  return [
    `Current continuity snapshot:\n${snapshot}`,
    `Fresh warmed project state (per-turn signal):\n${warmed}`,
    `New captured facts (newest last):\n${newTexts.map((t, i) => `${i + 1}. ${t}`).join("\n") || "(none)"}`,
    `Top durable claims:\n${noemaClaims.map((t, i) => `${i + 1}. ${t}`).join("\n") || "(none)"}`,
  ].join("\n\n");
}

/** Order-preserving union of two string arrays (trims, drops empties, dedups by exact value). */
function unionArrays(base: string[], extra: string[]): string[] {
  const out = [...base];
  for (const item of extra) {
    const v = typeof item === "string" ? item.trim() : "";
    if (v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Appends `value` to `list` if non-empty and not already present (order-preserving union). */
function appendUnique(list: string[], value: string | undefined | null): string[] {
  return unionArrays(list, [value ?? ""]);
}

/**
 * Carry-forward + warmer-merge fallback (LLM failure). Starts from the prior
 * continuity lists (or empty lists on first run) and OVERLAYS the fresh per-turn
 * `project_state` warmer so a failed synthesis still folds the cheap
 * deterministic signal — the first-run case is no longer all-empty when a
 * warmer row exists. Written via CAS so valid_at re-stamps, but the caller PARKS
 * the cursor so the same evidence is re-synthesized next tick. project_state
 * carries only 4 fields; the other 6 continuity fields carry forward from
 * priorState (or stay empty on first run).
 */
function pickSynthesisFields(priorState: ProjectContinuityStateRecord): ContinuitySynthesisFields {
  const out = { ...EMPTY_FIELDS };
  for (const key of FIELD_KEYS) {
    out[key] = [...priorState[key]];
  }
  return out;
}

function carryForwardFields(
  priorState: ProjectContinuityStateRecord | null,
  warmedProjectState: ProjectStateRecord | null,
): ContinuitySynthesisFields {
  const base: ContinuitySynthesisFields = priorState ? pickSynthesisFields(priorState) : { ...EMPTY_FIELDS };
  if (!warmedProjectState) return base;
  // Scalars (currentFocus, latestProgress) wrap into their array-typed
  // continuity fields; arrays (nextSteps, blockers) union directly.
  return {
    ...base,
    currentFocus: appendUnique(base.currentFocus, warmedProjectState.currentFocus),
    latestProgress: appendUnique(base.latestProgress, warmedProjectState.latestProgress),
    nextSteps: unionArrays(base.nextSteps, warmedProjectState.nextSteps),
    blockers: unionArrays(base.blockers, warmedProjectState.blockers),
  };
}

// ── Per-project build ────────────────────────────────────────────────────────

// Fetch cap == synthesis cap: we synthesize exactly what we fetch, so no row is
// dropped between fetch and synth (the F1 burn defect). A backlog > this cap is
// drained oldest-first across ticks via the tie-safe cursor advance below.
const NEW_TEXT_CAP = 40;
const NOEMA_CLAIM_CAP = 15;

type ProjectBuildOutcome = "built" | "fallback" | "skipped_no_evidence" | "cas_lost";

async function buildOneProject(
  deps: ContinuityBuildDeps,
  enrollment: ProjectEnrollmentRecord,
): Promise<ProjectBuildOutcome> {
  const { db, userId, apiKey, logger } = deps;
  const workspaceId = canonicalizeWorkspaceId(enrollment.workspaceId);
  const projectKey = enrollment.projectKey;

  const keys = deriveContinuityBindingKeys(enrollment);
  const cursor = await readContinuityBuildCursor(db, userId, workspaceId, projectKey);
  // Fetch cap == synthesis cap: fetch is bounded, oldest-first, cursor-filtered
  // in SQL. We synthesize the WHOLE fetched batch so nothing is dropped between
  // fetch and synth (F1). A backlog larger than the cap is drained across ticks
  // via the tie-safe advance below.
  const bounded = await fetchNewSemiotes(db, userId, keys, cursor, NEW_TEXT_CAP);
  if (bounded.length === 0) return "skipped_no_evidence";

  const newTexts = bounded.map((s) => s.text);
  const supportingSemioteIds = bounded.map((s) => s.id);
  const sourceSessionIds = Array.from(
    new Set(bounded.map((s) => s.sessionId).filter((s): s is string => typeof s === "string" && s.length > 0)),
  );

  // Three independent reads run concurrently (no data dependency between them):
  //  - priorState: the builder's OWN last output — read DIRECTLY by (user,
  //    workspace, project); NEVER a latest-any fallback (cross-project bleed
  //    risk). Anchors the CAS expectedVersion + carry-forward.
  //  - warmedProjectState: the per-turn regex warmer's output — a SEPARATE input
  //    the contract requires the builder to fold. Read STRICTLY by (userId,
  //    projectKey); project_state has no workspaceId axis.
  //  - noemaClaims: top durable claims for the bound evidence.
  const [priorState, warmedProjectState, noemaClaims] = await Promise.all([
    getProjectContinuityState(db, userId, workspaceId, projectKey),
    getProjectStateByProjectKey(db, userId, projectKey),
    fetchTopNoemaClaims(db, userId, supportingSemioteIds, NOEMA_CLAIM_CAP),
  ]);
  const expectedVersion = priorState?.version ?? 0;

  // Tie-safe cursor advance (dedup_state pattern, consolidation.ts:312-323).
  // `bounded` is ascending. If the batch drained the backlog (< cap) the newest
  // fetched createdAt is safe to advance to. If the batch is exactly the cap, a
  // same-createdAt tie may straddle the LIMIT boundary, so we may only advance
  // to the largest createdAt STRICTLY BELOW the tail — parking any tied cohort
  // sitting on the boundary. If every fetched row shares one createdAt (no
  // strictly-smaller value), we DO NOT advance: the next tick re-fetches the
  // same cohort and the idempotent CAS makes re-synthesis safe.
  const tailCreatedAt = bounded[bounded.length - 1]!.createdAt;
  let builtThrough: string | null;
  if (bounded.length < NEW_TEXT_CAP) {
    builtThrough = tailCreatedAt;
  } else {
    builtThrough = null;
    for (const s of bounded) {
      if (s.createdAt >= tailCreatedAt) break;
      builtThrough = s.createdAt;
    }
  }

  let fields: ContinuitySynthesisFields;
  let synthesized = false;
  try {
    const content = await callLlmGateway({
      model: resolveContinuityModel(),
      apiKey,
      jsonMode: true,
      temperature: 0,
      timeoutMs: resolveLlmTimeoutMs(),
      maxTokens: 1024,
      messages: [
        { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
        { role: "user", content: buildSynthesisUserPrompt(priorState, warmedProjectState, newTexts, noemaClaims) },
      ],
    });
    fields = parseSynthesisFields(content);
    synthesized = true;
  } catch (err) {
    // Degrade to carry-forward + warmer-merge; cursor stays parked below.
    logger?.(`memory-hybrid: continuity synthesis LLM failure for ${userId}::${workspaceId}::${projectKey}: ${String(err)}`);
    fields = carryForwardFields(priorState, warmedProjectState);
  }

  const write: ProjectContinuityStateWrite & { expectedVersion: number } = {
    userId,
    workspaceId,
    projectKey,
    projectId: enrollment.projectId,
    defaultNamespaceId: enrollment.defaultNamespaceId,
    ...fields,
    sourceEvidenceRefs: bounded.map((s) => ({ kind: "semiote", id: s.id, at: s.createdAt })),
    confidence: synthesized ? 0.7 : (priorState?.confidence ?? 0.5),
    sourceSessionIds,
    supportingSemioteIds,
    expectedVersion,
  };

  const cas = await compareAndSwapProjectContinuityState(db, write);
  if ("ok" in cas && cas.ok === false) {
    // Lost the race — another pass advanced the row. Park cursor, retry next tick.
    logger?.(`memory-hybrid: continuity CAS version_mismatch for ${userId}::${workspaceId}::${projectKey} (current=${cas.currentVersion})`);
    return "cas_lost";
  }

  // Advance the cursor ONLY after a successful synthesis committed. On LLM
  // failure the fallback row is written but the cursor parks so the same
  // evidence is re-synthesized next tick (failure never burns evidence). A null
  // builtThrough is the pathological full-cap same-createdAt cohort — park too
  // (re-synthesis is idempotent via CAS), never advancing past unfolded rows.
  if (synthesized) {
    if (builtThrough !== null) {
      await writeContinuityBuildCursor(db, userId, workspaceId, projectKey, builtThrough);
    }
    return "built";
  }
  return "fallback";
}

// ── Entrypoint (Step 4.5) ────────────────────────────────────────────────────

/**
 * Iterates enrolled projects for the user (capped at
 * RUNIR_CONTINUITY_MAX_PROJECTS_PER_RUN, step budget
 * CONSOLIDATION_CONTINUITY_BUDGET_MS), building each project's continuity row.
 * Degrade-never-throw: a per-project failure is logged and skipped; the step
 * never fails the consolidation run.
 */
export async function runContinuityBuildStep(deps: ContinuityBuildDeps): Promise<ContinuityBuildResult> {
  const { db, userId, logger } = deps;
  const maxProjects = resolveMaxProjectsPerRun();
  const budgetMs = resolveContinuityBudgetMs();
  const startedAt = Date.now();

  const enrollments = await listProjectEnrollments(db, userId);
  let built = 0;
  let fallbacks = 0;
  let considered = 0;

  for (const enrollment of enrollments) {
    if (considered >= maxProjects) break;
    if (Date.now() - startedAt >= budgetMs) {
      logger?.(`memory-hybrid: continuity build budget exhausted for ${userId} after ${considered} project(s)`);
      break;
    }
    considered++;
    try {
      const outcome = await buildOneProject(deps, enrollment);
      if (outcome === "built") built++;
      else if (outcome === "fallback") fallbacks++;
    } catch (err) {
      // Per-project degrade — never fail the run over one project.
      logger?.(`memory-hybrid: continuity build error for ${userId}::${enrollment.projectKey}: ${String(err)}`);
    }
  }

  return { built, fallbacks, projectsConsidered: considered };
}
