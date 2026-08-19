# Rúnir-7no.1 canonical-tenant diagnostic baseline

## Decision

The preregistered linked-memory diagnostic gate measured **0/100 (0.0%)** in
the final retained sample. The two-sided 95% Wilson interval is
**0.0%–3.7%**. The exact point-estimate branch is **`<20%`**.

**STOP the broad linked-memory proposal.** This measurement authorizes no
memory-architecture change, product activation, or implementation.

The largest measured primary defect category was `staleness/conflict`
(4/100), followed by `scope/project identity` (2/100). Their 95% Wilson
intervals overlap, so dominance is not supported under the conservative
frozen reporting rule. No separate dominant-defect follow-up Bead is required.

## Frozen study identity

- Bead: `Rúnir-7no.1`
- Canonical tenant: `brooks`
- Frozen repository commit: `f2b958735b71890730568237f905bac9a8077108`
- SurrealDB identity: namespace `main`, database `main`
- Frozen cutoff: `2026-08-19T09:34:53.871876Z`
- Retention boundary: `2026-05-21T09:34:53.871876Z` (90 days)
- Sampling seed: `r7no1-20260819-brooks-v1`
- Codebook SHA-256:
  `3318d6eb728d6dd9fa5a95b99baa3f4c91515d75e66bcaf2435e143d4ffa998d`
- C3 and source-authorization authority:
  `styrir-os/agent-guidance/data-classification-and-inference-routing.md`

The protocol, seven-label codebook, manifest, exact read-only queries,
eligibility and exclusion rules, metadata-only deduplication rule, seed,
120-case primary queue, 80-case reserve order, reviewer schemas,
denominators, counterfactual rubric, and threshold formula were frozen before
trace-content review.

## Eligibility and sampling

The unit was a canonical-tenant `retrieval_trace` row inside the frozen
retention window with either a persisted thin negative rating or a non-empty
entity-miss signal. Arbitrary unrated rows were not eligible.

The frozen export contained 2,737 proxy-eligible rows. Metadata-only exact
retry deduplication removed 130 rows across 104 groups, leaving a 2,607-row
candidate pool. Sampling was deterministic simple random sampling without
replacement, ordered by HMAC-SHA256 of the frozen seed and private row
identity.

Only preregistered exclusions were allowed:

- operator-designated C3 personal content;
- unauthorized, unknown, credential-overlay, or prohibited-overlay sources;
- noncanonical tenant;
- outside cutoff or retention;
- absent timestamp, prompt, or failure signal;
- malformed unit;
- exact metadata duplicate.

`not-a-failure`, `unclear`, and `insufficient-evidence` remained eligible and
were never replaced.

## Frozen defect codebook

Exactly seven defect labels were available:

1. `capture`
2. `scope/project identity`
3. `ranking`
4. `staleness/conflict`
5. `source verification`
6. `relation/multi-hop`
7. `wiki/navigation`

Primary-label precedence was:

`capture → scope/project identity → staleness/conflict → ranking → source verification → relation/multi-hop → wiki/navigation`

The primary label marks the earliest causal break. Later consequential breaks
could be secondary labels.

## Review topology and flow

Two independent blinded lanes classified every frozen case using
pseudonymous packets. Previous ratings, the hypothesis, the 20% threshold,
and implementation identity were absent. A separate adjudicator ran only
after both 200-decision lane files were complete.

Flow:

- **200 screened**
- **12 excluded**
  - 6 C3
  - 6 unauthorized source
- **188 eligible**
- **100 retained**
- **88 eligible reserve cases not needed**

All replacements followed the frozen reserve order. 86 screened cases
had at least one categorical reviewer disagreement; all were separately
adjudicated with explicit changed-field accounting.

## Agreement and confidence

Primary-outcome agreement used only the final 100 retained cases:

- raw agreement: **90.0%** (90/100)
- multiclass Cohen’s kappa: **0.6535**

Inclusion agreement used all 200 screened cases:

- raw agreement: **96.5%** (193/200)
- binary Cohen’s kappa: **0.6145**

Independent confidence distributions on the retained sample:

| Lane | Low | Medium | High |
|---|---:|---:|---:|
| Reviewer A | 5 | 12 | 83 |
| Reviewer B | 6 | 21 | 73 |
| Final adjudication | 7 | 1 | 92 |

## Defect distribution

All rates use the 100-case retained denominator, including retained
nondefects and uncertain outcomes. Primary and any-label counts were identical
in this sample.

| Defect label | Primary / any | Rate | 95% Wilson interval |
|---|---:|---:|---:|
| `capture` | 1 / 1 | 1.0% | 0.2%–5.4% |
| `scope/project identity` | 2 / 2 | 2.0% | 0.6%–7.0% |
| `ranking` | 0 / 0 | 0.0% | 0.0%–3.7% |
| `staleness/conflict` | 4 / 4 | 4.0% | 1.6%–9.8% |
| `source verification` | 0 / 0 | 0.0% | 0.0%–3.7% |
| `relation/multi-hop` | 1 / 1 | 1.0% | 0.2%–5.4% |
| `wiki/navigation` | 0 / 0 | 0.0% | 0.0%–3.7% |

## Existing-surface counterfactuals

All counterfactuals used existing read-only surfaces only.

| Counterfactual | Yes | No | Unavailable | Yes-rate 95% Wilson interval |
|---|---:|---:|---:|---:|
| Current hybrid plus existing locator resolves | 0 | 0 | 100 | 0.0%–3.7% |
| Existing on-demand continuity view resolves | 0 | 100 | 0 | 0.0%–3.7% |
| Relation/navigation capability required | 1 | 93 | 6 | 0.2%–5.4% |

The hybrid-plus-locator surface was unavailable for every retained case.
Under the frozen formula, `unavailable` is distinct from `no` and cannot enter
the linked-memory numerator. This is an important limitation of the measured
counterfactual, but it does not alter the preregistered point-estimate branch.

The linked-memory numerator required a genuine retained defect with a primary
or secondary relation/navigation label, relation/navigation capability
required=`yes`, and current hybrid plus locator resolves=`no`. No retained
case satisfied all four conditions.

## Safety and reproducibility

- All five frozen database queries were read-only.
- No rating, feedback, capture, store, maintenance, or other production
  mutation surface was called.
- Deterministic sample reproduction passed from the frozen seed.
- All **200/200** sampled row snapshots matched their initial SHA-256 values
  after review.
- Reviewer schemas, adjudication flow, denominators, Wilson intervals,
  counterfactual totals, and threshold arithmetic independently recomputed.
- An independent statistical lane matched the lead computation exactly.

Exact verification surfaces:

```text
bun .styrir/runs/20260819T092829Z-r7no1-trace-audit/study.ts verify-preregistration
bun .styrir/runs/20260819T092829Z-r7no1-trace-audit/study.ts verify-sample
bun .styrir/runs/20260819T092829Z-r7no1-trace-audit/study.ts verify-study
bun .styrir/runs/20260819T092829Z-r7no1-trace-audit/study.ts verify-measurement
bun .styrir/runs/20260819T092829Z-r7no1-trace-audit/study.ts verify-publication docs/analysis/2026-08-19-r7no1-trace-audit-decision.md
```

Private evidence remains ignored at:
`.styrir/runs/20260819T092829Z-r7no1-trace-audit`.

The sealed private checksum manifest is `checksums.sha256`; its SHA-256 is:
`04aaf44fd832d37fea1837a7d749c4d5e3aa6be7ec5a04591212be1dcc0306e6`.

No raw prompts, record identifiers, contexts, memory text, source excerpts,
reviewer decisions, secrets, or locator payloads are present in this tracked
record.
