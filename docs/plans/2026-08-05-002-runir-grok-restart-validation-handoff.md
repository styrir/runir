# Rúnir ↔ Grok Build restart-validation handoff

**Test ID:** `grok-restart-20260805T074001Z-1cbbca`
**Bead:** `Rúnir-pzt`
**Prepared:** 2026-08-05
**Status:** ready for a brand-new Grok Build session

## Purpose

Validate the shipped dual-lane integration honestly after restarting Grok Build:

1. **Ambient first-turn selection** — Rúnir facts projected into global `MEMORY.md`, then selected by Grok native first-turn memory.
2. **Explicit interactive recall** — `/runir-recall` queries Rúnir on demand when ambient memory is prompt-blind/session-stale.
3. **TUI lifecycle capture** — installed `UserPromptSubmit` and `Stop` hooks record the new session turn.
4. **Headless pre-inference injection** — `headless_inject.py` recalls Rúnir memory and places it before the user block in `grok --prompt-json`.

These are separate contracts. Do not report ambient failure as failure of explicit or headless Rúnir transport.

## Critical blind-test rule

**Do not resume the session that created this handoff.** Its tool transcript observed canary setup.

Start a brand-new session by quitting and relaunching Grok Build, or use `/new`. For the strongest test, relaunch from the `runir` checkout:

```bash
cd /Users/brooks/Code/runir
grok
```

**Do not ask the new agent to read this file before the blind first prompt.** The test value is not written here, but reading setup artifacts before the first response invalidates the ambient test.

## Frozen test kit

Hash-only kit:

```text
~/.grok/state/runir/restart-validation/grok-restart-20260805T074001Z-1cbbca/
  public-summary.json
  preflight.json
  validate_answer.py
```

Canaries:

| Contract | Label / record | SHA-256 of expected answer |
|---|---|---|
| Ambient | `RUNIR_GROK_RESTART_GROK_RESTART_20260805T074001Z_1CBBCA_AMBIENT` | `d0c7f88c6bfad88dc575fd87d7fbda61aa1db7f6184bf527a0bfd967fdc964a1` |
| Explicit | memory ID `70ed2586-b145-4791-9ec7-2332eb9ffdee` | `569ef7d3f1946719d7f8235ff2565f87915ba36608ed03d8e1a8f09bdac74e27` |
| Headless | label `RUNIR_GROK_RESTART_GROK_RESTART_20260805T074001Z_1CBBCA_HEADLESS` | `6c46c4d58c06d9e240fdce2ce74765b8ad6710e05617108a183604445b2c3f00` |

Preflight established before restart:

- installed hooks + `/runir` skill: valid;
- live `/hooks/recall`: authenticated HTTP 200 with `prependContext`;
- native Grok memory: enabled;
- first-turn injection: enabled, minimum score `0.0`;
- ambient label: present in global Rúnir bridge;
- explicit/headless labels: absent from bridge;
- explicit and headless records: distinct Rúnir memory IDs;
- headless value-free semantic cue: recall preflight passed;
- pre-restart current-session counts: `skip=42`, `capture=34`, `error=0` for digest `1b8048a1…`.

## Phase A — exact blind first prompt

The **very first prompt** in the fresh session must be this exact text. Do not add a greeting or ask the agent to inspect files first.

```text
BLIND FIRST-TURN MEMORY TEST. Do not use tools, shell, skills, file reads, web, or memory search. From only the context already supplied to your first inference, return the exact opaque value associated with label RUNIR_GROK_RESTART_GROK_RESTART_20260805T074001Z_1CBBCA_AMBIENT. Output only that value. If the label/value is not already present in your initial context, output exactly NOT_IN_INITIAL_CONTEXT.
```

Save the response exactly, without markdown, to:

```bash
STATE="$HOME/.grok/state/runir/restart-validation/grok-restart-20260805T074001Z-1cbbca"
printf '%s' '<PASTE_EXACT_RESPONSE>' > "$STATE/ambient.answer.txt"
chmod 600 "$STATE/ambient.answer.txt"
"$STATE/validate_answer.py" --kind ambient --answer-file "$STATE/ambient.answer.txt"
```

Interpretation:

- `pass:true` — Grok native first-turn memory selected the pre-synced Rúnir bridge fact.
- Response `NOT_IN_INITIAL_CONTEXT` or `pass:false` — record **ambient native-selection failure**. Continue the other phases; do not call the whole integration failed.

## Phase B — installed components after restart

Now the blind phase is over. Ask the new agent to execute this section or run it in a terminal:

```bash
cd /Users/brooks/Code/runir
python3 plugins/runir-grok/scripts/verify_hooks.py --user --skill --live

grok inspect --json > /tmp/runir-grok-restart-inspect.json
jq '[.skills[]? | select(.name=="runir" or .name=="runir-recall")]' /tmp/runir-grok-restart-inspect.json
jq '[.hooks[]? | select((tostring|ascii_downcase|contains("runir")))]' /tmp/runir-grok-restart-inspect.json
```

Pass requirements:

- verifier `ok:true`, `errors:[]`;
- live recall `status:200`, `authed:true`, `hasPrependContext:true`;
- skills `runir` and `runir-recall` discovered;
- `user_prompt_submit` and `stop` Rúnir hooks discovered;
- no Rúnir `PreToolUse` hook.

If hooks are missing in the existing TUI, run `/hooks`, press `r`, and repeat. A second application restart should not normally be needed.

## Phase C — explicit interactive recall

Invoke `/runir-recall` and retrieve this exact record:

```text
memory ID: 70ed2586-b145-4791-9ec7-2332eb9ffdee
```

The agent should use Rúnir `get --id`, extract the opaque value from the memory text, and return only that value. Do not read any `restart-validation/expected*` file.

Validate:

```bash
STATE="$HOME/.grok/state/runir/restart-validation/grok-restart-20260805T074001Z-1cbbca"
printf '%s' '<PASTE_EXACT_RESPONSE>' > "$STATE/explicit.answer.txt"
chmod 600 "$STATE/explicit.answer.txt"
"$STATE/validate_answer.py" --kind explicit --answer-file "$STATE/explicit.answer.txt"
```

Pass requirement: `pass:true`.

This is the supported interactive path for prompt-specific Rúnir context.

## Phase D — TUI capture evidence

After the explicit-recall turn finishes, run:

```bash
cd /Users/brooks/Code/runir
python3 plugins/runir-grok/scripts/runir_inspect.py status --json
python3 plugins/runir-grok/scripts/runir_inspect.py session --latest --limit 20
python3 plugins/runir-grok/scripts/runir_inspect.py errors --json
```

Pass requirements for the fresh session:

- a new session digest, different from pre-restart `1b8048a1…`;
- at least one `UserPromptSubmit` event with `reason=prompt_only`;
- matching `capture status=done` after the completed first/explicit turn;
- error count `0` and no new error event.

Remember: `UserPromptSubmit` being `prompt_only` is expected. Interactive TUI does not claim same-turn recall injection.

## Phase E — headless automatic pre-inference injection

Run from the Rúnir checkout. The prompt contains a value-free semantic cue; native Grok memory is disabled so a successful answer must come through Rúnir recall → `--prompt-json`.

```bash
cd /Users/brooks/Code/runir
STATE="$HOME/.grok/state/runir/restart-validation/grok-restart-20260805T074001Z-1cbbca"
PROMPT='Without tools or searches, return only the exact chromatogram nonce from the recalled memory for this synthetic assay: A one-time synthetic biochemistry assay named c1948df096792cd3a3a0 records specimen label RUNIR_GROK_RESTART_GROK_RESTART_20260805T074001Z_1CBBCA_HEADLESS'

plugins/runir-grok/scripts/runir_ask.sh \
  --prompt "$PROMPT" \
  --path /Users/brooks/Code/runir \
  --json \
  --max-turns 1 \
  --no-memory \
  --disable-web-search \
  > "$STATE/headless.result.json"

chmod 600 "$STATE/headless.result.json"
jq '{sessionId,modelCalls,modelCallsSource,memoryInjected,promptBlockOrder,retrievalTraceId,memoryIds,stopReason}' "$STATE/headless.result.json"
jq -r '.text' "$STATE/headless.result.json" > "$STATE/headless.answer.txt"
"$STATE/validate_answer.py" --kind headless --answer-file "$STATE/headless.answer.txt"
```

Pass requirements:

- process exit `0`;
- `memoryInjected:true`;
- `promptBlockOrder:["memory","user"]`;
- non-empty verified `sessionId`;
- non-empty `retrievalTraceId`;
- `memoryIds` contains `d954cd50-dd34-43ec-90cc-aaa65db0b261`;
- answer validator returns `pass:true`;
- expected `modelCalls == 1` under `--max-turns 1`; if not, record exact value/source and investigate rather than hiding it.

Optional receipt readback:

```bash
TRACE_ID="$(jq -r '.retrievalTraceId' "$STATE/headless.result.json")"
set -a; source /Users/brooks/Code/runir/.env >/dev/null 2>&1 || true; set +a
npx tsx /Users/brooks/Code/runir/cli/index.ts traces --id "$TRACE_ID" --json --pretty
```

Do not print credentials.

## Phase F — record results

Create:

```text
docs/plans/2026-08-05-003-runir-grok-restart-validation-results.md
```

Use this table:

| Gate | Result | Evidence |
|---|---|---|
| Fresh session / no resume | PASS/FAIL | session ID and launch method |
| Ambient first-turn selection | PASS/FAIL | validator JSON; classify native selection separately |
| Hooks + skills loaded | PASS/FAIL | verifier and `grok inspect` excerpts |
| Explicit `/runir-recall` | PASS/FAIL | memory ID + validator JSON |
| TUI capture | PASS/FAIL | session digest, prompt-only event, capture done, errors |
| Headless pre-inference | PASS/FAIL | redacted JSON fields, trace ID, memory ID, validator JSON |
| Architecture boundary | PASS/FAIL | no shared `src/**` changes made by validation |

Never write the expected plaintext canary values into the results document. Record hashes and IDs only.

## Bead close rule

```bash
cd /Users/brooks/Code/runir
bd show Rúnir-pzt
```

Close `Rúnir-pzt` only if these mandatory gates pass:

- installed hooks/skills;
- explicit recall;
- TUI capture;
- headless pre-inference injection.

Ambient is recorded separately because it depends on Grok native memory selection. If ambient fails while the mandatory Rúnir gates pass, close with an honest note that interactive automatic prompt-specific recall remains unsupported and native first-turn selection missed the bridge fact.

## Related follow-up

`Rúnir-7wo` tracks safely fast-forwarding the ordinary dirty Rúnir parent from `3fe372c` to shipped `dacef3a`. That reconciliation is recommended before or during validation, but the active hook/bridge/skill/headless runtime files are identical across the one missing commit; the delta is verifier hardening, tests, and this integration handoff.
