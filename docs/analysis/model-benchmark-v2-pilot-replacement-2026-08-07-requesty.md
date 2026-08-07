# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-08-07T04-57-01-753Z-c54a2db4`
- Condition: `pilot-replacement-2026-08-07`
- Created: 2026-08-07T04:57:01.753Z
- Git: `ee5e411931bdc5aa2db968ae6f2b00a41a5c677b`
- Fixture content hash: `8c37c2d13119086dfe437d80816728a55574ad7ce7372b5e47ede324770d5f5e`
- Prompt template hash: `ef76dcb4865eaf962d553bf5a2fcc6b1e11ba00a235544ee3219cc313a8beccc`
- Scoring contract: `runir-model-benchmark-scoring/v1`
- Prompt hash: `e151374223c0be6f09268a3de8b52ddd6c6901d5d9f229ed324e5ed7949660a5`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 6
- Completion: **complete** (6/6)
- Cumulative billed/estimated cost: $0.010471

## Executive recommendation

Gemini 3.1 Flash-Lite remains the production control. Recommend **keep** unless 3.5 Flash-Lite (or another challenger) shows no material regression in schema validity, hallucination, abstention, or evidence fidelity, improves precision/recall enough to justify measured $/1k turns, and stays within capture p95 latency. Review quality and cost tables above before proposing a switch.

## Model / configuration matrix

| ID | Label | Model ID | Reasoning | Support | Notes |
|---|---|---|---|---|---|
| flash-lite-3.1-control | Gemini 3.1 Flash-Lite @us (control / production) | `vertex/gemini-3.1-flash-lite@us` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| luna-low | GPT-5.6 Luna (reasoning=low) | `openai/gpt-5.6-luna` | low | native | native reasoning_effort=low |

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
| luna-low | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 1518 | 2020 | 2083 | 1496 | 100.0% | 100.0% | 0.0% |
| luna-low | 2412 | 2837 | 2890 | 2053 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-3.1-control | 0.002007 | 2.0072 | 0.001505 | 176.7 |
| luna-low | 0.001483 | 1.4831 | 0.001112 | 152.7 |

Cost note: Calibrated planning estimate assumes 7500 input + 800 output tokens/request at each candidate's dated list-price table. The input assumption is rounded above the 6,958-token live-smoke mean. This is not a guaranteed ceiling; runtime enforcement prefers gateway-billed cost, then token-estimated cost.
Runtime cost cap: $0.0300

## Notable failures

_No catastrophic schema/hallucination/abstention failures in this artifact._

## Limitations

- Gold matching is substring-based and may under-credit valid paraphrases.
- Gateway routing/pricing may differ from public list prices.
- Grok default-only reasoning must not be labeled low unless native control is verified.
- Dry-run rows use synthetic/zero network latency unless fixtures inject values.

## Reproduction

```bash
# Required source: ee5e411931bdc5aa2db968ae6f2b00a41a5c677b in a clean worktree
# Exact zero-network reproduction
node --import tsx/esm scripts/model-benchmark-extraction.ts --dry-run --models 'flash-lite-3.1-control,luna-low' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 1 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --smoke --condition-id 'pilot-replacement-2026-08-07' --max-total-cost-usd 0.03 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/pilot-replacement-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-pilot-replacement-2026-08-07-requesty.md'
# Exact paid reproduction (fresh human approval required)
REQUESTY_API_KEY=… node --import tsx/esm scripts/model-benchmark-extraction.ts --confirm-cost --models 'flash-lite-3.1-control,luna-low' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 1 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --smoke --condition-id 'pilot-replacement-2026-08-07' --max-total-cost-usd 0.03 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/pilot-replacement-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-pilot-replacement-2026-08-07-requesty.md'
```
