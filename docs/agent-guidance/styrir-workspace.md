# Styrir workspace layout

Styrir-generated work does not belong in a repository's source or
documentation trees by default. Repositories use one ignored local workspace,
`/.styrir/`, while machine-wide configuration, reusable state, and caches use
platform-appropriate user directories.

This convention separates three different things:

1. tracked product contracts and curated documentation;
2. ignored, checkout-specific runs and review artifacts;
3. user-scoped configuration, durable state, and reproducible caches.

## Repository contract

Every participating repository should commit these root ignore rules:

```gitignore
/.styrir/
/docs/analysis/
```

The second rule is a legacy guard. New tools must write generated analysis
under `.styrir`, not `docs`.

Git's official documentation distinguishes shared `.gitignore` rules from
private `.git/info/exclude` and user-global ignore rules. It also states that
ignore patterns do not affect already tracked files. A migration therefore
needs both the shared rule and explicit removal of old generated files from
the index:

- [Git ignore documentation](https://git-scm.com/docs/gitignore)

An optional global Git ignore for `.styrir/` is useful defense in depth, but it
does not replace the repository rule because it does not travel with clones.

## Local workspace

Use one root with subdirectories organized by artifact lifecycle, not by model
vendor or agent:

```text
.styrir/
├── runs/
│   └── <run-id>/
│       ├── request.json
│       ├── manifest.json
│       ├── inputs/
│       ├── outputs/
│       ├── evidence/
│       └── review/
├── analysis/
│   ├── raw/
│   └── reports/
├── pipelines/
├── build/
├── cache/
├── logs/
└── tmp/
```

The self-contained `runs/<run-id>` envelope is the target contract for new
Styrir workflows. Existing Rúnir benchmark tools currently use
`.styrir/analysis/raw` for JSONL and manifests and
`.styrir/analysis/reports` for derived Markdown. Review Studio reads the raw
root and does not initiate runs.

`pipelines/<lane>` holds local execution plans, state, and handoffs.
`build/` holds agent-created build or packaging products that do not belong in
an established product build root. `cache/` is only for small,
checkout-specific disposable caches; reusable or large caches belong in the
platform user cache described below.

The directory is ignored in its entirety. Do not put a tracked file inside it
with a Git negation rule; that makes the boundary hard to audit.

## Tracked project configuration

If multiple repositories eventually need a shared, reviewable Styrir contract,
reserve a root `.styrir.toml` file for it. That file would contain only
declarative inputs such as schema version, enabled lanes, retention policy,
redaction policy, and output-root overrides.

Do not add `.styrir.toml` until a Styrir tool validates and consumes it. The
runtime directory and tracked contract should remain separate, following the
same broad pattern as Terraform's ignored generated state and committed
dependency lock contract:

- [Terraform version-control guidance](https://developer.hashicorp.com/terraform/language/style)
- [Terraform dependency lock file](https://developer.hashicorp.com/terraform/language/files/dependency-lock)

## User-scoped storage

The storage classes are stable even though their physical paths vary by
platform:

| Class | Contents | Linux / XDG default | macOS native default |
|---|---|---|---|
| configuration | operator settings and provider metadata without secrets | `$XDG_CONFIG_HOME/styrir` | `~/Library/Application Support/Styrir/config` |
| durable data | templates, schemas, reusable indexes | `$XDG_DATA_HOME/styrir` | `~/Library/Application Support/Styrir/data` |
| state | run index, history, UI state | `$XDG_STATE_HOME/styrir` | `~/Library/Application Support/Styrir/state` |
| cache | downloaded or reproducible artifacts | `$XDG_CACHE_HOME/styrir` | `~/Library/Caches/Styrir` |
| runtime | sockets and short-lived coordination files | `$XDG_RUNTIME_DIR/styrir` | the platform temporary directory |

On macOS, a CLI may honor explicitly configured XDG variables, while a native
application should resolve Apple's standard Library locations. Runtime storage
must not hold large reports or evidence bundles.

Primary references:

- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)
- [Apple File System Programming Guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html)

Large shared stores should key repository-specific state by a stable repository
identity, such as a hash of canonical repository root plus remote identity, to
avoid collisions between checkouts.

## Promotion boundary

Generated output stays ignored until a human deliberately promotes it:

- reusable deterministic examples become compact test fixtures;
- reviewed architectural conclusions become ADRs or maintained guides;
- release evidence becomes a concise release record;
- raw model output, logs, manifests, and transient reports remain in
  `.styrir/`.

Promotion should copy or rewrite the smallest durable artifact. It should never
change a runner's default output to `docs/`.

## Safety and retention

An ignore rule is not access control. Git can force-add ignored files, and
other packaging tools may not consult `.gitignore`. Product repositories
should therefore:

- deny `.styrir` in release and export tooling;
- fail CI if `.styrir/` or the legacy `docs/analysis/` becomes tracked;
- record source SHA, timestamps, schema versions, and redaction state in run
  manifests;
- use bounded retention for caches, logs, and old runs;
- never store credentials in a run directory.

Established tools support the same separation in different forms: CMake
recommends out-of-source builds, Bazel uses a user output root keyed by
workspace, Cargo supports configurable output directories, and Gradle applies
retention to project and user caches.

- [CMake out-of-source builds](https://cmake.org/cmake/help/latest/guide/user-interaction/index.html)
- [Bazel output directory layout](https://docs.bazel.build/versions/main/output_directories.html)
- [Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html)
- [Gradle-managed directories and caches](https://docs.gradle.org/current/userguide/directory_layout.html)

## Rúnir migration

Rúnir's benchmark defaults now write beneath `.styrir/analysis`. The former
tracked `docs/analysis` bundles were generated run products, so they are
removed from the repository and protected by a legacy ignore rule. The
converting checkout preserves a local ignored copy under
`.styrir/analysis/migrated-docs-analysis-2026-08-07`; other clones can recover
historical bytes from Git history when necessary.

Curated benchmark decisions and operating instructions remain in
[`model-benchmark-guide.md`](../model-benchmark-guide.md). Tests use constructed,
purpose-specific compatibility inputs instead of loading a paid-run artifact.
