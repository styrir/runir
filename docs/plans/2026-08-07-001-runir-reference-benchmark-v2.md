# Rúnir Reference Benchmark v2

**Status:** PHASE 0 COMPLETE — clean commit and six-request pilot approved
**Date:** 2026-08-07
**Product boundary:** capture/extraction model quality and Review Studio evidence flow
**Not a claim about:** complete Rúnir retrieval, correction, decay, or competitor superiority

## Implementation checkpoint — 2026-08-07

Phase 0 is implemented and independently reviewed with no revisions remaining.
No paid calls were made during this phase.
The owner approved the clean checkpoint commit and the separately bounded
six-request paid pilot on 2026-08-07.

- calibrated planning disclosure uses 7,500 prompt tokens/request;
- runtime cap prefers valid gateway-billed cost, then token-estimated or
  calibrated fallback cost, and reserves configured maximum output tokens
  before the next request;
- dirty Git, invalid usage, authentication/model/HTTP/network/timeout/schema
  failures, and artifact collisions fail closed;
- partial manifests preserve completed rows and explicit stop provenance;
- condition identity is visible in Review Studio without changing automatic
  pairing keys;
- exact destination and artifact targets are recorded;
- output writes are no-clobber and exclusive by default;
- the exact 15-case × 3-repetition × 2-candidate dry run produced 90 synthetic
  rows with zero network access;
- focused benchmark/adapter tests, Review Studio tests, TypeScript, scoped
  lint, and JavaScript syntax checks pass.

## Decision

Create a modern, reproducible reference benchmark from two independent runs of
the same two-candidate matrix on the same clean Git commit:

- `flash-lite-3.1-control`
- `luna-low`

Each run uses all 15 gold cases with three repetitions per candidate:

```text
15 cases × 3 repetitions × 2 candidates = 90 requests/run
2 runs = 180 requests and 180 result rows
```

The first run is the reference baseline. The second is an immediate replication
used to measure stochastic and gateway variance. Future prompt, model, or code
changes compare against these immutable bundles; they do not overwrite them.

This is deliberately narrower than the existing four-candidate tournament.
Gemini 3.5 Flash-Lite and Grok 4.5 already showed material quality regressions
in the July artifact. Reopening them requires a separate model-selection
question and cost approval.

`luna-low` means reasoning `low`. It must not be labeled “Luna Max.” A Luna Max
experiment requires explicit support for that reasoning level plus a gateway
parameter pilot.

## Question

The benchmark answers:

1. Is the current extraction pipeline stable across two independent executions?
2. Does either retained candidate produce case-level quality or safety flips?
3. What run-to-run variance should future regressions exceed before they are
   treated as product changes rather than model or gateway noise?
4. What latency, output-token, and billed-cost ranges should become reference
   operating bounds?

It does not answer whether Rúnir as a memory system is better than another
product. That requires a separate system benchmark covering capture,
retrieval, correction, supersession, and decay.

## Evidence already available

### Real Studio smoke, 2026-08-07

Two aligned three-case control runs proved the complete live path:

```text
paid benchmark → JSONL + manifest → Review Studio → comparison → raw evidence
```

- 6/6 HTTP 200
- 6/6 schema-valid
- total billed cost: `$0.0122925`
- mean prompt tokens: `6,958/request`
- Run A mean latency: `1,982 ms`
- Run B mean latency: `1,589 ms`

### Historical full-primary run, 2026-07-22

The existing artifact contains 180 rows: 15 cases × 3 repetitions × 4
candidates. It is useful orientation but not a strict v2 baseline because:

- the checkout was dirty;
- `fixtureContentHash`, `promptTemplateHash`, and
  `scoringContractVersion` are absent;
- its candidate matrix includes already-disfavored challengers.

Observed historical results:

| Candidate | Rows | Precision | Recall | Hallucination | Mean billed cost/extract |
|---|---:|---:|---:|---:|---:|
| Flash-Lite 3.1 control | 45 | 100.0% | 100.0% | 0.0% | `$0.001249` |
| Luna low | 45 | 100.0% | 98.9% | 0.0% | `$0.003600` |
| Flash-Lite 3.5 | 45 | 95.6% | 95.6% | 4.4% | `$0.002213` |
| Grok 4.5 low | 45 | 94.8% | 95.6% | 5.2% | `$0.009165` |

## Phase 0 — make the benchmark publishable

No paid full-corpus run begins until these gates pass.

### 0.1 Freeze repository state

- Settle the current dirty worktree through a separately approved commit.
- Run both reference executions from one exact clean SHA.
- Fail closed if `git.dirty` is true.
- Materialize two separate detached worktrees from that SHA: one for Run A and
  one for Run B. Each run writes only to its own worktree after the preflight
  clean check, so Run A artifacts cannot make the Run B source checkout dirty.
- After both bundles pass their gates, copy the exact artifact bytes into the
  canonical `docs/analysis/raw/model-benchmark-v2/` integration directory;
  never rerun or regenerate raw rows during collection.
- Record branch, SHA, fixture hash, prompt-template hash, scoring-contract
  version, candidate matrix, gateway base URL, timeout, concurrency,
  repetitions, and max output tokens.

The prior artifacts remain immutable historical evidence.

### 0.2 Repair cost disclosure

The current preflight calls a 2,000-token prompt assumption “conservative,”
while the live smoke averaged 6,958 prompt tokens. Before a larger spend:

- replace the 2,000-token assumption with a calibrated input-token bound of at
  least 7,500 tokens/request, or compute the serialized request token count;
- label list-price estimates as estimates rather than hard ceilings;
- add `--max-total-cost-usd`;
- accumulate gateway-billed cost when present and stop before the next request
  when the approved run cap would be exceeded;
- preserve partial artifacts when a cost stop fires.

### 0.3 Add explicit condition identity

Add a stable condition label to the manifest and CLI:

- `reference-a`
- `reference-b`

The label is descriptive metadata, not part of case alignment. Stable
comparison keys remain `caseId × candidateId × repetition`.

### 0.4 Gate tests

Required before a pilot:

- cost estimation uses the calibrated prompt bound;
- a configured total-cost cap stops further requests and preserves rows;
- dirty-Git publishable mode fails before network access;
- condition identity is serialized and redacted safely;
- new manifests remain compatible with the Review Studio adapter;
- existing benchmark and Review Studio suites remain green.

## Phase 1 — zero-cost and paid pilot

### 1.1 Dry-run

Run the exact two-candidate configuration in dry-run mode:

```text
models: flash-lite-3.1-control,luna-low
cases: all 15
repetitions: 3
concurrency: 1
max output tokens: 2,048
timeout: 180,000 ms
planned requests: 90/run
```

Verify the disclosure, output targets, row count, candidate identities, hashes,
and cost cap without network calls.

### 1.2 Six-request paid pilot

Before either full run, execute:

```text
3 smoke cases × 1 repetition × 2 candidates = 6 requests
```

Pilot stop conditions:

- authentication or model/parameter rejection;
- any timeout or network error;
- any missing row;
- any non-schema-valid response;
- credential value found in an artifact;
- billed cost above `$0.03`.

The pilot requires explicit approval naming the case payload, Requesty
destination, candidate models, request count, and cost cap.

## Phase 2 — reference executions

### Run A: `reference-a`

- full 15-case corpus;
- three repetitions;
- two candidates;
- concurrency one;
- exact clean SHA and frozen configuration;
- 90 planned requests;
- run-level cost cap: `$0.30`.

After Run A, stop and inspect before authorizing Run B.

Run A stop conditions:

- any missing row or unrecoverable request error;
- provenance mismatch;
- cumulative billed cost above the approved cap;
- safety-critical regression requiring human review;
- credential leakage;
- Review Studio cannot catalog the resulting bundle.

### Run B: `reference-b`

Run only after Run A passes. Use the same SHA, fixtures, candidate matrix,
repetitions, concurrency, timeout, output-token limit, gateway, and scoring
contract. The only expected differences are run identity, timestamps, model
outputs, usage, latency, request IDs, and billed cost.

## Cost and duration envelope

Historical billed cost for 45 rows/candidate:

- Flash-Lite 3.1 control: `$0.0562131`
- Luna low: `$0.1619826`

Expected cost:

| Stage | Requests | Expected | Approval cap |
|---|---:|---:|---:|
| paid pilot | 6 | about `$0.015` | `$0.03` |
| reference A | 90 | about `$0.218` | `$0.30` |
| reference B | 90 | about `$0.218` | `$0.30` |
| total | 186 | about `$0.451` | `$0.63` |

The two full runs are expected to take roughly 5–10 minutes at concurrency one.
Cost approval is separate from plan approval.

## Analysis contract

### Unit of comparison

Pair rows by:

```text
caseId × candidateId × repetition
```

Treat the case—not each repetition—as the independent sampling unit. Repeated
rows measure model variance and must not be presented as 45 independent gold
cases.

### Primary quality metrics

- schema-valid rate
- atomic precision
- atomic recall
- hallucination rate
- omission rate
- abstention accuracy
- evidence fidelity

### Secondary operating metrics

- valid-completion and first-attempt success rates
- timeout and error rates
- latency p50, p90, and p95
- completion tokens
- billed cost per extraction
- billed cost per correct gold fact

Do not create a composite quality score.

### Statistical summary

- show every case-level outcome;
- report median and range across repetitions;
- use a fixed-seed paired cluster bootstrap over the 15 cases for quality and
  operating-metric delta intervals;
- label intervals descriptive because the corpus is curated rather than a
  random population sample;
- report safety-family flips separately from aggregate percentages.

Recommended reference-stability gates:

- 100% row completeness;
- 100% schema validity;
- zero request errors and timeouts;
- no new hallucination, omission, or abstention failure in `fabrication-trap`,
  `negative`, `abstention`, or `identifiers` families;
- aggregate precision and recall run-to-run delta within 2 percentage points;
- p95 latency and cost-per-correct-fact run-to-run delta within 25%, or an
  explicit provider-variance explanation.

These thresholds are proposed owner decisions, not facts implied by the current
scoring code.

## Review Studio visualization

Use each graph only for the question it answers:

- candidate-labeled dumbbells for aggregate Run A → Run B deltas;
- case × metric heatmap for regressions and safety flips;
- paired strip or slope plot for repetition variance;
- latency ECDF or compact distribution for tail behavior;
- cost-versus-quality Pareto plot for candidate tradeoffs;
- exact case drawer for input, output, parsing, scoring, usage, and diagnostics.

The Studio is currently strongest for run-over-run review. The generated
Markdown report remains the cross-model summary until real evidence shows that
a first-class within-run model comparison view is necessary.

## Artifact contract

Write immutable bundles beneath:

```text
docs/analysis/raw/model-benchmark-v2/
```

Each run produces:

- `<condition>-<timestamp>.jsonl`
- `<condition>-<timestamp>.manifest.json`
- a derived Markdown report outside the raw directory

Never overwrite `latest` during the reference run. Review Studio receives only
the explicit v2 artifact root. Raw JSONL and manifests are authoritative;
Markdown and the Studio catalog are rebuildable projections.

The runner fails closed when any raw, manifest, or report target already
exists. `--allow-artifact-overwrite` is reserved for explicitly mutable local
workflows and must not appear in pilot or reference-run commands.

## Closeout

The benchmark is complete only when:

1. both paid bundles and reports exist;
2. the secret-value audit passes;
3. Review Studio automatically pairs the runs with no compatibility override;
4. every expected case key is present on both sides;
5. primary, secondary, and safety-family findings are recorded;
6. actual billed cost is reported against the approved caps;
7. limitations distinguish extraction evidence from full-system Rúnir claims;
8. the execution Bead is closed with artifact paths and test evidence.

## Execution shape after approval

Use one sequential implementation path for Phase 0 because the cost gate,
manifest, CLI, runner, adapter, and tests share contracts. Paid runs are also
sequential because Run B depends on Run A review and the same external budget.
Run A and Run B execute from separate clean detached worktrees at the same
approved SHA; do not reuse Run A's now-dirty artifact worktree for Run B.

After immutable artifacts exist, analysis can split safely:

```text
Phase 0 hardening
        │
        ▼
six-request pilot
        │
        ▼
reference A ── human gate ── reference B
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
        statistical analysis          Studio evidence audit
                 └──────────────┬──────────────┘
                                ▼
                         owner closeout
```

Create Beads and launch implementation only after the owner approves this
draft. Paid execution always receives its own explicit approval.
