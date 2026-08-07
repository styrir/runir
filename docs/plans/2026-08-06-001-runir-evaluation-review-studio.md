# Rúnir Evaluation Review Studio

**Status:** IMPLEMENTED — Claude build review: APPROVE, no findings or required changes
**Date:** 2026-08-06
**Execution tracking:** `Rúnir-ylu` closed with all accepted child slices complete
**Implementation review:** `.pipeline/runir-eval-review-studio/review/claude-build-r2b/artifact.md`
**Product boundary:** owner-local review application; Rúnir remains a standalone HTTP memory service

## Decision

Build a thin, local **Rúnir Evaluation Review Studio** over Rúnir's existing
benchmark artifacts and Memory Impact Viewer contracts.

The studio is a review application, not a second evaluator or agent
orchestrator:

```text
existing harnesses ──> immutable run bundles ──> read adapters ─┐
                                                               ├─> local review UI
Rúnir trace APIs ──> retrieval receipts + ratings + lineage ────┘
```

Evaluation execution, scoring, capture, retrieval, arbitration, and memory
lifecycle policy remain in their current modules. The studio reads their
results, aligns comparable cases, presents graphs and drill-downs, and writes
only the existing thin human trace rating.

An optional, one-day generic-viewer spike may test benchmark comparison only.
It governs whether the custom studio builds its own Compare surface; it does
not govern the Rúnir receipt and lineage UI, whose source contract is already
the existing user-scoped Rúnir API.

## Problem

Rúnir currently preserves strong evidence but exposes it primarily as JSONL,
JSON, Markdown, and terminal receipts. This is reproducible and auditable, but
it is expensive for a human to review repeatedly:

- aggregate tables hide which cases changed;
- raw JSONL makes cross-run comparison laborious;
- Markdown reports are frozen snapshots rather than a navigable history;
- terminal trace receipts expose one turn at a time but do not support visual
  filtering, grouping, trends, or baseline comparison;
- retrieval, capture, arbitration, lineage, feedback, and decay evidence live
  in different operational and test surfaces.

The goal is not to make every internal datum graphical. The goal is to make
these four questions answerable in under one minute:

1. What changed between this run and its baseline?
2. Which cases or traces regressed?
3. Why did a selected case or trace produce that outcome?
4. What exact input, output, score, and memory-lifecycle evidence supports the
   conclusion?

## Existing assets to preserve

### Offline benchmark artifacts

`src/testing/model-benchmark/**` already separates execution, scoring, raw
results, manifests, and presentation:

- `ResultRow` carries run, case, repetition, candidate, model, Git, prompt,
  request, parser, quality, latency, usage, and cost fields.
- `RunManifest` carries run identity, Git state, fixture identity, prompt hash,
  disclosure, and row count.
- `writeArtifacts` writes JSONL, a manifest, and a derived Markdown report.
- `regenerateReportFromRaw` proves presentation can be rebuilt from raw
  evidence without live calls.

The current `runir-model-benchmark/v1` schema remains valid. The studio adds an
adapter; it does not force the benchmark runner to adopt UI concerns.

### Existing Memory Impact Viewer

Rúnir already calls `runir traces` its Memory Impact Viewer:

- `GET /hooks/traces?userId=...` lists lightweight recent retrieval receipts.
- `GET /hooks/traces/:id?userId=...` returns full sensitive trace detail.
- `POST /hooks/traces/:id/rate` records one of
  `helped|hurt|unused|missing|stale` plus an optional note.
- `POST /hooks/feedback` binds an answer and correction metadata to a trace and
  updates usefulness separately from the human rating.
- retrieval records include prompt, intent, lane, path, Hexis identity,
  retrieval audit, injected context, answer, capture receipt, selected items,
  corrections, and rating.
- `GET /memory/lineage/:id` returns the supersession chain.
- `runir traces --id` already formats
  prompt → recalled memories → injected text → answer → feedback → rating.

The studio should reuse these contracts. It must not create a competing trace
table or duplicate the rating vocabulary.

### Existing retrieval and lifecycle diagnostics

- in-memory `RetrievalTrace` objects record pipeline stage counts, drops, score
  ranges, and durations, but operational `retrieval_trace` records do not
  persist those stage arrays or durations;
- trace lifecycle events distinguish stage start/end, recall decisions,
  durable memory commits, and asynchronous indexing visibility, but they are
  not a persisted per-memory lifecycle feed;
- write arbitration returns `create|skip|merge-update|supersede` with reasons
  and matched/merged identifiers.
- `supersede_shadow` and `supersession_judge_ledger` preserve selected
  arbitration evidence.
- calibration replay already computes NDCG@5, top-1 current-state accuracy,
  stale-pick rate, boundary-flip rate, and Hexis invocation rate.

The persisted `retrievalAudit` can support a candidate-count funnel, but V1
must not promise per-stage duration charts. Internal ledgers remain candidates
for a later evidence inventory; V1 does not expose them through a new public
API.

## Research basis

The preceding Styrir Plus comparison found:

- static report systems such as Allure and Great Expectations preserve useful
  frozen evidence, but do not replace a navigable comparison workflow;
- LangSmith and Braintrust center review around stable case alignment,
  persistent baselines, deltas, regressions, filters, and per-case diffs;
- MLflow and Phoenix show that local trace/evaluation viewers can remain
  separate from the evaluator;
- Arize supports importing externally executed experiments, validating the
  harness → structured results → viewer boundary;
- Langfuse documents that trace creation alone does not create experiment runs
  or a comparison overview.

Evidence report:

`/Users/brooks/.codex/visualizations/2026/08/06/019fd70b-a00d-7662-b83b-a7783759bd3b/runir-eval-review-surface/report.html`

## Scope

### V1 must provide

1. A local, graphical run history.
2. Baseline-versus-candidate comparison for compatible run bundles.
3. Case-level input/output/score/provenance drill-down.
4. Retrieval-receipt browsing through the existing trace APIs.
5. Human trace rating through the existing rating endpoint.
6. Memory-lineage navigation from recalled memory IDs.
7. Static print/export for a selected run or comparison.
8. Direct access to underlying raw evidence from every summarized view.
9. Explicit coverage and evidence-expiry states for bounded or retained trace
   data.

### V1 must not provide

- paid-model execution from the browser;
- workflow or agent orchestration;
- benchmark scheduling;
- automatic mutation of gold fixtures;
- automatic promotion of rated traces into regression suites;
- a calibration-replay adapter before a versioned producer writes replay
  reports to disk;
- changes to capture, retrieval, ranking, arbitration, feedback, or decay
  policy;
- multi-user hosting, cloud synchronization, or remote analytics;
- a second trace persistence model;
- arbitrary filesystem browsing;
- a generic observability platform.

## Architecture

### Recommended deployment boundary

Place the studio under `tools/review-studio/` and run it as an owner-local
companion process on loopback, separate from the Rúnir service port.

The tool is currently excluded from the public Styrir product export because
`tools/` is absent from `docs/release/styrir-export-allowlist.txt`. Slice 2a
also adds `prefix:tools/review-studio` to the export denylist so a future
allowlist expansion cannot include it accidentally. It may import only
explicitly approved test/review contracts:

- `src/testing/model-benchmark/types.ts`;
- new pure benchmark-review adapter modules;
- presentation-only trace receipt view types when useful.

A dependency-boundary gate rejects imports from `src/app/**`,
`src/storage/**`, runtime singletons, or service policy modules.

Reasons:

- it can read local run bundles without giving the production service arbitrary
  filesystem access;
- it can proxy authenticated trace requests so the browser never receives
  `RUNIR_API_KEY`;
- it avoids expanding Rúnir's client-facing HTTP surface with UI-specific
  endpoints;
- it remains disposable and can be excluded from public product packaging if
  desired;
- it can be replaced by Phoenix, MLflow, or another viewer without changing
  memory-service policy.

The companion may reuse Hono and shared TypeScript contracts, but it must not
import Rúnir runtime singletons or storage policy.

### Data sources

| Source | Authority | Access | Mutability |
|---|---|---|---|
| Benchmark JSONL + manifest | Offline run evidence | Explicit allowlisted roots | Immutable |
| `/hooks/traces` | Operational recall receipts | Server-side authenticated proxy | Read-only |
| `/hooks/traces/:id` | Full sensitive receipt | On-demand proxy | Read-only |
| `/hooks/traces/:id/rate` | Human recall label | On-demand proxy | Existing narrow write |
| `/memory/lineage/:id` | Supersession history | On-demand proxy | Read-only |

Any local index is a rebuildable projection. It is not an authority and may be
deleted and regenerated from run bundles.

### Unified review model

Introduce a viewer-owned normalized model without changing existing producer
schemas:

```ts
type ReviewRun = {
  schemaVersion: "runir-review-run/v1";
  runId: string;
  suiteId: string;
  suiteVersion: string;
  runKind: "model-benchmark";
  createdAt: string;
  git: { sha: string; dirty: boolean };
  configHash: string;
  fixtureHash?: string;
  sourceArtifacts: string[];
  candidates: ReviewCandidate[];
  cases: ReviewCaseResult[];
};

type ReviewCaseResult = {
  comparisonKey: string;
  caseId: string;
  repetition?: number;
  candidateId: string;
  status: "pass" | "fail" | "error" | "unscored";
  metrics: Record<string, number | null>;
  inputRef?: ReviewArtifactRef;
  outputRef?: ReviewArtifactRef;
  traceRefs?: string[];
  diagnostics?: ReviewDiagnostic[];
};
```

Rules:

- `comparisonKey` must be deterministic and producer-defined or derived from
  stable producer IDs; never align cases by display text.
- new benchmark manifests must stamp `fixtureContentHash` and
  `promptTemplateHash`; the latter hashes `DEFAULT_CAPTURE_PROMPT` before
  `{SESSION_TIMESTAMP}` substitution;
- the normalized `suiteId` is the fixed benchmark identity and
  `suiteVersion` is derived from schema version, fixture content hash, prompt
  template hash, parser version, and the versioned scoring contract;
- `configHash` is SHA-256 over canonical, key-sorted JSON containing stable
  run configuration: candidate/model/effective-request settings, smoke and
  dry-run mode, repetitions, output limit, timeout, concurrency, and gateway
  identity. It excludes timestamps, run IDs, filesystem paths, credentials,
  mutable cost estimates, and presentation labels; candidate entries are
  sorted by stable candidate ID before hashing;
- this additive manifest provenance is evaluator correctness metadata, not a
  UI concern;
- legacy artifacts that lack content/template hashes require explicit human
  pairing and display `compatibility unverified`; fixture-path equality is
  never treated as content equality;
- adapters preserve unknown producer fields behind a raw-evidence link.
- baseline compatibility requires matching suite ID and suite version. A
  deliberate override is visible and never silent.
- metrics declare direction (`higher_is_better|lower_is_better|neutral`) before
  the UI colors a delta.
- no aggregate score combines quality, latency, and cost unless a separately
  reviewed decision policy defines the weighting.

### UI information architecture

#### 1. Runs

- sortable run table with suite, timestamp, Git state, candidate/configuration,
  case count, status, duration, and cost;
- filters by suite, run kind, candidate, Git SHA, dirty state, and date;
- metric trend lines only for compatible suites;
- explicit badges for incomplete, dirty, synthetic, or dry-run evidence.

#### 2. Compare

- baseline and candidate selectors restricted to compatible runs by default;
- aggregate delta table;
- dumbbell or grouped-bar comparison for a small number of aggregate metrics;
- case × metric regression heatmap for dense comparison;
- latency distribution as a histogram or box plot, not a single average;
- regression/improvement/unchanged filters;
- links from each aggregate delta to contributing cases.

#### 3. Case detail

- side-by-side input, expected result, baseline output, and candidate output;
- metric deltas with scoring explanations;
- parser/error/retry/request provenance;
- raw row and manifest access;
- trace references when the run produced operational receipts.

#### 4. Recall receipts

- timeline/list of recent traces using the lightweight endpoint;
- intent, lane, path, Hexis, rating, answer/capture presence, selected memory
  count, and timestamp filters applied client-side over the latest requested
  window;
- display that the window is bounded to the latest N traces and that the
  current route caps N at 200; never imply complete historical coverage;
- full detail fetched only when opened;
- a candidate-count funnel derived only from persisted
  `retrievalAudit`/attribution fields;
- no per-stage duration bars in V1 because operational traces do not persist
  the in-memory `RetrievalStageResult` timing data;
- selected-memory table with score, role, Hexis fit, ranking explanation, and
  lineage links;
- exact injected context and answer in expandable evidence panels;
- existing `helped|hurt|unused|missing|stale` rating controls;
- an explicit `trace expired by retention` state for dangling trace
  references; explain that a human rating or top-level answer pins evaluation
  data under the current retention rule.

#### 5. Memory lifecycle

V1 is pinned to evidence available through current stable routes:

- chronological `/memory/lineage/:id` entries with create/supersede status,
  inactive reason, and timestamps;
- usefulness and ranking counters already present on the opened trace item or
  receipt;
- explicit `evidence unavailable` states for any requested lifecycle step not
  represented by those contracts.

Create/merge ledgers, feedback history, decay history, commit/index events,
shadow rows, and reverse "which traces recalled this memory" lookup are
strictly later-slice work. V1 does not discover or infer them opportunistically.

### Graph-selection rules

- line chart: the same metric across at least three compatible runs;
- dumbbell/grouped bars: baseline versus one candidate across a small metric
  set;
- heatmap: many cases against multiple metrics or candidates;
- histogram/box plot: latency, token, or cost distributions;
- funnel/waterfall: ordered retrieval-stage survival;
- timeline: memory or trace lifecycle;
- table: exact values, identities, provenance, and sparse comparisons.

Avoid radar charts, decorative gauges, aggregate "health" scores, and graphs
that hide low sample counts.

## Security and privacy

Operational traces contain verbatim prompts, injected context, and answers.
They are the most sensitive studio data.

Required controls:

- bind the companion to `127.0.0.1` by default;
- refuse non-loopback binding unless an explicit opt-in and authentication
  design are implemented later;
- mint a cryptographically unguessable token for each companion launch,
  embed it only in the served bootstrap document, and require it in a custom
  header on every companion API request;
- never put the launch token in a URL, browser storage, generated export, or
  log;
- validate the exact canonical `Host` and `Origin` for every API request;
  reject DNS-rebinding hosts, cross-site origins, and unexpected ports;
- emit no permissive CORS headers and reject cross-site Fetch Metadata when
  present;
- require a separate CSRF token/header on the rating mutation in addition to
  the launch token, with `SameSite=Strict` behavior for any cookie used;
- send a restrictive Content Security Policy and load scripts, styles, fonts,
  and images only from the companion origin;
- read `RUNIR_API_KEY` only in the companion backend;
- never put the bearer in browser storage, query strings, generated HTML, or
  logs;
- require explicit `RUNIR_USER_ID`; do not silently use `default`;
- use a fixed configured Rúnir base URL and the existing endpoint policy rather
  than accepting arbitrary browser-provided URLs;
- allowlist run-artifact roots and reject traversal/symlink escapes;
- use no CDN assets, remote fonts, telemetry, or third-party scripts;
- escape all artifact and trace text before rendering;
- fetch full trace bodies only on demand;
- preserve Rúnir's retention rule: unrated/unanswered traces may expire, while
  evaluation-labeled traces are retained;
- exported reports must make sensitive-content inclusion explicit.

Loopback binding is not itself an authentication or CSRF boundary. The
companion is considered safe to proxy sensitive traces only after the token,
Host, Origin, Fetch Metadata, CORS, CSP, and mutation-CSRF gates pass.

## Implementation slices

### Slice 0 — optional generic-viewer comparison spike

Time-box this slice to one day and test only the question a generic evaluator
can fairly answer: whether Phoenix or MLflow can provide the benchmark
Runs/Compare/Case Detail workflow from one existing paid bundle.

The spike must demonstrate:

1. stable baseline/candidate case alignment;
2. aggregate and case-level deltas;
3. exact input/output/raw evidence drill-down;
4. owner-local operation without exporting private evidence.

The verdict governs only whether Slice 2a builds a custom Compare surface.
Rúnir trace, rating, and lineage review are not evaluated by this spike; the
existing user-scoped Rúnir API is already their contract.

The slice may be skipped if implementation momentum is more valuable than a
comparison-tool proof. If run, its deliverable is a short decision receipt
with screenshots, imported fixture IDs, gaps, and an adopt/custom verdict.

### Producer preparation — benchmark compatibility provenance

Land one small, independently reviewed additive change before the normalized
adapter relies on compatibility:

- add `fixtureContentHash` to `RunManifest`;
- add `promptTemplateHash` computed before session timestamp substitution;
- version the scoring contract used in suite identity;
- preserve the existing timestamp-specific `promptHash` for reproduction, but
  do not use it as the compatibility key;
- add fixtures proving hashes are stable for equivalent content and change
  when the corpus or prompt template changes.

Legacy artifacts remain readable but require explicit human pairing and an
`unverified compatibility` badge.

### Slice 1 — benchmark review adapter

Build pure, testable adapters:

- `runir-model-benchmark/v1` → `runir-review-run/v1`;
- suite identity from the additive compatibility provenance;
- baseline compatibility and stable case alignment;
- metric direction registry;
- aggregate/delta computation;
- secret and path redaction.

Calibration replay is out of V1 until a separate producer writes a versioned
report artifact. No HTTP server or UI belongs in this slice.

Gates:

- golden fixtures from current checked-in artifacts;
- deterministic output for the same inputs;
- mismatched suites refuse comparison by default;
- mismatched repetitions or candidate sets remain explicit;
- duplicate `runId` values across artifact roots are detected and surfaced;
- dirty/synthetic/dry-run provenance remains visible;
- unknown fields remain reachable through raw evidence;
- no network calls.

### Slice 2a — credential-free run catalog and comparison UI

Build the safest independently useful application first:

- scan explicit artifact roots;
- validate schemas and reject malformed bundles without crashing;
- build an in-memory or disposable on-disk catalog;
- expose viewer-only read APIs for runs, comparisons, cases, and allowlisted
  raw artifacts;
- serve Runs, Compare, and Case Detail on loopback;
- include print/export for a selected run or comparison;
- make no Rúnir connection and read no credentials.

An on-disk index requires a small ADR. Prefer no new native dependency; prove
that catalog startup and filtering are inadequate before introducing one.

Gates:

- traversal and symlink-escape tests;
- malformed/oversized JSONL containment;
- source artifacts remain unchanged;
- deleting the catalog and restarting reconstructs equivalent state;
- dependency-boundary enforcement is installed in this first
  `tools/review-studio/` slice and rejects imports from `src/app/**`,
  `src/storage/**`, and runtime singleton modules;
- `prefix:tools/review-studio` is added to the release denylist and its
  exclusion is covered by the export gate;
- every chart links to exact contributing rows;
- empty, partial, dirty, dry-run, legacy-unverified, and incompatible states
  are explicit;
- one existing benchmark comparison is fully reviewable without manually
  opening raw JSON.

### Slice 2b — sensitive trace proxy and receipt UI

Add the operational Memory Impact Viewer only after Slice 2a ships:

- proxy the existing Rúnir trace list/detail/rating and lineage endpoints;
- keep Rúnir credentials server-side;
- require the per-launch token, exact Host/Origin checks, no-CORS policy,
  Fetch Metadata checks, CSP, and mutation CSRF protection;
- render Recall Receipts using only persisted fields;
- show candidate-count funnel data only when `retrievalAudit` supports it;
- expose client-side filters over the visibly bounded latest N window
  (`N <= 200`);
- represent a dangling trace reference as `expired by retention`, not
  `evidence never existed`;
- pin V1 lifecycle detail to lineage entries plus available counters.

Gates:

- bearer and launch tokens never appear in frontend bundles, browser storage,
  URLs, exports, responses, or logs;
- cross-origin, bad-Host, bad-Origin, missing-token, and CSRF attempts fail
  closed;
- explicit-user behavior and rating vocabulary match existing trace routes;
- full verbatim details are fetched only on demand;
- service-down behavior degrades to an explicit unavailable state;
- dangling trace references and the latest-200 coverage bound are tested;
- the Slice 2a dependency boundary remains green after trace support is added;
- no network requests leave loopback.

### Slice 3 — lifecycle evidence expansion, only if justified

If the custom UI proves that required lifecycle evidence is unavailable:

1. inventory the exact missing fields;
2. prefer adapter composition from existing trace, lineage, shadow, and ledger
   records;
3. propose the smallest user-scoped read contract;
4. freeze and test the response schema;
5. keep debug-only and sensitive fields behind explicit controls.

Do not expose raw internal tables directly. Route handlers remain thin and
delegate to user-scoped service modules.

Per-stage durations, commit/index timing, decay history, shadow rows, judge
ledgers, and reverse trace-by-memory lookup begin here, never as accidental V1
scope.

### Slice 4 — annotations and regression promotion, deferred

Only after the read/review workflow is used successfully:

- case-level human annotations;
- "promote to regression candidate" creates a reviewable proposal, never an
  automatic fixture mutation;
- accepted promotions are implemented as ordinary reviewed repository changes
  and tracked in Beads.

## Verification strategy

### Contract and unit tests

- adapter schema parsing and version refusal;
- fixture-content and prompt-template hash stability;
- stable comparison keys and baseline compatibility;
- legacy explicit-pairing behavior;
- mismatched repetitions, candidate sets, and duplicate run IDs;
- delta direction and null handling;
- aggregation invariants;
- raw-evidence escaping;
- trace-proxy request/response preservation;
- explicit-user and rating vocabulary behavior;
- path allowlist, traversal, symlink, and size caps;
- per-launch token, Host, Origin, CORS, Fetch Metadata, CSP, and CSRF
  enforcement;
- dependency-boundary enforcement for `tools/review-studio/`.

### Integration tests

- load current checked-in model benchmark JSONL and manifest;
- compare two compatible fixture runs;
- connect to a stub Rúnir trace API and render list/detail/rating/lineage flows;
- prove list view does not fetch full verbatim trace bodies;
- prove rating is the only V1 write;
- prove service-down and expired-trace states remain distinct;
- prove client-side filters display their latest-N and 200-row coverage bound;
- rebuild the disposable catalog from source artifacts.

### UI tests

- regression heatmap → exact case drill-down;
- latency distribution and retrieval-audit candidate funnel with known
  fixtures;
- incompatible baseline refusal;
- empty/incomplete/dry-run/legacy-unverified/expired states;
- sensitive export confirmation;
- keyboard-only primary review path.

### Owner smoke

Slice 2a: Brooks selects a baseline and candidate, identifies the largest
regression, and opens its exact evidence without manually reading JSON or
Markdown.

Slice 2b: Brooks opens a recall receipt, follows one recalled memory to
lineage, and records a trace rating without exposing the bearer.

The smoke is successful only if those actions are understandable without
developer narration.

## Acceptance criteria

1. Existing benchmark runners and Memory Impact Viewer CLI behavior remain
   unchanged.
2. At least two runs can be compared by stable case identity: either newly
   generated dry-run/synthetic fixture bundles carrying the compatibility
   hashes, or explicitly paired legacy bundles visibly marked
   `compatibility unverified`.
3. Aggregate deltas are traceable to exact rows.
4. Trace list, full receipt, rating, and memory lineage work through existing
   user-scoped contracts.
5. The browser never receives the Rúnir bearer.
6. Companion API requests fail closed without the correct launch token,
   canonical Host/Origin, and mutation CSRF proof.
7. The application operates entirely on loopback with no external assets or
   telemetry.
8. Source run bundles and operational trace records remain authoritative.
9. The local catalog is demonstrably rebuildable.
10. No browser action can run a paid benchmark in V1.
11. Brooks can complete both owner smokes without reading raw JSON or
    Markdown.

## Failure and rollback

- The custom Compare surface is optional if the one-day generic-viewer spike
  is selected and succeeds.
- It runs on a separate loopback port and can be stopped without affecting the
  Rúnir service.
- Removing its disposable catalog loses no authoritative evidence.
- Existing CLI trace review and Markdown/JSONL artifacts remain available.
- Any new read endpoint added in Slice 3 must be additive and independently
  reversible.

## Open decisions for review

1. At implementation kickoff, is the optional one-day benchmark-comparison
   spike worth its delay, or should Slice 2a proceed directly?
2. Is an in-memory catalog sufficient for owner-local V1, or is a rebuildable
   persisted index justified?
3. What is the smallest frontend stack that supports dense comparison,
   accessibility, and reliable local packaging without becoming a second
   product-maintenance burden?

Static export excludes verbatim trace content by default. A future sensitive
export may include it only through an explicit per-export opt-in and warning.

## Durable tracking plan

After this architectural review:

- parent feature: `Rúnir-ylu`;
- producer preparation: `Rúnir-ylu.1`;
- normalized benchmark adapter: `Rúnir-ylu.2`, blocked by `.1`;
- credential-free catalog and comparison UI: `Rúnir-ylu.3`, blocked by `.2`;
- browser-security boundary: `Rúnir-ylu.4`;
- sensitive receipt/lineage UI: `Rúnir-ylu.5`, blocked by `.3` and `.4`;
- optional Slice 0 has no Bead and is created only if the one-day comparison
  spike is selected;
- Slice 3 lifecycle expansion is created only from concrete evidence gaps
  observed in `.5`;
- keep code commit/push and Dolt synchronization under the repository's active
  conservative profile unless separately authorized.

## Review record

Claude Fable 5 review:

- r1 verdict: `REVISE`;
- r1 artifact:
  `.pipeline/runir-eval-review-studio/review/fable-r1/artifact.md`;
- accepted blocker: loopback alone is not a browser-security boundary;
- accepted major findings: add producer compatibility provenance, remove
  unpersisted stage-duration promises, cut calibration from V1, split
  credential-free comparison from sensitive traces, and narrow the optional
  generic-viewer spike;
- accepted minor findings: explicit retention-expiry state, visible latest-200
  trace bound, lineage-only V1 lifecycle, and fixed
  `tools/review-studio/`/export/import boundaries.
- r2 verdict: `APPROVE`; all ten r1 findings resolved; four optional
  clarifications incorporated;
- r2 artifact:
  `.pipeline/runir-eval-review-studio/review/fable-r2/artifact.md`;
- r3 verdict: `APPROVE`;
- r3 result: `NEW FINDINGS: none`, `REQUIRED PLAN CHANGES: none`,
  `READY FOR BEADS: yes`;
- r3 artifact:
  `.pipeline/runir-eval-review-studio/review/fable-r3/artifact.md`.
