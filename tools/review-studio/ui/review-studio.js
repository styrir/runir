/* global document, window */
const launchToken = typeof document === "undefined" ? "" : document.querySelector('meta[name="runir-launch-token"]')?.getAttribute("content") || "";
const csrfToken = typeof document === "undefined" ? "" : document.querySelector('meta[name="runir-csrf-token"]')?.getAttribute("content") || "";
const root = typeof document === "undefined" ? null : document.querySelector("#review-studio");

const TRACE_RATINGS = ["helped", "hurt", "unused", "missing", "stale"];

const METRICS = {
  schemaValidRate: ["Schema-valid rate", "higher_is_better"],
  meanAtomicPrecision: ["Atomic precision", "higher_is_better"],
  meanAtomicRecall: ["Atomic recall", "higher_is_better"],
  meanHallucinationRate: ["Hallucination rate", "lower_is_better"],
  meanOmissionRate: ["Omission rate", "lower_is_better"],
  abstentionAccuracy: ["Abstention accuracy", "higher_is_better"],
  p50LatencyMs: ["p50 latency", "lower_is_better"],
  p95LatencyMs: ["p95 latency", "lower_is_better"],
  meanLatencyMs: ["Mean latency", "lower_is_better"],
  validCompletionRate: ["Valid completion", "higher_is_better"],
  timeoutRate: ["Timeout rate", "lower_is_better"],
  meanOutputTokens: ["Mean output tokens", "lower_is_better"],
  meanCostPerExtraction: ["Mean cost / extraction", "lower_is_better"],
  projectedCostPer1000Turns: ["Projected cost / 1k", "lower_is_better"],
  schemaValid: ["Schema valid", "higher_is_better"],
  atomicPrecision: ["Atomic precision", "higher_is_better"],
  atomicRecall: ["Atomic recall", "higher_is_better"],
  hallucinationRate: ["Hallucination rate", "lower_is_better"],
  omissionRate: ["Omission rate", "lower_is_better"],
  latencyMs: ["Latency", "lower_is_better"],
  completionTokens: ["Completion tokens", "lower_is_better"],
  estimatedCostUsd: ["Estimated cost", "lower_is_better"],
};

const state = {
  view: "runs",
  runs: [],
  diagnostics: [],
  duplicateRunIds: [],
  generatedAt: "",
  baselineId: "",
  candidateId: "",
  comparison: null,
  comparisonError: null,
  allowPairing: false,
  contributors: [],
  contributorLabel: "",
  runDetail: null,
  caseSelection: null,
  caseData: null,
  caseLoading: false,
  rawEvidence: null,
  drawerOpen: false,
  filter: "",
  loading: true,
  error: null,
  traceEnabled: false,
  traceLimit: 20,
  traces: [],
  traceCoverage: null,
  traceLoading: false,
  traceLoaded: false,
  traceError: null,
  traceFilters: { intent: "", lane: "", path: "", hexis: "", rating: "", answer: "", capture: "", from: "", to: "" },
  selectedTrace: null,
  selectedTraceLoading: false,
  selectedTraceError: null,
  selectedMemoryId: "",
  lineage: null,
  lineageLoading: false,
  lineageError: null,
  ratingSaving: false,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

function json(value) { return escapeHtml(JSON.stringify(value, null, 2)); }
function enc(value) { return encodeURIComponent(value); }
function labelFor(metric) { return METRICS[metric]?.[0] || metric; }
function isRate(metric) { return /Rate$|Accuracy$|Precision$|Recall$|Fidelity$|Compliance$|Correct$|SuccessRate$/.test(metric); }

function formatMetric(metric, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (isRate(metric)) return `${(Number(value) * 100).toFixed(1)}%`;
  if (/Cost|Usd/.test(metric)) return `$${Number(value).toFixed(4)}`;
  if (/Latency|Tokens/.test(metric)) return `${Number(value).toFixed(0)}${/Latency/.test(metric) ? " ms" : ""}`;
  return Number(value).toFixed(3);
}

function formatDelta(metric, delta) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  if (isRate(metric)) return `${sign}${(Number(delta) * 100).toFixed(1)} pp`;
  if (/Cost|Usd/.test(metric)) return `${sign}$${Number(delta).toFixed(4)}`;
  if (/Latency|Tokens/.test(metric)) return `${sign}${Number(delta).toFixed(0)}${/Latency/.test(metric) ? " ms" : ""}`;
  return `${sign}${Number(delta).toFixed(3)}`;
}

function badge(text, tone = "neutral") { return `<span class="badge ${tone}">${escapeHtml(text)}</span>`; }

function statusBadges(run) {
  const p = run.provenance || {};
  const out = [];
  out.push(badge(p.compatibility === "verified" ? "verified provenance" : "legacy / unverified", p.compatibility === "verified" ? "good" : "warn"));
  if (p.incomplete) out.push(badge("partial", "warn"));
  if (p.stopReason === "cost_cap") out.push(badge("cost cap", "warn"));
  if (p.gitDirty) out.push(badge("dirty git", "warn"));
  if (p.synthetic) out.push(badge("synthetic", "neutral"));
  if (p.dryRun) out.push(badge("dry-run", "neutral"));
  if (!out.length) out.push(badge("no flags"));
  return out.join("");
}

function runLabel(run) { return `${run.conditionId || run.runId} · ${run.catalogId}`; }

function aggregateDeltasForMetric(comparison, metric) {
  return (comparison?.aggregateDeltas || []).filter((delta) => Object.prototype.hasOwnProperty.call(delta?.metrics || {}, metric));
}

function candidateDescriptor(delta) {
  const aggregate = delta?.candidate || delta?.baseline;
  return {
    id: String(delta?.candidateId || aggregate?.candidateId || "unknown-candidate"),
    label: aggregate?.label ? String(aggregate.label) : "",
    modelId: aggregate?.modelId ? String(aggregate.modelId) : "",
  };
}

function renderCandidateLabel(delta) {
  const candidate = candidateDescriptor(delta);
  return `<span class="candidate-label"><strong>${escapeHtml(candidate.id)}</strong>${candidate.label ? `<small>${escapeHtml(candidate.label)}</small>` : ""}${candidate.modelId ? `<small class="mono">${escapeHtml(candidate.modelId)}</small>` : ""}</span>`;
}

function buildCaseSelection(comparison, key, baselineCatalogId, candidateCatalogId) {
  const delta = comparison?.caseDeltas?.find((item) => item.comparisonKey === key);
  if (!delta) return null;
  return {
    key,
    caseId: delta.caseId,
    repetition: delta.repetition,
    candidateId: delta.candidateId,
    availability: delta.availability,
    entries: [
      {
        catalogId: baselineCatalogId,
        runId: comparison.baselineRunId,
        side: "baseline",
        available: delta.baseline !== null && delta.baseline !== undefined,
      },
      {
        catalogId: candidateCatalogId,
        runId: comparison.candidateRunId,
        side: "candidate",
        available: delta.candidate !== null && delta.candidate !== undefined,
      },
    ],
  };
}

async function loadCaseEntries(selection, fetchCase) {
  const load = fetchCase || (async (entry) => (await api(`/api/cases/${enc(entry.catalogId)}?key=${enc(selection.key)}`)).case);
  return Promise.all(selection.entries.map(async (entry) => {
    if (!entry.available) return { ...entry, case: null, unavailableReason: "not present in this run" };
    try {
      return { ...entry, case: await load(entry), unavailableReason: "" };
    } catch (error) {
      const status = Number(error?.status);
      return {
        ...entry,
        case: null,
        unavailableReason: status === 404 ? "not present in this run" : "evidence unavailable",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

async function api(path) {
  const response = await fetch(path, {
    method: "GET",
    headers: { "X-Runir-Launch-Token": launchToken },
  });
  let payload;
  try { payload = await response.json(); } catch { payload = { message: `HTTP ${response.status}` }; }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Runir-Launch-Token": launchToken,
      "X-Runir-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = { message: `HTTP ${response.status}` }; }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function truncate(text, max = 150) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function traceAnswerState(trace) {
  return trace?.answer !== undefined || trace?.feedbackReceivedAt ? "present" : "absent";
}

function traceCaptureState(trace) {
  return trace?.captureReceipt ? "present" : "unavailable";
}

function traceMatchesFilters(trace) {
  const filters = state.traceFilters;
  const values = {
    intent: trace.intentLabel,
    lane: trace.laneLabel,
    path: trace.retrievalPath,
    hexis: [trace.hexisLabel, trace.hexisId].filter(Boolean).join(" "),
    rating: trace.rating,
    answer: traceAnswerState(trace),
    capture: traceCaptureState(trace),
  };
  for (const key of ["intent", "lane", "path", "hexis"]) {
    if (filters[key] && !String(values[key] || "").toLowerCase().includes(filters[key].toLowerCase())) return false;
  }
  for (const key of ["rating", "answer", "capture"]) {
    if (filters[key] && values[key] !== filters[key]) return false;
  }
  const createdAt = Date.parse(trace.createdAt || "");
  if (filters.from && (!Number.isFinite(createdAt) || createdAt < Date.parse(filters.from))) return false;
  if (filters.to && (!Number.isFinite(createdAt) || createdAt > Date.parse(filters.to))) return false;
  return true;
}

function shell(viewMarkup) {
  const views = ["runs", "compare", "case", ...(state.traceEnabled ? ["receipts"] : [])];
  const nav = views.map((view) => `<button class="nav-button" data-view="${view}" aria-current="${state.view === view ? "page" : "false"}">${view === "case" ? "Case detail" : view === "receipts" ? "Recall receipts" : view}</button>`).join("");
  const stamp = state.traceEnabled ? `<strong>LOCAL PROXY</strong>loopback only<br>trace reads on demand<br>one narrow rating write` : `<strong>OFFLINE SURFACE</strong>no paid execution<br>no network assets<br>read-only catalog`;
  return `<div class="studio-shell">
    <header class="masthead">
      <div class="brand-lockup"><p class="eyebrow">Rúnir / local evidence review</p><h1 class="wordmark">Evidence<br>Light Table</h1><p class="dek">A rebuildable, credential-free lens on benchmark runs. Every mark points back to the rows that made it.</p></div>
      <div class="header-stamp">${stamp}</div>
    </header>
    <nav class="primary-nav" aria-label="Primary navigation">${nav}</nav>
    <main class="content">${viewMarkup}</main>
    <aside class="drawer" id="evidence-drawer" ${state.drawerOpen ? "" : "hidden"} aria-label="Exact evidence drawer">${renderDrawer()}</aside>
  </div>`;
}

function renderDrawer() {
  if (!state.drawerOpen) return "";
  return `<div class="drawer-head"><div><p class="eyebrow">Exact evidence</p><h2>Raw contribution</h2></div><button class="button-quiet" data-close-drawer>Close</button></div>
    ${state.rawEvidence ? `<p class="card-caption">Sanitized by the producer adapter. Artifact paths and credential-like fields remain redacted.</p><div class="evidence-block"><h4>Manifest</h4><pre>${json(state.rawEvidence.manifest)}</pre></div><div class="evidence-block"><h4>Raw row</h4><pre>${json(state.rawEvidence.row)}</pre></div><p class="card-caption">Unknown manifest fields: ${escapeHtml((state.rawEvidence.unknownManifestFields || []).join(", ") || "none")}<br>Unknown row fields: ${escapeHtml((state.rawEvidence.unknownRowFields || []).join(", ") || "none")}</p>` : `<p class="loading">Loading exact evidence…</p>`}`;
}

function renderRuns() {
  const filter = state.filter.trim().toLowerCase();
  const runs = state.runs.filter((run) => !filter || JSON.stringify(run).toLowerCase().includes(filter));
  const diagnostics = state.diagnostics.length || state.duplicateRunIds.length;
  return `<div class="section-intro"><div><p class="eyebrow">01 / run ledger</p><h2>Runs</h2><p>One line per immutable bundle. Flags are evidence conditions, not a single health score.</p></div><div class="control-row"><button class="button-quiet" data-refresh>Rebuild catalog</button><button class="button-quiet" data-print>Print</button></div></div>
    ${diagnostics ? `<div class="notice"><div>${badge("catalog notes", "warn")}</div><p>${state.duplicateRunIds.length ? `${state.duplicateRunIds.length} duplicate run ID(s) surfaced. ` : ""}${state.diagnostics.length} scan/adaptation diagnostic(s) remain visible below the ledger.</p></div>` : ""}
    <div class="control-row space-below"><label for="run-filter">Filter ledger</label><input id="run-filter" data-filter value="${escapeHtml(state.filter)}" placeholder="run id, model, suite, state…" autocomplete="off"></div>
    ${runs.length ? `<div class="ledger-card"><table class="ledger"><thead><tr><th>Run</th><th>Evidence state</th><th>Suite / provenance</th><th>Matrix</th><th>Rows</th><th>Artifact</th></tr></thead><tbody>${runs.map(renderRunRow).join("")}</tbody></table></div>` : `<div class="empty-state"><h3>${state.runs.length ? "No runs match the filter" : "No reviewable artifacts"}</h3><p>${state.runs.length ? "Clear the filter to return to the complete ledger." : "Start with an explicit --root containing paired .manifest.json and .jsonl artifacts. The catalog never scans outside those roots."}</p></div>`}
    ${state.diagnostics.length ? `<details class="paper-card card-pad section-stack"><summary>Catalog diagnostics (${state.diagnostics.length})</summary><div class="contributors">${state.diagnostics.map((item) => `<div class="contributor-row"><div><strong>${escapeHtml(item.code)}</strong><small>${escapeHtml(item.message)}${item.relativePath ? ` · ${escapeHtml(item.relativePath)}` : ""}</small></div>${badge(item.severity, item.severity === "error" || item.severity === "warning" ? "warn" : "neutral")}</div>`).join("")}</div></details>` : ""}`;
}

function renderRunRow(run) {
  const candidateText = (run.candidates || []).map((candidate) => candidate.label || candidate.id).join(", ");
  return `<tr><td><button class="ledger-run" data-open-run="${escapeHtml(run.catalogId)}">${escapeHtml(run.conditionId || run.runId)}<small>${run.conditionId ? `${escapeHtml(run.runId)} · ` : ""}${escapeHtml(run.createdAt)} · <span class="mono">${escapeHtml(run.git?.sha || "unknown")}</span></small></button></td><td><div class="badge-row">${statusBadges(run)}</div></td><td><span class="mono">${escapeHtml(run.suiteId)}</span><small class="muted">${escapeHtml(run.suiteVersion)}</small></td><td>${escapeHtml(candidateText || "declared matrix unavailable")}</td><td><span class="mono">${escapeHtml(run.caseCount)}</span><small class="muted">${escapeHtml(run.provenance?.expectedRowCount ?? "planned n/a")} planned</small></td><td><span class="mono">${escapeHtml(run.artifact?.rootLabel || "root")}</span><small class="muted">${escapeHtml(run.artifact?.relativeManifest || "")}</small></td></tr>`;
}

function renderCompare() {
  if (!state.runs.length) return `<div class="section-intro"><div><p class="eyebrow">02 / comparison canvas</p><h2>Compare</h2></div></div><div class="empty-state"><h3>Comparison waits for evidence</h3><p>Load at least two explicit artifact runs to compare stable case identities.</p></div>`;
  const baseline = state.runs.find((run) => run.catalogId === state.baselineId) || state.runs[0];
  const candidate = state.runs.find((run) => run.catalogId === state.candidateId);
  if (!state.baselineId) state.baselineId = baseline.catalogId;
  const options = state.runs.map((run) => `<option value="${escapeHtml(run.catalogId)}" ${run.catalogId === state.baselineId ? "selected" : ""}>${escapeHtml(runLabel(run))} · ${escapeHtml(run.provenance?.compatibility === "verified" ? "verified" : "legacy")}</option>`).join("");
  const candidateOptions = state.runs.map((run) => `<option value="${escapeHtml(run.catalogId)}" ${run.catalogId === state.candidateId ? "selected" : ""}>${escapeHtml(runLabel(run))} · ${escapeHtml(run.suiteVersion === baseline.suiteVersion ? "same suite" : "incompatible suite")}</option>`).join("");
  return `<div class="section-intro"><div><p class="eyebrow">02 / comparison canvas</p><h2>Compare</h2><p>Shapes are chosen for the question: dumbbells for aggregate deltas, a distribution for latency, and a heatmap for case-level drift.</p></div><div class="control-row"><button class="button-quiet" data-print>Print</button><button class="button-quiet" data-export-comparison ${state.comparison ? "" : "disabled"}>Export JSON</button></div></div>
    <div class="compare-toolbar"><div class="selector-block"><label for="baseline-select">Baseline / control</label><select id="baseline-select" data-baseline>${options}</select></div><div class="versus">VS</div><div class="selector-block"><label for="candidate-select">Candidate / specimen</label><select id="candidate-select" data-candidate>${candidateOptions}</select></div></div>
    <div class="control-row space-below"><label><input type="checkbox" data-allow-pairing ${state.allowPairing ? "checked" : ""}> allow explicit legacy/incompatible pairing</label><button class="button-primary" data-load-comparison>Load comparison</button>${candidate ? `<span class="muted mono">${escapeHtml(candidate.provenance?.compatibility === "verified" ? "hash-stamped" : "unverified")}</span>` : ""}</div>
    ${state.comparisonError ? `<div class="notice"><div>${badge("comparison blocked", "warn")}</div><p>${escapeHtml(state.comparisonError.message || "The selected runs are not compatible by default.")} ${state.comparisonError.payload?.compatibility?.reasons?.join(" ") || "Use the explicit pairing control only when a human accepts the provenance warning."}</p></div>` : ""}
    ${state.comparison ? renderComparison(state.comparison) : `<div class="empty-state"><h3>Choose two runs</h3><p>Compatible hash-stamped runs are the default path. Legacy runs and suite mismatches remain selectable so their refusal is visible.</p></div>`}`;
}

function renderComparison(comparison) {
  const status = comparison.compatibility?.status;
  const tone = status === "compatible" ? "good" : "warn";
  const preferredMetricIds = ["meanAtomicPrecision", "meanAtomicRecall", "meanHallucinationRate", "meanOmissionRate", "p95LatencyMs", "meanCostPerExtraction"];
  const allAggregateMetricIds = [...new Set(comparison.aggregateDeltas.flatMap((delta) => Object.keys(delta.metrics || {})))];
  const metricIds = [...preferredMetricIds.filter((metric) => allAggregateMetricIds.includes(metric)), ...allAggregateMetricIds.filter((metric) => !preferredMetricIds.includes(metric))];
  const caseMetricIds = ["atomicPrecision", "atomicRecall", "hallucinationRate", "omissionRate", "latencyMs", "evidenceFidelity"];
  const baseline = state.runs.find((run) => run.catalogId === state.baselineId);
  const candidate = state.runs.find((run) => run.catalogId === state.candidateId);
  return `<div class="notice ${status === "compatible" ? "good" : ""}"><div>${badge(status || "unknown", tone)}</div><p>${escapeHtml((comparison.compatibility?.reasons || []).join(" "))} ${escapeHtml((comparison.compatibility?.warnings || []).join(" "))} ${comparison.compatibility?.pairing === "explicit-override" ? "Human pairing override is recorded." : ""}</p></div>
    <div class="compare-grid"><section class="paper-card card-pad"><h3>Aggregate deltas</h3><p class="card-caption">Candidate minus baseline. Every candidate in the matrix gets its own row; direction is metric metadata and no composite health score is invented.</p><table class="metric-table"><thead><tr><th>Metric</th><th>Candidate identity</th><th>Baseline</th><th>Candidate</th><th>Delta</th></tr></thead><tbody>${metricIds.map((metric) => aggregateDeltasForMetric(comparison, metric).map((delta) => renderAggregateMetric(delta, metric)).join("")).join("")}</tbody></table></section><section class="paper-card card-pad"><h3>Dumbbell field</h3><p class="card-caption">Each candidate has a labeled dumbbell. Click a mark to list that candidate's contributing case rows.</p>${renderDumbbells(comparison, metricIds)}</section></div>
    <section class="paper-card card-pad section-stack"><h3>Latency distribution</h3><p class="card-caption">Each bar is a bucket of exact latency rows; click one to reveal contributors.</p>${renderLatencyDistribution(comparison)}<div class="distribution-legend"><span><i class="legend-dot"></i>baseline</span><span><i class="legend-dot amber"></i>candidate</span></div></section>
    <section class="paper-card card-pad section-stack"><h3>Regression heatmap</h3><p class="card-caption">Case × metric. Amber is a worse candidate delta, teal is an improvement. Every cell opens exact evidence.</p><div class="heatmap-wrap">${renderHeatmap(comparison, caseMetricIds)}</div>${state.contributors.length ? renderContributors() : ""}</section>
    ${baseline && candidate ? `<p class="card-caption section-stack">Compared <span class="mono">${escapeHtml(baseline.runId)}</span> against <span class="mono">${escapeHtml(candidate.runId)}</span>. Raw rows remain behind the case drawer.</p>` : ""}`;
}

function renderAggregateMetric(delta, metric) {
  const value = delta?.metrics?.[metric];
  const base = delta?.baseline?.metrics?.[metric];
  const cand = delta?.candidate?.metrics?.[metric];
  const candidate = candidateDescriptor(delta);
  return `<tr><td><button class="metric-link" data-open-metric="${escapeHtml(metric)}" data-open-candidate="${escapeHtml(candidate.id)}">${escapeHtml(labelFor(metric))}</button></td><td>${renderCandidateLabel(delta)}</td><td>${formatMetric(metric, base)}</td><td>${formatMetric(metric, cand)}</td><td class="delta-${escapeHtml(value?.assessment || "unknown")}">${formatDelta(metric, value?.delta)} <small>${escapeHtml(value?.assessment || "unknown")}</small></td></tr>`;
}

function renderDumbbells(comparison, metrics) {
  if (!metrics.length) return `<p class="muted">No shared aggregate metrics are available.</p>`;
  const rows = comparison.aggregateDeltas.flatMap((delta) => {
    const selectedMetrics = metrics.slice(0, 6).filter((metric) => Object.prototype.hasOwnProperty.call(delta.metrics || {}, metric));
    const renderMetrics = selectedMetrics.length ? selectedMetrics : Object.keys(delta.metrics || {}).slice(0, 1);
    return renderMetrics.map((metric) => renderDumbbell(delta, metric));
  });
  return `<div class="dumbbell-list">${rows.join("")}</div>`;
}

function renderDumbbell(delta, metric) {
  const metricDelta = delta?.metrics?.[metric];
  const baseValue = delta?.baseline?.metrics?.[metric];
  const candidateValue = delta?.candidate?.metrics?.[metric];
  const base = typeof baseValue === "number" && Number.isFinite(baseValue) ? baseValue : null;
  const cand = typeof candidateValue === "number" && Number.isFinite(candidateValue) ? candidateValue : null;
  const values = [base, cand].filter((value) => value !== null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min || 1;
  const left = (value) => 12 + ((value - min) / span) * 76;
  const baseLeft = base === null ? 12 : left(base);
  const candLeft = cand === null ? 88 : left(cand);
  const assessment = metricDelta?.assessment || "unknown";
  const candidate = candidateDescriptor(delta);
  const link = base !== null && cand !== null ? `<line class="dumbbell-link-line" x1="${Math.min(baseLeft, candLeft)}" y1="6" x2="${Math.max(baseLeft, candLeft)}" y2="6"></line>` : "";
  const basePoint = base === null ? "" : `<circle class="dumbbell-point base" cx="${baseLeft}" cy="6" r="2.5"></circle>`;
  const candidatePoint = cand === null ? "" : `<circle class="dumbbell-point candidate ${assessment === "regressed" ? "regressed" : ""}" cx="${candLeft}" cy="6" r="2.5"></circle>`;
  return `<button class="dumbbell" data-open-metric="${escapeHtml(metric)}" data-open-candidate="${escapeHtml(candidate.id)}" aria-label="Open cases contributing to ${escapeHtml(labelFor(metric))} for ${escapeHtml(candidate.id)}"><span class="dumbbell-label"><span>${escapeHtml(labelFor(metric))}</span>${renderCandidateLabel(delta)}<span class="delta-${escapeHtml(assessment)}">${escapeHtml(formatDelta(metric, metricDelta?.delta))}</span></span><svg class="dumbbell-chart" viewBox="0 0 100 12" role="img" aria-label="${escapeHtml(labelFor(metric))} for ${escapeHtml(candidate.id)} baseline to candidate"> <line class="dumbbell-axis" x1="4" y1="6" x2="96" y2="6"></line>${link}${basePoint}${candidatePoint}</svg><span class="axis-note"><span>baseline ${escapeHtml(formatMetric(metric, base))}</span><span>candidate ${escapeHtml(formatMetric(metric, cand))}</span></span></button>`;
}

function renderLatencyDistribution(comparison) {
  const values = comparison.caseDeltas.flatMap((delta) => {
    const entries = [];
    if (delta.baseline?.metrics?.latencyMs !== null && delta.baseline?.metrics?.latencyMs !== undefined) {
      entries.push({ value: delta.baseline.metrics.latencyMs, side: "baseline", key: delta.comparisonKey });
    }
    if (delta.candidate?.metrics?.latencyMs !== null && delta.candidate?.metrics?.latencyMs !== undefined) {
      entries.push({ value: delta.candidate.metrics.latencyMs, side: "candidate", key: delta.comparisonKey });
    }
    return entries;
  });
  if (!values.length) return `<div class="empty-state"><p>No latency values in the selected rows.</p></div>`;
  const min = Math.min(...values.map((item) => item.value));
  const max = Math.max(...values.map((item) => item.value));
  const span = max - min || 1;
  const bins = Array.from({ length: 10 }, () => ({ baseline: [], candidate: [] }));
  for (const item of values) {
    const index = Math.min(9, Math.floor(((item.value - min) / span) * 10));
    bins[index][item.side].push(item);
  }
  const peak = Math.max(1, ...bins.flatMap((bin) => [bin.baseline.length, bin.candidate.length]));
  return `<div class="distribution" aria-label="Latency distribution">${bins.map((bin, index) => {
    const height = Math.max(6, (Math.max(bin.baseline.length, bin.candidate.length) / peak) * 100);
    return `<button class="distribution-bar ${bin.candidate.length >= bin.baseline.length ? "candidate" : ""}" data-open-latency="${index}" aria-label="Open latency bucket ${index + 1} contributors"><span class="count">${bin.baseline.length}/${bin.candidate.length}</span><svg class="distribution-glyph" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true"><rect class="distribution-rect" x="1" y="${100 - height}" width="8" height="${height}"></rect></svg><span class="bin-label">${Math.round(min + (span * index) / 10)}–${Math.round(min + (span * (index + 1)) / 10)}</span></button>`;
  }).join("")}</div>`;
}

function renderHeatmap(comparison, metrics) {
  const ids = metrics.filter((metric) => !/^p\d|meanCost|projectedCost/.test(metric)).slice(0, 6);
  if (!comparison.caseDeltas.length || !ids.length) return `<div class="empty-state"><p>No aligned cases or metrics are available for the heatmap.</p></div>`;
  return `<table class="heatmap"><thead><tr><th>Case / candidate / repetition</th>${ids.map((metric) => `<th>${escapeHtml(labelFor(metric))}</th>`).join("")}</tr></thead><tbody>${comparison.caseDeltas.map((delta) => { const candidate = candidateDescriptor(delta); const availability = delta.availability === "both" ? "" : `<span class="case-availability">${escapeHtml(delta.availability.replace("-", " "))}</span>`; return `<tr><th><button class="metric-link" data-open-case="${escapeHtml(delta.comparisonKey)}">${escapeHtml(delta.caseId)}${renderCandidateLabel(delta)}<span class="mono">r${escapeHtml(delta.repetition)}</span>${availability}</button></th>${ids.map((metric) => { const item = delta.metrics?.[metric] || { assessment: "unknown", delta: null }; return `<td><button class="heatmap-cell ${escapeHtml(item.assessment)}" data-open-case="${escapeHtml(delta.comparisonKey)}" aria-label="Open ${escapeHtml(delta.caseId)} for candidate ${escapeHtml(candidate.id)} ${escapeHtml(labelFor(metric))}">${escapeHtml(formatDelta(metric, item.delta))}</button></td>`; }).join("")}</tr>`; }).join("")}</tbody></table>`;
}

function renderContributors() {
  return `<div class="contributors"><p class="eyebrow section-stack">${escapeHtml(state.contributorLabel || "Contributing rows")}</p>${state.contributors.map((item) => `<div class="contributor-row"><div><strong>${escapeHtml(item.caseId)} <span class="muted">${escapeHtml(item.candidateId)} · r${escapeHtml(item.repetition)}</span></strong><small>${escapeHtml(item.comparisonKey)} · ${escapeHtml(item.availability)}</small></div><button class="button-quiet" data-open-case="${escapeHtml(item.comparisonKey)}">Open evidence</button></div>`).join("")}</div>`;
}

function renderCase() {
  if (state.caseLoading) return `<div class="section-intro"><div><p class="eyebrow">03 / exact evidence</p><h2>Case detail</h2></div></div><p class="loading">Loading exact contributing rows…</p>`;
  if (!state.caseData) return `<div class="section-intro"><div><p class="eyebrow">03 / exact evidence</p><h2>Case detail</h2><p>Open a run row or a chart mark to bring its exact evidence here.</p></div></div><div class="empty-state"><h3>Nothing selected</h3><p>The comparison canvas is intentionally sparse until a stable case key is selected.</p></div>`;
  const entries = state.caseData.entries || [];
  const firstCase = entries.find((entry) => entry.case)?.case;
  const exportEntry = entries.find((entry) => entry.case) || entries.find((entry) => entry.available);
  const selection = state.caseSelection || {};
  return `<div class="case-head"><div><p class="eyebrow">03 / exact evidence</p><h2>${escapeHtml(firstCase?.caseId || selection.caseId || "Selected case")}</h2><p class="case-meta">comparison key <span class="mono">${escapeHtml(firstCase?.comparisonKey || selection.key || "")}</span></p></div><div class="control-row"><button class="button-quiet" data-print>Print</button>${exportEntry ? `<button class="button-quiet" data-export-run="${escapeHtml(exportEntry.catalogId)}">Export run JSON</button>` : ""}</div></div>
    <div class="badge-row space-below">${entries.map((entry) => `${badge(`${entry.side} · ${entry.runId || "run unavailable"}`, entry.case ? "dark" : "warn")}${entry.case ? "" : ` ${badge(entry.unavailableReason || "evidence unavailable", "warn")}`}`).join("")}</div>
    <div class="case-columns">${entries.map((entry) => renderCaseColumn(entry)).join("")}</div>`;
}

function renderCaseColumn(entry) {
  const item = entry.case;
  if (!item) {
    const reason = entry.unavailableReason || "evidence unavailable";
    return `<section class="paper-card card-pad evidence-column evidence-unavailable-column"><h3>${escapeHtml(entry.side)}</h3><p class="case-meta">run <span class="mono">${escapeHtml(entry.runId || "run unavailable")}</span></p><div class="evidence-unavailable"><strong>${escapeHtml(reason)}</strong><span>${entry.errorMessage ? escapeHtml(entry.errorMessage) : "This case has no loaded evidence in this run."}</span></div></section>`;
  }
  const row = item.rawEvidence?.row || {};
  return `<section class="paper-card card-pad evidence-column"><h3>${escapeHtml(entry.side)}</h3><p class="case-meta">${escapeHtml(item.candidateId)} · repetition ${escapeHtml(item.repetition)} · ${badge(item.status, item.status === "pass" ? "good" : item.status === "fail" || item.status === "error" ? "warn" : "neutral")}</p><div class="metric-pills">${Object.entries(item.metrics || {}).filter(([, value]) => value !== null).slice(0, 8).map(([metric, value]) => `<span class="metric-pill">${escapeHtml(labelFor(metric))}: <strong>${escapeHtml(formatMetric(metric, value))}</strong></span>`).join("")}</div><div class="evidence-block"><h4>Input / row reference</h4><pre>${escapeHtml(`case: ${item.inputRef?.locator || item.caseId}\nrow: ${item.outputRef?.locator || item.comparisonKey}`)}</pre></div><div class="evidence-block"><h4>Output / parser</h4><pre>${json({ parse: row.parse, diagnostics: item.diagnostics })}</pre></div><div class="evidence-block"><h4>Request / scoring</h4><pre>${json({ effectiveRequest: row.effectiveRequest, quality: row.quality, usage: row.usage, latencyMs: row.latencyMs, retryCount: row.retryCount, errorClass: row.errorClass })}</pre></div><button class="button-primary" data-open-raw="${escapeHtml(entry.catalogId)}" data-raw-key="${escapeHtml(item.comparisonKey)}">Open exact raw evidence</button></section>`;
}

function traceStatus(trace) {
  return `${trace.items?.length ?? 0} selected · answer ${traceAnswerState(trace)} · capture ${traceCaptureState(trace)}`;
}

function renderTraceFilters() {
  const f = state.traceFilters;
  const option = (value, label, current) => `<option value="${escapeHtml(value)}" ${current === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  return `<div class="receipt-filters paper-card card-pad"><div class="filter-heading"><div><p class="eyebrow">bounded window filters</p><h3>Find a receipt</h3></div><label class="limit-control">Latest <select data-trace-limit aria-label="Latest trace limit">${[20, 50, 100, 200].map((value) => option(String(value), String(value), String(state.traceLimit))).join("")}</select></label></div>
    <div class="receipt-filter-grid"><label>Intent<input data-trace-filter="intent" value="${escapeHtml(f.intent)}" placeholder="status, reference…"></label><label>Lane<input data-trace-filter="lane" value="${escapeHtml(f.lane)}" placeholder="latest_state…"></label><label>Path<input data-trace-filter="path" value="${escapeHtml(f.path)}" placeholder="hybrid…"></label><label>Hexis<input data-trace-filter="hexis" value="${escapeHtml(f.hexis)}" placeholder="label or id…"></label><label>Rating<select data-trace-filter="rating">${option("", "Any rating", f.rating)}${TRACE_RATINGS.map((value) => option(value, value, f.rating)).join("")}</select></label><label>Answer<select data-trace-filter="answer">${option("", "Any answer", f.answer)}${option("present", "Present", f.answer)}${option("absent", "Absent", f.answer)}</select></label><label>Capture<select data-trace-filter="capture">${option("", "Any capture", f.capture)}${option("present", "Present", f.capture)}${option("unavailable", "Not in list", f.capture)}</select></label><label>From<input type="datetime-local" data-trace-filter="from" value="${escapeHtml(f.from)}"></label><label>To<input type="datetime-local" data-trace-filter="to" value="${escapeHtml(f.to)}"></label></div></div>`;
}

function renderTraceList() {
  const traces = state.traces.filter(traceMatchesFilters);
  if (!traces.length) {
    const empty = state.traceCoverage?.emptyState === "never_selected_or_empty";
    return `<div class="empty-state receipt-empty"><h3>${empty ? "No selected receipts in this window" : state.traces.length ? "No receipts match these filters" : "No recall receipts returned"}</h3><p>${empty ? "Memory only records a receipt when a turn actually selected recallable memory. This is an empty latest-N window, not proof of historical absence." : state.traces.length ? "Clear one or more client-side filters to return to the bounded latest-N list." : "The configured Rúnir returned an empty latest-N list."}</p></div>`;
  }
  return `<div class="receipt-list">${traces.map((trace) => `<button class="receipt-row" data-open-trace="${escapeHtml(trace.id)}"><span class="receipt-row-top"><span class="mono">${escapeHtml(trace.createdAt || "timestamp unavailable")}</span>${trace.rating ? badge(trace.rating, trace.rating === "helped" ? "good" : trace.rating === "hurt" ? "warn" : "neutral") : badge("unrated", "neutral")}</span><strong>${escapeHtml(trace.intentLabel || "intent unavailable")} <span class="muted">/ ${escapeHtml(trace.laneLabel || "lane unavailable")}</span></strong><span class="receipt-row-prompt">${escapeHtml(truncate(trace.prompt || "Prompt excerpt unavailable", 180))}</span><small>${escapeHtml(traceStatus(trace))} · ${escapeHtml(trace.retrievalPath || "path unavailable")} ${trace.hexisLabel ? `· Hexis ${escapeHtml(trace.hexisLabel)}` : ""}</small><span class="receipt-row-id mono">${escapeHtml(trace.id)}</span></button>`).join("")}</div>`;
}

function renderFunnel(funnel) {
  if (!funnel || !funnel.available) return `<div class="evidence-unavailable"><strong>Candidate-count funnel unavailable</strong><span>${escapeHtml(funnel?.reason || "Persisted retrievalAudit fields are insufficient.")}</span></div>`;
  const peak = Math.max(1, ...funnel.stages.map((stage) => stage.count));
  return `<div class="funnel" aria-label="Persisted candidate count funnel">${funnel.stages.map((stage) => `<div class="funnel-stage"><div class="funnel-label"><strong>${escapeHtml(stage.label)}</strong><span class="mono">${escapeHtml(stage.count)}</span></div><progress class="funnel-progress" max="${peak}" value="${stage.count}" aria-label="${escapeHtml(stage.label)}: ${escapeHtml(stage.count)} of ${peak}">${escapeHtml(stage.count)} of ${peak}</progress><small class="muted">${escapeHtml(stage.sourceField)}</small></div>`).join("")}<p class="card-caption">Only persisted <span class="mono">retrievalAudit</span> counts are shown. Debug attribution and stage durations are excluded.</p></div>`;
}

function renderSelectedMemoryTable(trace) {
  const items = trace.items || [];
  if (!items.length) return `<div class="empty-state"><p>No selected-memory rows are present in this receipt.</p></div>`;
  return `<div class="memory-table-wrap"><table class="memory-table"><thead><tr><th>Memory</th><th>Score</th><th>Role</th><th>Hexis fit</th><th>Ranking evidence</th><th>Lineage</th></tr></thead><tbody>${items.map((item) => `<tr class="${state.selectedMemoryId === item.id ? "selected" : ""}"><td><strong class="mono">${escapeHtml(item.id)}</strong><small>${escapeHtml(item.path || "path unavailable")}</small></td><td class="mono">${Number.isFinite(item.score) ? Number(item.score).toFixed(3) : "—"}</td><td>${escapeHtml(item.memoryRole || "role unavailable")}</td><td class="mono">${typeof item.hexisFit === "number" ? Number(item.hexisFit).toFixed(2) : "—"}</td><td>${item.rankingExplanation?.length ? `<ul class="ranking-list">${item.rankingExplanation.map((explanation) => `<li>${escapeHtml(explanation)}</li>`).join("")}</ul>` : `<span class="muted">unavailable</span>`}</td><td><button class="button-quiet" data-open-lineage="${escapeHtml(item.id)}">Open timeline</button></td></tr>`).join("")}</tbody></table></div>`;
}

function renderLineage() {
  if (!state.selectedMemoryId) return `<div class="empty-state"><p>Select a memory above to request its user-scoped lineage.</p></div>`;
  if (state.lineageLoading) return `<p class="loading">Loading user-scoped lineage for <span class="mono">${escapeHtml(state.selectedMemoryId)}</span>…</p>`;
  if (state.lineageError) return `<div class="evidence-unavailable"><strong>Lineage evidence unavailable</strong><span>${escapeHtml(state.lineageError.message || "The selected memory has no available lineage response.")}</span></div>`;
  const entries = state.lineage?.lineage || [];
  if (!entries.length) return `<div class="evidence-unavailable"><strong>Lineage evidence unavailable</strong><span>No lifecycle entries were returned for this selected memory.</span></div>`;
  return `<div class="timeline">${entries.map((entry, index) => `<article class="timeline-entry"><div class="timeline-marker">${index + 1}</div><div><div class="timeline-head"><strong class="mono">${escapeHtml(entry.id || entry.memoryId || "memory id unavailable")}</strong>${entry.active === true ? badge("current", "good") : entry.active === false ? badge("inactive", "warn") : badge("state unavailable", "neutral")}</div><p class="case-meta">${escapeHtml(entry.createdAt || entry.created_at || "created timestamp unavailable")} ${entry.inactiveReason || entry.inactive_reason ? `· ${escapeHtml(entry.inactiveReason || entry.inactive_reason)}` : ""}</p><p class="timeline-detail">${entry.supersededById || entry.superseded_by ? `superseded by ${escapeHtml(entry.supersededById || entry.superseded_by)}` : entry.supersedesId || entry.supersedes ? `supersedes ${escapeHtml(entry.supersedesId || entry.supersedes)}` : "No supersession edge represented."}</p></div></article>`).join("")}</div><p class="card-caption">V1 shows only the existing lineage response. Create/merge ledgers, decay, commit/index events, shadow rows, and reverse trace lookup are evidence unavailable.</p>`;
}

function renderTraceDetail() {
  if (state.selectedTraceLoading) return `<div class="section-intro"><div><p class="eyebrow">receipt detail</p><h2>Recall Receipt</h2></div></div><p class="loading">Fetching the full verbatim receipt on demand…</p>`;
  if (state.selectedTraceError) return `<div class="section-intro"><div><p class="eyebrow">receipt detail</p><h2>Recall Receipt</h2></div></div><div class="notice"><div>${badge(state.selectedTraceError.payload?.error || "unavailable", "warn")}</div><p>${escapeHtml(state.selectedTraceError.message || "The receipt could not be opened.")}</p></div><button class="button-quiet" data-back-receipts>Back to receipts</button>`;
  const payload = state.selectedTrace;
  const trace = payload?.trace;
  if (!trace) return `<div class="empty-state"><h3>Select a receipt</h3><p>Open a row from the bounded latest-N list to inspect its verbatim evidence.</p></div>`;
  const answer = trace.captureReceipt?.answer ?? trace.answer;
  return `<div class="section-intro"><div><p class="eyebrow">receipt detail / on demand</p><h2>Recall Receipt</h2><p>Full prompt, injected context, and answer are loaded only for this selected trace.</p></div><div class="control-row"><button class="button-quiet" data-back-receipts>Back to receipts</button></div></div>
    <div class="receipt-detail-head paper-card card-pad"><div><div class="badge-row">${badge(trace.rating || "unrated", trace.rating === "helped" ? "good" : trace.rating === "hurt" ? "warn" : "neutral")} ${badge(trace.intentLabel || "intent unavailable", "dark")} ${badge(trace.retrievalPath || "path unavailable", "neutral")}</div><h3 class="receipt-id">${escapeHtml(trace.id)}</h3><p class="case-meta">${escapeHtml(trace.createdAt || "timestamp unavailable")} · ${escapeHtml(trace.laneLabel || "lane unavailable")} ${trace.hexisLabel ? `· Hexis ${escapeHtml(trace.hexisLabel)}` : ""}</p></div><div class="rating-panel"><span class="eyebrow">human recall label</span><div class="rating-buttons">${TRACE_RATINGS.map((rating) => `<button class="button-${rating === "hurt" ? "warn" : rating === trace.rating ? "primary" : "quiet"}" data-rate="${rating}" ${state.ratingSaving ? "disabled" : ""}>${rating}</button>`).join("")}</div>${trace.ratingNote ? `<small class="muted">note: ${escapeHtml(trace.ratingNote)}</small>` : ""}</div></div>
    <div class="receipt-detail-grid"><section class="paper-card card-pad"><h3>Retrieval receipt</h3><p class="card-caption">Persisted selection evidence and ranking counters for this turn.</p>${renderSelectedMemoryTable(trace)}</section><section class="paper-card card-pad"><h3>Candidate-count funnel</h3>${renderFunnel(payload.review?.candidateFunnel)}</section></div>
    <section class="paper-card card-pad evidence-panels"><h3>Verbatim evidence</h3><details open><summary>Prompt</summary><pre>${escapeHtml(trace.prompt || "Prompt unavailable")}</pre></details><details><summary>Injected context</summary><pre>${escapeHtml(trace.prependContext || "Injected context was not stored for this receipt.")}</pre></details><details><summary>Answer</summary><pre>${escapeHtml(answer || "Answer unavailable: no feedback or capture receipt is stored.")}</pre></details>${trace.captureReceipt ? `<details><summary>Capture receipt</summary><pre>${json(trace.captureReceipt)}</pre></details>` : ""}</section>
    <section class="paper-card card-pad"><div class="section-intro compact"><div><p class="eyebrow">memory lifecycle</p><h3>Lineage timeline</h3><p>Selected memory <span class="mono">${escapeHtml(state.selectedMemoryId || "none")}</span>. The request is user-scoped and made only after selection.</p></div></div>${renderLineage()}</section>`;
}

function renderReceipts() {
  if (!state.traceEnabled) return `<div class="section-intro"><div><p class="eyebrow">04 / recall receipts</p><h2>Trace mode is off</h2></div></div><div class="empty-state"><h3>Credential-free file-only launch</h3><p>Relaunch with explicit <span class="mono">--trace</span>, a user scope, and a backend-owned key in the launch environment to enable the server-side loopback proxy.</p></div>`;
  if (state.selectedTrace || state.selectedTraceLoading || state.selectedTraceError) return renderTraceDetail();
  return `<div class="section-intro"><div><p class="eyebrow">04 / memory impact viewer</p><h2>Recall Receipts</h2><p>Latest lightweight receipts first. Select one to fetch the sensitive prompt, injected context, answer, and lineage on demand.</p></div><div class="control-row"><button class="button-quiet" data-refresh-traces>Refresh window</button></div></div>
    <div class="notice good"><div>${badge("bounded coverage", "good")}</div><p>${escapeHtml(state.traceCoverage?.label || `latest ${state.traceLimit} of at most 200`)}. Filters apply client-side within this returned window; this is not complete historical coverage.</p></div>
    ${state.traceError ? `<div class="notice"><div>${badge(state.traceError.payload?.error || "unavailable", "warn")}</div><p>${escapeHtml(state.traceError.message || "The configured Rúnir trace service is unavailable.")}</p></div>` : ""}
    ${renderTraceFilters()}${state.traceLoading ? `<p class="loading">Loading the latest lightweight receipt window…</p>` : renderTraceList()}`;
}

function renderLoading() { return shell(`<p class="loading">Rebuilding local catalog…</p>`); }
function renderError() { return shell(`<div class="error-block"><h2>Review Studio could not load</h2><pre>${escapeHtml(state.error?.message || state.error || "Unknown error")}</pre></div>`); }

function render() {
  if (!root) return;
  if (state.loading) { root.innerHTML = renderLoading(); return; }
  if (state.error) { root.innerHTML = renderError(); return; }
  const view = state.view === "compare" ? renderCompare() : state.view === "case" ? renderCase() : state.view === "receipts" ? renderReceipts() : renderRuns();
  root.innerHTML = shell(view);
}

function openContributors(metric, candidateId = "") {
  state.contributors = (state.comparison?.caseDeltas || []).filter((item) => {
    if (candidateId && item.candidateId !== candidateId) return false;
    const assessment = item.metrics?.[metric]?.assessment;
    return assessment === "regressed" || assessment === "improved" || assessment === "unchanged";
  });
  state.contributorLabel = `${labelFor(metric)}${candidateId ? ` / ${candidateId}` : ""} / exact contributors`;
  state.view = "compare";
  render();
}

function openLatencyBucket(index) {
  const deltas = state.comparison?.caseDeltas || [];
  const values = deltas.flatMap((delta) => [delta.baseline?.metrics?.latencyMs, delta.candidate?.metrics?.latencyMs]).filter((value) => Number.isFinite(value));
  if (!values.length) return;
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
  state.contributors = deltas.filter((delta) => [delta.baseline?.metrics?.latencyMs, delta.candidate?.metrics?.latencyMs].some((value) => Number.isFinite(value) && Math.min(9, Math.floor(((value - min) / span) * 10)) === index));
  state.contributorLabel = `Latency bucket ${index + 1} / exact contributors`;
  state.view = "compare";
  render();
}

async function loadRuns(refresh = false) {
  state.loading = true; state.error = null; render();
  try {
    const [capabilities, payload] = await Promise.all([
      api("/api/capabilities"),
      api(`/api/runs${refresh ? "?refresh=true" : ""}`),
    ]);
    state.traceEnabled = capabilities.trace?.enabled === true;
    state.generatedAt = payload.generatedAt; state.runs = payload.runs || []; state.diagnostics = payload.diagnostics || []; state.duplicateRunIds = payload.duplicateRunIds || [];
    if (!state.baselineId && state.runs[0]) state.baselineId = state.runs[0].catalogId;
    if (!state.candidateId && state.runs[1]) state.candidateId = state.runs[1].catalogId;
  } catch (error) { state.error = error; }
  state.loading = false; render();
}

async function loadTraces() {
  if (!state.traceEnabled) return;
  state.traceLoading = true; state.traceError = null; state.selectedTrace = null; state.selectedTraceError = null; render();
  try {
    const payload = await api(`/api/traces?limit=${enc(state.traceLimit)}`);
    state.traces = payload.traces || [];
    state.traceCoverage = payload.coverage || { label: `latest ${state.traceLimit} of at most 200` };
    state.traceLoaded = true;
  } catch (error) {
    state.traceError = error;
    state.traceLoaded = false;
  }
  state.traceLoading = false; render();
}

async function openTrace(id) {
  state.view = "receipts";
  state.selectedTrace = null; state.selectedTraceError = null; state.selectedTraceLoading = true;
  state.selectedMemoryId = ""; state.lineage = null; state.lineageError = null; render();
  try {
    state.selectedTrace = await api(`/api/traces/${enc(id)}`);
  } catch (error) {
    state.selectedTraceError = error;
  }
  state.selectedTraceLoading = false; render();
}

async function openLineage(id) {
  state.selectedMemoryId = id; state.lineage = null; state.lineageError = null; state.lineageLoading = true; render();
  try {
    state.lineage = await api(`/api/lineage/${enc(id)}`);
  } catch (error) {
    state.lineageError = error;
  }
  state.lineageLoading = false; render();
}

async function rateTrace(rating) {
  const trace = state.selectedTrace?.trace;
  if (!trace || !TRACE_RATINGS.includes(rating)) return;
  state.ratingSaving = true; render();
  try {
    const payload = await apiPost(`/api/traces/${enc(trace.id)}/rate`, { rating });
    trace.rating = payload.rating || rating;
    const listEntry = state.traces.find((item) => item.id === trace.id);
    if (listEntry) listEntry.rating = trace.rating;
  } catch (error) {
    state.selectedTraceError = error;
  }
  state.ratingSaving = false; render();
}

async function loadComparison() {
  if (!state.baselineId || !state.candidateId || state.baselineId === state.candidateId) {
    state.comparisonError = new Error("Select distinct baseline and candidate runs."); render(); return;
  }
  state.comparison = null; state.comparisonError = null; state.contributors = []; render();
  const query = `baseline=${enc(state.baselineId)}&candidate=${enc(state.candidateId)}${state.allowPairing ? "&allowUnverified=true&allowIncompatible=true" : ""}`;
  try { state.comparison = await api(`/api/compare?${query}`); }
  catch (error) { state.comparisonError = error; }
  render();
}

async function openCase(key) {
  const selection = buildCaseSelection(state.comparison, key, state.baselineId, state.candidateId);
  if (!selection) {
    state.comparisonError = new Error("The selected case is no longer present in the loaded comparison.");
    state.view = "compare";
    render();
    return;
  }
  state.caseSelection = selection;
  state.view = "case"; state.caseLoading = true; state.caseData = null; state.drawerOpen = false; render();
  try {
    state.caseData = { entries: await loadCaseEntries(selection) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.caseData = {
      entries: selection.entries.map((entry) => ({
        ...entry,
        case: null,
        unavailableReason: "evidence unavailable",
        errorMessage: message,
      })),
    };
  }
  state.caseLoading = false; render();
}

async function openRun(catalogId) {
  state.view = "case"; state.caseLoading = true; state.caseData = null; state.drawerOpen = false; render();
  try {
    const payload = await api(`/api/runs/${enc(catalogId)}`);
    const first = payload.run?.cases?.[0];
    if (!first) throw new Error("Selected run has no loaded case rows.");
    state.caseSelection = { key: first.comparisonKey, entries: [{ catalogId, runId: payload.runId, side: "selected" }] };
    const casePayload = await api(`/api/cases/${enc(catalogId)}?key=${enc(first.comparisonKey)}`);
    state.caseData = { entries: [{ catalogId, runId: payload.runId, side: "selected", case: casePayload.case }] };
  } catch (error) { state.error = error; }
  state.caseLoading = false; render();
}

async function openRaw(catalogId, key) {
  state.drawerOpen = true; state.rawEvidence = null; render();
  try { state.rawEvidence = (await api(`/api/raw/${enc(catalogId)}?key=${enc(key)}`)).rawEvidence; }
  catch (error) { state.rawEvidence = { error: error.message }; }
  render();
}

async function download(path, filename) {
  try {
    const response = await fetch(path, { headers: { "X-Runir-Launch-Token": launchToken } });
    const text = await response.text();
    if (!response.ok) throw new Error(`Export failed: HTTP ${response.status}`);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
  } catch (error) { state.comparisonError = error; render(); }
}

root?.addEventListener("input", (event) => {
  if (event.target.matches("[data-filter]")) { state.filter = event.target.value; render(); const input = document.querySelector("[data-filter]"); input?.focus(); input?.setSelectionRange(state.filter.length, state.filter.length); }
  if (event.target.matches("[data-trace-filter]")) { state.traceFilters[event.target.dataset.traceFilter] = event.target.value; render(); const input = document.querySelector(`[data-trace-filter="${event.target.dataset.traceFilter}"]`); input?.focus(); }
});

root?.addEventListener("change", (event) => {
  if (event.target.matches("[data-baseline]")) { state.baselineId = event.target.value; state.comparison = null; state.comparisonError = null; render(); }
  if (event.target.matches("[data-candidate]")) { state.candidateId = event.target.value; state.comparison = null; state.comparisonError = null; render(); }
  if (event.target.matches("[data-allow-pairing]")) { state.allowPairing = event.target.checked; }
  if (event.target.matches("[data-trace-filter]")) { state.traceFilters[event.target.dataset.traceFilter] = event.target.value; render(); }
  if (event.target.matches("[data-trace-limit]")) { state.traceLimit = Math.min(200, Math.max(1, Number(event.target.value) || 20)); void loadTraces(); }
});

root?.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-open-case]"); if (!target) return;
  if (target.dataset.view) { state.view = target.dataset.view; state.comparisonError = null; render(); if (target.dataset.view === "receipts" && state.traceEnabled && !state.traceLoaded) void loadTraces(); return; }
  if (target.dataset.refresh !== undefined) { void loadRuns(true); return; }
  if (target.dataset.refreshTraces !== undefined) { void loadTraces(); return; }
  if (target.dataset.print !== undefined) { window.print(); return; }
  if (target.dataset.loadComparison !== undefined) { void loadComparison(); return; }
  if (target.dataset.openRun) { void openRun(target.dataset.openRun); return; }
  if (target.dataset.openTrace) { void openTrace(target.dataset.openTrace); return; }
  if (target.dataset.openLineage) { void openLineage(target.dataset.openLineage); return; }
  if (target.dataset.backReceipts !== undefined) { state.selectedTrace = null; state.selectedTraceError = null; state.selectedMemoryId = ""; state.lineage = null; state.lineageError = null; render(); return; }
  if (target.dataset.rate) { void rateTrace(target.dataset.rate); return; }
  if (target.dataset.openMetric) { openContributors(target.dataset.openMetric, target.dataset.openCandidate || ""); return; }
  if (target.dataset.openLatency !== undefined) { openLatencyBucket(Number(target.dataset.openLatency)); return; }
  if (target.dataset.openCase) { void openCase(target.dataset.openCase); return; }
  if (target.dataset.openRaw) { void openRaw(target.dataset.openRaw, target.dataset.rawKey); return; }
  if (target.dataset.closeDrawer !== undefined) { state.drawerOpen = false; state.rawEvidence = null; render(); return; }
  if (target.dataset.exportRun) { void download(`/api/runs/${enc(target.dataset.exportRun)}/export`, `runir-${target.dataset.exportRun}.json`); return; }
  if (target.dataset.exportComparison !== undefined && state.comparison) { void download(`/api/compare/export?baseline=${enc(state.baselineId)}&candidate=${enc(state.candidateId)}${state.allowPairing ? "&allowUnverified=true&allowIncompatible=true" : ""}`, `runir-comparison-${state.baselineId}-${state.candidateId}.json`); }
});

export { aggregateDeltasForMetric, candidateDescriptor, buildCaseSelection, loadCaseEntries };

if (typeof document !== "undefined") void loadRuns();
