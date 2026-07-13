# Capture DOX - Extraction And Continuity Writes

## Purpose

Capture-side memory ingestion: prompt/context assembly, LLM extraction and segmentation, salience/continuity compression, enrichment, and project-state warming.

## Ownership

- `extraction/capture.ts`: extract facts and route them through write arbitration.
- `continuity/**`: session salience, project-state warming, session diff/compression, continuity prototypes.
- `enrichment/`: memory enrichment and metadata shaping.
- `capture-context-assembler.ts`: request context assembly for capture calls.

## Local Contracts

- Capture creates independently true facts; avoid compounded multi-fact units when extraction granularity matters.
- All durable memory writes must pass through write arbitration; do not bypass `src/storage/writes/write-arbitrator.ts`.
- Preserve raw evidence/spans where existing contracts expect them; do not prettify raw system/model outputs in test artifacts.
- Capture can skip quietly for no messages, no API key, or no extractable facts; extractable errors should not crash the agent turn.
- Service intelligence stays here/in service modules, never in client plugins.

## Work Guidance

- Read `docs/agent-guidance/architecture-canon.md` §3 before changing capture/write flow.
- Read `docs/agent-guidance/storage-retrieval.md` before changing write arbitration or storage-side ingestion expectations.
- Check neighboring extraction tests before changing prompt shape, JSON parsing, thresholds, or salience behavior.

## Verification

- Focused capture changes: run relevant `capture`, `session-capture`, `salience`, or `write-arbitrator` tests.
- Any `src/` capture change followed by live `/hooks/capture` probe requires hard service restart first.
- Broad capture behavior changes should include `npm run typecheck` and targeted Vitest coverage.

## Child DOX Index

This subtree has no child AGENTS.md files yet.
