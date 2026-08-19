# Handoffs

Load this document when preparing or consuming work that crosses conversations,
sessions, agents, or operators. Skip it for isolated subtasks that return their
result immediately to a coordinating agent.

## Goal

A handoff must let the next agent resume safely without replaying the entire
conversation or mistaking a proposal for implemented state.

Keep the handoff concise, evidence-grounded, and scoped to the active work.
Large raw outputs belong under `/.styrir/`; the handoff should link to them
rather than copying them into tracked guidance.

## Required content

Record:

- the intended outcome and current status;
- what is implemented, what is only proposed, and what remains unverified;
- changed files or relevant symbols;
- validation commands and their results;
- preserved evidence paths under `/.styrir/`;
- unresolved findings, blockers, dependencies, and risks;
- external state that must be rechecked;
- the safest concrete next action.

Do not claim completion from monitor activity, a plan, an unreviewed diff, or
an external action that was not verified.

## Where to record it

For work with a durable tracker item, record the resumable summary in that
item according to [`beads-and-dolt.md`](beads-and-dolt.md).

Use a tracked handoff document only when the handoff itself is a maintained
project artifact. Do not create ad hoc Markdown handoff files as a parallel
task tracker.

Use `/.styrir/runs/<run-id>/` for self-contained execution evidence and
`/.styrir/analysis/` for generated analysis. Never store credentials or secret
values in handoff evidence.

## Incomplete work

An incomplete handoff should state:

1. the last known-good checkpoint;
2. the exact blocker or stopping condition;
3. attempts already made and their outcomes;
4. preserved local or remote state;
5. what authority or input is still required;
6. the next safe command or inspection.

Do not close unfinished work merely to simplify the handoff.

## Completed work

A completed handoff should state:

1. the delivered behavior or decision;
2. validation and review results;
3. remaining limitations or separately tracked follow-up;
4. the in-scope commit hashes;
5. the exact Git publication verification command and result;
6. verified Beads/Dolt publication state when the work has an associated Bead.

Completed repository work must not be handed off with an in-scope commit or
push still pending. If publication is incomplete, treat the handoff as
incomplete and record the exact blocker and next safe action instead.

The final summary must stand on its own without requiring access to collapsed
commentary or hidden agent context.
