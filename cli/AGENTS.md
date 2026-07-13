# CLI DOX

## Purpose

The `runir` command-line entrypoint and CLI documentation.

## Ownership

- `index.ts`: CLI command implementation.
- `README.md`: CLI usage notes.

## Local Contracts

- CLI behavior is a user-facing contract; preserve command names, flags, exit behavior, and output shape unless intentionally changing them.
- CLI commands should call the service through documented HTTP/client seams where applicable instead of duplicating service policy.
- Do not read or print secrets except through explicit user-requested credential operations.

## Work Guidance

- Read root `package.json` `bin` and scripts before changing CLI launch behavior.
- Keep CLI docs synchronized with implemented commands.

## Verification

- CLI changes: targeted command smoke plus `npm run typecheck`.
- Docs-only CLI changes: `git diff --check`.

## Child DOX Index

This subtree has no child AGENTS.md files yet.
