# Rúnir integration handoff — shared harness contract and Grok alternate path

**Date:** 2026-08-05  
**Next implementation bead:** `Rúnir-git`  
**Product root for the active workflow:** `/Users/brooks/.grok/worktrees/runir/runir-git-verifier-policy`  
**Base:** `origin/main` at `3fe372cbda85f792cf2062dd53b6433b0afab843`

## Executive summary

The Rúnir integration is **not unfinished because shared Rúnir failed**. The original/shared Rúnir behavior remains the correct integration for other harnesses that expose usable per-turn lifecycle and context events. Grok Build is the exception: its interactive TUI does not expose a supported prompt-specific content channel before the first model inference.

Therefore the product must preserve **two approaches**:

1. **Shared/original Rúnir for other systems.** Keep shared `src/**` and existing harness hooks harness-agnostic. Do not weaken or redesign them for Grok.
2. **Grok-specific adapter under `plugins/runir-grok/**`.** Accept the host limitation honestly and use the alternate surfaces that Grok actually supports:
   - interactive TUI: ambient global `MEMORY.md` bridge, explicit `runir-recall`, capture-only Stop hook; prompt-blind/session-stale labeling;
   - scripted/headless Grok: pre-inference recall through `--prompt-json`, then verified capture;
   - Grok-only transport, lifecycle, verifier, state, and host workarounds remain plugin-local.

The next product change is narrow: land `Rúnir-git`, which hardens the **Grok plugin's live verifier transport**. It is not another memory architecture redesign.

## Why Grok needs the alternate path

The viability decision is `conditional_keep`:

- `UserPromptSubmit` is passive and its stdout is ignored by the documented Grok contract.
- `PreToolUse` allow/deny is a gate, not a memory context channel; the old experiment produced 23 sibling denials and even denied native `memory_search`.
- `Stop.additionalContext` forces another continuation and consumes the continuation budget.
- Native automatic memory injection is first-turn/post-compaction only; a same-turn bridge publish still missed the frozen prompt.
- The host does await the UPS command in observed runs, but no documented content-bearing same-turn return channel exists.

Canonical evidence:

- `.pipeline/runir-grok-viability-fable/decision/artifact.md`
- `.pipeline/runir-grok-viability-fable/probe-host/artifact.md`
- `docs/plans/2026-08-04-001-grok-userpromptsubmit-additionalcontext-request.md`
- durable Beads memory: `runir-grok-harness-boundary`

The xAI `UserPromptSubmit.additionalContext` request is drafted locally but was **not submitted**. External submission remains a human decision.

## What has shipped

### Viability and lifecycle correction

- `Rúnir-5xm`: viability decision completed — conditional keep.
- `Rúnir-ysk`: deny/Stop delivery transports retired; TUI behavior honestly relabeled.
- `Rúnir-4e8`: headless pre-inference recall/capture proof shipped.
- `Rúnir-12v`: local host feature request drafted and closed without external submission.
- Shared Rúnir was not rewritten for Grok.

### Grok memory adapter

- TUI first turn synchronously syncs the plugin-managed global `MEMORY.md` block.
- Later turns use throttled detached sync.
- Fetch failure preserves the prior managed block and does not advance successful throttle state.
- Explicit `runir-recall` remains available when ambient memory is stale or prompt-blind.
- Headless wrapper provides real pre-inference memory-first injection and verified capture.

### Transport cap (`Rúnir-eiw`)

Shipped to `origin/main` as `3fe372c`:

- one 1 MiB capped body reader in `plugins/runir-grok/lib/runir_core.py`;
- used by plugin-local `get_json`, `post_json`, and bridge `fetch_runir_facts`;
- declared oversize rejected before read; absent/dishonest lengths bounded at cap+1; exact cap accepted;
- bridge oversize maps to `error:oversize` and fail-preserves prior block/throttle;
- `204 passed, 1 skipped`; specialist review 0 blocking / 0 major.

## Next implementation: `Rúnir-git`

`verify_hooks.py --live` still has a Grok-plugin-local transport path that does not consistently reuse the endpoint/redirect/body-cap policy. Implement only this bead.

### Required behavior

- `live_recall_probe`:
  - preflight with `runir_core.is_allowed_runir_endpoint`;
  - use shared proxy-stripped, same-origin redirect-guarded `OPENER`;
  - use the `Rúnir-eiw` capped body reader;
  - preserve verifier-specific result taxonomy and hints rather than routing through fail-open `get_json`/`post_json`.
- Preserve exit taxonomy:
  - `0`: ok;
  - `3`: `missing_user_id`, unauthorized, or `http_NNN` diagnostic results;
  - `4`: service down.
- Cross-origin redirects must never receive `Authorization`.
- Non-loopback HTTP remains rejected; non-loopback HTTPS still requires `RUNIR_ALLOW_REMOTE_ENDPOINTS=1`.
- Ollama verifier traffic adopts only the shared proxy-stripped redirect guard and body cap. `RUNIR_OLLAMA_BASE` is **not** subject to the authenticated Rúnir endpoint allowlist.
- Add focused deterministic tests for allowlist, redirect/auth stripping, cap behavior, taxonomy, and explicit Ollama policy.

### Hard scope boundary

- Product edits stay under `plugins/runir-grok/**` and this handoff document.
- No `src/**` changes.
- Do not modify shared/original hooks for other harnesses.
- Do not reintroduce PreToolUse deny or Stop memory delivery.
- Do not claim the interactive TUI has prompt-specific same-turn recall.
- Do not touch unrelated parent-checkout model-benchmark files.

## Remaining integration state after `Rúnir-git`

After this bead lands, the planned Grok adapter hardening path is effectively complete under the current host contract:

- shared Rúnir remains the normal integration for other systems;
- Grok TUI remains ambient/session-stale plus explicit recall;
- headless Grok remains the automatic pre-inference path;
- the host feature request remains the convergence point for true TUI parity.

Do not invent another shared-core rewrite to make Grok look identical to other harnesses. Any future work should be triggered by a new host capability, a concrete adapter bug, or explicit approval to submit/implement the host request.

## Verification and closeout expectations

- Run focused verifier tests first, then the complete `plugins/runir-grok/tests` suite.
- Grep all plugin verifier HTTP response reads for uncapped reads.
- Confirm `git status --porcelain -- src` is empty.
- Specialist correctness + security review and adversarial verification must be clean.
- Closeout judgment goes through Claude Opus 5 medium effort.
- When `ship=true`: Dolt push, commit, fast-forward/land on Rúnir `main`, push `origin/main`, then close `Rúnir-git` with exact receipts.
