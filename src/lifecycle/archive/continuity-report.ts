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
import { basename, dirname } from "node:path";
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

// Consume the WHOLE absolute user/home path INCLUDING spaces (macOS paths have
// them) so the parent directory can never leak — the space-excluding class left
// `/Users/x/Private Project/secret.txt` → `Private Project/secret.txt` (Codex F4).
const PATH_RE = /\/(Users|home)\/[\w .+/-]+/g;

/** Elides absolute user/home paths to their basename (human-readable, §9.2
 *  private-path elision — not the [PATH_n] redaction marker). The full match is
 *  consumed (parent path never leaks); a trailing prose word after a
 *  no-punctuation path is a cosmetic artifact, not a privacy leak. */
export function elidePaths(text: string): string {
  return text.replace(PATH_RE, (m) => basename(m.replace(/\/+$/, "")) || "path");
}

/** The disk choke: elide private paths, then scrub secret markers. Applied to
 *  EVERY rendered string (not just excerpts) before it reaches a file. */
export function sanitizeForDisk(text: string): string {
  return redactExportText(elidePaths(text));
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

function sanitizeList(items: string[]): string[] {
  return items.map((s) => sanitizeForDisk(s));
}

function toEvidenceView(ref: EvidenceRef): EvidenceView {
  return {
    sourceType: ref.sourceType,
    sourceId: sanitizeForDisk(ref.sourceId),
    label: sanitizeForDisk(ref.label),
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
    evidence: gap.evidence.map(toEvidenceView),
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
  const view: ProjectView = {
    projectKey: state.projectKey,
    workspaceId: state.workspaceId,
    gapsPending,
    currentFocus: sanitizeList(state.currentFocus),
    latestProgress: sanitizeList(state.latestProgress),
    nextSteps: sanitizeList(state.nextSteps),
    openLoops: sanitizeList(state.openLoops),
    blockers: sanitizeList(state.blockers),
    gaps: gaps.map(toGapView),
    weakSignalCount: gaps.filter((g) => g.confidence === "weak").length,
    contentHash: "",
    gapIds: gaps.map((g) => g.id),
  };
  // Hash the sanitized, date-normalized content (NOT the volatile ms
  // timestamps or the gapIds/contentHash themselves).
  const { contentHash: _c, gapIds: _g, ...hashable } = view;
  view.contentHash = fingerprint(JSON.stringify(hashable));
  return view;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function mdList(items: string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "_(none)_";
}

function renderProjectMarkdown(p: ProjectView): string {
  const lines: string[] = [`## Project: ${p.projectKey}`, ""];
  if (p.gapsPending) {
    lines.push("> ⏳ **Gaps pending evaluation** — the continuity state changed since gaps were last evaluated; the gap list below may be stale.", "");
  }
  lines.push("### Current focus", mdList(p.currentFocus), "", "### Latest progress", mdList(p.latestProgress), "");
  lines.push("### Next steps", mdList(p.nextSteps), "", "### Open loops", mdList(p.openLoops), "");
  lines.push(`### Gaps (${p.gaps.length}${p.gapsPending ? ", evaluation pending" : ""})`, "");
  if (p.gapsPending) {
    // Never present stale evaluation as a clean bill of health (Codex F2).
    lines.push("_Gap evaluation is pending for this project — the list below is NOT a complete evaluation against the latest state._", "");
  } else if (p.gaps.length === 0) {
    lines.push("_No open gaps detected on Rúnir-resident evidence._", "");
  }
  if (p.gaps.length > 0) {
    for (const g of p.gaps) {
      lines.push(`#### [${g.kind}] ${g.title}`);
      lines.push(`_confidence: ${g.confidence} · status: ${g.status} · first seen: ${g.firstSeenDate} · last seen: ${g.lastSeenDate}_`, "");
      lines.push(g.summary, "", `**Recommendation:** ${g.recommendation}`, "");
      if (g.evidence.length > 0) {
        lines.push("<details><summary>Evidence</summary>", "");
        for (const e of g.evidence) {
          lines.push(`- **${e.sourceType}** ${e.label}${e.date ? ` (${e.date})` : ""}${e.excerpt ? `: ${e.excerpt}` : ""}`);
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
    `# Daily Continuity Report — ${model.date}`,
    "",
    `_user: ${model.userId} · lookback: ${model.lookbackDays}d_`,
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
  lines.push(`**Not yet evaluated** (awaiting Leit S-2 evidence): ${model.notYetEvaluated.join(", ")}.`, "");
  if (model.skippedProjects.length > 0) lines.push(`**Skipped (inactive):** ${model.skippedProjects.join(", ")}.`, "");
  if (model.pendingProjects.length > 0) lines.push(`**Gaps pending evaluation:** ${model.pendingProjects.join(", ")}.`, "");
  lines.push(
    "",
    "_Export manifest: generated from project_continuity_state + continuity_gap (output-only projection). Low-confidence (weak) signals are ordered by score and are advisory, not committed work._",
  );
  return lines.join("\n") + "\n";
}

export function renderJson(model: ReportModel): string {
  return JSON.stringify(model, null, 2) + "\n";
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlList(items: string[]): string {
  if (items.length === 0) return "<p class='muted'>(none)</p>";
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function renderProjectHtml(p: ProjectView): string {
  const gapHtml =
    p.gapsPending
      ? "<p class='pending'>Gap evaluation is pending for this project — the list below is NOT a complete evaluation against the latest state.</p>" +
        p.gaps
          .map(
            (g) => `<article class="gap ${esc(g.kind)}"><h4>[${esc(g.kind)}] ${esc(g.title)}</h4><p>${esc(g.summary)}</p></article>`,
          )
          .join("")
      : p.gaps.length === 0
      ? "<p class='muted'>No open gaps detected on Rúnir-resident evidence.</p>"
      : p.gaps
          .map(
            (g) => `<article class="gap ${esc(g.kind)}">
      <h4>[${esc(g.kind)}] ${esc(g.title)}</h4>
      <p class="meta">confidence: ${esc(g.confidence)} · status: ${esc(g.status)} · first seen: ${esc(g.firstSeenDate)} · last seen: ${esc(g.lastSeenDate)}</p>
      <p>${esc(g.summary)}</p>
      <p class="rec"><b>Recommendation:</b> ${esc(g.recommendation)}</p>
      ${
        g.evidence.length > 0
          ? `<details><summary>Evidence</summary><ul>${g.evidence
              .map(
                (e) =>
                  `<li><b>${esc(e.sourceType)}</b> ${esc(e.label)}${e.date ? ` (${esc(e.date)})` : ""}${e.excerpt ? `: ${esc(e.excerpt)}` : ""}</li>`,
              )
              .join("")}</ul></details>`
          : ""
      }
    </article>`,
          )
          .join("");
  return `<section class="project">
    <h3>${esc(p.projectKey)}</h3>
    ${p.gapsPending ? `<p class="pending">⏳ Gaps pending evaluation — the gap list may be stale.</p>` : ""}
    <h5>Current focus</h5>${htmlList(p.currentFocus)}
    <h5>Next steps</h5>${htmlList(p.nextSteps)}
    <h5>Open loops</h5>${htmlList(p.openLoops)}
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
    // Belt-and-suspenders: the model is already sanitized, but the final choke
    // sanitizes ALL content so no bypass is possible.
    await writeFile(fullPath, sanitizeForDisk(content), "utf-8");
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
      skippedProjects.push(projectKey);
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
      skippedProjects.push(projectKey); // no-op: content unchanged since last report
      continue;
    }

    projects.push(view);
    await Promise.all(view.gapIds.map((gapId) => markGapReported(db, gapId, `${date}T00:00:00.000Z`)));
    if (view.gapsPending) {
      pendingProjects.push(projectKey);
    } else {
      // Advance the cursor only for a fully-evaluated project; reportedThrough is
      // the evaluated-through watermark, not the raw state timestamp.
      await writeContinuityReportState(db, userId, workspaceId, projectKey, view.contentHash, evaluatedThrough ?? "");
    }
  }

  const model: ReportModel = {
    date,
    userId,
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
