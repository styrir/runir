# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-07-22T23-34-33-311Z-a2ef5c91`
- Created: 2026-07-22T23:34:42.305Z
- Git: `561b113e7fb9694776f9db7a94d80d95b0b19f4c` (dirty)
- Prompt hash: `5674d7f8116dd8f5153853e981e386e9cc20bee9bc5fd5dcc8d32bb6c956f2b2`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 6

## Executive recommendation

Gemini 3.1 Flash-Lite remains the production control. Recommend **keep** unless 3.5 Flash-Lite (or another challenger) shows no material regression in schema validity, hallucination, abstention, or evidence fidelity, improves precision/recall enough to justify measured $/1k turns, and stays within capture p95 latency. Review quality and cost tables above before proposing a switch.

## Model / configuration matrix

| ID | Label | Model ID | Reasoning | Support | Notes |
|---|---|---|---|---|---|
| flash-lite-3.1-control | Gemini 3.1 Flash-Lite @us (control / production) | `vertex/gemini-3.1-flash-lite@us` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| flash-lite-3.5 | Gemini 3.5 Flash-Lite (challenger) | `vertex/gemini-3.5-flash-lite` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |

## Corpus and scoring

- Cases: 3 (smoke subset)
- Repetitions: 1
- Planned requests: 6
- Gateway: `https://router.requesty.ai/v1`
- Credential source: `env:REQUESTY_API_KEY`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| flash-lite-3.5 | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 1850 | 2128 | 2163 | 1650 | 100.0% | 100.0% | 0.0% |
| flash-lite-3.5 | 1341 | 1867 | 1933 | 1347 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-3.1-control | 0.003720 | 3.7197 | 0.002790 | 218.0 |
| flash-lite-3.5 | 0.003802 | 3.8016 | 0.002851 | 248.3 |

Cost note: Conservative estimate assumes ~2k input + ~800 output tokens/request at max list price among candidates (in=$0.45/1M, out=$2.7/1M as of candidate tables). Gateway billing may differ.

## Notable failures

_No catastrophic schema/hallucination/abstention failures in this artifact._

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
