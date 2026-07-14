# Plugins DOX - Thin Client Integrations

## Purpose

Packaged Rúnir client integrations. Clients invoke the HTTP service and must remain thin.

## Ownership

- `runir-claudecode/`: Claude Code plugin (supported beta/1.0 client).
- `runir-codex/`: Codex plugin (supported beta/1.0 client).
- `runir-pi/`: Pi coding-agent extension (`runir-memory.ts` + OM lanes). Install via `pi install` path package; not a Claude/Codex marketplace plugin.

## Local Contracts

- Do not move retrieval, capture, ranking, or orchestration intelligence into plugins.
- Plugin behavior must stay aligned with the service HTTP contract and hook lifecycle semantics.
- Keep clients thin HTTP/lifecycle adapters only.

## Work Guidance

- Pi package: edit `plugins/runir-pi`, then `/reload` in Pi (or reinstall path package).
- Claude/Codex: follow existing hook-contract and marketplace refresh steps.

## Verification

- Claude: `npm run test:hooks:contract:local` when available.
- Codex: `npm run test:hooks:contract:codex:local` when available.
- Pi: `plugins/runir-pi/test/run.sh` (stub harness incl. store unit gates; no live service required). Live explicit-remember smoke: `plugins/runir-pi/test/store-live-smoke.mjs` (needs service + env).
