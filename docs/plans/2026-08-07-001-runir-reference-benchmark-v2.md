# Rúnir Reference Benchmark v2

**Status:** GEMINI REASONING ACCEPTANCE COMPLETE — High passes exact-identifier probe; follow-up commit pending
**Date:** 2026-08-07
**Product boundary:** capture/extraction model quality and Review Studio evidence flow
**Not a claim about:** complete Rúnir retrieval, correction, decay, or competitor superiority

## Implementation checkpoint — 2026-08-07

Phase 0 is implemented and independently reviewed with no revisions remaining.
No paid calls were made during this phase.
The owner approved the clean checkpoint commit and the separately bounded
six-request paid pilot on 2026-08-07.
The owner approved the follow-up clean commit and replacement six-request
pilot on 2026-08-07 after attempt 1 stopped on the provider precondition.
The owner approved the separately bounded 90-request Reference Run A with a
`$0.30` cap on 2026-08-07.

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

### Pilot attempt 1 — stopped safely

The approved pilot started from clean SHA
`b71990d84655ac3b70ee02c8582f1f0016a0bed1` through the machine's Infisical
Universal Auth implementation. Infisical injected `REQUESTY_API_KEY` only into
the benchmark child process.

- one of six planned requests was sent;
- Requesty returned HTTP 400 for `openai/gpt-5.6-luna`;
- the provider required a lowercase `json` token in the input messages when
  translating `response_format=json_object`;
- the runner stopped immediately with `model_rejected`; no remaining requests
  were sent;
- the immutable partial bundle is
  `docs/analysis/raw/model-benchmark-v2/pilot-2026-08-07-requesty.*`;
- no gateway-billed cost was reported; the manifest's `$0.0123` cumulative
  value is the calibrated fallback estimate, not confirmed billing.

The canonical extraction and segmentation instructions now explicitly include
lowercase `json` in both system and user messages. A zero-cost serialization
regression test covers the Requesty/OpenAI JSON-mode precondition. A replacement
six-request pilot requires a new clean commit and explicit request-count/cost
approval because attempt 1 consumed one HTTP request.

### Replacement pilot — passed

The approved replacement pilot ran from clean SHA
`ee5e411931bdc5aa2db968ae6f2b00a41a5c677b` through Infisical Universal
Auth into fresh no-clobber artifact paths.

- 6/6 planned rows completed;
- 6/6 HTTP 200;
- 6/6 schema-valid;
- zero request errors and timeouts;
- both candidates achieved 100% smoke precision and recall with zero
  hallucinations;
- actual gateway-billed cost: `$0.01047095` against the `$0.03` cap;
- Review Studio provenance is verified, complete, and diagnostic-free;
- an audit using the actual Infisical-injected secret confirmed no credential
  value appears in the JSONL, manifest, or Markdown report.

The immutable replacement bundle is
`docs/analysis/raw/model-benchmark-v2/pilot-replacement-2026-08-07-requesty.*`.

### Reference Run A — complete with an atomicity regression

Reference Run A executed from clean SHA
`ee5e411931bdc5aa2db968ae6f2b00a41a5c677b` in its own detached worktree.
Infisical Universal Auth injected the Requesty credential only into the
benchmark child process.

- 90/90 planned rows completed;
- 90/90 HTTP 200 and schema-valid;
- zero retries, request errors, timeouts, or hallucinations;
- actual gateway-billed cost: `$0.08570175` against the `$0.30` cap;
- Flash-Lite control: 100.0% precision, 100.0% recall, 0.0% omission,
  1,343 ms p50 and 2,000 ms p95 latency;
- Luna low: 100.0% precision, 93.3% recall, 6.7% omission, 1,815 ms p50
  and 4,099 ms p95 latency;
- both candidates achieved 100% abstention accuracy and correction handling;
- Review Studio provenance is verified, complete, and diagnostic-free;
- an audit using the actual Infisical-injected secret confirmed no credential
  value appears in the JSONL, manifest, or Markdown report.

Luna low merged the two expected atomic facts into one memory object in all
three repetitions of `alias-ambiguous` and all three repetitions of
`quantity-port`. The text preserved both expected values, so this is an
atomicity/granularity failure rather than fabricated or semantically missing
evidence. Under the frozen scorer, however, each affected row receives 0.5
recall, 0.5 omission, and 0.5 granularity compliance. Because
`quantity-port` belongs to the `identifiers` family, this crosses the proposed
no-new-omission gate and is recorded explicitly for owner review.

The exact-byte canonical bundle is:

- `docs/analysis/raw/model-benchmark-v2/reference-a-2026-08-07-requesty.jsonl`
- `docs/analysis/raw/model-benchmark-v2/reference-a-2026-08-07-requesty.manifest.json`
- `docs/analysis/model-benchmark-v2-reference-a-2026-08-07-requesty.md`

The original low-effort Reference Run B was canceled by the 2026-08-07 owner
decision. Running it would spend another 90 requests on a candidate that is no
longer under consideration for this selection cycle.

### Native Luna Max amendment — implementation complete, paid run blocked

OpenAI's GPT-5.6 documentation confirms that Luna supports native
`reasoning.effort=max` through the Responses API. Requesty's documented generic
OpenAI reasoning translation maps `max` to `high`, so this benchmark must not
label a Requesty-normalized request as native Max.

The benchmark now has explicit direct-OpenAI Responses candidates:

- `luna-low-responses`
- `luna-max`

The new lane uses `/v1/responses`, `gpt-5.6-luna`, nested
`reasoning: {effort}`, `max_output_tokens`, Responses output-item parsing,
Responses usage counters, per-candidate endpoint/credential provenance, and
exact `--case-ids` selection. Historical Chat Completions candidates and raw
artifacts remain unchanged.

The zero-network effort-pilot dry run completed 24/24 synthetic rows:

```text
4 cases × 3 repetitions × 2 efforts = 24 requests
cases: alias-ambiguous, quantity-port, multi-claim-split, fabrication-trap
efforts: low, max
max output tokens: 2,048
proposed paid cap: $0.50
calibrated planning estimate: $0.2952
```

No paid call was made. The machine's Infisical `dev` environment currently
injects `REQUESTY_API_KEY` but not `OPENAI_API_KEY`; the runner therefore fails
closed before network access for this direct lane. Add `OPENAI_API_KEY` to the
existing Infisical project before requesting paid execution. The key must never
be placed directly on a command line or in a repository file.

### Requesty Luna High amendment — selected diagnostic

The owner selected a smaller Requesty-based diagnostic before provisioning the
direct OpenAI credential. Requesty documents that OpenAI
`reasoning_effort=high` is forwarded unchanged on its OpenAI-compatible Chat
Completions route. This keeps the Run A model, gateway, prompt, response format,
and transport fixed while changing only Luna's requested effort from low to
high.

The benchmark now exposes `luna-high-requesty` as an explicit candidate. It is
not included in `default`, `extended`, or `all`, so historical matrices and
presets remain frozen. The proposed diagnostic is:

```text
2 cases × 3 repetitions × 1 candidate = 6 requests
cases: alias-ambiguous, quantity-port
model: openai/gpt-5.6-luna through Requesty Chat Completions
reasoning_effort: high
max output tokens: 2,048
calibrated planning estimate: $0.0738
proposed paid cap: $0.15
```

The two selected cases are exactly the Run A rows where Luna Low merged two
gold facts into one extracted memory object. The paid run required a clean
checkpoint commit and separate explicit approval naming Requesty, the two case
IDs, six requests, and the `$0.15` cap. The direct native-Max lane remains
implemented but deferred; this Requesty run is labeled High, not Max.

The Infisical-injected zero-network preflight completed 6/6 synthetic rows with
the exact case, repetition, candidate, transport, endpoint, effort, output-token
limit, estimate, and cap shown above. Its disclosure identified
`env:REQUESTY_API_KEY` without exposing the value, and a value-aware audit
confirmed that the injected credential was absent from the JSONL, manifest, and
Markdown artifacts. No paid model call was made during that preflight.

### Requesty Luna High diagnostic — passed

The approved diagnostic executed from clean SHA
`8718cfd0c3ede0c8283e64a6fefae0d0c1bcb5f7` through Infisical Universal
Auth and Requesty:

- 6/6 planned requests completed with HTTP 200 and schema-valid output;
- zero retries, request errors, timeouts, hallucinations, or omissions;
- all six rows emitted two separate memory objects and matched both gold facts;
- actual gateway-billed cost was `$0.00693504` against the `$0.15` cap;
- mean latency was `4,689.5 ms`;
- Review Studio cataloged the bundle with verified provenance and zero
  diagnostics;
- the Requesty credential value was absent from all three artifacts.

High fixed the targeted atomicity regression in every repetition. On the same
six rows, Luna Low had 50% recall and 50% granularity compliance, while High
had 100% for both. This remains a targeted result rather than a full-corpus
production verdict.

### Gemini 3.5 Requesty reasoning matrix — implementation complete

The existing `flash-lite-3.5` candidate remains unchanged with reasoning
unsupported. Three explicit benchmark-only candidates now exercise Requesty's
documented Vertex effort-to-budget mapping:

| Candidate | Wire effort | Declared mapped budget |
|---|---|---:|
| `flash-lite-3.5-reasoning-low` | `low` | 1,024 |
| `flash-lite-3.5-reasoning-medium` | `medium` | 8,192 |
| `flash-lite-3.5-reasoning-high` | `high` | 24,576 |

These candidates are excluded from `default`, `extended`, and `all`.
Production capture behavior is unchanged. Raw rows, manifests, reports, and
Review Studio provenance record both the requested effort and mapped budget.

Planning estimates add the full mapped reasoning budget to the calibrated
visible-output assumption. Runtime cap reservation conservatively adds the
full mapped budget to `max-output-tokens` before every request. A regression
test proves that the High candidate stops before network when the cap cannot
cover this reserve.

The Infisical-backed zero-network acceptance preflight passed:

```text
1 case × 1 repetition × 3 efforts = 3 requests
case: identifiers-path-url
model: vertex/gemini-3.5-flash-lite through Requesty Chat Completions
max visible output tokens: 2,048
calibrated budget-inclusive planning estimate: $0.1078434
proposed paid cap: $0.15
```

All three synthetic rows serialized the exact intended `reasoning_effort`,
mapped budget, candidate identity, endpoint, and credential-source label.
Focused benchmark and adapter tests, TypeScript, scoped lint, diff validation,
and a value-aware secret audit pass. No paid Gemini reasoning call was made
during that preflight.

### Gemini 3.5 reasoning acceptance — complete

The approved probe executed from clean SHA
`1e70ba809d05fa1d0063c2eb6877f175a21922ec` through Infisical Universal
Auth and Requesty. All three effort values were accepted:

| Effort | HTTP/schema | Reported reasoning tokens | Frozen score | Latency | Billed cost |
|---|---|---:|---|---:|---:|
| Low | 200 / valid | not reported | fail | 2,145 ms | `$0.0026324` |
| Medium | 200 / valid | 1,067 | fail | 7,364 ms | `$0.0053124` |
| High | 200 / valid | 1,597 | pass | 11,081 ms | `$0.0066424` |

- 3/3 planned requests completed with zero retries, errors, or timeouts;
- cumulative gateway-billed cost was `$0.0145872` against the `$0.15` cap;
- High preserved both exact required strings:
  `https://github.com/styrir/runir` and
  `src/domain/memory/prompts.ts`;
- Low and Medium preserved the correct repository identity and exact path, but
  shortened the URL to `styrir/runir`;
- under the frozen exact-substring scorer, that shortened URL makes the
  extracted fact unmatched, producing 0% precision/recall and 100%
  omission/hallucination for those rows;
- this is an exact-identifier fidelity failure, not fabricated project content;
- a value-aware audit found no Requesty credential in the artifacts;
- Review Studio cataloged the complete clean-Git bundle with verified
  provenance and zero diagnostics.

High is the only effort that passed this acceptance case, but one request is
not a production decision. The next useful experiment is a three-repetition
High-only pilot across `identifiers-path-url`, `alias-ambiguous`, and
`quantity-port`, after this bundle is committed and separately costed.

The immutable acceptance bundle is:

- `docs/analysis/raw/model-benchmark-v2/gemini-3.5-reasoning-acceptance-2026-08-07-requesty.jsonl`
- `docs/analysis/raw/model-benchmark-v2/gemini-3.5-reasoning-acceptance-2026-08-07-requesty.manifest.json`
- `docs/analysis/model-benchmark-v2-gemini-3.5-reasoning-acceptance-2026-08-07-requesty.md`

## Decision

The original Run A tested this two-candidate matrix:

- `flash-lite-3.1-control`
- `luna-low`

The original plan shaped each run as all 15 gold cases with three repetitions
per candidate:

```text
15 cases × 3 repetitions × 2 candidates = 90 requests/run
2 planned runs = 180 requests and 180 result rows
```

Run A is the completed reference baseline. Run B was not executed after the
owner selected Gemini 3.1 and stopped additional candidate testing. Future
prompt, model, or code changes compare against the immutable completed bundle;
they do not overwrite it.

This is deliberately narrower than the existing four-candidate tournament.
Gemini 3.5 Flash-Lite and Grok 4.5 already showed material quality regressions
in the July artifact. Reopening them requires a separate model-selection
question and cost approval.

`luna-low` remains correctly labeled historical evidence. The later Luna High
and Gemini 3.5 reasoning probes remain targeted diagnostic evidence; neither
replaced the full-corpus result.

Owner decision, 2026-08-07: retain `flash-lite-3.1-control` as the benchmark
reference and stop additional candidate testing for this selection cycle.
Promote `vertex/gemini-3.1-flash-lite@us`, with no reasoning parameter, to the
production capture-extraction default. This promotion does not apply to
unbenchmarked model-backed stages.

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

Canceled by the 2026-08-07 owner decision. Do not run the old low-effort
replication under this selection cycle. Luna Low, Luna High, and Gemini 3.5
reasoning remain historical or targeted diagnostic evidence.

## Cost and duration envelope

Historical billed cost for 45 rows/candidate:

- Flash-Lite 3.1 control: `$0.0562131`
- Luna low: `$0.1619826`

Expected cost:

| Stage | Requests | Expected | Approval cap |
|---|---:|---:|---:|
| paid pilot | 6 | about `$0.015` | `$0.03` |
| reference A | 90 | about `$0.218` | `$0.30` |
| Requesty Luna High diagnostic | 6 | `$0.0738` calibrated | `$0.15` proposed |
| native Luna effort pilot | 24 | about `$0.295` calibrated | `$0.50` proposed |
| old reference B | 90 | paused | not approved |

Any replacement reference pair receives a new cost estimate after the effort
pilot. Cost approval is separate from plan approval.

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
