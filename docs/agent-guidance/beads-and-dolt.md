# Beads and Dolt

Load this document only when work needs durable task tracking, dependencies,
blockers, shared project memory, ownership, completion state, or tracker
synchronization.

Do not load it for a read-only investigation, a self-contained explanation, or
an isolated subtask whose result returns immediately to a coordinating agent.

## Repository tracker

Rúnir product work uses Beads (`bd`) with:

- database: `runir_product`;
- issue prefix: `Rúnir-`;
- source of truth: the Beads/Dolt database resolved by this checkout.

Confirm the resolved workspace before changing tracker state:

```bash
bd prime
bd where
```

Do not edit `.beads/` directly. `.beads/issues.jsonl` is a passive export, not
the writable source of truth. Do not target another repository or database for
Rúnir product work.

## What belongs in Beads

Use Beads for:

- implementation work that must survive the current conversation;
- dependencies, blockers, ownership, and priority;
- follow-up work discovered outside the active scope;
- decisions or evidence another agent must be able to recover;
- completion state and closeout notes.

Do not use Markdown TODO files as a parallel project tracker. A short local
execution checklist is fine when it is only for the current turn. Generated
evidence and scratch artifacts belong under `/.styrir/`, not in Beads or
tracked documentation.

Use `bd remember` for durable project knowledge that is not itself a task.

## Start and claim work

Orient before creating or claiming:

```bash
bd ready
bd list --status=open
bd list --status=in_progress
bd show <id>
```

Create one Bead per coherent task:

```bash
bd create \
  --title "Short outcome" \
  --description "Why this work exists and what is in scope" \
  --acceptance "Observable completion criteria" \
  --type task \
  --priority 2
```

Claim it atomically before implementation:

```bash
bd update <id> --claim
```

Prefer `--json` when a command's output will be parsed. Do not use `bd edit`;
it opens an interactive editor.

## Dependencies and follow-up work

Represent ordering explicitly:

```bash
bd dep add <issue> <depends-on>
bd blocked
```

When implementation reveals unrelated work, create a separate Bead with enough
context to resume it. Do not silently expand the current task, bury the
discovery in prose, or close follow-up work that was not completed.

For the content and evidence required when another agent must resume work, use
[`handoffs.md`](handoffs.md).

## Close and synchronize

Close only work that is actually complete:

```bash
bd update <id> --notes "Outcome, validation, and remaining context"
bd close <id> --reason "Completed outcome and validation"
bd dolt push
```

Before closing:

1. run proportionate tests, lint, type checks, or builds;
2. create separate Beads for unfinished discoveries;
3. record validation and evidence;
4. confirm the acceptance criteria are satisfied.

Push Beads/Dolt state unless the user forbids remote tracker mutation. If
tracker sync fails, report the exact command and error. Do not claim remote
tracker state is current when only local Beads state changed.

Beads sync and Git publication are separate. Closing or synchronizing a Bead
does not grant permission to commit, rewrite, or push Git history. Git actions
follow the current user, repository, and orchestrator instructions.
