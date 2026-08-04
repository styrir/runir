# Feature request: pre-inference `additionalContext` on `UserPromptSubmit`

> **DRAFT — LOCAL REVIEW ONLY · NOT SUBMITTED.**
> Local review artifact for human decision. No issue filed, no email, no external send.
> Bead: Rúnir-12v · Date: 2026-08-04 · Status: draft (local)

---

## 1. Summary

**Current:** `UserPromptSubmit` is documented as non-blocking and passive (`~/.grok/docs/user-guide/10-hooks.md:89,103`); passive-event stdout is ignored (`:302-304`). The only documented `additionalContext` vocabulary lives on `Stop`, where it also keeps the agent working (`:256`).

**Observed (not contract):** On session `019fcbe4`, the host already awaits the UPS command hook before every turn's first model request (n=6; ~139–160 ms post-hook gap). Timing is sufficient; the content channel is absent.

**Requested:** Honor content-bearing JSON on UPS stdout — reuse the existing `hookSpecificOutput.additionalContext` *vocabulary* from `Stop` (`:256`) — inject it into the **same turn's** frozen model request **before first inference**, **without** continuing the turn, **without** counting against the 8-continuation cap (`:262`), as untrusted reference data under fail-open semantics.

---

## 2. Problem: the timing is sufficient, the channel is absent

Memory and session-context plugins need a host-visible way to attach prompt-relevant text to the **current** user turn before the model request is frozen. Without that channel, the only mechanical options observed in the interactive Grok Build TUI are:

1. Abuse `PreToolUse` deny as a transport (semantic abuse; multiplies per sibling tool call).
2. Abuse `Stop.additionalContext` to force a continuation (extends the turn; burns the cap).
3. Rely on native first-turn memory injection (session-start / post-compact only; same-turn publish misses).

**Current (documented):** UPS is "Blocking? **No**" (`10-hooks.md:89`). Only `PreToolUse` and `Stop`/`SubagentStop` can block; "**every other event is passive**" (`10-hooks.md:103`). Passive hooks discard stdout (`10-hooks.md:302-304`).

**Observed (implementation behavior, not contract):** Across six turns the host still waits for the UPS hook to finish before `loop_started` (see §4.1). The missing piece is therefore not await machinery — it is a **content-bearing return channel on the event that already runs pre-freeze**.

Probe-host lane conclusion (viability study): *timing sufficient, channel absent* — no hooks or native-memory route gets prompt-specific recall into the frozen prompt before first inference under today's contract.

---

## 3. Current documented behavior

All claims in this section are **current** (documented host contract as of local user-guide files). Paths are under `~/.grok/docs/user-guide/`.

### 3.1 Hooks contract

| Claim | Citation |
|-------|----------|
| `UserPromptSubmit` fires on prompt submit; **Blocking? No** | `10-hooks.md:89` |
| Only `PreToolUse` and `Stop`/`SubagentStop` can block; **every other event is passive** | `10-hooks.md:103` |
| Hook failures (timeouts, crashes, malformed output) are **fail-open** | `10-hooks.md:156` |
| `PreToolUse` stdout vocabulary is **allow** / **deny** only | `10-hooks.md:236-241` (`:240` allow; `:241` deny) |
| Exit codes: 0 success/allow; 2 explicit deny/block-stop; other **fail-open** | `10-hooks.md:245-249` |
| `Stop` non-error feedback: `hookSpecificOutput.additionalContext` — "**Also keeps the agent working**" | `10-hooks.md:256` |
| After **8 continuations** (blocks or non-error feedback) the gate is overridden | `10-hooks.md:262` |
| Interrupted / refused / max-turns turns **skip Stop hooks entirely** | `10-hooks.md:266` |
| Passive hooks: **stdout is ignored** | `10-hooks.md:302-304` |
| Best-practice hint: "long-running hooks **block the UI**" (only await-related doc signal) | `10-hooks.md:467` |
| Fail-open restated: use explicit `deny` to block; crashes do not block | `10-hooks.md:468` |

### 3.2 Native memory contract

| Claim | Citation |
|-------|----------|
| File watcher reindexes external edits "**on the next memory search**" (lazy) | `13-memory.md:141`, `:436-446` |
| Automatic injection: **first turn of each session** only (configurable) | `13-memory.md:252-262` |
| Automatic injection also **after auto-compaction** | `13-memory.md:264-266` |
| Host-owned hybrid scoring (vector 0.7 / BM25 0.3; min_score default 0.35) | `13-memory.md:285-289` |
| Host-owned chunking / index / search / initial_injection settings | `13-memory.md:360-389` |

**Current implication:** There is **no documented per-turn** automatic memory injection path. First-turn + post-compact are the only automatic injection points (`13-memory.md:252-266`). UPS has no content-bearing output contract.

---

## 4. Observed behavior (session `019fcbe4`)

> Labels: everything in §4 is **observed implementation behavior** from session
> `019fcbe4-27e5-7112-9014-5e2e440a8280` (agent-ops workspace), not documented contract.
> Canonical analysis: `.pipeline/runir-grok-viability-fable/probe-host/artifact.md` §2.
> Adapter trace: `~/.grok/state/runir/trace-0020d7aa58515ecbd5fe37a0cac3fa176259979815af9d53fff42f3d16fb78b7.jsonl`.

### 4.1 Await table (n=6)

The host awaits the UPS command hook before freezing every turn's first request — including the cancel-then-send turn. Sources: session `events.jsonl` + adapter trace.

| Turn | `turn_started` | UPS recall | `loop_started` | gap after hook |
|------|----------------|------------|----------------|----------------|
| 0 | 08:29:50.921 (`events.jsonl:62`) | 08:29:51.980 recall; 08:29:52.109 native publish (trace `:1-2`) | 08:29:52.250 (`:63`) | **141 ms** |
| 1 | 08:48:58.742 (`:1281`) | 08:48:59.784 (trace `:7`) | 08:48:59.925 (`:1282`) | **141 ms** |
| 2 (`redirect_kind:"cancel_then_send"`) | 08:49:26.439 (`:1285`) | 08:49:27.442 (trace `:8`) | 08:49:27.581 (`:1286`) | **139 ms** |
| 3 | 09:03:18.579 (`:2014`) | 09:03:19.534 (trace `:16`) | 09:03:19.683 (`:2015`) | **149 ms** |
| 4 | 09:14:30.011 (`:2687`) | 09:14:31.141 (trace `:22`) | 09:14:31.289 (`:2688`) | **148 ms** |
| 5 | 09:53:37.829 (`:3877`) | 09:53:38.788 (trace `:28`) | 09:53:38.948 (`:3878`) | **160 ms** |

Uniform ~**139–160 ms** host-side gap after the hook's final trace write is a strong await signature. Verified only up to ~1.3 s of hook latency against the installed **45 s** timeout (`~/.grok/hooks/runir-grok.json` UPS `timeout: 45`). The await is **observed, not documented** — docs still say UPS is non-blocking (`10-hooks.md:89`).

### 4.2 Freeze miss (141 ms early publish, stale block)

**Observed:** Synchronous publish at **08:29:52.109** landed **141 ms before** `loop_started` (08:29:52.250), yet the frozen `<memory-context>` did **not** include the just-published facts.

- Frozen conversation (`chat_history.jsonl`) system block held the **previous session's** managed global chunk (`MEMORY.md` lines 4–6, score 0.59: *"Full redesigned behavior for Runir requires starting a new session…"*).
- First-turn injection block returned **3 results, all `source: session`** — zero current global-`MEMORY.md` content.
- Canary string `FABLE_ASK_SUBSCRIPTION_OK` (written by the publish, `publishedCount:9`) was absent from every memory block of the frozen prompt.
- Session context was built at 08:29:15.940 (`prompt_context.json:33`) — ~35 s before the first prompt.

So same-turn "publish inside the awaited UPS hook → native first-turn injection" **achieved its timing goal and still missed the freeze**. Content diff proves the miss; it does not yet discriminate injection-before-hook from lazy reindex race (`13-memory.md:141`).

### 4.3 Sibling denials (23 fires; bursts 3/6/4/4/6)

**Observed:** Five `pre_tool_use` deny bursts in the adapter trace — **3 + 6 + 4 + 4 + 6 = 23** sibling denials:

| Burst | Trace lines | Count |
|-------|-------------|-------|
| 1 | `:3-5` | 3 |
| 2 | `:9-14` | 6 |
| 3 | `:17-20` | 4 |
| 4 | `:23-26` | 4 |
| 5 | `:29-34` | 6 |

Turn 0 first inference was fully memory-blind: `waiting_for_model` 08:29:52.278 → `tool_execution` 08:30:05.248 (`events.jsonl:64-65`) — **~13 s** of model work without the recall, ending in three parallel tools (`read_file`, **`memory_search`**, `run_terminal_command`, `:66-68`) **all denied** by the gate (trace `:3-5`), forcing a correction round (`loop_started 1` at 08:30:05.629). The middle denial refused the host's **own native `memory_search` tool** — the cleanest demonstration that deny-as-transport is not a viable product path.

### 4.4 Lost turn (`c66c5229`)

**Observed:** Recall id **`c66c5229`** (6,504 chars, trace `:7`) has **no deliver and no capture**. Turn 2's cancel-then-send recall (`c7cfafbc`, trace `:8`) overwrote the single session-keyed slot. Prompt-specific content prepared on turn 1 was permanently lost under the current transport design.

### 4.5 Audit gap

**Observed:** Session `events.jsonl` contains **zero** hook-related event types (case-insensitive grep for `hook`: no matches). Hook effects exist only in the plugin's private trace files. There is no host-visible audit record of injection or denial activity.

---

## 5. Why the existing channels cannot carry pre-inference content

### 5.1 Passive stdout (UPS / SessionStart / …)

**Current:** Passive events ignore stdout (`10-hooks.md:103`, `:302-304`). A plugin that prints JSON or plain text on UPS success has no host-side consumer. **Rejected** as a content channel by contract.

### 5.2 PreToolUse deny transport

**Current:** Vocabulary is allow/deny only (`10-hooks.md:236-241`). Exit-code semantics are gate-shaped, not context-injection-shaped (`:245-249`).

**Observed:** 23 sibling denials (bursts **3/6/4/4/6**), a **~13 s wasted first inference on turn 0** (`waiting_for_model` 08:29:52.278 → `tool_execution` 08:30:05.248, `events.jsonl:64-65`; later turns not uniformly ~13 s), and denial of native `memory_search` (§4.3). Content arrives only as failed-tool feedback after planning has already started — too late for first inference, and semantically abusive. **Rejected.**

### 5.3 `Stop.additionalContext`

**Current:** The vocabulary exists (`10-hooks.md:256`) but "**Also keeps the agent working**"; both blocks and non-error feedback count toward the **8-continuation cap** (`:262`); interrupted / refused / max-turns turns **skip Stop entirely** (`:266`).

Using Stop as a memory-delivery mechanism therefore **forces a continuation**, burns the cap, and is skipped on interrupt. It cannot inject-and-end. **Rejected** for pre-inference / non-extending delivery.

### 5.4 Native memory automatic injection

**Current:** Automatic injection only on first turn and after compaction (`13-memory.md:252-266`). Lazy reindex on next search (`:141`, `:436-446`). Host owns scoring/chunking (`:285-289`, `:360-389`).

**Observed:** Same-turn synchronous publish 141 ms before freeze still missed (§4.2). No per-turn injection path exists by contract. **Rejected** as the pre-inference content channel for prompt-specific recall.

---

## 6. Requested behavior — minimal contract

Every sentence below is **Requested** (not current behavior). The ask reuses `Stop`'s *vocabulary*, not its *side effect*.

**Requested:** when a `UserPromptSubmit` command hook exits 0, the host reads JSON on stdout and honors:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<text>"
  }
}
```

**Requested** numbered requirements:

1. **Await, documented.**
   **Requested:** The host awaits the UPS command hook up to its configured `timeout` before freezing the model request for that turn. (Already observed n=6; this asks only that the await and its bound be *specified* in the user guide.)

2. **Pre-freeze injection.**
   **Requested:** On exit 0 with valid JSON, the `additionalContext` text is inserted into the model request for the **same** turn, **before first inference** — not deferred to the following turn, not gated on compaction.

3. **Untrusted reference — structural prompt-boundary (not delimiter-only).**
   **Requested:** Delivery is a **host-created typed field or message role**, distinct from the user turn and the system prompt. Delimiter markers alone are **not** sufficient (forgeable closers / role markers / instruction smuggling). Concretely the host MUST:
   - create the envelope itself (hook supplies only the payload string, not framing tokens);
   - escape, length-prefix, or otherwise neutralize payload content so it cannot close or reopen the envelope;
   - reject unexpected top-level fields and unexpected keys inside `hookSpecificOutput` (allowlist parse);
   - document residual model-injection risk (any text the model sees can still be persuasive even when correctly framed);
   - ship adversarial tests: embedded delimiter closers, fake role markers, multi-block smuggling, oversized nested JSON / deep parser trees, pre-parse stdout floods (byte cap before JSON parse), and unexpected-field rejection.
   It must not be able to impersonate the user turn or the system prompt (prompt-boundary integrity).

4. **No turn extension.**
   **Requested:** Unlike `Stop.additionalContext` (**current** `10-hooks.md:256`), UPS `additionalContext` must **not** keep the agent working, must **not** trigger a continuation, and must **not** count against the 8-continuation cap (**current** `:262`). Vocabulary only; **not** the Stop side effect.

5. **Bounded — capture, parse, per-hook, and aggregate per-turn.**
   **Requested:** Host documents and enforces resource bounds **before** and **after** extraction. Post-extract `additionalContext` size caps alone are insufficient (a malicious/defective hook can exhaust host memory/parser first). Concretely:
   - **Pre-parse stdout capture bound:** max buffered stdout **bytes** per UPS hook contribution, enforced **before** JSON parse (timeout bounds wall-clock only — not buffered bytes);
   - **Parser depth / complexity bounds:** max JSON nesting depth and max node/token count (or equivalent) so oversized nested trees cannot DOS the host parser;
   - a **per-hook** size cap on extracted `additionalContext` string;
   - an **aggregate per-turn** budget across all UPS hooks that contribute;
   - a **max number of contributing hooks** per turn (or equivalent contribution count);
   - **deterministic merge + truncation** order (stable, documented; e.g. by scope then registration order among **eligible** scopes — see §7 config-scope-authorization);
   - **whole-contribution reject** on any capture/parse/size violation: drop that contribution, leave the user turn unmodified for that hook, emit audit metadata (**without retaining the rejected body** — no raw oversized/unparseable payload in transcript, temp spill, or default audit store);
   - audit records of omitted / truncated / rejected contributions (see req 7).
   Single-hook post-extract caps alone are insufficient when multi-scope hooks fire or when attack surface is pre-parse.

6. **Fail-open.**
   **Requested:** Timeout, non-zero exit, unparseable stdout, pre-parse capture overflow, or parser-bound violation leaves the prompt unmodified — consistent with the existing fail-open rule (**current** `10-hooks.md:156`, `:249`, `:468`). Failures still emit audit metadata (req 7) without retaining rejected bodies.

7. **Auditable with privacy defaults.**
   **Requested:** Every injection attempt is inspectable after the fact. **Default audit is metadata-only** (not raw body):
   - hook identity (id / path / type / scope: global|project|config|plugin; for config: source path + controller class — user vs org-managed);
   - content digest (e.g. SHA-256) and byte size **only for accepted or truncated-accepted payloads** — rejected pre-parse / parser-bound / oversized bodies MUST NOT be retained or digested from a kept copy (record reason + observed size class only);
   - truncation / omission / reject reason if any;
   - timestamp and session id.
   Raw body inclusion in transcript / event stream is **opt-in under explicit transcript privacy / retention policy**, not the default. Note that any accepted payload that is injected into the model request **leaves the machine to the model provider** (provider egress boundary) — audit digests must not be mistaken for non-egress. Today `events.jsonl` records no hook activity at all (§4.5).

---

## 7. Security requirements

All items below are **Requested** acceptance criteria for any implementation of §6.

- **Structural untrusted-content envelope (prompt-boundary).** Injected text is reference data only. Framing is a **host-created typed field / message**, not delimiter-semantic markup the payload can forge. Payload is escaped or length-prefixed; unexpected JSON fields rejected; adversarial tests required (§6.3). Residual model-injection risk documented.
- **No auto-continue.** The channel must never extend or restart a turn. A memory-delivery mechanism that can force re-inference is a denial-of-wallet and correction-loop hazard (grounded in **current** Stop semantics at `10-hooks.md:256,262`).
- **Config-scope authorization (eligible scopes + trust principal).** Hook Locations (**current** `10-hooks.md:59-75`) merge several Always-loaded sources — including **user** config (`~/.grok/config.toml` `:71`) and **organization / server-synced** managed layers (`managed_config.toml` at `$GROK_HOME` and `/etc/grok` `:72`; `requirements.toml` user and system `:73`; org rows also at `:181-182`). "User registered" alone is **not** sufficient authorization language: admin/server-distributed UPS hooks must not silently gain a prompt-injection + provider-egress channel under a personal-opt-in reading. **Requested** contract:
  - **Enumerate eligible scopes for UPS `additionalContext`.** Default eligible set for this request: **user-controlled** registrations only — global user hooks (`~/.grok/hooks/*.json` etc.), project hooks (after folder trust), user `~/.grok/config.toml` entries, and plugin hooks under existing per-plugin trust.
  - **Org-managed config is a distinct trust principal.** `managed_config.toml` and `requirements.toml` (**current** Always at `:72-73`) are **excluded from UPS `additionalContext` by default** under this request. If a future host revision admits them, it MUST treat org/admin as an **administrative trust principal** separate from end-user opt-in (documented policy flip; not implied by personal registration).
  - **No default-on AC** for users with zero eligible UPS hooks.
  - **Provenance** on every contribution names scope **and** config source/controller (`user-config` | `managed_config` | `requirements` | `global-hooks` | `project` | `plugin`) so audit can distinguish personal vs org injection (§6.7).
- **Resource bounds — pre-parse capture, parser, per-hook, aggregate.** Bounded injection prevents context exhaustion **and** host-side parser/memory DOS by a misbehaving, compromised, or multi-scope hook set (§6.5). Caps cover: (1) pre-parse stdout **byte** capture, (2) JSON depth/node complexity, (3) extracted `additionalContext` per contribution, (4) merged total across **eligible** scopes, (5) max contribution count. Deterministic truncation/reject order; whole-contribution reject on bound breach **without retaining rejected body**; omitted/truncated/rejected contributions audited as metadata only.
- **Fail-open, never fail-closed.** A broken, timed-out, unparseable, capture-overflow, or parser-bound-violating hook must not block or corrupt the user's turn (**current** fail-open posture `10-hooks.md:156,:249,:468`). Failures still leave an audit breadcrumb (no rejected-body retention).
- **Hook trust boundary (command vs HTTP; folder + plugin trust).**
  - **Command-hook channel (preferred / default for this request):** UPS `additionalContext` is accepted only from **command** hooks (`type: command`). HTTP hooks (**current** `10-hooks.md:358-366`) either **do not** contribute `additionalContext`, or — if the host later chooses to allow them — require an explicit, documented HTTPS endpoint-trust + auth story (not implied by this request).
  - **Folder trust preserved:** Project-scoped hooks remain gated by the existing folder-trust store (`/hooks-trust` / `--trust`; **current** `10-hooks.md:78-80`, `:460`). Untrusted project hooks stay silently skipped — no AC from them.
  - **Plugin trust preserved:** Plugin-bundled hooks keep their existing per-plugin trust posture (**current** `10-hooks.md:74`).
  - **Provenance:** Each contribution carries identity / type / scope / config-source controller into the audit record (§6.7).
  - This request does **not** ask the host to trust remote content by default; Rúnir's own memory transport remains loopback. Global hooks still run with the user's privileges (**current** `10-hooks.md:459`).
- **Auditability + privacy + provider egress.** Default audit is **metadata** (hook id, digest where body was accepted, sizes, truncation/reject reason, ts, provenance including config source/controller) — not raw inject body. Rejected pre-parse/parser/oversized bodies are **not retained**. Raw body only under explicit transcript privacy / retention policy. Document that accepted injection is **model-provider egress** (payload leaves the machine with the request). Today hook effects are recorded only in plugin-private traces (§4.5) — not an acceptable audit story for injected context.

---

## 8. Non-goals for this request

This request does **not** ask for:

- New blocking / deny semantics on UPS beyond documenting the existing await and adding a content-bearing success path.
- Any change to `PreToolUse` allow/deny vocabulary or Stop decision control.
- A host-side memory-provider plugin API, custom scorer, or replacement of native memory.
- Changes to native memory scoring, chunking, first-turn injection, or post-compaction injection.
- Guaranteed await beyond the configured hook `timeout` (fail-open on timeout remains).
- Any Rúnir product code change as part of this document (sibling beads handle TUI disarm and headless proof separately).

---

## 9. Open questions

Framed for the host team — **not claims**:

1. **Await bound.** Observed await holds for ~1.3 s of hook work; installed UPS timeout is **45 s** (`~/.grok/hooks/runir-grok.json`). What is the intended upper bound, and will it be documented alongside UPS?
2. **First-turn injection query.** Does first-turn native injection use the user prompt as the search query, a project/workspace descriptor, or another signal? (Relevant to whether ambient MEMORY.md routes can ever be prompt-specific.)
3. **Resumed-turn block ordering.** On `--resume` / continued sessions, how do host-injected blocks order relative to prior transcript and any UPS `additionalContext` (if added)?
4. **Injection vs. hook ordering today.** For the freeze miss (§4.2): does first-turn memory search run before, concurrent with, or after UPS? (Separates race from ordering; optional E2 in the viability probe plan.)

---

## 10. Provenance and status

| Item | Value |
|------|-------|
| Session | `019fcbe4-27e5-7112-9014-5e2e440a8280` |
| Adapter trace | `~/.grok/state/runir/trace-0020d7aa58515ecbd5fe37a0cac3fa176259979815af9d53fff42f3d16fb78b7.jsonl` |
| Host contract | `~/.grok/docs/user-guide/10-hooks.md`, `13-memory.md` |
| Canonical analysis | `.pipeline/runir-grok-viability-fable/probe-host/artifact.md`, `decision/artifact.md` |
| Decision quote | *"file the xAI feature request for `UserPromptSubmit` `additionalContext` (the vocabulary already exists on Stop at `10-hooks.md:256`; attach the n=6 await table). That is the only path to all six criteria in the actual TUI."* (decision artifact follow-on / convergence point) |
| Bead | Rúnir-12v |
| This file | `docs/plans/2026-08-04-001-grok-userpromptsubmit-additionalcontext-request.md` |

**Status:** Local draft for human review only. **Not submitted.** Shipping (external send to xAI or any third party) is a human decision outside this document. No `gh issue`, email, HTTP POST, or message was issued as part of authoring this draft.

---

*End of draft.*
