---
name: runir
description: >
  Inspect Rúnir Grok memory activity for the current or latest session.
  Use when the user runs /runir or asks about recall, delivery, capture,
  bridge, or runir-grok hook status. On-demand only — Grok has no Pi-style
  footer; real-time monitoring uses runir_watch.py in a second terminal pane.
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: "Rúnir memory inspect (last|session|captures|errors|bridge|status)"
---

# /runir — Rúnir Grok observability

On-demand inspector for the runir-grok adapter. **Grok has no Pi-style memory
footer.** Real-time activity requires a second pane running `runir_watch.py`;
this skill is the on-demand slash path.

## Important limits

- Trace/status files do not store prompts, recalled context, headers, or credentials.
- `recall-{sha256(sessionId)}.json` **does retain the latest original prompt** for capture. State files are owner-only (`0600`) but have no automatic TTL; remove stale files according to your local retention policy.
- Trace ring: last 100 events per session under `~/.grok/state/runir/`.
- Filenames use `sha256(sessionId)` digests only (no plaintext session ids on disk).

## How to run

Shell to the plugin inspector (prefer the installed plugin path):

```bash
PLUGIN="${RUNIR_GROK_PLUGIN:-$HOME/Code/runir/plugins/runir-grok}"
python3 "$PLUGIN/scripts/runir_inspect.py" <subcommand> [flags]
```

If this skill was installed from a worktree or non-default checkout, resolve
the same directory that contains `hooks/runir-grok.py` (plugin SoT).

## Subcommands

| Command | Purpose |
|---------|---------|
| `last` | Latest status + last N trace events |
| `session` | Turn-by-turn history grouped by promptId |
| `captures` | Capture markers + capture trace events |
| `errors` | Error events across sessions |
| `bridge` | Managed `<!-- runir-bridge -->` MEMORY.md block |
| `status` | Pretty/raw `status-{digest}.json` |

Common flags: `--latest` (default), `--session ID`, `--digest HEX`, `--limit N`,
`--json`, `--state-dir PATH`, `--memory-root PATH`.

## Default invocation

When the user runs bare `/runir` with no arguments, run:

```bash
PLUGIN="${RUNIR_GROK_PLUGIN:-$HOME/Code/runir/plugins/runir-grok}"
python3 "$PLUGIN/scripts/runir_inspect.py" last --latest
```

If they name a subcommand (`/runir errors`, `/runir bridge`), pass it through.

## Live tail (not this skill)

```bash
python3 "$PLUGIN/scripts/runir_watch.py" --mode watch
# or one-shot:
python3 "$PLUGIN/scripts/runir_watch.py" --mode once
```
