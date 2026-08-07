# Model Benchmarks and Review Studio

This guide explains how to run Rúnir's capture-extraction model benchmark,
the explicit `/memory/think` benchmark, produce reviewable evidence, and
inspect or compare that evidence in Review Studio. It is intended for Rúnir
maintainers and for operators evaluating their own models through an
OpenAI-compatible gateway.

The capture and Think suites are independent. A model cannot improve its
capture score by doing well at Think synthesis, and Review Studio permanently
refuses Capture-versus-Think comparisons.

## Current capture benchmark decision

As of 2026-08-07, the selected extraction profile is:

- candidate: `flash-lite-3.1-control`
- model: `vertex/gemini-3.1-flash-lite@us`
- reasoning parameter: none
- evidence: all 15 corpus cases, repeated three times
- result: 100% schema validity, precision, recall, and abstention accuracy,
  with no measured hallucinations or omissions

The selection applies to the benchmarked extraction task and request contract.
It is not a claim that Gemini 3.1 is best for every Rúnir model-backed stage.
As of 2026-08-07, the code default and owner-local `/hooks/capture` profile have
been promoted to this model with no reasoning parameter. Topic segmentation,
entity extraction, continuity, and `/memory/think` were not part of that
promotion. See
[Why Gemini 3.1 was selected](#why-gemini-31-was-selected) for the complete
comparison and evidence limits.

### Mirror the winning profile in production

For a capture-only deployment override, set:

```dotenv
EXTRACT_MODEL=vertex/gemini-3.1-flash-lite@us
```

Do not add a reasoning-effort parameter. `EXTRACT_MODEL` is passed only to
`extractMemories` on the capture route. The older `RUNIR_EXTRACTOR_MODEL`
variable remains a shared fallback for compatibility and can also change topic
segmentation, entity extraction, continuity, and `/memory/think`.

The benchmark used a 2,048-token output ceiling because its fixtures are short.
Production retains the larger `RUNIR_EXTRACT_MAX_TOKENS` safety ceiling for
real transcripts; that operational ceiling does not enable model reasoning.

## How the pieces fit together

The runner and Studio are deliberately separate:

1. `scripts/model-benchmark-extraction.ts` loads the frozen corpus, calls the
   selected models, scores their extraction output, and writes a JSONL result,
   a manifest, and a Markdown report.
2. `scripts/model-benchmark-think.ts` does the same for fixed-evidence Think
   synthesis or a loopback end-to-end `/memory/think` lane.
3. Review Studio scans explicit artifact roots and turns those files into Runs,
   Compare, and Case Detail views.
4. Review Studio never schedules or pays for a model call. To see a new run,
   execute the runner first and then refresh the Studio catalog.

This is the middle ground between a bare test script and a benchmark-management
platform: execution remains explicit and auditable, while review is visual.

## Prerequisites

- Node.js 22.12 or newer
- repository dependencies installed with `npm install`
- an OpenAI-compatible gateway for paid runs
- credentials injected into the runner by an approved secret manager

Rúnir's own runs use Infisical Universal Auth. The exact operator wrapper is
machine-specific and intentionally not committed. Other operators may use
their own secret manager, but the runner process must receive one of:

- `REQUESTY_API_KEY` or `OPENROUTER_API_KEY` for configured-gateway candidates
- `OPENAI_API_KEY` for direct OpenAI Responses candidates

Never place a secret value in a command, committed file, report, or shell
history. The runner records only the credential source label.

## The frozen corpus

The default corpus is
[`fixtures/model-benchmark/corpus.json`](../fixtures/model-benchmark/corpus.json).
It currently contains 15 human-gold cases covering:

- simple and multi-claim extraction
- abstention and fabrication resistance
- corrections and negative preferences
- exact URLs, paths, code, and SurrealQL
- project-bound mappings and relative dates
- same-name alias ambiguity
- multiple quantities and ports
- uncertainty and hedging

Scoring is deterministic. Required facts are matched against human-authored
`mustContain` values; no candidate model grades itself or another candidate.

With no `--smoke` or `--case-ids` flag, the runner selects the entire corpus.
`--smoke` selects three basic cases. `--case-ids` selects an explicit subset.

## Run a zero-network preflight

Start with the exact profile and full-corpus shape you intend to run. This
example produces 45 synthetic provenance rows—15 cases times three
repetitions—but makes no network calls:

```bash
node --import tsx/esm scripts/model-benchmark-extraction.ts \
  --dry-run \
  --models flash-lite-3.1-control \
  --fixtures fixtures/model-benchmark/corpus.json \
  --repetitions 3 \
  --concurrency 1 \
  --timeout-ms 180000 \
  --max-output-tokens 2048 \
  --condition-id gemini-3.1-full \
  --max-total-cost-usd 0.30 \
  --out-raw docs/analysis/raw/gemini-3.1-full-preflight.jsonl \
  --out-report docs/analysis/gemini-3.1-full-preflight.md
```

Inspect the disclosure before considering a paid run. It states the selected
models, case count, request count, effective reasoning and JSON behavior,
credential source, timeout, output limit, and estimated cost when dated pricing
is available.

Useful narrower shapes are:

```bash
# Three-case smoke
node --import tsx/esm scripts/model-benchmark-extraction.ts \
  --dry-run --models flash-lite-3.1-control --smoke

# Explicit cases
node --import tsx/esm scripts/model-benchmark-extraction.ts \
  --dry-run \
  --models flash-lite-3.1-control \
  --case-ids identifiers-path-url,alias-ambiguous,quantity-port
```

Dry-run output is synthetic configuration evidence. It does not establish model
quality or network latency.

## Run an approved paid benchmark

Only proceed after reviewing the dry-run disclosure and obtaining explicit
approval for the request count and cost cap. Invoke the following command
*through the approved secret-manager injection path*:

```bash
node --import tsx/esm scripts/model-benchmark-extraction.ts \
  --confirm-cost \
  --models flash-lite-3.1-control \
  --fixtures fixtures/model-benchmark/corpus.json \
  --repetitions 3 \
  --concurrency 1 \
  --timeout-ms 180000 \
  --max-output-tokens 2048 \
  --condition-id gemini-3.1-full \
  --max-total-cost-usd 0.30 \
  --require-clean-git \
  --out-raw docs/analysis/raw/gemini-3.1-full.jsonl \
  --out-report docs/analysis/gemini-3.1-full.md
```

Safety behavior:

- paid calls require `--confirm-cost`;
- CI is prohibited from making paid benchmark calls;
- missing injected credentials fail before network access;
- `--require-clean-git` binds a paid result to a clean source state;
- existing artifacts are not overwritten unless
  `--allow-artifact-overwrite` is explicitly passed;
- `--max-total-cost-usd` is checked before each request using gateway-billed
  cost when available, then token-based estimates.

Use unique condition IDs and output paths. Do not overwrite reference evidence
to make a new run look like an old one.

## Test your own model

For an initial zero-network or smoke check, pass an OpenAI-compatible gateway
model ID directly:

```bash
node --import tsx/esm scripts/model-benchmark-extraction.ts \
  --dry-run \
  --models provider/your-model-id \
  --base-url https://your-gateway.example/v1 \
  --smoke \
  --condition-id your-model-smoke
```

Before a paid or promotion-grade run, add an explicit `Candidate` entry in
[`src/testing/model-benchmark/candidates.ts`](../src/testing/model-benchmark/candidates.ts).
Raw IDs use conservative family heuristics and have no dated price table, so
they are insufficient for trustworthy reasoning provenance or cost
reservation. An explicit candidate should record:

- a stable candidate ID and exact wire model ID
- API style and endpoint class
- reasoning support, requested effort, and any gateway-mapped token budget
- JSON-mode policy
- dated input/output pricing and its source
- any provider-specific request fields that are safe to persist

If a model ID has more than one effort or endpoint configuration, select the
explicit candidate ID. The runner rejects an ambiguous bare model ID rather
than silently choosing one.

To use your own corpus, copy the default corpus and preserve its shape:

```json
{
  "cases": [
    {
      "id": "stable-case-id",
      "family": "atomicity",
      "messages": [
        { "role": "user", "content": "The source text to extract." }
      ],
      "gold": {
        "abstain": false,
        "independentClaimCount": 1,
        "facts": [
          {
            "id": "stable-gold-id",
            "mustContain": ["exact value"],
            "required": true
          }
        ]
      }
    }
  ]
}
```

Keep gold human-authored and freeze the corpus before comparing models.

## Evaluate `/memory/think`

Think has two deliberately separate suites:

- `runir-think-synthesis` sends frozen evidence directly through the production
  Think prompt, request body, parser, and deterministic scorer. This isolates
  model behavior from retrieval.
- `runir-think-e2e` calls a loopback Rúnir `/memory/think` endpoint and records
  retrieval selection, the 12-item evidence cap, whether synthesis ran, and
  synthesis quality. This measures the assembled route. The corpus's expected
  evidence IDs must already be seeded in that test tenant before this lane can
  make a retrieval-quality claim.

The frozen Think corpus is
[`fixtures/think-benchmark/corpus.json`](../fixtures/think-benchmark/corpus.json).
Its human gold defines independently checkable claims, allowed evidence IDs,
forbidden traps, and required knowledge gaps. The model response is also
claim-addressable: every output claim carries its own citation list.

The deterministic scorer keeps these dimensions separate:

- schema validity and abstention correctness;
- answer completeness;
- unsupported-claim rate, including arbitrary unmatched claims rather than
  only known trap phrases;
- citation validity, precision, and completeness;
- knowledge-gap accuracy;
- latency, token use, and cost.

In the end-to-end suite, retrieval gets its own pass/fail metric. If expected
supporting evidence is not retained, the row records `synthesisVerdict:
not-scored` and Review Studio leaves synthesis-quality metrics empty instead of
charging the retrieval miss to the model.

Production Think currently defaults to `openai/gpt-5.6-luna` and intentionally
sends no reasoning-effort parameter:

```dotenv
RUNIR_THINK_MODEL=openai/gpt-5.6-luna
```

That model choice is independent from capture extraction.

### Current fixed-evidence result

The first clean paid fixed-evidence Luna run completed 5/5 requests with HTTP
200 and schema-valid output for `$0.0008986` in observed gateway billing. The
original frozen scorer recorded 4/5 strict passes. Review of the fifth row
found that Luna preserved the exact bead, path, and URL and cited the correct
evidence, but the fixture modeled those three separately checkable facts as one
compound gold claim.

`Rúnir-41z` corrects the fixture by splitting those facts into three gold
claims. A zero-network re-score of the unchanged paid responses produces 5/5
strict passes, while regression coverage confirms that a merged shotgun claim
still fails. The original raw result and its 4/5 verdict remain immutable.

See
[`docs/analysis/luna-think-synthesis-2026-08-07-requesty-review.md`](analysis/luna-think-synthesis-2026-08-07-requesty-review.md)
for the result, latency, cost, and false-negative analysis.

### Current end-to-end result

The first clean seeded end-to-end Luna run used an isolated single-tenant
SurrealDB database containing only the seven synthetic corpus evidence items.
All five `/memory/think` requests passed retrieval retention and strict
synthesis scoring. Every row was schema-valid, fully cited, free of unsupported
claims, and correct on required gaps and abstention. Latency was 1,989 ms p50
and 3,695 ms maximum. Route-visible token usage estimates `$0.006838`; the
gateway did not return billed cost through the production route.

Because the tenant had seven memories and Think's retrieval window is 24,
every query selected all seven. This proves assembled-route retention and
grounded synthesis under distractors, not retrieval selectivity at scale.
`Rúnir-atg` tracks a larger zero-network distractor lane with retrieval
precision and rank metrics.

See
[`docs/analysis/luna-think-e2e-2026-08-07-requesty-review.md`](analysis/luna-think-e2e-2026-08-07-requesty-review.md)
for isolation, preflight, retrieval, synthesis, latency, cost, and limitations.

### Think zero-network preflight

The default command validates the corpus, prints the complete request count and
provenance disclosure, and makes no network calls:

```bash
npm run benchmark:think -- \
  --suite synthesis \
  --fixtures fixtures/think-benchmark/corpus.json \
  --model openai/gpt-5.6-luna \
  --candidate-id luna-think \
  --candidate-label "GPT-5.6 Luna" \
  --repetitions 1 \
  --timeout-ms 30000 \
  --max-output-tokens 1200
```

Dry preflight does not write model-quality rows. It proves only that the
bounded run shape, corpus, request contract, and source provenance are valid.

### Approved fixed-evidence Think run

Run paid execution only through the approved Infisical injection wrapper. The
runner never accepts a secret as a command-line flag and logs only the
credential source:

```bash
npm run benchmark:think -- \
  --suite synthesis \
  --fixtures fixtures/think-benchmark/corpus.json \
  --model openai/gpt-5.6-luna \
  --candidate-id luna-think \
  --candidate-label "GPT-5.6 Luna" \
  --repetitions 1 \
  --confirm-cost \
  --max-total-cost-usd 0.15 \
  --input-usd-per-1m <current-input-price> \
  --output-usd-per-1m <current-output-price> \
  --out-raw docs/analysis/raw/luna-think.jsonl \
  --out-report docs/analysis/luna-think.md
```

Paid execution fails closed unless the worktree is clean, the injected
`OPENROUTER_API_KEY` is present, the price inputs and cap are explicit, and the
worst-case token reservation fits beneath the cap. Existing artifacts are
refused before any request unless `--allow-overwrite` is explicit.
`--allow-dirty` is an emergency provenance escape hatch: it permits execution,
but the manifest remains dirty and Review Studio displays a `dirty_git`
warning. Do not use it for reference or promotion evidence.

### Loopback end-to-end Think run

Start a Rúnir instance whose test tenant contains the corpus's expected
memories, then use:

```bash
npm run benchmark:think -- \
  --suite e2e \
  --service-url http://127.0.0.1:7700 \
  --user-id owner \
  --model openai/gpt-5.6-luna \
  --candidate-id luna-think-e2e \
  --confirm-cost \
  --max-total-cost-usd 0.15 \
  --input-usd-per-1m <current-input-price> \
  --output-usd-per-1m <current-output-price> \
  --out-raw docs/analysis/raw/luna-think-e2e.jsonl \
  --out-report docs/analysis/luna-think-e2e.md
```

The runner refuses non-loopback service URLs. `RUNIR_API_KEY`, when required by
the local service, is read from the injected process environment. A mocked
route-contract test proves wiring; only a seeded run with expected IDs proves
retrieval quality. The production route returns token usage when the gateway
provides it; the runner estimates that row from the explicit price inputs. If
usage is unavailable, the row is marked `reserved_worst_case` and reserves a
conservative bound based on 12 evidence items capped at 4,000 characters each
plus the fixed prompt overhead and output ceiling. The manifest records
`route_usage_or_reservation` so Review Studio does not present that cost basis
as gateway billing.

## Open the results in Review Studio

Point Studio at the directory containing paired `.jsonl` and `.manifest.json`
artifacts:

```bash
npm run review-studio -- \
  --root docs/analysis/raw \
  --port 7711
```

Open [http://127.0.0.1:7711](http://127.0.0.1:7711).

Use:

- **Runs** for aggregate quality, latency, reliability, cost, configuration,
  and provenance;
- **Compare** for compatible baseline/candidate dumbbells and heatmaps;
- **Case Detail** for exact capture parser evidence or a Think
  claim-to-evidence matrix, knowledge gaps, retrieval contract, and scores;
- **Refresh** after the runner writes a new artifact beneath a configured root;
- **Export JSON** or Print for a review handoff.

Runs are comparison-compatible only when their suite, corpus, scoring contract,
prompt template, metric contract, and relevant condition provenance align.
Legacy or same-suite version mismatches require a deliberate override.
Different suite IDs can never be overridden into one comparison.

## Why Gemini 3.1 was selected

The broad full-corpus run compared four candidates under the same 15 cases and
three repetitions:

| Candidate | Precision | Recall | Hallucination | Omission | Mean latency | p95 latency |
|---|---:|---:|---:|---:|---:|---:|
| Gemini 3.1 Flash-Lite | 100.0% | 100.0% | 0.0% | 0.0% | 1,597 ms | 2,363 ms |
| Gemini 3.5 Flash-Lite | 95.6% | 95.6% | 4.4% | 4.4% | 1,497 ms | 2,497 ms |
| GPT-5.6 Luna Low | 100.0% | 98.9% | 0.0% | 1.1% | 1,703 ms | 2,860 ms |
| Grok 4.5 Low | 94.8% | 95.6% | 5.2% | 4.4% | 3,546 ms | 7,078 ms |

Source:
[`docs/analysis/model-benchmark-full-primary.md`](analysis/model-benchmark-full-primary.md).
Costs in that report are gateway- and date-specific; quality and latency drove
the decision.

Gemini 3.1 was selected because it was the only candidate in that broad run
with perfect measured quality while retaining low latency. Gemini 3.5 was
slightly faster on mean latency but lost exact URL fidelity in two repetitions,
had a slightly worse p95, and provided no material cost advantage.

A later clean full-corpus reference run again gave Gemini 3.1 100% precision
and recall. Luna Low fell to 93.3% recall in that run:
[`docs/analysis/model-benchmark-v2-reference-a-2026-08-07-requesty.md`](analysis/model-benchmark-v2-reference-a-2026-08-07-requesty.md).

Luna High corrected Luna Low's fact-merging failure on the targeted
`alias-ambiguous` and `quantity-port` cases, passing all six requests, but that
was a two-case acceptance probe rather than a complete promotion run. Its mean
latency was 4,690 ms:
[`docs/analysis/model-benchmark-v2-luna-high-requesty-pilot-2026-08-07-requesty.md`](analysis/model-benchmark-v2-luna-high-requesty-pilot-2026-08-07-requesty.md).
That result demonstrated a useful effort effect, not superiority over Gemini
3.1 across the corpus.

Gemini 3.5 High reasoning preserved the exact URL/path case once, but took
11,081 ms. Low and Medium failed exact URL fidelity in the same acceptance
probe:
[`docs/analysis/model-benchmark-v2-gemini-3.5-reasoning-acceptance-2026-08-07-requesty.md`](analysis/model-benchmark-v2-gemini-3.5-reasoning-acceptance-2026-08-07-requesty.md).
This was diagnostic evidence, not a production-selection result.

### Why Haiku 4.5 was not admitted

Haiku 4.5 was **not** run through the current 15-case benchmark, so it has no
comparable precision, recall, latency, or cost score and must not be described
as a scored benchmark loser.

It was excluded before the candidate matrix based on an earlier operational
extraction evaluation:

- its observed output put a raw newline inside a JSON string while extracting
  basic multiline text, making the response invalid under normal `JSON.parse`;
- the local Haiku proxy's unknown-model fallback also obscured reliable
  model-attribution metrics.

Those failures led to JSON-repair coverage in
[`src/__tests__/extract-json-retry-repair.test.ts`](../src/__tests__/extract-json-retry-repair.test.ts)
and corrected model-resolution provenance in
[`src/entities/entity-extractor.ts`](../src/entities/entity-extractor.ts).

The benchmark admission bar requires parseable structured output and
unambiguous model attribution before paying for a full comparative run. Haiku
did not clear that bar in the preserved evaluation, and its cost was not
measured by this harness. This is an evidence-bounded exclusion, not a claim
that every possible Haiku configuration must fail.

## Interpreting a report

Promotion decisions should consider all of:

- schema validity and first-attempt success
- atomic precision and recall
- hallucination, omission, and abstention behavior
- evidence and exact-value fidelity
- p50/p90/p95 latency and timeout rate
- gateway-billed or dated estimated cost
- repetition stability
- prompt, corpus, source, and effective request provenance

A targeted probe can diagnose a failure or prove that an effort setting changes
behavior. It cannot by itself replace a full-corpus promotion run.

## Validation and troubleshooting

Show the runner's current options:

```bash
node --import tsx/esm scripts/model-benchmark-extraction.ts --help
```

Validate the runner and Studio:

```bash
npm test -- --run src/__tests__/model-benchmark-extraction.test.ts
npm run review-studio:test
npm run typecheck
```

Common failures:

- **No run in Studio:** confirm both the JSONL and matching manifest are below
  the configured `--root`, then refresh the catalog.
- **Incompatible comparison:** compare the manifest hashes and condition
  provenance; do not bypass the warning until the mismatch is understood.
- **Paid run blocked:** obtain approval, use `--confirm-cost`, and inject the
  required credential through the approved secret manager.
- **Dirty worktree blocked:** commit or otherwise settle the exact source state
  before using `--require-clean-git`; do not remove the guard merely to proceed.
- **Cost estimate unavailable:** define an explicit candidate with dated
  pricing before a paid run.
