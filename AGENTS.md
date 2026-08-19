# AGENTS.md — Rúnir (product)

Standalone HTTP memory service. Clients call it; it does not orchestrate agents.

**Plugins:** `plugins/runir-claudecode`, `plugins/runir-codex`, `plugins/runir-pi` (thin HTTP clients).

**Service:** default local dogfood `:7700`; see
[`docs/ops/local-launchd-service.md`](docs/ops/local-launchd-service.md).

## Repository closeout

Completed repository work is not closed out until its in-scope changes are
committed, the current branch is pushed, and any associated Bead is updated,
closed, and synchronized. Do not report completed work with in-scope changes
left uncommitted or unpushed. A user request to execute or continue
Bead-backed repository work authorizes the ordinary commits and branch push
required for that work's verified closeout; do not stop to request separate
commit or push permission. This standing closeout authorization covers only
verified in-scope changes and never authorizes history rewriting, force-pushes,
or unrelated work. Follow
[`docs/agent-guidance/beads-and-dolt.md`](docs/agent-guidance/beads-and-dolt.md)
for the required sequence and verification.

## Generated workspace (`/.styrir/`)

Agents and local automation that create generated reports, benchmark bundles,
pipeline state, build products, logs, caches, or scratch files should read
[`docs/agent-guidance/styrir-workspace.md`](docs/agent-guidance/styrir-workspace.md).
Generated non-source work belongs in the ignored `/.styrir/` workspace; never
force-add it or store secrets there.

## Progressive agent guidance

Keep this always-loaded file short. Do not add large procedural, reference, or
command blocks to `AGENTS.md`. Put detailed topic guidance in
`docs/agent-guidance/<topic>.md`, then add only a short conditional link here.

- Agents that need durable task tracking, dependencies, blockers, project
  memory, or tracker synchronization should read
  [`docs/agent-guidance/beads-and-dolt.md`](docs/agent-guidance/beads-and-dolt.md).
- Agents preparing or consuming a multi-session or agent-to-agent handoff
  should read
  [`docs/agent-guidance/handoffs.md`](docs/agent-guidance/handoffs.md).
- Read-only and isolated subagents should skip both unless their task directly
  needs that guidance.

## Shell and file operations

Agents running shell commands or file operations should read
[`docs/agent-guidance/non-interactive-shell.md`](docs/agent-guidance/non-interactive-shell.md).
Agents that do not use the shell should skip it.
