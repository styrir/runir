// Daily continuity report (Rúnir-78sy.5, Archeion v2 Phase 5a).
//
// A PURE read+render+cursor pass: reads the already-persisted
// project_continuity_state + continuity_gap rows (built by Step 4.5/4.6 on the
// consolidation tick) for each enrolled project and renders md/json/html — never
// re-reads raw sessions (§10.1). Output-only.
//
// Redaction-before-disk (§9.2): sanitizeForDisk (path-elide + secret-scrub) runs
// on EVERY rendered string, and per-EvidenceRef the sensitivity policy omits
// verbatim/secret/undefined-sensitivity excerpts (fail-closed) — so no raw
// sensitive content reaches the md/json/html files (Codex F5).
//
// No-op skip (§10.1/§10.2): a per-project CONTENT HASH over the fully-sanitized
// report model (Codex re-confirm) — dates not ms-timestamps, so it is stable
// within a day and immune to the builder's LLM-fallback updated_at churn; the
// project is skipped only when the rendered content is byte-identical.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fingerprint } from "../../identity/canonical-context.js";
import type {
  ContinuityGapRecord,
  EvidenceRef,
  ProjectContinuityStateRecord,
  ProjectEnrollmentRecord,
} from "../../domain/memory/continuity.js";
import {
  getContinuityGaps,
  readGapEvaluatedThrough,
  markGapReported,
  readContinuityReportState,
  writeContinuityReportState,
} from "../../storage/surreal/continuity-gap-store.js";
import { getProjectContinuityState, listProjectEnrollments } from "../../storage/surreal/continuity-state-store.js";
import { redactExportText } from "./vault-exporter.js";
import { assertWithinRoot } from "./path-safety.js";
import type { SurrealClient } from "../../storage/surreal/surreal-store.js";

// §11.2: these 4 kinds have no Rúnir-resident evidence class yet; the report
// must show "not yet evaluated", NEVER "no gaps found".
const NOT_YET_EVALUATED_KINDS = ["orphaned_change", "bead_stale", "doc_drift", "stale_agent_run"];

// ── Redaction / sanitization (§9.2 / Codex F5) ───────────────────────────────

// Consume private absolute paths, including Unicode/spaces, before publication.
// Keep only a basename so the report remains readable without exposing parents.
const USER_HOME_PATH_RE = /\/(?:Users|home)\/[\p{L}\p{N} .+_@%/-]+/gu;
const UNIX_PRIVATE_PATH_RE = /(^|[\s("'`=:[{,;])(\/(?!\/)[^\r\n)"'`<>]+)/gu;
const WINDOWS_PRIVATE_PATH_RE = /\b[A-Za-z]:\\[\p{L}\p{N} .+_@%\\/-]+/gu;
const WINDOWS_UNC_PATH_RE = /(^|[\s("'`=:[{,;])(\\\\[^\r\n)"'`<>]+)/gu;
const RELATIVE_PRIVATE_PATH_RE = /(^|[\s("'`=:[{,;])((?:~\/|\.{1,2}\/|\.styrir\/|\.beads\/|\.dolt\/|\.git\/|\.ssh\/)[^\r\n)"'`<>]*|\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/gu;
const BARE_RELATIVE_PATH_RE =
  /(^|[\s("'`=:[{,;])((?:[\p{L}\p{N}._+-]+\/)+[\p{L}\p{N}._+ -]+)/gu;
const SECRET_ASSIGNMENT_RE =
  /(?:\\*["'`]|&quot;|&#39;)?\b(?:[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential)|database_url|redis_url|mongo(?:db)?_uri|accountkey|sharedaccesssignature|sig)\b(?:\\*["'`]|&quot;|&#39;)?\s*[:=]\s*(?:&quot;[^&\r\n]*(?:&[^q\r\n][^&\r\n]*)*&quot;|&#39;[^&\r\n]*(?:&[^#\r\n][^&\r\n]*)*&#39;|\\*"(?:\\.|[^"\\])*\\*"|\\*'(?:\\.|[^'\\])*\\*'|\\*`(?:\\.|[^`\\])*\\*`|[^\s"'`<]+)/giu;
const PROVIDER_SECRET_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|xapp-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|(?:sk-ant-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_)[A-Za-z0-9_-]{20,})\b/gu;
const AZURE_CONNECTION_STRING_RE = /\bDefaultEndpointsProtocol=[^\s]+/giu;
const DATABASE_URL_RE =
  /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|mssql):\/\/[^\s)"'`<>]+/giu;
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const SECRET_SIGNAL_RE =
  /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|(?:[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential)|database_url|redis_url|mongo(?:db)?_uri|accountkey|sharedaccesssignature|sig)\s*[:=]|(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|mssql):\/\/|DefaultEndpointsProtocol=|(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|xapp-|AIza|GOCSPX-|sk-ant-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|hf_)[A-Za-z0-9_-]{12,})/iu;

function pathTail(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const tail = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (
    !tail ||
    tail.startsWith(".") ||
    /^(?:id_rsa|id_ed25519|credentials|known_hosts|authorized_keys)$/iu.test(tail)
  ) {
    return "path";
  }
  return tail;
}

/** Elides absolute user/home paths to their basename (human-readable, §9.2
 *  private-path elision — not the [PATH_n] redaction marker). The full match is
 *  consumed (parent path never leaks); a trailing prose word after a
 *  no-punctuation path is a cosmetic artifact, not a privacy leak. */
export function elidePaths(text: string): string {
  return text
    .replace(USER_HOME_PATH_RE, (path) => pathTail(path))
    .replace(UNIX_PRIVATE_PATH_RE, (_match, prefix: string, path: string) => `${prefix}${pathTail(path)}`)
    .replace(WINDOWS_PRIVATE_PATH_RE, (match) => pathTail(match))
    .replace(WINDOWS_UNC_PATH_RE, (_match, prefix: string, path: string) => `${prefix}${pathTail(path)}`)
    .replace(RELATIVE_PRIVATE_PATH_RE, (_match, prefix: string, path: string) => `${prefix}${pathTail(path)}`)
    .replace(BARE_RELATIVE_PATH_RE, (_match, prefix: string, path: string) => `${prefix}${pathTail(path)}`);
}

/** The disk choke: elide private paths, then scrub secret markers. Applied to
 *  EVERY rendered string (not just excerpts) before it reaches a file. */
export function sanitizeForDisk(text: string): string {
  const probe = text
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/\\+(?=["'` ])/gu, "");
  if (SECRET_SIGNAL_RE.test(probe)) return "[redacted: sensitive]";

  const sanitized = elidePaths(text)
    .replace(PRIVATE_KEY_BLOCK_RE, "[redacted: private-key]")
    .replace(AZURE_CONNECTION_STRING_RE, "[redacted: connection-string]")
    .replace(DATABASE_URL_RE, "[redacted: database-url]")
    .replace(SECRET_ASSIGNMENT_RE, "[redacted: credential]")
    .replace(PROVIDER_SECRET_RE, "[redacted: provider-key]");
  return redactExportText(sanitized);
}

/** Per-EvidenceRef sensitivity policy. verbatim_session / secret_redacted / an
 *  UNDEFINED sensitivity (fail-closed) → the excerpt is omitted and replaced
 *  with a redaction placeholder; normal / private_path → sanitized passthrough. */
function safeExcerpt(ref: EvidenceRef): string | undefined {
  if (!ref.excerpt) return undefined;
  const s = ref.sensitivity;
  if (s === "normal" || s === "private_path") return sanitizeForDisk(ref.excerpt);
  return `[redacted: ${sanitizeForDisk(ref.label)}]`;
}

function toDate(iso: string | undefined): string {
  if (!iso) return "";
  const idx = iso.indexOf("T");
  return idx > 0 ? iso.slice(0, idx) : iso;
}

// ── Report model (all string fields already sanitized) ───────────────────────

interface EvidenceView {
  sourceType: string;
  sourceId: string;
  label: string;
  excerpt?: string;
  date: string;
}

interface GapView {
  kind: string;
  // dedupeKey is the discriminator between two gaps that render identically
  // (e.g. missing_handoff for session A vs B) — MUST be in the content hash so a
  // swap forces a re-render (Codex F3).
  dedupeKey: string;
  title: string;
  summary: string;
  recommendation: string;
  confidence: string;
  status: string;
  score: number;
  firstSeenDate: string;
  lastSeenDate: string;
  relatedWorkItems: string[];
  candidateTaskPreview?: { title: string; description: string };
  evidence: EvidenceView[];
}

type ReportItemClass = "focus" | "progress" | "next_steps" | "open_loops" | "blockers" | "gaps";
type ReportSourceState = "resolved" | "unavailable";

interface ReportItemEvidenceView {
  itemClass: ReportItemClass;
  /** Position in the filtered rendered array. */
  itemIndex: number;
  /** Position in the producer's original unfiltered array. */
  sourceItemIndex: number;
  text: string;
  sourceState: ReportSourceState;
  sources: Array<{ sourceType: string; sourceId: string }>;
  safeScope: {
    userId: string;
    workspaceId: string;
    projectKey: string;
  };
  knownTime: string | null;
  conflictOrStaleness: string | null;
  derivationVersion: string | null;
  generationDigest: string;
}

interface ProjectView {
  projectKey: string;
  workspaceId: string;
  gapsPending: boolean;
  currentFocus: string[];
  latestProgress: string[];
  nextSteps: string[];
  openLoops: string[];
  blockers: string[];
  gaps: GapView[];
  itemEvidence: ReportItemEvidenceView[];
  weakSignalCount: number;
  contentHash: string;
  gapIds: string[];
}

interface ReportModel {
  date: string;
  userId: string;
  lookbackDays: number;
  notYetEvaluated: string[];
  projects: ProjectView[];
  skippedProjects: string[];
  pendingProjects: string[];
}

const REPORT_SOURCE_TYPES = new Set<EvidenceRef["sourceType"]>([
  "session_turn",
  "session_summary",
  "semiote",
  "noema",
  "runir_session",
  "agent_run_event",
  "workspace_execution",
  "bead",
  "git_commit",
  "git_diff",
  "doc_artifact",
  "handoff",
]);

const EVIDENCE_SENSITIVITIES = new Set<NonNullable<EvidenceRef["sensitivity"]>>([
  "normal",
  "verbatim_session",
  "private_path",
  "secret_redacted",
]);

function sanitizeList(items: string[]): string[] {
  return items.map((s) => sanitizeForDisk(s));
}

function rawNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = rawNonEmptyString(record, key);
  return value === undefined ? undefined : sanitizeForDisk(value);
}

function publicationSourceId(rawSourceId: string): string {
  return `src-${fingerprint(rawSourceId)}`;
}

function nonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function reportSourceType(record: Record<string, unknown>, key: string): EvidenceRef["sourceType"] | undefined {
  const value = rawNonEmptyString(record, key);
  return value && REPORT_SOURCE_TYPES.has(value as EvidenceRef["sourceType"])
    ? value as EvidenceRef["sourceType"]
    : undefined;
}

function normalizedSourceId(sourceType: EvidenceRef["sourceType"], sourceId: string): string {
  const prefix = `${sourceType}:`;
  return sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId;
}

function sourceIdsEqual(
  sourceType: EvidenceRef["sourceType"],
  left: string,
  right: string,
): boolean {
  return normalizedSourceId(sourceType, left) === normalizedSourceId(sourceType, right);
}

function stateSourceIsBacked(
  state: ProjectContinuityStateRecord,
  mapping: Record<string, unknown>,
  sourceType: EvidenceRef["sourceType"],
  sourceId: string,
): boolean {
  if (
    sourceType === "semiote" &&
    state.supportingSemioteIds.some((id) => sourceIdsEqual(sourceType, id, sourceId))
  ) {
    return true;
  }

  return state.sourceEvidenceRefs.some((candidate) => {
    if (candidate === mapping) return false;
    if (
      candidate.itemClass !== undefined ||
      candidate.itemIndex !== undefined ||
      candidate.sourceState !== undefined
    ) {
      return false;
    }
    const candidateHasSourceType = "sourceType" in candidate;
    const candidateType = candidateHasSourceType
      ? reportSourceType(candidate, "sourceType")
      : reportSourceType(candidate, "kind");
    if (candidateHasSourceType && candidateType === undefined) return false;
    const candidateHasSourceId = "sourceId" in candidate;
    const candidateId = candidateHasSourceId
      ? rawNonEmptyString(candidate, "sourceId")
      : rawNonEmptyString(candidate, "id");
    if (candidateHasSourceId && candidateId === undefined) return false;
    return candidateType === sourceType &&
      candidateId !== undefined &&
      sourceIdsEqual(sourceType, candidateId, sourceId);
  });
}

function anchoredStateItems(
  state: ProjectContinuityStateRecord,
  itemClass: Exclude<ReportItemClass, "gaps">,
  rawItems: string[],
): { items: string[]; evidence: ReportItemEvidenceView[] } {
  const items: string[] = [];
  const evidence: ReportItemEvidenceView[] = [];

  for (const [itemIndex, rawText] of rawItems.entries()) {
    const matching = state.sourceEvidenceRefs.filter((ref) =>
      ref.itemClass === itemClass && nonNegativeInteger(ref, "itemIndex") === itemIndex
    );
    if (matching.length !== 1) continue;

    const ref = matching[0];
    const rawState = nonEmptyString(ref, "sourceState");
    const resolved = rawState === "resolved";
    const unavailable = itemClass === "progress" && rawState === "unavailable";
    if (!resolved && !unavailable) continue;

    const sourceType = reportSourceType(ref, "sourceType");
    const sourceId = rawNonEmptyString(ref, "sourceId");
    if (
      unavailable &&
      (
        "sourceType" in ref ||
        "sourceId" in ref ||
        "kind" in ref ||
        "id" in ref
      )
    ) {
      continue;
    }
    if (
      resolved &&
      (!sourceType || !sourceId || !stateSourceIsBacked(state, ref, sourceType, sourceId))
    ) {
      continue;
    }

    const text = sanitizeForDisk(rawText);
    const renderedItemIndex = items.length;
    items.push(text);
    evidence.push({
      itemClass,
      itemIndex: renderedItemIndex,
      sourceItemIndex: itemIndex,
      text,
      sourceState: unavailable ? "unavailable" : "resolved",
      sources: sourceType && sourceId
        ? [{ sourceType, sourceId: publicationSourceId(sourceId) }]
        : [],
      safeScope: {
        userId: sanitizeForDisk(state.userId),
        workspaceId: sanitizeForDisk(state.workspaceId),
        projectKey: sanitizeForDisk(state.projectKey),
      },
      knownTime: nonEmptyString(ref, "knownAt") ?? null,
      conflictOrStaleness: nonEmptyString(ref, "conflictOrStaleness") ?? null,
      derivationVersion: nonEmptyString(ref, "derivationVersion") ?? null,
      generationDigest: "",
    });
  }

  return { items, evidence };
}

function isUsableEvidenceRef(value: unknown): value is EvidenceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.sourceType !== "string" ||
    !REPORT_SOURCE_TYPES.has(ref.sourceType as EvidenceRef["sourceType"]) ||
    typeof ref.sourceId !== "string" ||
    ref.sourceId.trim().length === 0 ||
    typeof ref.label !== "string" ||
    ref.label.trim().length === 0
  ) {
    return false;
  }
  for (const key of ["uri", "excerpt", "timestamp"] as const) {
    if (ref[key] !== undefined && typeof ref[key] !== "string") return false;
  }
  if (ref.confidence !== undefined && typeof ref.confidence !== "number") return false;
  if (
    ref.sensitivity !== undefined &&
    (
      typeof ref.sensitivity !== "string" ||
      !EVIDENCE_SENSITIVITIES.has(ref.sensitivity as NonNullable<EvidenceRef["sensitivity"]>)
    )
  ) {
    return false;
  }
  return true;
}

function toEvidenceView(ref: EvidenceRef): EvidenceView {
  return {
    sourceType: sanitizeForDisk(ref.sourceType),
    sourceId: publicationSourceId(ref.sourceId.trim()),
    label: sanitizeForDisk(ref.label.trim()),
    excerpt: safeExcerpt(ref),
    date: toDate(ref.timestamp),
  };
}

function toGapView(gap: ContinuityGapRecord): GapView {
  return {
    kind: gap.kind,
    dedupeKey: gap.dedupeKey,
    title: sanitizeForDisk(gap.title),
    summary: sanitizeForDisk(gap.summary),
    recommendation: sanitizeForDisk(gap.recommendation),
    confidence: gap.confidence,
    status: gap.status,
    score: gap.score,
    firstSeenDate: toDate(gap.firstSeenAt),
    lastSeenDate: toDate(gap.lastSeenAt),
    relatedWorkItems: sanitizeList(gap.relatedWorkItems),
    candidateTaskPreview: gap.candidateTaskPreview
      ? { title: sanitizeForDisk(gap.candidateTaskPreview.title), description: sanitizeForDisk(gap.candidateTaskPreview.description) }
      : undefined,
    evidence: gap.evidence.filter(isUsableEvidenceRef).map(toEvidenceView),
  };
}

/** Builds a sanitized per-project view + a content hash over it. The hash uses
 *  DATES (not ms timestamps), so it is stable within a day and churn-immune. */
function buildProjectView(
  state: ProjectContinuityStateRecord,
  gaps: ContinuityGapRecord[],
  gapEvaluatedThrough: string | null,
): ProjectView {
  const gapsPending = gapEvaluatedThrough === null || gapEvaluatedThrough < state.updatedAt;
  const focus = anchoredStateItems(state, "focus", state.currentFocus);
  const progress = anchoredStateItems(state, "progress", state.latestProgress);
  const nextSteps = anchoredStateItems(state, "next_steps", state.nextSteps);
  const openLoops = anchoredStateItems(state, "open_loops", state.openLoops);
  const blockers = anchoredStateItems(state, "blockers", state.blockers);
  const acceptedGaps = gaps
    .map((gap, itemIndex) => ({ gap, itemIndex, view: toGapView(gap) }))
    .filter(({ view }) => !gapsPending && view.evidence.length > 0);
  const safeScope = {
    userId: sanitizeForDisk(state.userId),
    workspaceId: sanitizeForDisk(state.workspaceId),
    projectKey: sanitizeForDisk(state.projectKey),
  };
  const gapEvidence: ReportItemEvidenceView[] = acceptedGaps.map(({ itemIndex: sourceItemIndex, view }, itemIndex) => ({
    itemClass: "gaps",
    itemIndex,
    sourceItemIndex,
    text: view.title,
    sourceState: "resolved",
    sources: view.evidence.map((source) => ({
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    })),
    safeScope,
    knownTime: view.lastSeenDate || null,
    conflictOrStaleness: view.status || null,
    derivationVersion: null,
    generationDigest: "",
  }));
  const itemEvidence = [
    ...focus.evidence,
    ...progress.evidence,
    ...nextSteps.evidence,
    ...openLoops.evidence,
    ...blockers.evidence,
    ...gapEvidence,
  ];
  const view: ProjectView = {
    projectKey: safeScope.projectKey,
    workspaceId: safeScope.workspaceId,
    gapsPending,
    currentFocus: focus.items,
    latestProgress: progress.items,
    nextSteps: nextSteps.items,
    openLoops: openLoops.items,
    blockers: blockers.items,
    gaps: acceptedGaps.map(({ view: gap }) => gap),
    itemEvidence,
    weakSignalCount: acceptedGaps.filter(({ gap }) => gap.confidence === "weak").length,
    contentHash: "",
    gapIds: acceptedGaps.map(({ gap }) => gap.id),
  };
  // Hash the sanitized, date-normalized content (NOT the volatile ms
  // timestamps or the gapIds/contentHash themselves).
  const { contentHash: _c, gapIds: _g, ...hashable } = view;
  view.contentHash = fingerprint(JSON.stringify(hashable));
  for (const item of view.itemEvidence) item.generationDigest = view.contentHash;
  return view;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function sourceReferenceLabel(sourceType: string, sourceId: string): string {
  return sourceId.startsWith(`${sourceType}:`)
    ? sourceId
    : `${sourceType}:${sourceId}`;
}

const MARKDOWN_SPECIAL_CHARACTERS = new Set([
  "\\",
  "`",
  "*",
  "_",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "#",
  "+",
  "-",
  ".",
  "!",
  "|",
]);

function escapeMarkdown(value: string): string {
  let escaped = "";
  for (const character of value) {
    if (character === "<") {
      escaped += "&lt;";
    } else if (character === ">") {
      escaped += "&gt;";
    } else if (character === "&") {
      escaped += "&amp;";
    } else if (MARKDOWN_SPECIAL_CHARACTERS.has(character)) {
      escaped += `\\${character}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function safeMarkdown(value: string): string {
  return escapeMarkdown(sanitizeForDisk(value));
}

function itemEvidenceLabel(item: ReportItemEvidenceView): string {
  const source = item.sourceState === "unavailable"
    ? "source unavailable"
    : item.sources.map((ref) => sourceReferenceLabel(ref.sourceType, ref.sourceId)).join(", ");
  return [
    `item-class: ${item.itemClass}`,
    `item-index: ${item.itemIndex}`,
    `source-item-index: ${item.sourceItemIndex}`,
    `source-state: ${item.sourceState}`,
    source,
    `scope: user=${item.safeScope.userId}, workspace=${item.safeScope.workspaceId}, project=${item.safeScope.projectKey}`,
    `known-time: ${item.knownTime ?? "unknown"}`,
    `conflict-or-staleness: ${item.conflictOrStaleness ?? "unknown"}`,
    `derivation-version: ${item.derivationVersion ?? "unknown"}`,
    `generation-digest: ${item.generationDigest}`,
  ].join("; ");
}

function mdItemList(p: ProjectView, itemClass: Exclude<ReportItemClass, "gaps">): string {
  const items = p.itemEvidence.filter((item) => item.itemClass === itemClass);
  return items.length > 0
    ? items.map((item) => `- ${safeMarkdown(item.text)} _(${safeMarkdown(itemEvidenceLabel(item))})_`).join("\n")
    : "_(none)_";
}

function renderProjectMarkdown(p: ProjectView): string {
  const lines: string[] = [`## Project: ${safeMarkdown(p.projectKey)}`, ""];
  if (p.gapsPending) {
    lines.push("> ⏳ **Gaps pending evaluation** — the continuity state changed since gaps were last evaluated; the gap list below may be stale.", "");
  }
  lines.push("### Current focus", mdItemList(p, "focus"), "", "### Latest progress", mdItemList(p, "progress"), "");
  lines.push("### Next steps", mdItemList(p, "next_steps"), "", "### Open loops", mdItemList(p, "open_loops"), "");
  lines.push("### Blockers", mdItemList(p, "blockers"), "");
  lines.push(`### Gaps (${p.gaps.length}${p.gapsPending ? ", evaluation pending" : ""})`, "");
  if (p.gapsPending) {
    // Never present stale evaluation as a clean bill of health (Codex F2).
    lines.push("_Gap evaluation is pending for this project — the list below is NOT a complete evaluation against the latest state._", "");
  } else if (p.gaps.length === 0) {
    lines.push("_No open gaps detected on Rúnir-resident evidence._", "");
  }
  if (p.gaps.length > 0) {
    for (const [gapIndex, g] of p.gaps.entries()) {
      const itemEvidence = p.itemEvidence.filter((item) => item.itemClass === "gaps")[gapIndex];
      lines.push(`#### [${safeMarkdown(g.kind)}] ${safeMarkdown(g.title)}`);
      lines.push(`_confidence: ${safeMarkdown(g.confidence)} · status: ${safeMarkdown(g.status)} · first seen: ${safeMarkdown(g.firstSeenDate)} · last seen: ${safeMarkdown(g.lastSeenDate)}_`, "");
      if (itemEvidence) lines.push(`_${safeMarkdown(itemEvidenceLabel(itemEvidence))}_`, "");
      lines.push(safeMarkdown(g.summary), "", `**Recommendation:** ${safeMarkdown(g.recommendation)}`, "");
      if (g.evidence.length > 0) {
        lines.push("<details><summary>Evidence</summary>", "");
        for (const e of g.evidence) {
          lines.push(`- **${safeMarkdown(sourceReferenceLabel(e.sourceType, e.sourceId))}** ${safeMarkdown(e.label)}${e.date ? ` (${safeMarkdown(e.date)})` : ""}${e.excerpt ? `: ${safeMarkdown(e.excerpt)}` : ""}`);
        }
        lines.push("", "</details>", "");
      }
    }
  }
  return lines.join("\n");
}

export function renderMarkdown(model: ReportModel): string {
  const changed = model.projects.length;
  const newHigh = model.projects.reduce(
    (n, p) => n + p.gaps.filter((g) => g.confidence !== "weak" && g.firstSeenDate === model.date).length,
    0,
  );
  const repeated = model.projects.reduce(
    (n, p) => n + p.gaps.filter((g) => g.firstSeenDate < model.date).length,
    0,
  );
  const lines: string[] = [
    `# Daily Continuity Report — ${safeMarkdown(model.date)}`,
    "",
    `_user: ${safeMarkdown(model.userId)} · lookback: ${model.lookbackDays}d_`,
    "",
    "## Summary",
    `- Projects changed: ${changed}`,
    `- New high-confidence gaps (today): ${newHigh}`,
    `- Repeated unresolved gaps: ${repeated}`,
    `- Skipped (inactive) projects: ${model.skippedProjects.length}`,
    `- Projects with gaps pending evaluation: ${model.pendingProjects.length}`,
    "",
  ];
  for (const p of model.projects) lines.push(renderProjectMarkdown(p), "");
  lines.push("## Appendix", "");
  lines.push(`**Not yet evaluated** (awaiting Leit S-2 evidence): ${model.notYetEvaluated.map(safeMarkdown).join(", ")}.`, "");
  if (model.skippedProjects.length > 0) lines.push(`**Skipped (inactive):** ${model.skippedProjects.map(safeMarkdown).join(", ")}.`, "");
  if (model.pendingProjects.length > 0) lines.push(`**Gaps pending evaluation:** ${model.pendingProjects.map(safeMarkdown).join(", ")}.`, "");
  lines.push(
    "",
    "_Export manifest: generated from project_continuity_state + continuity_gap (output-only projection). Low-confidence (weak) signals are ordered by score and are advisory, not committed work._",
  );
  return lines.join("\n") + "\n";
}

export function renderJson(model: ReportModel): string {
  return JSON.stringify(sanitizeJsonValue(model), null, 2) + "\n";
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeForDisk(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeJsonValue(nested)]),
    );
  }
  return value;
}

function esc(value: unknown): string {
  return sanitizeForDisk(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlItemList(p: ProjectView, itemClass: Exclude<ReportItemClass, "gaps">): string {
  const items = p.itemEvidence.filter((item) => item.itemClass === itemClass);
  if (items.length === 0) return "<p class='muted'>(none)</p>";
  return `<ul>${items.map((item) =>
    `<li data-source-state="${esc(item.sourceState)}">${esc(item.text)}<br><small class="meta">${esc(itemEvidenceLabel(item))}</small></li>`
  ).join("")}</ul>`;
}

function renderProjectHtml(p: ProjectView): string {
  const gapHtml =
    p.gapsPending
      ? "<p class='pending'>Gap evaluation is pending for this project — the list below is NOT a complete evaluation against the latest state.</p>" +
        p.gaps
          .map(
            (g, gapIndex) => {
              const itemEvidence = p.itemEvidence.filter((item) => item.itemClass === "gaps")[gapIndex];
              return `<article class="gap ${esc(g.kind)}"><h4>[${esc(g.kind)}] ${esc(g.title)}</h4>${itemEvidence ? `<p class="meta">${esc(itemEvidenceLabel(itemEvidence))}</p>` : ""}<p>${esc(g.summary)}</p></article>`;
            },
          )
          .join("")
      : p.gaps.length === 0
      ? "<p class='muted'>No open gaps detected on Rúnir-resident evidence.</p>"
      : p.gaps
          .map(
            (g, gapIndex) => {
              const itemEvidence = p.itemEvidence.filter((item) => item.itemClass === "gaps")[gapIndex];
              return `<article class="gap ${esc(g.kind)}">
      <h4>[${esc(g.kind)}] ${esc(g.title)}</h4>
      <p class="meta">confidence: ${esc(g.confidence)} · status: ${esc(g.status)} · first seen: ${esc(g.firstSeenDate)} · last seen: ${esc(g.lastSeenDate)}</p>
      ${itemEvidence ? `<p class="meta">${esc(itemEvidenceLabel(itemEvidence))}</p>` : ""}
      <p>${esc(g.summary)}</p>
      <p class="rec"><b>Recommendation:</b> ${esc(g.recommendation)}</p>
      ${
        g.evidence.length > 0
          ? `<details><summary>Evidence</summary><ul>${g.evidence
              .map(
                (e) =>
                  `<li><b>${esc(sourceReferenceLabel(e.sourceType, e.sourceId))}</b> ${esc(e.label)}${e.date ? ` (${esc(e.date)})` : ""}${e.excerpt ? `: ${esc(e.excerpt)}` : ""}</li>`,
              )
              .join("")}</ul></details>`
          : ""
      }
    </article>`;
            },
          )
          .join("");
  return `<section class="project">
    <h3>${esc(p.projectKey)}</h3>
    ${p.gapsPending ? `<p class="pending">⏳ Gaps pending evaluation — the gap list may be stale.</p>` : ""}
    <h5>Current focus</h5>${htmlItemList(p, "focus")}
    <h5>Latest progress</h5>${htmlItemList(p, "progress")}
    <h5>Next steps</h5>${htmlItemList(p, "next_steps")}
    <h5>Open loops</h5>${htmlItemList(p, "open_loops")}
    <h5>Blockers</h5>${htmlItemList(p, "blockers")}
    <h5>Gaps (${p.gaps.length})</h5>${gapHtml}
  </section>`;
}

export function renderHtml(model: ReportModel): string {
  const style = `
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    .muted, .meta { color: #888; font-size: 0.9em; }
    .pending { color: #b8860b; font-weight: 600; }
    article.gap { border-left: 3px solid #888; padding-left: 0.8rem; margin: 1rem 0; }
    details summary { cursor: pointer; color: #6699cc; }
    @media (prefers-color-scheme: dark) {
      body { background: #14171a; color: #e6e6e6; }
      article.gap { border-left-color: #4a5568; }
    }`;
  const body = model.projects.map(renderProjectHtml).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Continuity Report ${esc(model.date)}</title><style>${style}</style></head>
<body>
  <h1>Daily Continuity Report — ${esc(model.date)}</h1>
  <p class="meta">user: ${esc(model.userId)} · lookback: ${esc(model.lookbackDays)}d</p>
  <h2>Summary</h2>
  <ul>
    <li>Projects changed: ${model.projects.length}</li>
    <li>Skipped (inactive): ${model.skippedProjects.length}</li>
    <li>Gaps pending evaluation: ${model.pendingProjects.length}</li>
  </ul>
  ${body}
  <h2>Appendix</h2>
  <p><b>Not yet evaluated</b> (awaiting Leit S-2 evidence): ${esc(model.notYetEvaluated.join(", "))}.</p>
  <p class="muted">Export manifest: generated from project_continuity_state + continuity_gap (output-only). Weak signals are advisory.</p>
</body></html>
`;
}

// ── Writer (sanitize + containment, no stale-sweep) ──────────────────────────

export class ContinuityReportWriter {
  constructor(private readonly reportDir: string) {}

  async write(relName: string, content: string): Promise<string> {
    const fullPath = assertWithinRoot(this.reportDir, relName);
    await mkdir(dirname(fullPath), { recursive: true });
    // Every renderer sanitizes field values before syntax is introduced. A
    // post-serialization text scrub can corrupt JSON or lose assignment context.
    await writeFile(fullPath, content, "utf-8");
    return fullPath;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

function resolveLookbackDays(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
  const n = Number(process.env.RUNIR_CONTINUITY_REPORT_LOOKBACK_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
}

export function resolveReportDir(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = process.env.RUNIR_CONTINUITY_REPORT_DIR?.trim();
  if (dir) return dir;
  const isTestNs = Boolean(process.env.RUNIR_TEST_NS);
  const vault = (isTestNs ? process.env.VAULT_TEST_EXPORT_PATH : process.env.VAULT_EXPORT_PATH)?.trim();
  if (vault) return `${vault.replace(/\/+$/, "")}/07 Continuity/reports`;
  return ".pipeline/continuity-reports";
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export interface ContinuityReportOptions {
  userId: string;
  reportDir?: string;
  lookbackDays?: number;
  /** Report date (YYYY-MM-DD); injectable for determinism. Defaults to today. */
  date?: string;
}

export interface ContinuityReportResult {
  date: string;
  reportDir: string;
  projectsRendered: number;
  projectsSkipped: number;
  projectsPending: number;
  files: string[];
}

/**
 * Renders the daily continuity report for one user across all enrolled projects.
 * Per project: build the sanitized model view + content hash; skip (no-op) when
 * the hash matches the last reported hash; otherwise include it, stamp
 * last_reported_at on surfaced gaps, and advance the report cursor.
 */
export async function runContinuityReport(
  db: SurrealClient,
  options: ContinuityReportOptions,
): Promise<ContinuityReportResult> {
  const { userId } = options;
  const lookbackDays = resolveLookbackDays(options.lookbackDays);
  const reportDir = resolveReportDir(options.reportDir);
  const date = options.date ?? new Date().toISOString().slice(0, 10);

  const enrollments: ProjectEnrollmentRecord[] = await listProjectEnrollments(db, userId);
  const projects: ProjectView[] = [];
  const skippedProjects: string[] = [];
  const pendingProjects: string[] = [];

  for (const enrollment of enrollments) {
    const workspaceId = enrollment.workspaceId;
    const projectKey = enrollment.projectKey;
    const state = await getProjectContinuityState(db, userId, workspaceId, projectKey);
    if (!state) {
      skippedProjects.push(sanitizeForDisk(projectKey));
      continue;
    }
    const [gaps, evaluatedThrough, priorReport] = await Promise.all([
      getContinuityGaps(db, userId, workspaceId, projectKey),
      readGapEvaluatedThrough(db, userId, workspaceId, projectKey),
      readContinuityReportState(db, userId, workspaceId, projectKey),
    ]);
    const view = buildProjectView(state, gaps, evaluatedThrough);

    // A gaps-pending project is NEVER skipped and NEVER advances the report
    // cursor — its gaps are stale until Step 4.6 catches up, so the report must
    // keep re-rendering it (and never let a "pending" hash suppress future runs)
    // until evaluation is current (Codex F1).
    if (!view.gapsPending && priorReport && priorReport.reportedContentHash === view.contentHash) {
      skippedProjects.push(sanitizeForDisk(projectKey)); // no-op: content unchanged since last report
      continue;
    }

    projects.push(view);
    await Promise.all(view.gapIds.map((gapId) => markGapReported(db, gapId, `${date}T00:00:00.000Z`)));
    if (view.gapsPending) {
      pendingProjects.push(sanitizeForDisk(projectKey));
    } else {
      // Advance the cursor only for a fully-evaluated project; reportedThrough is
      // the evaluated-through watermark, not the raw state timestamp.
      await writeContinuityReportState(db, userId, workspaceId, projectKey, view.contentHash, evaluatedThrough ?? "");
    }
  }

  const model: ReportModel = {
    date,
    userId: sanitizeForDisk(userId),
    lookbackDays,
    notYetEvaluated: NOT_YET_EVALUATED_KINDS,
    projects,
    skippedProjects,
    pendingProjects,
  };

  const writer = new ContinuityReportWriter(reportDir);
  const files = await Promise.all([
    writer.write(`${date}-continuity-report.md`, renderMarkdown(model)),
    writer.write(`${date}-continuity-report.json`, renderJson(model)),
    writer.write(`${date}-continuity-report.html`, renderHtml(model)),
  ]);

  return {
    date,
    reportDir,
    projectsRendered: projects.length,
    projectsSkipped: skippedProjects.length,
    projectsPending: pendingProjects.length,
    files,
  };
}
