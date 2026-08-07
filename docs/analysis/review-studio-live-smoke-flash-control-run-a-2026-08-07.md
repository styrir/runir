# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-08-07T03-08-51-723Z-9d4e1d07`
- Created: 2026-08-07T03:08:57.672Z
- Git: `85a9592abf1a2014b1f5f3015170992f64e31be6` (dirty)
- Fixture content hash: `8c37c2d13119086dfe437d80816728a55574ad7ce7372b5e47ede324770d5f5e`
- Prompt template hash: `2e7efde6c7c7e5e0b880d3e7705d9944ac881da794b5322268bb64a4c58783be`
- Scoring contract: `runir-model-benchmark-scoring/v1`
- Prompt hash: `3a93c410464335206b85246417d0180e5854e6a92ce5a8269038b5e548eaae14`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 3

## Executive recommendation

Gemini 3.1 Flash-Lite remains the production control. Recommend **keep** unless 3.5 Flash-Lite (or another challenger) shows no material regression in schema validity, hallucination, abstention, or evidence fidelity, improves precision/recall enough to justify measured $/1k turns, and stays within capture p95 latency. Review quality and cost tables above before proposing a switch.

## Model / configuration matrix

| ID | Label | Model ID | Reasoning | Support | Notes |
|---|---|---|---|---|---|
| flash-lite-3.1-control | Gemini 3.1 Flash-Lite @us (control / production) | `vertex/gemini-3.1-flash-lite@us` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |

## Corpus and scoring

- Cases: 3 (smoke subset)
- Repetitions: 1
- Planned requests: 3
- Gateway: `https://router.requesty.ai/v1`
- Credential source: `env:REQUESTY_API_KEY`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 2262 | 2792 | 2858 | 1982 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-3.1-control | 0.003767 | 3.7674 | 0.002826 | 235.7 |

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
