# Luna Think synthesis — Stage 1 review

- **Run:** `think-2026-08-07T16-47-15-449Z`
- **Source:** clean Git SHA `040a311a2f7922eca2de1cafef729c653b4f3e2d`
- **Suite:** `runir-think-synthesis` (fixed evidence; retrieval excluded)
- **Model:** `openai/gpt-5.6-luna` through Requesty
- **Reasoning parameter:** none
- **Authorization:** 5 requests, `$0.15` maximum

## Outcome

- 5/5 requests completed with HTTP 200.
- 5/5 responses were schema-valid.
- Automated strict score: 4/5.
- Observed gateway-billed cost: `$0.0008986`.
- Latency: 1,829 ms p50, 2,161 ms mean, 3,712 ms maximum.
- Token usage: 1,499 prompt, 499 completion, 1,998 total.
- The Infisical-injected credential value was absent from the JSONL, manifest,
  and generated report.

The four unambiguous cases passed every strict dimension: answer completeness,
unsupported-claim rate, citation validity/precision/completeness, required
knowledge gaps, abstention, forbidden traps, and schema validity.

## The apparent fifth-case failure is a harness false negative

For `identifier-path-url`, Luna returned three separate checkable claims:

1. bead `Rúnir-84d`;
2. path `/workspace/runir`;
3. URL `http://127.0.0.1:7711/`.

Every value is exact, and every claim cites the sole allowed evidence item.
The fixture, however, represents all three facts as one compound gold claim
whose `mustContain` list requires all three values in a single output claim.
The scorer therefore marks each individually correct claim unsupported and
reports zero answer completeness.

This conflicts with the production Think prompt's claim-addressable output
contract, which encourages separate checkable claims. The raw 4/5 score remains
unchanged as immutable evidence, but it is not evidence that Luna lost or
fabricated an identifier.

## Zero-network correction verification

`Rúnir-41z` corrects the fixture by representing the bead, path, and URL as
three independently checkable gold claims backed by the same evidence item.
The scorer itself remains strict and unchanged.

Re-scoring the five saved responses against the corrected fixture made no
network calls and produced 5/5 strict passes. The identifier row now has:

- answer completeness `1`;
- unsupported-claim rate `0`;
- citation precision `1`;
- matched gold claims `benchmark-bead`, `benchmark-path`, and `benchmark-url`.

A regression test proves the other side of the contract: one output claim that
merges all three gold facts remains an unsupported shotgun claim and receives
zero answer completeness. The original JSONL and manifest retain their exact
bytes and their original raw 4/5 verdict.

## Evidence bundle

- Generated report:
  [`luna-think-synthesis-2026-08-07-requesty.md`](luna-think-synthesis-2026-08-07-requesty.md)
- Raw rows:
  [`raw/think-benchmark/luna-think-synthesis-2026-08-07-requesty.jsonl`](raw/think-benchmark/luna-think-synthesis-2026-08-07-requesty.jsonl)
- Manifest:
  [`raw/think-benchmark/luna-think-synthesis-2026-08-07-requesty.manifest.json`](raw/think-benchmark/luna-think-synthesis-2026-08-07-requesty.manifest.json)
