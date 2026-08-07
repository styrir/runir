# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-07-22T23-43-35-279Z-10006f68`
- Created: 2026-07-22T23:49:50.747Z
- Git: `561b113e7fb9694776f9db7a94d80d95b0b19f4c` (dirty)
- Prompt hash: `acfffc5f59776560c6521f520aede70cbfbb3c384c634edaf34cdd0c12cd401d`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 180

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

- Cases: 15
- Repetitions: 3
- Planned requests: 180
- Gateway: `https://router.requesty.ai/v1`
- Credential source: `env:REQUESTY_API_KEY`
- Scoring: human gold mustContain matching; precision/recall/hallucination/omission/abstention; no model-as-judge gold.

## Quality

| Candidate | n | Schema-valid | Precision | Recall | Hallucination | Omission | Abstention |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 45 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| flash-lite-3.5 | 45 | 100.0% | 95.6% | 95.6% | 4.4% | 4.4% | 100.0% |
| grok-4.5-low | 45 | 100.0% | 94.8% | 95.6% | 5.2% | 4.4% | 100.0% |
| luna-low | 45 | 100.0% | 100.0% | 98.9% | 0.0% | 1.1% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-3.1-control | 1568 | 2306 | 2363 | 1597 | 100.0% | 100.0% | 0.0% |
| flash-lite-3.5 | 1426 | 2098 | 2497 | 1497 | 100.0% | 100.0% | 0.0% |
| grok-4.5-low | 3316 | 5505 | 7078 | 3546 | 100.0% | 100.0% | 0.0% |
| luna-low | 1689 | 2460 | 2860 | 1703 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-3.1-control | 0.003734 | 3.7337 | 0.003734 | 220.9 |
| flash-lite-3.5 | 0.003704 | 3.7037 | 0.003876 | 209.8 |
| grok-4.5-low | 0.015458 | 15.4580 | 0.016177 | 280.6 |
| luna-low | 0.007498 | 7.4979 | 0.007668 | 166.3 |

Cost note: Conservative estimate assumes ~2k input + ~800 output tokens/request at max list price among candidates (in=$2/1M, out=$6/1M as of candidate tables). Gateway billing may differ.

## Notable failures

- `flash-lite-3.5` / `identifiers-path-url` r2: error=none schema=true class=malformed hall=100.0% head="{\\n  \"facts\": [\\n    {\\n      \"l2\": \"User noted that the project is related to GitHub repository styrir/runir,
- `flash-lite-3.5` / `identifiers-path-url` r3: error=none schema=true class=valid hall=100.0% head="{\"facts\": [{\"l2\": \"User noted that the project is styrir/runir, and its extractor prompt is located in src/domain/
- `grok-4.5-low` / `identifiers-path-url` r1: error=none schema=true class=valid hall=100.0% head="{\"facts\": [{\"l2\": \"Project Runir is related to the GitHub repository https://github.com/styrir/runir.\", \"l0\": \
- `grok-4.5-low` / `identifiers-path-url` r3: error=none schema=true class=valid hall=100.0% head="{\"facts\": [{\"l2\": \"Project Runir is related to the GitHub repository https://github.com/styrir/runir.\", \"l0\": \

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
