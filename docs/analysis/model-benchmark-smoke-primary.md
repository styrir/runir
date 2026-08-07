# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-07-22T23-39-27-909Z-7ac522e2`
- Created: 2026-07-22T23:39:54.000Z
- Git: `561b113e7fb9694776f9db7a94d80d95b0b19f4c` (dirty)
- Prompt hash: `fe3bdc74e7f1d90d855282646f735b821474ec2fbd40201bf725253a6a9a2e74`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 12

## Executive recommendation

Gemini 3.1 Flash-Lite remains the production control. Recommend **keep** unless 3.5 Flash-Lite (or another challenger) shows no material regression in schema validity, hallucination, abstention, or evidence fidelity, improves precision/recall enough to justify measured $/1k turns, and stays within capture p95 latency. Review quality and cost tables above before proposing a switch.

## Model / configuration matrix

| ID | Label | Model ID | Reasoning | Support | Notes |
|---|---|---|---|---|---|
| flash-lite-3.1-control | Gemini 3.1 Flash-Lite @us (control / production) | `vertex/gemini-3.1-flash-lite@us` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| flash-lite-3.5 | Gemini 3.5 Flash-Lite (challenger) | `vertex/gemini-3.5-flash-lite` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| luna-low | GPT-5.6 Luna (reasoning=low) | `openai/gpt-5.6-luna` | low | native | native reasoning_effort=low |
| grok-4.5-low | Grok 4.5 (reasoning=low) | `xai/grok-4.5` | low | native | native reasoning_effort=low; jsonMode=off: response_format omitted (matches production non-openai extract path) |

## Corpus and scoring

- Cases: 3 (smoke subset)
- Repetitions: 1
- Planned requests: 12
- Gateway: `https://router.requesty.ai/v1`
- Credential source: `env:REQUESTY_API_KEY`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| flash-lite-3.5 | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| grok-4.5-low | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| luna-low | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 2144 | 2969 | 3072 | 2151 | 100.0% | 100.0% | 0.0% |
| flash-lite-3.5 | 1348 | 2324 | 2446 | 1584 | 100.0% | 100.0% | 0.0% |
| grok-4.5-low | 3278 | 4422 | 4565 | 3240 | 100.0% | 100.0% | 0.0% |
| luna-low | 1646 | 2460 | 2562 | 1720 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-3.1-control | 0.003760 | 3.7602 | 0.002820 | 233.0 |
| flash-lite-3.5 | 0.003763 | 3.7629 | 0.002822 | 234.0 |
| grok-4.5-low | 0.015139 | 15.1393 | 0.011355 | 231.7 |
| luna-low | 0.007444 | 7.4443 | 0.005583 | 159.3 |

Cost note: Conservative estimate assumes ~2k input + ~800 output tokens/request at max list price among candidates (in=$2/1M, out=$6/1M as of candidate tables). Gateway billing may differ.

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
