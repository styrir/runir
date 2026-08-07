# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `dry-2026-07-22T23-22-04-551Z`
- Created: 2026-07-22T23:22:04.553Z
- Git: `561b113e7fb9694776f9db7a94d80d95b0b19f4c` (dirty)
- Prompt hash: `070124a313f4234674814a3084d4ed158e72f812eafe35c3cc0d105b2caeeeee`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 12

## Executive recommendation

No paid results yet. Keep `vertex/gemini-3.1-flash-lite@us` as production control until smoke + full benchmark complete.

## Model / configuration matrix

| ID | Label | Model ID | Reasoning | Support | Notes |
|---|---|---|---|---|---|
| flash-lite-control | Gemini 3.1 Flash-Lite (control) | `vertex/gemini-3.1-flash-lite@us` | — | unsupported | reasoning unsupported; no reasoning parameter sent; reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| grok-4.5 | Grok 4.5 | `xai/grok-4.5` | low | default-only | reasoningSupport=default-only: requested reasoning=low is NOT asserted; gateway default behavior applies; do not label results as "low"; reasoningSupport=default-only: requested reasoning=low is NOT asserted; gateway default behavior applies; do not label results as "low"; jsonMode=off: response_format omitted (matches production non-openai extract path); effective reasoning level: gateway-default (unlabeled) |
| luna-low | GPT-5.6 Luna (reasoning=low) | `openai/gpt-5.6-luna` | low | native | native reasoning_effort=low; native reasoning_effort=low |
| luna-none | GPT-5.6 Luna (reasoning=none) | `openai/gpt-5.6-luna` | none | native | native reasoning_effort=none; native reasoning_effort=none |

## Corpus and scoring

- Cases: 3 (smoke subset)
- Repetitions: 1
- Planned requests: 12
- Gateway: `https://openrouter.ai/api/v1`
- Credential source: `missing`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-control | 3 | 0.0% | 33.3% | 33.3% | 0.0% | 66.7% | 100.0% |
| grok-4.5 | 3 | 0.0% | 33.3% | 33.3% | 0.0% | 66.7% | 100.0% |
| luna-low | 3 | 0.0% | 33.3% | 33.3% | 0.0% | 66.7% | 100.0% |
| luna-none | 3 | 0.0% | 33.3% | 33.3% | 0.0% | 66.7% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-control | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0% |
| grok-4.5 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0% |
| luna-low | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0% |
| luna-none | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-control | n/a | n/a | n/a | n/a |
| grok-4.5 | n/a | n/a | n/a | n/a |
| luna-low | n/a | n/a | n/a | n/a |
| luna-none | n/a | n/a | n/a | n/a |

Cost note: Conservative estimate assumes ~2k input + ~800 output tokens/request at max list price among candidates (in=$2/1M, out=$6/1M as of candidate tables). Gateway billing may differ.

## Notable failures

- `flash-lite-control` / `atomic-simple` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `flash-lite-control` / `multi-claim-split` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `flash-lite-control` / `fabrication-trap` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `grok-4.5` / `atomic-simple` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `grok-4.5` / `multi-claim-split` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `grok-4.5` / `fabrication-trap` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `luna-low` / `atomic-simple` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `luna-low` / `multi-claim-split` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `luna-low` / `fabrication-trap` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `luna-none` / `atomic-simple` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `luna-none` / `multi-claim-split` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""
- `luna-none` / `fabrication-trap` r1: error=dry_run schema=false class=empty_content hall=0.0% head=""

## Limitations

- Gold matching is substring-based and may under-credit valid paraphrases.
- Gateway routing/pricing may differ from public list prices.
- Grok default-only reasoning must not be labeled low unless native control is verified.
- Dry-run rows use synthetic/zero network latency unless fixtures inject values.

## Reproduction

```bash
# Free dry-run (default)
npx tsx scripts/model-benchmark-extraction.ts --dry-run
# Paid smoke (human approval required)
REQUESTY_API_KEY=… npx tsx scripts/model-benchmark-extraction.ts --confirm-cost --smoke --repetitions 1
# Full run (second human approval)
REQUESTY_API_KEY=… npx tsx scripts/model-benchmark-extraction.ts --confirm-cost --repetitions 3
```
