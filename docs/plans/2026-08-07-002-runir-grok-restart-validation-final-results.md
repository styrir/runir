# Rúnir ↔ Grok Build restart-validation final results

**Test ID:** `grok-restart-20260807T023648Z-04fa44`  
**Bead (child):** `Rúnir-pzt.4`  
**Parent epic:** `Rúnir-pzt`  
**Executed:** 2026-08-07  
**State / kit directory:** `~/.grok/state/runir/restart-validation/grok-restart-20260807T023648Z-04fa44/`  
**Report root (this worktree):** `/Users/brooks/.grok/worktrees/code-runir/runir-pzt4-final-validation-12`  
**Installed source (plugin SoT):** `/Users/brooks/Code/worktrees/runir-pzt-integration` @ `eb1e0e04c4537ef1852f083ef7935bcfcd7ff58d`  
**Runtime workspace (frozen path):** `/Users/brooks/Code/runir`  
**Overall decision:** **`mandatory_gates_pass_ambient_native_fail`**  
**Mandatory Rúnir gates:** **PASS**  
**Ambient native selection:** **FAIL** (classified separately; does not block mandatory close)

> Historical note: the earlier failed report
> `docs/plans/2026-08-05-003-runir-grok-restart-validation-results.md`
> is preserved **unchanged** as the 2026-08-05 fail record. This document is the
> 2026-08-07 fix-forward final results for kit `…04fa44` / bead `Rúnir-pzt.4`.

## Purpose

Record an honest, secrecy-safe final result for the dual-lane Rúnir ↔ Grok restart
validation after fix-forward of the blocked first workflow:

1. Preserve already-proven **fresh** blind / explicit / TUI evidence (no re-run of
   the interactive blind prompt).
2. Re-verify **installed components** against the actual **installed integration**
   source (plugin SoT = installed_source, not report_root).
3. Re-run **headless once** with frozen workspace path `/Users/brooks/Code/runir`
   and the exact expected headless memory ID.
4. Publish a redacted gate table (hashes, IDs, booleans, redacted receipts only)
   and state the close rule for child + parent epic.

These contracts are independent. Ambient native-selection miss is **not** failure
of explicit, TUI, headless, or installed-component transport.

## Fresh session identity (`slash_new`)

| Field | Value |
|---|---|
| launchMethod | `slash_new` |
| grokSessionId (UUID) | `019fda96-bdb0-7ff3-80e2-6cc606c15b1f` |
| grokSessionDigest (sha256 of UUID) | `a61dcec3acbcb15c99c8b47179fb4ca0ac96c8f611c8e9d485a1ec927f2b501f` |
| grokSessionIdPresent | `true` |
| firstPromptIsBlindAmbient | `true` |
| blindPromptOrdinal | `1` |
| ambientGateProtocolValid | `true` |
| recordedBy | `workgraph` |
| contaminatesBlindPrompt | `false` |
| baseline.latestDigest (pre-session) | `6de9695619cb7a1eab654cb5f779af9e4d3df6b7a10ef90dd248640e3c146ece` |
| digest differs from baseline | `true` |

Provenance receipt (kit, redacted): `provenance.json`  
(`launchMethod=slash_new`, digest above, protocol flags only; no prompt/answer bodies).

## Executive result

All **mandatory** Rúnir gates pass under correct source/path binding:

- Fresh `slash_new` session with blind prompt ordinal **1** (protocol valid).
- Configured explicit recall hash-validates under identity from
  `/Users/brooks/Code/runir/.env` (no manual user-id override).
- TUI lifecycle: first-turn `prompt_only` skip + matching capture `done`, session
  errors `0`, aggregate error delta not increased.
- Installed components: live `verify_hooks` + inspect shape + byte-equal plugin
  files at accepted commit with **installed_source** as plugin SoT.
- Headless canary (single paid turn): memory inject, `[memory, user]` order,
  expected memory ID present, canonical + capture path =
  `/Users/brooks/Code/runir`, answer hash match.
- Architecture boundary: no shared `src/**` mutation; worktree clean at
  `eb1e0e04…`.

**Ambient native selection remains FAIL** (fallback answer; validator miss) and is
recorded **separately**. Ordering protocol stays valid. **No blind re-run.**

The first blocked workflow (`runir-pzt4-final-validation-12`) is a
**validation-harness path / source-binding diagnostic**, not a product regression:
components previously used report_root as plugin SoT path identity, and headless
bound `canonicalIdentity.path` to report_root instead of frozen
`public-summary.workspacePath` (`/Users/brooks/Code/runir`). Fix-forward re-verify
with correct bindings yields components PASS + headless PASS without product code
change.

## Gate table

| Gate | Result | Evidence (hashes / IDs / booleans only) |
|---|---|---|
| Fresh session / `slash_new` protocol | **PASS** | UUID `019fda96-bdb0-7ff3-80e2-6cc606c15b1f`; digest `a61dcec3…2b501f`; `firstPromptIsBlindAmbient=true`; `blindPromptOrdinal=1`; `ambientGateProtocolValid=true` |
| Ambient first-turn native selection | **FAIL (separate)** | protocol valid; `ambient_selected=false`; answerSha256 `d34eb6b6…e47c06` ≠ expected `48fc3a54…b5bc9`; decision `protocol_valid_ambient_miss`; `blind_rerun_needed=false` |
| Installed components (hooks + skills) | **PASS** | `verify_hooks --user --skill --live --plugin-root INSTALLED_SOURCE/plugins/runir-grok`: `ok=true`, `errors=[]`, live HTTP 200, `authed=true`, `hasPrependContext=true`, `identitySource=env_file`; skills `runir` + `runir-recall`; hooks `UserPromptSubmit` + `Stop`; no Rúnir `PreToolUse`; 6 key paths byte-equal installed↔report at `eb1e0e04…` |
| Configured explicit recall | **PASS** | memoryId `13cd1463-045c-4186-b500-527b1f3308d3`; identity `configured:/Users/brooks/Code/runir/.env`; `manual_override=false`; answerSha256 = expected `d5177395…de1e9d` |
| TUI lifecycle capture | **PASS** | promptId `d752daa5-9d48-4019-aab3-5cacf2b6fca4` (sha256 `552faca2…c20dfc`); skip `reason=prompt_only` @ `user_prompt_submit`; matching capture `done` HTTP 200; session `error=0`; error_delta `0`; blind ordinal `1` |
| Headless pre-inference (corrected path) | **PASS** | `--path /Users/brooks/Code/runir`; `modelCalls=1`; `memoryInjected=true`; `promptBlockOrder=[memory,user]`; expected memoryId `a5b33294-5153-4039-b44b-647d53002fc4` **present**; `canonicalIdentity.path` + `captureReceipt.path` = `/Users/brooks/Code/runir`; answerSha256 = expected `86cbb1c3…cc2ecc`; `ask_rc=0` |
| Architecture boundary (`src/**`) | **PASS** | product head `eb1e0e04c4537ef1852f083ef7935bcfcd7ff58d`; porcelain `0`; `git diff -- src` empty; src delta vs merge-base `0` |

### Mandatory vs ambient classification

| Class | Status | Blocks close? |
|---|---|---|
| Mandatory Rúnir gates (protocol, explicit, TUI, components, headless, architecture) | **all PASS** | n/a — satisfied |
| Ambient native selection | **FAIL** | **No** — recorded separately; protocol remains valid |

**Decision string:** `mandatory_gates_pass_ambient_native_fail`  
**blocking_count:** `0` · **major_count:** `0` · **passed:** `true`

## Phase A — ambient blind first turn (protocol PASS; native selection FAIL)

### Protocol

Proven from session `chat_history.jsonl` + kit provenance (no bodies in this report):

| Check | Result |
|---|---|
| First actual `<user_query>` equals blind-prompt (whitespace-normalized) | **true** (sha256 `46b8bcdca71b0c0b278a5db5575802dda243ae668e2b1a2d4940950f2cad101c`) |
| First assistant is exact non-secret fallback | **true** (sha256 `d34eb6b6ef4f990da4992597ab673aa3422f455a5445aa926308623a78e47c06`) |
| No tool call before first assistant | **true** (history indices 5→6) |
| blind prompt raw sha256 | `1c13a85e6c6c50394d3e24fc99267dfb18e93fd97b747f723727a1391d376418` |

### Ambient validator (hash-only)

```json
{
  "kind": "ambient",
  "pass": false,
  "answerSha256": "d34eb6b6ef4f990da4992597ab673aa3422f455a5445aa926308623a78e47c06",
  "expectedSha256": "48fc3a545f5de251e34719a160dc5d72d7e686d63fb5157f53426289115b5bc9"
}
```

| Field | Value |
|---|---|
| ambient memoryId (public-summary) | `e49f814c-7525-494a-a1ba-854d5e44c208` |
| ambient label | `RUNIR_GROK_RESTART_20260807T023648Z_04FA44_AMBIENT` |
| ambient_selected | `false` |
| decision | `protocol_valid_ambient_miss` |
| blind_rerun_needed | `false` |

**Interpretation:** native first-turn memory did not surface the ambient canary; the
ordering contract still holds. Do not re-run the interactive blind prompt.

Owner-only receipts (mode 0600; not inlined):

- `ambient.answer.txt`
- `ambient.validator.json`
- `provenance.json`

## Phase B — installed components (PASS; installed_source SoT)

### Roots

| Field | Value |
|---|---|
| plugin SoT | **installed_source** (not report_root) |
| installed_source | `/Users/brooks/Code/worktrees/runir-pzt-integration` |
| installed_source_head | `eb1e0e04c4537ef1852f083ef7935bcfcd7ff58d` |
| report_root_head | `eb1e0e04c4537ef1852f083ef7935bcfcd7ff58d` |
| heads equal + clean | `true` / porcelain `0` |
| runtime env file | `/Users/brooks/Code/runir/.env` |

### Verifier (prescribed for fix-forward)

```bash
env -u RUNIR_USER_ID RUNIR_ENV_FILE=/Users/brooks/Code/runir/.env \
  python3 INSTALLED_SOURCE/plugins/runir-grok/scripts/verify_hooks.py \
    --user --skill --live \
    --plugin-root INSTALLED_SOURCE/plugins/runir-grok
```

| Field | Value |
|---|---|
| verify_ok | `true` |
| verify_errors | `[]` |
| live_status | `200` |
| live_authed | `true` |
| live_hasPrependContext | `true` |
| live_identitySource | `env_file` |
| events | `UserPromptSubmit`, `Stop` |
| preToolUse (Rúnir) | absent |

### Inspect shape

| Field | Value |
|---|---|
| skills | `runir`, `runir-recall` |
| runir-related hooks | `user_prompt_submit`, `stop` |
| Rúnir PreToolUse | `false` |

### Byte-equal inventory (installed_source ↔ report_root)

| Path | sha256 | equal |
|---|---|---|
| `plugins/runir-grok/hooks/runir-grok.py` | `23bba4afd8919a4ee24afcec36d729156092b7c0567b5fe2735c4d6f46bcdf6c` | true |
| `plugins/runir-grok/skills/runir/SKILL.md` | `73776ec2cdf5e04d2c6795438464b3140b50de8efe7a41c08fa8edb9fbc31dd4` | true |
| `plugins/runir-grok/skills/runir-recall/SKILL.md` | `de03eeac59658c62f9994a271409e9d9f4acacb0abf181e4f51d65189fd2d316` | true |
| `plugins/runir-grok/scripts/verify_hooks.py` | `0c1e36996a1e1c51251dcf3c8cfcb38dbb97ee9bdc02e9e03da079a85593a35f` | true |
| `plugins/runir-grok/templates/user-hooks.json` | `d65d04115f4f47d18cd4e323785c9cdc9f0ba58882254f3e250854e03f2c2992` | true |
| `plugins/runir-grok/lib/runir_core.py` | `f8bc91107b3265994d9b6f4cb3b5daa33b987975a52b4d2399369bfe69d574c5` | true |

## Phase C — configured explicit interactive recall (PASS)

| Field | Value |
|---|---|
| path | `configured_interactive_get` |
| identity_source | `configured:/Users/brooks/Code/runir/.env` |
| configured_user_id | `owner` |
| manual_override | `false` |
| memory_id | `13cd1463-045c-4186-b500-527b1f3308d3` |
| label | `RUNIR_GROK_RESTART_20260807T023648Z_04FA44_EXPLICIT` |
| retrieval_ok | `true` |
| validator_pass | `true` |
| answerSha256 | `d5177395ad2a3db22f96efa44f27202d45377793f787600b5b9e7ac99cde1e9d` |
| expectedSha256 | `d5177395ad2a3db22f96efa44f27202d45377793f787600b5b9e7ac99cde1e9d` |

```json
{
  "kind": "explicit",
  "pass": true,
  "answerSha256": "d5177395ad2a3db22f96efa44f27202d45377793f787600b5b9e7ac99cde1e9d",
  "expectedSha256": "d5177395ad2a3db22f96efa44f27202d45377793f787600b5b9e7ac99cde1e9d"
}
```

Owner-only receipts: `explicit.answer.txt`, `explicit.validator.json` (mode 0600).

## Phase D — TUI lifecycle capture (PASS)

| Field | Value |
|---|---|
| session_digest | `a61dcec3acbcb15c99c8b47179fb4ca0ac96c8f611c8e9d485a1ec927f2b501f` |
| promptId | `d752daa5-9d48-4019-aab3-5cacf2b6fca4` |
| promptId_sha256 | `552faca2ed7ca7bf8cb32a4d6468195131d78c4575f9c92bd8c06cb630c20dfc` |
| first skip | `channel=user_prompt_submit`, `reason=prompt_only` @ `2026-08-07T04:59:10.765Z` |
| matching capture | `status=done`, HTTP `200` @ `2026-08-07T04:59:16.924Z` |
| session errors | `0` |
| baseline aggregateTraceErrors | `1` |
| current aggregateTraceErrors | `1` |
| error_delta | `0` |
| blind_prompt_ordinal | `1` |
| decision | `tui_lifecycle_pass` |

## Phase E — headless canary (PASS; corrected path binding)

Single paid turn via installed wrapper; frozen workspace path only:

```bash
# configured identity; process RUNIR_USER_ID unset before sourcing .env
INSTALLED_SOURCE/plugins/runir-grok/scripts/runir_ask.sh \
  --prompt-file <temp> \
  --path /Users/brooks/Code/runir \
  --json --max-turns 1 --no-memory --disable-web-search
```

| Field | Value |
|---|---|
| workspacePath / `--path` | `/Users/brooks/Code/runir` |
| wrapper commit | `eb1e0e04c4537ef1852f083ef7935bcfcd7ff58d` |
| ask_rc | `0` |
| model_calls | `1` |
| memory_injected | `true` |
| prompt_block_order | `[memory, user]` |
| expected_memory_id | `a5b33294-5153-4039-b44b-647d53002fc4` |
| expected_memory_id_present | `true` |
| retrieval_trace_id_present | `true` |
| session_id_present | `true` |
| stop_reason_present | `true` |
| canonicalIdentity.path | `/Users/brooks/Code/runir` (ok) |
| captureReceipt.path | `/Users/brooks/Code/runir` (ok) |
| selected_has_expected_memoryId | `true` |
| identity_source | `configured:/Users/brooks/Code/runir/.env` |
| manual_override | `false` |
| answerSha256 | `86cbb1c31d3019629e56800f716b068e9a5e071eb1614ef8d733110558cc2ecc` |
| expectedSha256 | `86cbb1c31d3019629e56800f716b068e9a5e071eb1614ef8d733110558cc2ecc` |
| validator_pass | `true` |
| blocking | `[]` |

```json
{
  "kind": "headless",
  "pass": true,
  "answerSha256": "86cbb1c31d3019629e56800f716b068e9a5e071eb1614ef8d733110558cc2ecc",
  "expectedSha256": "86cbb1c31d3019629e56800f716b068e9a5e071eb1614ef8d733110558cc2ecc"
}
```

Public-summary headless canary: label
`RUNIR_GROK_RESTART_20260807T023648Z_04FA44_HEADLESS`, memoryId
`a5b33294-5153-4039-b44b-647d53002fc4`, sha256 as above; `workspacePath` =
`/Users/brooks/Code/runir`.

Owner-only receipts: `headless.answer.txt`, `headless.validator.json` (mode 0600).

## Architecture boundary (PASS)

| Check | Result |
|---|---|
| product / report head | `eb1e0e04c4537ef1852f083ef7935bcfcd7ff58d` |
| branch | `workgraph/runir-pzt4-final-validation-12` |
| `git status --porcelain` count | `0` (pre-report); report file is docs-only add |
| `git diff -- src` | empty |
| src dirty count | `0` |
| no_src_mutation | `true` |

No product `src/**`, plugin install, kit answer, hook, skill, or service-config
mutation was performed by this final-results write. Report edits are confined to
`docs/plans/` under report_root (plus pipeline stage artifacts outside the product
runtime).

## Path-binding diagnostic (first blocked workflow)

| Field | Value |
|---|---|
| first workflow slug | `runir-pzt4-final-validation-12` |
| fix-forward slug | `runir-pzt4-final-validation-fix-13` |
| root-cause class | `validation_harness_path_source_binding` |
| product_regression_established | `false` |

| Prior gate | Prior decision | Binding error | Fix-forward |
|---|---|---|---|
| Components | `components_fail_sot_path_mismatch` | verify SoT path = report_root plugin tree while live hooks resolve to installed_source | `--plugin-root INSTALLED_SOURCE/plugins/runir-grok` → **PASS** |
| Headless | `fail` (`expected_memoryId_present`) | session/cwd footprint = report_root; wrong path identity for selected memory | `--path /Users/brooks/Code/runir` (= public-summary.workspacePath) → **PASS** |

Prior PASS evidence retained without re-running: audit protocol, ambient hash
pair, explicit hash, TUI first-turn pair. Blind interactive prompt **not** re-run.

## Independent hash inventory (redacted)

| Artifact | sha256 |
|---|---|
| ambient.answer.txt | `d34eb6b6ef4f990da4992597ab673aa3422f455a5445aa926308623a78e47c06` |
| explicit.answer.txt | `d5177395ad2a3db22f96efa44f27202d45377793f787600b5b9e7ac99cde1e9d` |
| headless.answer.txt | `86cbb1c31d3019629e56800f716b068e9a5e071eb1614ef8d733110558cc2ecc` |
| blind-prompt.txt (raw) | `1c13a85e6c6c50394d3e24fc99267dfb18e93fd97b747f723727a1391d376418` |
| blind-prompt.txt (strip) | `46b8bcdca71b0c0b278a5db5575802dda243ae668e2b1a2d4940950f2cad101c` |
| hooks/runir-grok.py | `23bba4afd8919a4ee24afcec36d729156092b7c0567b5fe2735c4d6f46bcdf6c` |
| scripts/verify_hooks.py | `0c1e36996a1e1c51251dcf3c8cfcb38dbb97ee9bdc02e9e03da079a85593a35f` |

## Secrecy statement

This document records **only**:

- SHA-256 digests, memory IDs, session UUID + digest, promptIds, booleans, paths,
  commit SHAs, HTTP status codes, and redacted validator JSON shells.

This document does **not** contain:

- canary plaintext / opaque values
- credentials, API keys, or dotenv secrets
- raw model JSON, prependContext bodies, or answer file contents
- expected opaque tokens beyond their hashes

Answer files and validator files remain owner-only (`0600`) under the kit
directory. `*.answer.txt` files were not opened by the final-results writer.

## Close rule

| Condition | Required |
|---|---|
| All mandatory Rúnir gates PASS | **yes** (satisfied: protocol, explicit, TUI, components, headless, architecture) |
| Ambient native selection PASS | **not required** for close; FAIL is recorded separately under `protocol_valid_ambient_miss` |
| Results document secrecy-safe (hashes/IDs/booleans only) | **yes** (this file) |
| No shared `src/**` mutation at accepted integration commit | **yes** |
| Blind interactive prompt not re-run | **yes** |

**Close eligibility:** **YES** for child bead `Rúnir-pzt.4` and parent epic
`Rúnir-pzt` under the mandatory-gate rule above.

**This stage does not mutate Beads, push Git, or push Dolt.** Actual closeout
(commit of this docs-only results file, bead close, remotes) is deferred to the
pipeline closeout stage / operator, subject to review + test gates.

## Bead acceptance mapping (`Rúnir-pzt.4`)

| Criterion | Status |
|---|---|
| Fresh-session launch method + session ID recorded | **PASS** (`slash_new` + UUID + digest) |
| Blind ambient hash-checked; classified separately | **protocol PASS** + **ambient FAIL separate** |
| Configured explicit recall hash-validates | **PASS** |
| TUI prompt_only + matching capture done + no new errors | **PASS** |
| Headless inject/order/session/trace/modelCalls/validator + expected memory ID @ frozen path | **PASS** |
| Installed components (live verify + skills/hooks shape) | **PASS** |
| no shared `src/**` mutation | **PASS** |
| results hashes/IDs only | **yes** |
| Close child + parent epic | **eligible** (not executed in build stage) |

## Pipeline evidence pointers (agent-ops)

| Artifact | Path |
|---|---|
| Prior audit | `.pipeline/runir-pzt4-final-validation-12/stages/audit/` |
| Prior explicit / TUI | `.pipeline/runir-pzt4-final-validation-12/stages/verify/{explicit,tui}/` |
| Fix-forward verify merge | `.pipeline/runir-pzt4-final-validation-fix-13/stages/verify/` |
| Components re-verify | `.pipeline/runir-pzt4-final-validation-fix-13/stages/verify/components/` |
| Headless re-verify | `.pipeline/runir-pzt4-final-validation-fix-13/stages/verify/headless/` |
| Kit public-summary | `~/.grok/state/runir/restart-validation/grok-restart-20260807T023648Z-04fa44/public-summary.json` |

## Explicit non-claims / non-actions

- Did **not** re-run the interactive blind ambient prompt.
- Did **not** open `*.answer.txt` or print canary plaintext / credentials.
- Did **not** edit runtime_root product code, installed_source, plugins, tests,
  hooks, skills, service config, or kit answer files for this write.
- Did **not** waive ambient native selection (FAIL remains on the record).
- Did **not** treat the first blocked workflow as product failure; it is a
  path-binding diagnostic remediable by correct SoT / workspace binding.
- Did **not** commit, push Git, push Dolt, or mutate Beads in this stage.
