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

## Close, commit, and synchronize

Close only work that is actually complete:

When a user asks an agent to execute or continue Bead-backed repository work,
that request includes authorization for the ordinary Git commits and branch
push needed to close out the verified in-scope result. Do not interrupt
closeout to ask for separate commit or push permission. This authorization is
strictly scoped: it does not cover unrelated working-tree changes, rebases,
amends, force-pushes, or any other history rewrite.

```bash
git status --short
git diff --check
git add <in-scope-paths>
git diff --cached --check
git commit -m "<repository-style outcome>"
bd update <id> --notes "Outcome, validation, and remaining context"
bd close <id> --reason "Completed outcome and validation"
bd dolt push
git push
git status --short
git rev-list --left-right --count '@{upstream}'...HEAD
bd show <id>
```

Before closing:

1. run proportionate tests, lint, type checks, or builds;
2. create separate Beads for unfinished discoveries;
3. confirm the acceptance criteria are satisfied;
4. inspect the complete diff and exclude unrelated work;
5. commit all in-scope changes in one or more atomic, independently valid
   commits grouped by behavior;
6. record validation, evidence, and commit hashes in the Bead.

A repository closeout is incomplete until all in-scope Git changes are
committed and the current branch is pushed. When the work has an associated
Bead, its updated or closed state must also be pushed to Dolt before closeout.
Do not report completed work while a required commit or push is pending.

After pushing, require concrete evidence: `git status --short` must show no
in-scope changes, `git rev-list --left-right --count '@{upstream}'...HEAD` must
report `0 0`, `bd dolt push` must succeed for associated Beads, and `bd show
<id>` must show the intended local tracker state.

If either push fails, report the exact command and error and leave the work
explicitly incomplete. Never claim remote state is current based only on local
Git or Beads state.
