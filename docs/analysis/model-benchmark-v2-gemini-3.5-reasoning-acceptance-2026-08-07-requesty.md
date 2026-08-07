# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-08-07T08-37-27-896Z-b92a0bdf`
- Condition: `gemini-3.5-reasoning-acceptance-2026-08-07`
- Created: 2026-08-07T08:37:27.896Z
- Git: `1e70ba809d05fa1d0063c2eb6877f175a21922ec`
- Fixture content hash: `8c37c2d13119086dfe437d80816728a55574ad7ce7372b5e47ede324770d5f5e`
- Prompt template hash: `ef76dcb4865eaf962d553bf5a2fcc6b1e11ba00a235544ee3219cc313a8beccc`
- Scoring contract: `runir-model-benchmark-scoring/v1`
- Prompt hash: `97c198956a41a82479c015cff3939aaad80a5bcb0ee1859e27d1b823165dd6e4`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 3
- Completion: **complete** (3/3)
- Cumulative billed/estimated cost: $0.014587

## Executive recommendation

Control candidate (Gemini 3.1 Flash-Lite) missing from results; collect more evidence before any production change.

## Model / configuration matrix

| ID | Label | Model ID | API | Endpoint | Reasoning | Support | Mapped budget | Notes |
|---|---|---|---|---|---|---|---:|---|
| flash-lite-3.5-reasoning-high | Gemini 3.5 Flash-Lite (Requesty mapped reasoning=high / 24,576 tokens) | `vertex/gemini-3.5-flash-lite` | chat_completions | configured | high | gateway-mapped | 24576 | Requesty Vertex mapping: reasoning_effort=high -> reasoning budget 24576 tokens; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| flash-lite-3.5-reasoning-low | Gemini 3.5 Flash-Lite (Requesty mapped reasoning=low / 1,024 tokens) | `vertex/gemini-3.5-flash-lite` | chat_completions | configured | low | gateway-mapped | 1024 | Requesty Vertex mapping: reasoning_effort=low -> reasoning budget 1024 tokens; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| flash-lite-3.5-reasoning-medium | Gemini 3.5 Flash-Lite (Requesty mapped reasoning=medium / 8,192 tokens) | `vertex/gemini-3.5-flash-lite` | chat_completions | configured | medium | gateway-mapped | 8192 | Requesty Vertex mapping: reasoning_effort=medium -> reasoning budget 8192 tokens; jsonMode=off: response_format omitted (matches production non-openai extract path) |

## Corpus and scoring

- Cases: 1
- Case IDs: `identifiers-path-url`
- Repetitions: 1
- Planned requests: 3
- Configured gateway default: `https://router.requesty.ai/v1`
- Credential sources: `env:REQUESTY_API_KEY`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.5-reasoning-high | 1 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | n/a |
| flash-lite-3.5-reasoning-low | 1 | 100.0% | 0.0% | 0.0% | 100.0% | 100.0% | n/a |
| flash-lite-3.5-reasoning-medium | 1 | 100.0% | 0.0% | 0.0% | 100.0% | 100.0% | n/a |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.5-reasoning-high | 11081 | 11081 | 11081 | 11081 | 100.0% | 100.0% | 0.0% |
| flash-lite-3.5-reasoning-low | 2145 | 2145 | 2145 | 2145 | 100.0% | 100.0% | 0.0% |
| flash-lite-3.5-reasoning-medium | 7364 | 7364 | 7364 | 7364 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-3.5-reasoning-high | 0.006642 | 6.6424 | 0.006642 | 1819.0 |
| flash-lite-3.5-reasoning-low | 0.002632 | 2.6324 | n/a | 215.0 |
| flash-lite-3.5-reasoning-medium | 0.005312 | 5.3124 | n/a | 1287.0 |

Cost note: Calibrated planning estimate assumes 7500 input + 800 output tokens/request at each candidate's dated list-price table. The input assumption is rounded above the 6,958-token live-smoke mean. This is not a guaranteed ceiling; runtime enforcement prefers gateway-billed cost, then token-estimated cost. For gateway-mapped reasoning candidates, the full declared reasoning budget is added to planning cost and to the per-request runtime reserve as output tokens.
Runtime cost cap: $0.1500

## Notable failures

- `flash-lite-3.5-reasoning-low` / `identifiers-path-url` r1: error=none schema=true class=valid hall=100.0% head="{\\n  \"facts\": [\\n    {\\n      \"l2\": \"User noted that the project is styrir/runir and the extractor prompt file
- `flash-lite-3.5-reasoning-medium` / `identifiers-path-url` r1: error=none schema=true class=valid hall=100.0% head="{\\n  \"facts\": [\\n    {\\n      \"l2\": \"The memory extractor prompt for the styrir/runir repository is located at

## Limitations

- Gold matching is substring-based and may under-credit valid paraphrases.
- Gateway routing/pricing may differ from public list prices.
- Grok default-only reasoning must not be labeled low unless native control is verified.
- Dry-run rows use synthetic/zero network latency unless fixtures inject values.

## Reproduction

```bash
# Required source: 1e70ba809d05fa1d0063c2eb6877f175a21922ec in a clean worktree
# Exact zero-network reproduction
node --import tsx/esm scripts/model-benchmark-extraction.ts --dry-run --models 'flash-lite-3.5-reasoning-high,flash-lite-3.5-reasoning-low,flash-lite-3.5-reasoning-medium' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 1 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --case-ids 'identifiers-path-url' --condition-id 'gemini-3.5-reasoning-acceptance-2026-08-07' --max-total-cost-usd 0.15 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/gemini-3.5-reasoning-acceptance-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-gemini-3.5-reasoning-acceptance-2026-08-07-requesty.md'
# Exact paid reproduction (fresh human approval required)
# Run the following only through the approved Infisical credential injection path:
node --import tsx/esm scripts/model-benchmark-extraction.ts --confirm-cost --models 'flash-lite-3.5-reasoning-high,flash-lite-3.5-reasoning-low,flash-lite-3.5-reasoning-medium' --fixtures '/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json' --repetitions 1 --concurrency 1 --timeout-ms 180000 --max-output-tokens 2048 --base-url 'https://router.requesty.ai/v1' --case-ids 'identifiers-path-url' --condition-id 'gemini-3.5-reasoning-acceptance-2026-08-07' --max-total-cost-usd 0.15 --require-clean-git --out-raw '/Users/brooks/Code/runir/docs/analysis/raw/model-benchmark-v2/gemini-3.5-reasoning-acceptance-2026-08-07-requesty.jsonl' --out-report '/Users/brooks/Code/runir/docs/analysis/model-benchmark-v2-gemini-3.5-reasoning-acceptance-2026-08-07-requesty.md'
```
