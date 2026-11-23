# vk-2996 live recall evidence

The split is meant to move code without changing behavior, so this compares
live recall with and without it, on the same database at the same time. The
commit adding this file adds only this file.

| Instance | Port | Code |
|---|---|---|
| A: without the split | 7798 | `fb59be1` (vk-2995 tip, clean tree) |
| B: with the split | 7799 | `8a864be` (the split on top of vk-2997 `2797623`, which contains `fb59be1`; clean tree; the parent of the commit adding this file) |

Both ran `node --env-file=<local .env> --import tsx/esm index.ts` on
127.0.0.1 against a local SurrealDB 3.1.4, with local ollama embeddings, the
local reranker and relevance floor 0.55. LLM keys were blanked, so the
consolidation scheduler did not start. Recall itself still writes: each
request stores a retrieval trace and can update access counters, so later
requests see slightly different database state. The API key was blanked
because the live suite sends no bearer token. Both instances were stopped
afterwards.

## /hooks/recall, compared with nothing removed

Script: [`vk-2996-compare-recall.mjs`](vk-2996-compare-recall.mjs), run as
`RECALL_USER_ID=<tenant> RECALL_PROMPTS=<local prompts file> node docs/evidence/vk-2996-compare-recall.mjs http://127.0.0.1:7798 http://127.0.0.1:7799`.

The prompts and project paths are the operator's and are not committed; the
labels describe them. Each prompt goes to A, then B, then A again. Nothing is
removed before comparing: the script lists every JSON path whose value
differs. A-vs-A shows what differs between two requests to the same code.

The last row sends the live suite's own session-opener request: the same
prompt, the suite's hard-coded placeholder path, and the same body (prompt,
path and userId only, no client or session id).

"Shape" is the same on all three requests in every row, and is given as
count / selected memories / injected-context characters / continuity source
/ structured opener block.

| Prompt | HTTP (A/B/A) | Shape (A = B = A) | Differs A vs B | Differs A vs A |
|---|---|---|---|---|
| auth question, other project 1 | 200/200/200 | 5 / 5 / 9119 / none / no | `$.retrievalTraceId` | `$.retrievalTraceId` |
| reconnect bug, this repo | 200/200/200 | 5 / 5 / 5058 / none / no | `$.retrievalTraceId` | `$.retrievalTraceId` |
| review policy, other project 2 | 200/200/200 | 5 / 5 / 7018 / none / no | `$.retrievalTraceId` | `$.retrievalTraceId` |
| service startup, this repo | 200/200/200 | 5 / 5 / 1258 / none / no | `$.retrievalTraceId` | `$.retrievalTraceId` |
| ranking detail, this repo | 200/200/200 | 5 / 5 / 2408 / none / no | `$.retrievalTraceId` | `$.retrievalTraceId` |
| services question, other project 3 | 200/200/200 | 5 / 5 / 3395 / none / no | `$.retrievalTraceId` | `$.retrievalTraceId` |
| session opener, this repo | 200/200/200 | 5 / 5 / 1414 / deterministic / yes | `$.retrievalTraceId`; `$.selected[0..4].score` (Δ 5.3e-7 to 5.4e-7) | `$.retrievalTraceId`; `$.selected[0..4].score` (Δ 9.1e-7 to 9.4e-7) |
| live suite's opener request | 200/200/200 | 0 / 0 / 924 / deterministic / yes | nothing | nothing |

- `retrievalTraceId` is a fresh id per request, so it differs between any two
  requests. The suite's opener request selects no memories and carries no
  trace id, so nothing differs there.
- On the session opener, each of the five selected scores moves less between
  A and B than between the two A requests (sent last), which fits a
  time-dependent score. The selected memories, their order, the injected
  text and every other field are identical.
- No response was an adaptive skip or carried an error.

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
| session_opener count >= 1, prependContext non-null | fail | fail |
| continuitySource is a known value | pass | pass |
| writes dated artifacts | pass | pass |

How the opener test fails while the artifact test passes: on both instances
the opener test fails at its first assertion, `session_opener: count should
be >= 1: expected 0 to be greater than or equal to 1`. The artifact test
reuses that same response and checks only that `prependContext` is not
null. The last comparison row shows what that response is: no memories
selected (count 0), but 924 characters of injected context from the
deterministic continuity path, with a structured opener block. So nothing is
recalled for the suite's placeholder path, yet the opener still injects
continuity context, and that satisfies the artifact test. The continuity
source test passes for the same reason (`deterministic`).

The suite's result depends on the tenant's current memories, which is why
this record compares the two builds rather than requiring a full pass. The
artifacts the suite writes to `docs/testing/` contain memory text, so they
were deleted and are not committed.
