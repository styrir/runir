# vk-2996 live recall evidence

The split is meant to move code without changing behavior, so this compares
live recall with and without it, on the same database at the same time. The
commit adding this file adds only evidence (this file and the comparison
script beside it).

| Instance | Port | Code |
|---|---|---|
| A: without the split | 7798 | `fb59be1` (vk-2995 tip, clean tree) |
| B: with the split | 7799 | `0b96657` (split merged with `fb59be1` and vk-2997 `664b78c`, clean tree apart from this script) |

After this run the branch merged vk-2997 again (`4ac672b`). Outside
`docs/evidence`, that merge changes only files under `plugins/runir-pi/` (the
Pi extension and its harnesses), which the service does not load, so the
service code compared here is the code delivered
(`git diff --name-only 0b96657 HEAD -- . ':!docs/evidence'`).

Both ran `node --env-file=<local .env> --import tsx/esm index.ts` on
127.0.0.1 against a local SurrealDB 3.1.4, with local ollama embeddings, the
local reranker and relevance floor 0.55. LLM keys were blanked, so the
consolidation scheduler did not start. Recall itself still writes: each
request stores a retrieval trace and can update access counters, so later
requests see slightly different database state. The API key was blanked
because the live suite sends no bearer token. Both instances were stopped
afterwards.

## /hooks/recall on real project paths

Script: [`vk-2996-compare-recall.mjs`](vk-2996-compare-recall.mjs), run as
`RECALL_USER_ID=<tenant> RECALL_PROMPTS=<local prompts file> node docs/evidence/vk-2996-compare-recall.mjs http://127.0.0.1:7798 http://127.0.0.1:7799`.

The prompts and project paths are the operator's and are not committed; the
labels below describe them. Each prompt goes to A, then B, then A again.
Nothing is removed before comparing: the script lists every JSON path whose
value differs. A-vs-A shows what differs between two requests to the same
code. No response was an adaptive skip.

| Prompt | HTTP (A/B/A) | Memories (A/B/A) | Differs A vs B | Differs A vs A |
|---|---|---|---|---|
| auth question, other project 1 | 200/200/200 | 5/5/5 | `$.retrievalTraceId` | `$.retrievalTraceId` |
| reconnect bug, this repo | 200/200/200 | 5/5/5 | `$.retrievalTraceId` | `$.retrievalTraceId` |
| review policy, other project 2 | 200/200/200 | 5/5/5 | `$.retrievalTraceId` | `$.retrievalTraceId` |
| service startup, this repo | 200/200/200 | 5/5/5 | `$.retrievalTraceId` | `$.retrievalTraceId` |
| ranking detail, this repo | 200/200/200 | 5/5/5 | `$.retrievalTraceId` | `$.retrievalTraceId` |
| services question, other project 3 | 200/200/200 | 5/5/5 | `$.retrievalTraceId` | `$.retrievalTraceId` |
| session opener, this repo | 200/200/200 | 5/5/5 | `$.retrievalTraceId`; `$.selected[0..4].score` (Δ 6.0e-7 to 6.1e-7) | `$.retrievalTraceId`; `$.selected[0..4].score` (Δ 1.2e-6 each) |

- `retrievalTraceId` is a fresh id per request, so it differs between any two
  requests.
- On the session opener, all five selected scores move between any two
  requests. A-vs-A, sent last, moves about twice as much as A-vs-B, which
  fits a time-dependent score. The selected memories, their order, the
  injected text and every other field are identical.
- Every other field matches in all seven cases.

Memory text is not reproduced because this repository is public.

## Live recall integration suite

`src/__tests__/recall-integration.test.ts`, which the default test run
excludes, run with a local config that only removes that exclusion:

```
RUNIR_LIVE_TESTS=1 RUNIR_SERVICE_URL=http://127.0.0.1:<port> RUNIR_TEST_USER_ID=<tenant> npx vitest run --config <local config>
```

Nothing was skipped: all 9 tests ran on both instances, each with the same
result.

| Test | A (without) | B (with) |
|---|---|---|
| [current_status] count >= 1 | pass | pass |
| [architecture] count >= 1 | pass | pass |
| [debugging] count >= 1 | pass | pass |
| [schema] count >= 1 | pass | pass |
| [recent_work] count >= 1 | pass | pass |
| writes dated JSON baseline | pass | pass |
| session_opener count >= 1 | fail | fail |
| continuitySource is a known value | pass | pass |
| writes dated artifacts | pass | pass |

The session-opener test fails with and without the split. It queries a
hard-coded placeholder path, and nothing in this tenant is recalled for it.
The session-opener comparison above, on a real path, covers that case
instead. The previous version of this record (against `e3a1537`) saw four
failures on both instances; this run, against the newer base, sees one on
both. The suite's result depends on the tenant's current memories, which is
why this record compares the two builds rather than requiring a full pass.
The artifacts the suite writes to `docs/testing/` contain memory text, so
they were deleted and are not committed.
