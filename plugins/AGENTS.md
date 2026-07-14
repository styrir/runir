# Plugins DOX - Thin Client Integrations

## Purpose

Packaged Rúnir client integrations. Clients invoke the HTTP service and must remain thin.

## Ownership

- `runir-claudecode/`: Claude Code plugin (supported beta/1.0 client). Ships bundled `mcp/runir-mcp.mjs` + `.mcp.json`.
- `runir-codex/`: Codex plugin (supported beta/1.0 client). Ships the same byte-identical `mcp/runir-mcp.mjs` + `.mcp.json`.
- `runir-pi/`: Pi coding-agent extension (`runir-memory.ts` + OM lanes + native `runir_store`). Install via `pi install` path package; not a Claude/Codex marketplace plugin.
- Canonical MCP source: `src/mcp/` (outside `plugins/*`). Emit with `npm run build:runir-mcp` — do not create `plugins/runir-mcp`.

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
- MCP: `npm run build:runir-mcp` then `npx vitest run src/mcp` (store unit + stdio protocol; checksum gate in build).
- MCP installed-style smoke (gate 10): `npm run test:runir-mcp:installed` (stages Claude/Codex plugin copies under temp roots; tools/list + tools/call via bundled mjs only).
