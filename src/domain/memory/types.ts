// Barrel re-export for the memory-domain types.
//
// Historically this file held all 60+ memory-domain types in one 785-LOC
// barrel. WS-0 / Rúnir-yod0.1.4 (arch1.01.6) split it into five cohesive
// modules (boundary / payload / retrieval / lifecycle / prompts). This file
// preserves the legacy import path `src/domain/memory/types` for every
// existing caller — no project-wide import edits required.
//
// New code should generally import from the specific module that owns the
// symbol; the barrel remains a stable, backwards-compatible entry point.

// `boundary-hash` symbols (CanonicalField, boundaryHash) are re-exported
// transitively via `boundary.js`; no separate barrel line is needed.
export * from "./boundary.js";
export * from "./payload.js";
export * from "./retrieval.js";
export * from "./lifecycle.js";
export * from "./prompts.js";
export * from "./exact-qa.js";
