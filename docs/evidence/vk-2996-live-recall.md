# vk-2996 live recall evidence

The split is a pure move, so the evidence compares live recall with and
without it, on the same database at the same moment. The commit adding this
file changes nothing else.

| Instance | Port | Code |
|---|---|---|
| without the split | 7798 | `2140e4f` (vk-2995 tip, clean tree) |
| with the split | 7799 | `4e92290` (split merged with `2140e4f`, clean tree) |

Both ran `node --env-file=.env --import tsx/esm index.ts` on 127.0.0.1 against
the local SurrealDB 3.1.4 (`main/main`), with local ollama embeddings, the
local reranker, relevance floor 0.55 and no capture key (so no consolidation
scheduler or other writes). `RUNIR_API_KEY` was unset because the suite sends
no bearer token. Both instances were stopped afterwards.

## Live recall integration suite

`src/__tests__/recall-integration.test.ts`, which the default test run
excludes, run with a config that only removes that exclusion:

```
RUNIR_LIVE_TESTS=1 RUNIR_SERVICE_URL=http://127.0.0.1:<port> RUNIR_TEST_USER_ID=<local tenant> npx vitest run --config .styrir/vitest.live-recall.config.ts
```

| Test | Without split | With split |
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

Not skipped: 9 of 9 ran on both. The artifacts the suite writes match: the
baseline JSON differs only in `captured_at` and `service_url`, the sample
JSON matches once timings are removed, and the sample Markdown is
byte-identical.

The four failures happen with and without the split. The suite queries the
hard-coded path `/Users/sam/Code/runir` with prompts from an older tenant
(for example "MIM-71 state lane continuity wiring"), which match nothing in
this tenant above the relevance floor.

## Recall on real paths

Six `/hooks/recall` requests (the local tenant's userId, real project paths
under the operator's `~/Code`) sent to both instances, responses compared after
removing timing fields:

| Prompt | Path | Results (without / with) | Responses |
|---|---|---|---|
| verba two-factor auth | verba | 5 / 5 | identical |
| surreal reconnect replay loop | runir | 5 / 5 | identical |
| verk review policy checks | verk | 5 / 5 | identical |
| how is the launchd service started | runir | 5 / 5 | identical |
| entity leg rrf weight | runir | 5 / 5 | identical |
| leit services | leit | no count field / no count field | identical |

6 of 6 identical; 25 memories returned per instance. Memory text is not
reproduced here because this repository is public.
