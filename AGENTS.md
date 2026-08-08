# AGENTS.md — Rúnir (product)

Standalone HTTP memory service. Clients call it; it does not orchestrate agents.

**Plugins:** `plugins/runir-claudecode`, `plugins/runir-codex`, `plugins/runir-pi` (thin HTTP clients).

**Service:** default local dogfood `:7700`; see
[`docs/ops/local-launchd-service.md`](docs/ops/local-launchd-service.md).

## Generated workspace (`/.styrir/`)

All agents and local automation **MUST** route generated, non-source work into
the ignored repository-local `/.styrir/` workspace. Do not create generated
reports, benchmark bundles, pipeline state, build products, logs, or scratch
files in tracked source or documentation trees.

Use these canonical lifecycle-oriented paths:

```text
.styrir/
├── runs/<run-id>/          # request, manifest, inputs, outputs, evidence, review
├── analysis/
│   ├── raw/                # JSONL and machine-readable evidence
│   └── reports/            # generated Markdown/HTML/PDF review artifacts
├── pipelines/<lane>/       # local pipeline plans, state, and handoffs
├── build/                  # agent-created build and packaging output
├── cache/                  # disposable checkout-specific cache only
├── logs/                   # local execution logs
└── tmp/                    # disposable intermediate work
```

Rules:

- Benchmark output is analysis output: use `.styrir/analysis/raw` and
  `.styrir/analysis/reports`.
- A self-contained execution should use `.styrir/runs/<run-id>` and record its
  source SHA, schema/version, timestamps, and redaction state in a manifest.
- Override tools whose defaults would write generated material elsewhere.
  Existing product build systems may retain an established ignored output root
  such as `dist/`; new agent-created build output belongs in `.styrir/build`.
- Never force-add `/.styrir/` content to Git. Promotion into a tracked fixture,
  ADR, maintained guide, or release record must be a deliberate human-reviewed
  copy or rewrite of the smallest durable artifact.
- Never store credentials or secret values in `/.styrir/`.
- `/.styrir/` is not durable task tracking or tracked configuration. Use the
  durable planning workflow below for project work, and do not add
  `.styrir.toml` until a validating consumer exists.
- Put reusable machine-wide state and large shared caches in the
  platform-appropriate user directories, not in a checkout cache.

See [`docs/styrir-workspace-layout.md`](docs/styrir-workspace-layout.md) for
the complete repository, platform-storage, promotion, safety, and retention
contract.

## Planning and handoffs

Only agents that need durable task tracking, dependencies, blockers,
multi-session continuity, or a shared handoff should read
[`docs/agent-guidance/planning-beads-and-handoffs.md`](docs/agent-guidance/planning-beads-and-handoffs.md).
Read-only and isolated subagents that do not need those capabilities should
skip it.

<!-- bd-doctor-divergence: ok -->

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var
