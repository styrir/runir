# Rúnir ↔ Grok Build restart-validation results

**Test ID:** `grok-restart-20260805T074001Z-1cbbca`
**Bead:** `Rúnir-pzt`
**Executed:** 2026-08-05
**State directory:** `~/.grok/state/runir/restart-validation/grok-restart-20260805T074001Z-1cbbca/`
**Overall result:** **FAIL — mandatory explicit and headless gates did not pass; Bead remains open**

## Executive result

The restart loaded the installed Grok hooks and skills, and the fresh TUI session produced expected `UserPromptSubmit`/`Stop` lifecycle evidence with no new hook error. The architecture boundary also remained intact.

The full validation does **not** pass:

- The blind ambient prompt was not the fresh session's first prompt, so that gate was invalidated. This is **not** evidence that native ambient selection missed the bridged fact.
- The configured explicit interactive path resolves `RUNIR_USER_ID=owner`; the frozen explicit memory belongs to `brooks`, so the documented `get --id` path returns `404`. A diagnostic retrieval with `--user-id brooks` found the record and hash-validated its opaque value, proving that the record itself still exists.
- Headless pre-inference injection returned `memoryInjected:false`, only a user prompt block, no retrieval trace, no selected memory IDs, and a hash-invalid answer. Retries, including the longer cold-embedder timeout, produced the same result.

Because explicit interactive recall and headless injection are mandatory gates, `Rúnir-pzt` must remain open.

## Gate table

| Gate | Result | Evidence |
|---|---|---|
| Fresh session / no resume | **INCOMPLETE EVIDENCE** | User reported a complete Grok restart, and fresh TUI digest `6de9695619cb7a1eab654cb5f779af9e4d3df6b7a10ef90dd248640e3c146ece` differs from pre-restart digest `1b8048a1…`. The harness did not independently record the launch method or Grok session ID required by the handoff. |
| Ambient first-turn selection | **FAIL — protocol invalidated** | The exact blind prompt was not submitted as the fresh session's first prompt. No native-selection PASS/FAIL inference is valid from this run. No ambient answer was fabricated. |
| Hooks + skills loaded | **PASS** | `verify_hooks.py --user --skill --live`: `ok:true`, `errors:[]`, authenticated HTTP `200`, `hasPrependContext:true`. `grok inspect` discovered `runir` and `runir-recall`, `user_prompt_submit` and `stop`, and no Rúnir `PreToolUse`. |
| Explicit `/runir-recall` | **FAIL — configured identity cannot retrieve frozen record** | With `.env` defaults, `RUNIR_USER_ID=owner`; `get --id 70ed2586-b145-4791-9ec7-2332eb9ffdee` returned `404`. Diagnostic `--user-id brooks` retrieval succeeded and the official validator returned `pass:true` with SHA-256 `569ef7d3f1946719d7f8235ff2565f87915ba36608ed03d8e1a8f09bdac74e27`. This proves record integrity but does not pass the configured interactive path. |
| TUI capture | **PASS** | Fresh digest `6de9695619cb…`; `UserPromptSubmit` events have `reason=prompt_only`; matching completed captures are present; current-session status reports `captureStatus:"done"`, `capture:2`, `error:0`. The sole global error receipt is historical (`2026-07-31`) and belongs to another digest. |
| Headless pre-inference | **FAIL** | Required run and retries returned `modelCalls:1`, `memoryInjected:false`, `promptBlockOrder:["user"]`, empty `retrievalTraceId`, empty `memoryIds`, and validator `pass:false`. Longer `RUNIR_RECALL_TIMEOUT=20` did not change the result. |
| Architecture boundary | **PASS for tracked shared source; untracked baseline by session snapshot** | `git diff -- src` was empty, proving no tracked shared `src/**` mutation. The conversation-start and post-run status snapshots list the same untracked model-benchmark paths; validation did not intentionally edit, stage, move, or remove them, but no byte-level pre-run baseline was captured. |

## Phase A — ambient blind first turn

### Result

**FAIL — invalid test procedure; native-selection result is unknown.**

The exact blind prompt was not the first inference in the restarted session. The session first received the larger handoff text. This destroys the intended blind first-turn condition. The validator was not supplied with a fabricated answer, and the result must not be classified as a native-memory selection miss.

## Phase B — installed components

### Commands

```bash
cd /Users/brooks/Code/runir
python3 plugins/runir-grok/scripts/verify_hooks.py --user --skill --live
grok inspect --json
```

### Result

**PASS.**

Verifier evidence:

```json
{
  "ok": true,
  "errors": [],
  "events": {
    "UserPromptSubmit": {"present": true, "timeout": 45},
    "Stop": {"present": true, "timeout": 5}
  },
  "preToolUse": null,
  "skill": {"present": true, "userInvocable": true, "disableModelInvocation": true},
  "live": {"authed": true, "status": 200, "hasPrependContext": true, "reason": "ok"}
}
```

`grok inspect` also showed:

- skills `runir` and `runir-recall`;
- Rúnir `user_prompt_submit` and `stop` hooks;
- no Rúnir `PreToolUse` hook.

Owner-only receipts:

- `components.verify.json`
- `grok-inspect.json`

## Phase C — explicit interactive recall

### Configured-path result

**FAIL.**

The deployed skill loads `/Users/brooks/Code/runir/.env` and invokes `get --id` without an explicit `--user-id`. The current dotenv resolves:

```text
RUNIR_USER_ID=owner
```

Under that configured identity, the exact frozen memory ID returned:

```text
404 Not Found: Memory not found: 70ed2586-b145-4791-9ec7-2332eb9ffdee
```

Therefore the installed/configured interactive retrieval path cannot retrieve the frozen record.

### Diagnostic identity override

To distinguish missing data from identity configuration, the same record was fetched with `--user-id brooks`. Retrieval succeeded. The opaque value was routed directly to an owner-only answer file and checked with the official hash-only validator; it was never printed or written to this document.

Validator result:

```json
{
  "kind": "explicit",
  "pass": true,
  "answerSha256": "569ef7d3f1946719d7f8235ff2565f87915ba36608ed03d8e1a8f09bdac74e27",
  "expectedSha256": "569ef7d3f1946719d7f8235ff2565f87915ba36608ed03d8e1a8f09bdac74e27"
}
```

This diagnostic proves the record and frozen answer are intact, but it does not convert the configured-path failure into a PASS.

Owner-only receipts:

- `explicit.configured-path.redacted.json`
- `explicit.diagnostic-override.redacted.json`
- `explicit.retrieved.json`
- `explicit.answer.txt`
- `explicit.validator.json`

## Phase D — TUI lifecycle capture

### Commands

```bash
cd /Users/brooks/Code/runir
python3 plugins/runir-grok/scripts/runir_inspect.py status --json
python3 plugins/runir-grok/scripts/runir_inspect.py session --latest --limit 30
python3 plugins/runir-grok/scripts/runir_inspect.py errors --json
```

### Result

**PASS.**

Fresh session evidence:

```json
{
  "digest": "6de9695619cb7a1eab654cb5f779af9e4d3df6b7a10ef90dd248640e3c146ece",
  "label": "019fd218-ce3",
  "status": {
    "counts": {"recall": 1, "deliver": 0, "skip": 3, "capture": 2, "error": 0},
    "captureStatus": "done"
  }
}
```

The latest session ledger contains `UserPromptSubmit` events with `reason=prompt_only` and corresponding `capture status=done` events. The digest differs from pre-restart `1b8048a1…`.

`runir_inspect.py errors --json` listed one historical error at `2026-07-31T15:22:39.793Z` on digest `c4b3b0f8…`; it is not a new error from this session. Current-session status reports `error:0`.

Owner-only receipts:

- `tui.status.json`
- `tui.session.txt`
- `tui.errors.json`
- `tui.status.redacted.json`
- `tui.errors.summary.json`

## Phase E — headless automatic pre-inference injection

### Required command shape

```bash
plugins/runir-grok/scripts/runir_ask.sh \
  --prompt "$PROMPT" \
  --path /Users/brooks/Code/runir \
  --json \
  --max-turns 1 \
  --no-memory \
  --disable-web-search
```

### Result

**FAIL.**

Required-run receipt:

```json
{
  "sessionId": "e9424f8f-cacd-45bb-bf13-a22f266b2c3c",
  "modelCalls": 1,
  "modelCallsSource": "modelUsage",
  "memoryInjected": false,
  "promptBlockOrder": ["user"],
  "retrievalTraceId": "",
  "memoryIds": [],
  "stopReason": "end_turn",
  "text": "<redacted>"
}
```

Validator:

```json
{
  "kind": "headless",
  "pass": false,
  "answerSha256": "09007578ffaeb21bb8558397e78998270a178c7ae5ef31c54db31d0d2c1ffe3a",
  "expectedSha256": "6c46c4d58c06d9e240fdce2ce74765b8ad6710e05617108a183604445b2c3f00"
}
```

Two diagnostic retries also failed:

1. Explicit `RUNIR_USER_ID=brooks`.
2. `RUNIR_USER_ID=brooks` with `RUNIR_RECALL_TIMEOUT=20` to rule out the default cold-embedder timeout.

Both retained:

```json
{
  "modelCalls": 1,
  "memoryInjected": false,
  "promptBlockOrder": ["user"],
  "retrievalTraceId": "",
  "memoryIds": []
}
```

Additional diagnosis:

- `memory/get` under `brooks` can retrieve expected memory ID `d954cd50-dd34-43ec-90cc-aaa65db0b261`, and its text contains the frozen expected answer hash.
- `memory/search` under `brooks` ranks that expected memory ID in the result set.
- The exact `/hooks/recall` request under `brooks` returned HTTP `200`, `count:0`, empty `prependContext`, no trace, and no selected IDs.
- A later exact `/hooks/recall` request under configured identity `owner` selected three unrelated `noema:*` IDs; the returned context did not contain the frozen headless answer hash.

These receipts narrow the observed failure to recall selection/identity before prompt construction: the target record remained retrievable and searchable under `brooks`, while the tested `/hooks/recall` calls did not select it. They do not by themselves establish the deeper service root cause. The directly proven fact is that the model ran once but no relevant Rúnir memory block reached `--prompt-json`.

Owner-only receipts include:

- `headless.result.json`
- `headless.receipt.redacted.json`
- `headless.answer.txt`
- `headless.validator.json`
- `headless.retry-brooks.*`
- `headless.retry-timeout.*`
- `headless.get-current.json`
- `headless.search-current.json`
- `headless.recall-owner-metadata.json`
- `headless.recall-owner-hashcheck.json`
- `headless.brooks-diagnostic.redacted.json`

## Phase F — architecture and repository scope

### Result

**PASS for tracked shared source; untracked baseline is limited to session status snapshots.**

`git diff -- src` was empty, proving that validation made no tracked shared `src/**` mutation. The conversation-start snapshot and final status list the same untracked model-benchmark paths. Validation did not intentionally edit, stage, move, or remove those paths, but a byte-level pre-run baseline was not captured, so the untracked preservation claim is based on the supplied session snapshot plus operator scope rather than content hashes.

Validation created only this results document inside the repository. Owner-only evidence was written beneath the frozen state directory. No branch reconciliation, commit, push, or shared Rúnir `src/**` redesign was performed.

## Test-kit hygiene finding

The user-supplied restart instruction said that all plaintext canary setup artifacts had been redacted, while the handoff describes a three-file hash-only kit and warns against reading `expected*` files. At inspection time, the state directory still contained plaintext-capable setup artifacts named `expected.json`, `explicit.get.json`, `headless.get.json`, and setup/search/store outputs. Most were owner-only, but four `*.attempt-1.stdout` / `*.attempt-1.stderr` files were mode `0644`.

No plaintext value is copied here. This should be treated as a separate validation-kit hygiene defect and cleaned only after preserving any evidence required for diagnosis.

## Bead disposition

`Rúnir-pzt` remains **open / in progress** because two mandatory gates failed:

- configured explicit interactive recall;
- headless pre-inference injection.

Ambient selection was invalidated separately and is not used to claim either Rúnir transport success or failure.
