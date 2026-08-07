# Rúnir Extraction Model Benchmark Report

- Schema: `runir-model-benchmark/v1`
- Run ID: `paid-2026-07-22T23-31-29-871Z-cb3c179c`
- Created: 2026-07-22T23:32:05.595Z
- Git: `561b113e7fb9694776f9db7a94d80d95b0b19f4c` (dirty)
- Prompt hash: `8b6f90230ee3dacb8ea2d87e74e62d48001932b0a2e63564a689ab1dc6eec925`
- Fixtures: `/Users/brooks/Code/runir/fixtures/model-benchmark/corpus.json`
- Rows: 12

## Executive recommendation

Flash-Lite remains the incumbent control. Recommend **keep** production model unless a challenger shows no material regression in schema validity, hallucination, abstention, or evidence fidelity, improves precision/recall enough to justify measured $/1k turns, and stays within capture p95 latency. Review quality and cost tables above before proposing a switch.

## Model / configuration matrix

| ID | Label | Model ID | Reasoning | Support | Notes |
|---|---|---|---|---|---|
| flash-lite-control | Gemini 3.1 Flash-Lite (control) | `vertex/gemini-3.1-flash-lite@us` | — | unsupported | reasoning unsupported; no reasoning parameter sent; jsonMode=off: response_format omitted (matches production non-openai extract path) |
| grok-4.5 | Grok 4.5 | `xai/grok-4.5` | low | default-only | reasoningSupport=default-only: requested reasoning=low is NOT asserted; gateway default behavior applies; do not label results as "low"; jsonMode=off: response_format omitted (matches production non-openai extract path); effective reasoning level: gateway-default (unlabeled) |
| luna-low | GPT-5.6 Luna (reasoning=low) | `openai/gpt-5.6-luna` | low | native | native reasoning_effort=low |
| luna-none | GPT-5.6 Luna (reasoning=none) | `openai/gpt-5.6-luna` | none | native | native reasoning_effort=none |

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
| flash-lite-control | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| grok-4.5 | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| luna-low | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| luna-none | 3 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |

## Latency / reliability

| Candidate | p50 ms | p90 ms | p95 ms | mean ms | valid % | first-ok % | timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|
| flash-lite-control | 1614 | 1752 | 1770 | 1509 | 100.0% | 100.0% | 0.0% |
| grok-4.5 | 4563 | 12465 | 13453 | 7012 | 100.0% | 100.0% | 0.0% |
| luna-low | 1615 | 2198 | 2271 | 1710 | 100.0% | 100.0% | 0.0% |
| luna-none | 1410 | 2132 | 2223 | 1675 | 100.0% | 100.0% | 0.0% |

## Cost

| Candidate | mean $/extract | $/1k turns | $/correct gold fact | mean out tokens |
|---|---:|---:|---:|---:|
| flash-lite-control | 0.003608 | 3.6081 | 0.002706 | 176.7 |
| grok-4.5 | 0.016811 | 16.8113 | 0.012608 | 510.3 |
| luna-low | 0.007454 | 7.4543 | 0.005591 | 161.0 |
| luna-none | 0.007392 | 7.3923 | 0.005544 | 150.7 |

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
