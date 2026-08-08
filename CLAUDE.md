# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first.** Product boundaries, plugins, generated
workspace rules, and conditional guidance links live there.

Anthropic Claude Code looks for `CLAUDE.md`; this project uses `AGENTS.md` as the operational source of truth.

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
  durable planning guidance linked from `AGENTS.md` for project work, and do
  not add `.styrir.toml` until a validating consumer exists.
- Put reusable machine-wide state and large shared caches in the
  platform-appropriate user directories, not in a checkout cache.

See [`docs/styrir-workspace-layout.md`](docs/styrir-workspace-layout.md) for
the complete repository, platform-storage, promotion, safety, and retention
contract.
