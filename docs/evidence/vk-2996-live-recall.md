# vk-2996 live recall evidence

The split is meant to move code without changing behavior, so this compares
live recall with and without it, on the same database at the same time. The
commit adding this file adds only evidence (this file and the comparison
script beside it).

| Instance | Port | Code |
|---|---|---|
| A: without the split | 7798 | `e3a1537` (vk-2995 tip, clean tree) |
| B: with the split | 7799 | `3a44a81` (split merged with `e3a1537`, clean tree) |

Both ran `node --env-file=.env --import tsx/esm index.ts` on 127.0.0.1 against
the local SurrealDB 3.1.4 (`main/main`), with local ollama embeddings, the
local reranker and relevance floor 0.55. No capture key was set, so the
consolidation scheduler did not start. Recall itself still writes: each
request stores a retrieval trace and can update access counters, so later
requests see slightly different database state. `RUNIR_API_KEY` was unset
because the live suite sends no bearer token. Both instances were stopped
afterwards.

## /hooks/recall on real project paths

Script: [`vk-2996-compare-recall.mjs`](vk-2996-compare-recall.mjs), run as
`RECALL_USER_ID=<local tenant> node docs/evidence/vk-2996-compare-recall.mjs http://127.0.0.1:7798 http://127.0.0.1:7799`.

Each prompt goes to A, then B, then A again, on project paths under the
operator's `~/Code`. Nothing is removed before comparing: the script lists
every JSON path whose value differs. A-vs-A shows what differs between two
requests to the same code.

| Prompt | Project | HTTP (A/B/A) | Memories (A/B/A) | Differs A vs B | Differs A vs A |
|---|---|---|---|---|---|
| verba two-factor auth | verba | 200/200/200 | 5/5/5 | `retrievalTraceId` | `retrievalTraceId` |
| surreal reconnect replay loop | runir | 200/200/200 | 5/5/5 | `retrievalTraceId` | `retrievalTraceId` |
| verk review policy checks | verk | 200/200/200 | 5/5/5 | `retrievalTraceId` | `retrievalTraceId` |
| how is the launchd service started | runir | 200/200/200 | 5/5/5 | `retrievalTraceId` | `retrievalTraceId` |
| entity leg rrf weight | runir | 200/200/200 | 5/5/5 | `retrievalTraceId` | `retrievalTraceId` |
| which leit services need to be running | leit | 200/200/200 | 5/5/5 | `retrievalTraceId` | `retrievalTraceId` |
| let's continue where we left off (session opener) | runir | 200/200/200 | 5/5/5 | `retrievalTraceId`, `selected[].score` (max 3.9e-7) | `retrievalTraceId`, `selected[].score` (max 7.9e-7) |

- `retrievalTraceId` is a fresh id per request, so it differs between any two
  requests.
- The session opener's scores move by less than 1e-6 between any two
  requests. A-vs-A, sent last, moves about twice as much as A-vs-B, which
  fits a time-dependent score. The selected memories, their order, the
  injected text (`prependContext`) and every other field are identical.
- Every other field matches in all seven cases.

An earlier version of this record said six recalls were identical "after
removing timing fields". That was wrong in two ways. The comparison also
removed `retrievalTraceId`, plus any key ending in "ms" or "at". And the
sixth prompt ("leit services") was below the adaptive-retrieval threshold,
so both instances returned `{skipped: true}` without retrieving anything.
This version removes nothing, and it replaces that prompt with one that
retrieves.

Memory text is not reproduced because this repository is public.

## Live recall integration suite

`src/__tests__/recall-integration.test.ts`, which the default test run
excludes, run with a config that only removes that exclusion:

```
RUNIR_LIVE_TESTS=1 RUNIR_SERVICE_URL=http://127.0.0.1:<port> RUNIR_TEST_USER_ID=<local tenant> npx vitest run --config .styrir/vitest.live-recall.config.ts
```

Nothing was skipped: all 9 tests ran on both instances, each with the same
result.

| Test | A (without) | B (with) |
|---|---|---|
| [current_status] count >= 1 | fail (0 results) | fail (0 results) |
| [architecture] count >= 1 | fail (0 results) | fail (0 results) |
| [debugging] count >= 1 | pass | pass |
| [schema] count >= 1 | pass | pass |
| [recent_work] count >= 1 | fail (0 results) | fail (0 results) |
| writes dated JSON baseline | pass | pass |
| session_opener count >= 1 | fail (0 results) | fail (0 results) |
| continuitySource is a known value | pass | pass |
| writes dated artifacts | pass | pass |

The four failures happen with and without the split. The suite queries a
hard-coded path from another machine's home directory, with prompts from an
older tenant, and those match nothing in this tenant above the relevance
floor. The session-opener artifacts it writes are therefore empty on both
instances and are not evidence. The session-opener comparison above, on a
real path, covers that case instead.
