# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-08-07T08-04-11-449Z-a53ab8e1`
- Condition: `luna-high-requesty-pilot-2026-08-07`
- Created: 2026-08-07T08:04:11.449Z
- Git: `8718cfd0c3ede0c8283e64a6fefae0d0c1bcb5f7`
- Fixture content hash: `8c37c2d13119086dfe437d80816728a55574ad7ce7372b5e47ede324770d5f5e`
- Prompt template hash: `ef76dcb4865eaf962d553bf5a2fcc6b1e11ba00a235544ee3219cc313a8beccc`
- Scoring contract: `runir-model-benchmark-scoring/v1`
- Prompt hash: `3a41493e30daac5acd1c2531139e99dc348bb3090b6c319bb90f16f7dcc26a7b`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 6
- Completion: **complete** (6/6)
- Cumulative billed/estimated cost: $0.006935

## Executive recommendation

Control candidate (Gemini 3.1 Flash-Lite) missing from results; collect more evidence before any production change.

## Model / configuration matrix

| ID | Label | Model ID | API | Endpoint | Reasoning | Support | Notes |
|---|---|---|---|---|---|---|---|
| luna-high-requesty | GPT-5.6 Luna (Requesty Chat Completions, reasoning=high) | `openai/gpt-5.6-luna` | chat_completions | configured | high | native | native reasoning_effort=high |

## Corpus and scoring

- Cases: 2
- Case IDs: `alias-ambiguous`, `quantity-port`
- Repetitions: 3
- Planned requests: 6
- Configured gateway default: `https://router.requesty.ai/v1`
- Credential sources: `env:REQUESTY_API_KEY`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| luna-high-requesty | 6 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | n/a |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| luna-high-requesty | 4644 | 5726 | 5765 | 4690 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| luna-high-requesty | 0.001156 | 1.1558 | 0.000578 | 529.0 |

Cost note: Calibrated planning estimate assumes 7500 input + 800 output tokens/request at each candidate's dated list-price table. The input assumption is rounded above the 6,958-token live-smoke mean. This is not a guaranteed ceiling; runtime enforcement prefers gateway-billed cost, then token-estimated cost.
Runtime cost cap: $0.1500

## Notable failures

_No catastrophic schema/hallucination/abstention failures in this artifact._

## Limitations

- Gold matching is substring-based and may under-credit valid paraphrases.
- Gateway routing/pricing may differ from public list prices.
- Grok default-only reasoning must not be labeled low unless native control is verified.
- Dry-run rows use synthetic/zero network latency unless fixtures inject values.

## Reproduction

```bash
# Required source: 8718cfd0c3ede0c8283e64a6fefae0d0c1bcb5f7 in a clean worktree
# Exact zero-network reproduction
node --import tsx/esm scripts/model-benchmark-extraction.ts --dry-run --models 'luna-high-requesty' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 3 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --case-ids 'alias-ambiguous,quantity-port' --condition-id 'luna-high-requesty-pilot-2026-08-07' --max-total-cost-usd 0.15 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/luna-high-requesty-pilot-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-luna-high-requesty-pilot-2026-08-07-requesty.md'
# Exact paid reproduction (fresh human approval required)
# Run the following only through the approved Infisical credential injection path:
node --import tsx/esm scripts/model-benchmark-extraction.ts --confirm-cost --models 'luna-high-requesty' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 3 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --case-ids 'alias-ambiguous,quantity-port' --condition-id 'luna-high-requesty-pilot-2026-08-07' --max-total-cost-usd 0.15 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/luna-high-requesty-pilot-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-luna-high-requesty-pilot-2026-08-07-requesty.md'
```
