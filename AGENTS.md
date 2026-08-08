# AGENTS.md — Rúnir (product)

Standalone HTTP memory service. Clients call it; it does not orchestrate agents.

**Plugins:** `plugins/runir-claudecode`, `plugins/runir-codex`, `plugins/runir-pi` (thin HTTP clients).

**Service:** default local dogfood `:7700`; see
[`docs/ops/local-launchd-service.md`](docs/ops/local-launchd-service.md).

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
