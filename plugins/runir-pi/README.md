# Rúnir Pi plugin

Rúnir thin client for Pi — lives in the product `plugins/` tree with Claude Code and Codex clients.

## Install

```bash
pi install /Users/brooks/Code/runir/plugins/runir-pi
```

Then reload Pi:

```text
/reload
```

## Extensions

- `runir-memory.ts` — Rúnir memory recall/capture for Pi sessions, with compact footer status, a `/runir` inspector, and OM compaction-projection lanes that re-anchor continuity across Pi context compaction.

Ouroboros integration is provided by the upstream Pi package, not this package:

```bash
pi install npm:pi-ouroboros
```

## Rúnir Memory

Local defaults:

```text
RUNIR_BASE=http://127.0.0.1:7700
RUNIR_USER_ID=brooks
```

`RUNIR_API_KEY` is required by the local service for hook endpoints. The extension reads it from the Pi process environment first, then from:

```text
/Users/brooks/Code/runir/.env
```

Override the file path with `RUNIR_ENV_FILE` if needed.

Runtime UI:

```text
ᚱ ready      active, no visible recall details
ᚱ /runir     recall data exists; inspect with /runir
ᚱ skip       recall skipped by the local negative filter
ᚱ err /runir recall/capture error; inspect with /runir:errors
```

Automatic recall does not emit visible `[runir]` chat messages. Memory counts/content are shown only when you invoke the inspector.

Inspector commands:

```text
/runir
/runir:last
/runir:session
/runir:captures
/runir:errors
```

## OM Compaction Projection

Around Pi context compaction the extension asks Runir for a budget-fitted
continuity projection: a `pre_compaction` fetch is staged before compaction
(fallback), a `post_compaction_validation` recite-back fetched after
compaction replaces it, and whichever is staged is injected once into the
next turn's system prompt. Runir may honestly return nothing — then the
compaction proceeds without a projection.

A banded detector watches context usage and acts before Pi's own late
auto-compaction: at ~55% it flushes the full branch to capture (legacy
`RUNIR_PRECOMPACT_PERCENT` overrides this threshold), at ~70% it prepares a
projection for the compaction summarizer, and at ~85% — or past an absolute
token ceiling on huge context windows — it triggers compaction itself,
passing the prepared projection as summarizer focus. Triggering waits for
the agent run to finish (compaction aborts in-flight work).

```text
RUNIR_OM_SOFT_PERCENT=55
RUNIR_OM_PLAN_PERCENT=70
RUNIR_OM_FORCED_PERCENT=85
RUNIR_OM_FORCED_TOKEN_CEILING=200000
RUNIR_OM_PREPARED_FRESH_MS=120000
RUNIR_OM_PLAN_RETRY_MS=60000
RUNIR_OM_COMPACT_PENDING_TTL_MS=120000
```

```text
/om:ping           service reachability + authenticated hook check
/om:view           staged projection + OM traces (also /runir om)
/om:recall <id> [lineage]   fetch a stored memory by id (+ supersession chain)
```

The `runir_recall` LLM tool exposes the same id lookup to the model, so it
can expand memory ids cited in injected context. Superseded ids report their
supersession chain (with the current state marked) instead of a false
not-found.

Tuning (env, defaults shown):

```text
RUNIR_OM_PRE_BUDGET_TOKENS=1000
RUNIR_OM_POST_BUDGET_TOKENS=500
RUNIR_OM_RECALL_TIMEOUT_MS=4000
RUNIR_OM_STAGED_TTL_MS=900000
RUNIR_OM_DISABLED=1   # kill switch for the OM lanes only
```

## MCP Tools

General MCP support is provided by the global package:

```bash
pi install npm:pi-mcp-adapter
```

Global MCP server config lives at:

```text
~/.config/mcp/mcp.json
```

Default to lazy/proxy-only servers. Promote `directTools` only for intentionally frequent tools.
