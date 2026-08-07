# Luna Think end-to-end — Stage 2 review

- **Run:** `think-2026-08-07T17-47-48-745Z`
- **Source:** clean Git SHA `4740fb7fa72dc66dea8fff86efa219376cf001a7`
- **Suite:** `runir-think-e2e`
- **Model:** `openai/gpt-5.6-luna` through Requesty
- **Reasoning parameter:** none
- **Authorization:** 5 `/memory/think` requests, `$0.15` maximum

## Isolation and preflight

The run used the dedicated single-tenant identity
`stage2-think-benchmark` in the temporary non-production SurrealDB namespace
and database `runir_stage2_20260807/think_e2e_1833d293`. The tenant contained
only the seven synthetic evidence items from the frozen corpus. No owner
memory or production `main/main` row was queried or modified.

After artifact validation, the exact temporary namespace was removed. That
deleted seven synthetic semiote rows and ten retrieval traces (five zero-cost
preflight traces and five paid-run traces). The database rows are not
recoverable; the JSONL, manifest, generated report, and this review preserve
the benchmark evidence.

The zero-cost retrieval preflight caught two setup/adapter problems before
payment:

1. direct synthetic seeding needed the corpus's embedding fingerprint before
   retrieval would admit its vectors;
2. production recall returns bare semiote record IDs while the fixture uses
   source-qualified `semiote:<id>` references.

After recording the matching fingerprint, all five loopback retrieval probes
retained their required evidence with zero external model calls. The e2e
adapter now aligns only equivalent semiote IDs for scoring; non-semiote source
identities remain unchanged. The correction was committed before payment, so
the paid run started from a clean source state.

## Outcome

- 5/5 `/memory/think` requests completed with HTTP 200.
- 5/5 retrieval rows retained every required evidence ID.
- 5/5 synthesis rows passed the strict scorer.
- 5/5 responses were schema-valid.
- Citation validity, precision, and completeness were `1` on every row.
- Answer completeness, gap accuracy, and abstention correctness were `1` on
  every row.
- No forbidden trap or unsupported claim was emitted.
- The exact bead, path, and URL were preserved as three separately cited
  claims.
- Latency was 1,989 ms p50, 2,338 ms mean, and 3,695 ms maximum.
- Usage was 2,662 prompt tokens, 696 completion tokens, and 3,358 total tokens.
- Token-estimated cost was `$0.006838` against the `$0.15` cap. Requesty did
  not return route-visible billed cost, so this must not be labeled billing.
- The Infisical-injected credential value was absent from the JSONL, manifest,
  generated report, and isolated service log.

## Retrieval boundary

Every query selected all seven tenant memories because the tenant was smaller
than Think's 24-item retrieval window. This is still a useful assembled-route
test: required evidence survived retrieval, the 12-item synthesis cap was not
crossed, irrelevant memories were presented to Luna, and synthesis remained
fully grounded.

It is not a retrieval-selectivity or scale result. `Rúnir-atg` tracks a
distractor corpus larger than the retrieval window plus retrieval precision
and rank metrics. No additional paid call is justified until that zero-network
lane exists.

## Evidence bundle

- Generated report:
  [`luna-think-e2e-2026-08-07-requesty.md`](luna-think-e2e-2026-08-07-requesty.md)
- Raw rows:
  [`raw/think-benchmark/luna-think-e2e-2026-08-07-requesty.jsonl`](raw/think-benchmark/luna-think-e2e-2026-08-07-requesty.jsonl)
- Manifest:
  [`raw/think-benchmark/luna-think-e2e-2026-08-07-requesty.manifest.json`](raw/think-benchmark/luna-think-e2e-2026-08-07-requesty.manifest.json)
