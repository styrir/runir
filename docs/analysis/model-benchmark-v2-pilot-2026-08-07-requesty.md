# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-08-07T04-49-44-932Z-af6b6a29`
- Condition: `pilot-2026-08-07`
- Created: 2026-08-07T04:49:44.932Z
- Git: `b71990d84655ac3b70ee02c8582f1f0016a0bed1`
- Fixture content hash: `8c37c2d13119086dfe437d80816728a55574ad7ce7372b5e47ede324770d5f5e`
- Prompt template hash: `2e7efde6c7c7e5e0b880d3e7705d9944ac881da794b5322268bb64a4c58783be`
- Scoring contract: `runir-model-benchmark-scoring/v1`
- Prompt hash: `1aa2b17954083db16c1f6d9f81442cb5c5baf38d4fce5852c1ec883eb99998b4`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 1
- Completion: **partial** (1/6)
- Stop reason: `model_rejected`
- Cumulative billed/estimated cost: $0.012300

## Executive recommendation

Control candidate (Gemini 3.1 Flash-Lite) missing from results; collect more evidence before any production change.

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
| luna-low | 1 | 0.0% | 0.0% | 0.0% | 0.0% | 100.0% | n/a |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| luna-low | 1147 | 1147 | 1147 | 1147 | 0.0% | 0.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| luna-low | 0.012300 | 12.3000 | n/a | n/a |

Cost note: Calibrated planning estimate assumes 7500 input + 800 output tokens/request at each candidate's dated list-price table. The input assumption is rounded above the 6,958-token live-smoke mean. This is not a guaranteed ceiling; runtime enforcement prefers gateway-billed cost, then token-estimated cost.
Runtime cost cap: $0.0300

## Notable failures

- `luna-low` / `atomic-simple` r1: error=http_400 schema=false class=wrong_schema hall=0.0% head="{\"error\":{\"origin\":\"provider\",\"message\":\"Response input messages must contain the word 'json' in some form to

## Limitations

- Gold matching is substring-based and may under-credit valid paraphrases.
- Gateway routing/pricing may differ from public list prices.
- Grok default-only reasoning must not be labeled low unless native control is verified.
- Dry-run rows use synthetic/zero network latency unless fixtures inject values.

## Reproduction

```bash
# Required source: b71990d84655ac3b70ee02c8582f1f0016a0bed1 in a clean worktree
# Exact zero-network reproduction
node --import tsx/esm scripts/model-benchmark-extraction.ts --dry-run --models 'flash-lite-3.1-control,luna-low' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 1 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --smoke --condition-id 'pilot-2026-08-07' --max-total-cost-usd 0.03 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/pilot-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-pilot-2026-08-07-requesty.md'
# Exact paid reproduction (fresh human approval required)
REQUESTY_API_KEY=… node --import tsx/esm scripts/model-benchmark-extraction.ts --confirm-cost --models 'flash-lite-3.1-control,luna-low' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 1 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --smoke --condition-id 'pilot-2026-08-07' --max-total-cost-usd 0.03 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/pilot-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-pilot-2026-08-07-requesty.md'
```
