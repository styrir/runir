# Rúnir-7no.2 history and source-anchor audit

## Decision

The five deterministic synthetic histories are **not lossless end to end** in
the current system. Their known facts are representable with existing fields,
but one or more current lifecycle, conflict, identity, or retrieval consumers
lose information in every history. Unknown time, revision, span, validity,
conflict resolution, and identity equivalence remain unknown; none is inferred.

The frozen continuity baseline accepted **1/18** item-class/format cells under
the source-anchor rubric: only an evidence-backed gap in JSON. This is a rubric
result, not a count of visually present fields. The other 17 cells were
rejected because their item source was ambiguous or absent.

No persisted schema change is justified. All **10** candidate fields were
rejected (**0 accepted**). The minimal report change uses the existing
`sourceEvidenceRefs` field as a strict per-item mapping and the existing
sanitized `contentHash` as the generation digest. It adds no parallel graph,
provenance table, store, or report model outside the existing output path.

## Scope and frozen safety rules

- Bead: `Rúnir-7no.2`
- Frozen repository commit: `76de2cd9f78c951311d5f3df8b2e3cffc37afb63`
- Evidence: deterministic synthetic fixtures and source inspection only; no production tenant reads or mutations were authorized.
- History scope was exactly: late historical event, corrected preference, exclusive-fact disagreement, duplicate source-turn import, and false identity candidate.
- Report scope was exactly six item classes (`focus`, `progress`, `next_steps`, `open_loops`, `blockers`, and `gaps`) across Markdown, JSON, and HTML.
- High-impact classes are focus, next steps, open loops, blockers, and gaps. Unsupported or ambiguously supported high-impact items must not render. Progress may render only with a resolved source or an explicit unavailable source state.
- Project-wide evidence is not per-item evidence. No mapping may be guessed from aggregate source references or supporting IDs.
- Ingestion time must not become event time; a CAS version must not become a semantic revision; missing source coordinates or validity bounds must not be backfilled; unresolved conflict must not acquire a winner; and name similarity or an unproved alias must not become identity equivalence.
- This audit authorizes no real-data report activation, collector, scheduler, automatic task materialization, new graph, or new provenance store.

## Five deterministic histories

All names, values, identifiers, and timestamps below are synthetic.

| History | Exact synthetic fact | Current producer and consumer | Required existing fields | Observed lossless verdict | Preserved unknowns |
|---|---|---|---|---|---|
| Late historical event | An event happened at `2024-01-02T00:00:00.000Z` and was ingested at `2026-08-19T15:00:00.000Z`. | Extractor or manual metadata produces `event.happenedAt`; persistence and hybrid recall carry it, while merge, recency, exact-QA, latest-state, overlays, and session openers do not consume it as event time. | `payload.event.happenedAt`, `createdAt`, `updatedAt`, `validAt` | **No.** Create can retain the known event time separately, but merge and temporal consumers are lossy. | Missing event time stays absent; live extractor population and event-time ordering remain unknown. |
| Corrected preference | Editor preference changes from `Vim` to `Helix`. | Capture metadata and write arbitration produce semiote supersession; semiote recall, Noema preference recall, and lineage each consume only part of the correction. | `factKey`, `atomicFact`, `continuitySubjectKey`, `supersedesId`, `supersededById`, `noemaClaimKey`, `noemaRevisionHash` | **No.** Semiote supersession can retain both values and pointers, but authority provenance, Noema revision history, lifecycle synchronization, and recall are not lossless end to end. | Extractor output, feature flags, promotion timing, and unstored semantic revision history remain unknown. |
| Exclusive-fact disagreement | Priya Nair and Marcus Webb are separately asserted as the Atlas on-call lead, with no known winner. | Write arbitration can keep both semiotes under the opt-in keep-both guard; Noema promotion, retrieval policy, continuity synthesis, and latest-state selection consume them with different collapse behavior. | `factKey`, `continuitySubjectKey`, `claimSubject`, `claimPredicate`, `noemaStatus`, `noemaClaimKey`, `noemaRevisionHash`, `supportingSemioteIds` | **No.** Both sources can survive, but promotion and downstream selection can create an order-dependent apparent winner. | No automatic conflict producer or support-ID-to-value/revision mapping is assumed; resolution remains unknown. |
| Duplicate source-turn import | Identical source text is imported twice inside the arbitration window, with a control import after 72 hours. | Capture metadata produces source-shaped spans and normalized text; write arbitration deduplicates by text within time windows, while exact-QA, search mapping, linking, and session-turn storage consume different source fields. | `factKey`, `raw_source_text`, `rawSpan.sourceTurnIndex`, `rawSpan.cursorStart`, `rawSpan.cursorEnd`, `sourceEventId`, `sourceTurnIndex` | **No.** A retry can reuse the first semiote in-window, but dedupe is not source-keyed, skipped coordinates are not backfilled, and a later retry can create another row. | Missing or invalid coordinates remain absent; a skipped retry does not invent or repair them. |
| False identity candidate | Similar unaliased people `Alice` and `Alice Smith` stay separate; a planted exact `alice` alias on `Al` causes the current merge path. | Entity extraction, alias enrichment, repair, and entity arbitration produce normalized names and aliases; capture linking, entity recall, name lookup, consolidation, and repair consume the selected ID. | `canonicalName`, `nameNorm`, `aliases`, `aliasesNorm`, `kind`, `scope`, `userId`, `confidence` | **No.** Similar unproved names remain separate, but an exact alias can merge without authoritative equivalence, and confidence promotion can write a new slug while returning the old ID. | Similarity is not equivalence; ambiguous alias authority and a deterministic winner remain unknown. |

## Frozen 6 x 3 baseline source-anchor audit

The table records rubric acceptance at the frozen commit, before the report change. "Rejected" includes content that was visibly rendered but could not be accepted as independently source-anchored.

| Item class | Markdown | JSON | HTML |
|---|---|---|---|
| Focus | Rejected - ambiguous aggregate evidence | Rejected - ambiguous plain string | Rejected - ambiguous aggregate evidence |
| Progress | Rejected - ambiguous source | Rejected - ambiguous source | Rejected - absent |
| Next steps | Rejected - ambiguous aggregate evidence | Rejected - ambiguous plain string | Rejected - ambiguous aggregate evidence |
| Open loops | Rejected - ambiguous aggregate evidence | Rejected - ambiguous plain string | Rejected - ambiguous aggregate evidence |
| Blockers | Rejected - absent | Rejected - ambiguous plain string | Rejected - absent |
| Gaps | Rejected - source ID omitted | **Rendered - resolved evidence source** | Rejected - source ID omitted |

Baseline result: **1/18 rendered and source-resolved; 17/18 rejected**. JSON preserved workspace/project scope and gap source IDs, but state items remained plain strings. Human-readable formats omitted workspace scope and generation hashes. Progress was absent from HTML, blockers were absent from Markdown and HTML, and pending HTML stripped gap evidence and dates.

## Field-necessity outcome

The gate evaluated 10 candidate additions and accepted none:

| Candidate | Outcome |
|---|---|
| `eventOccurredAt` | Rejected; existing optional `event.happenedAt` represents known event time. |
| `revision` | Rejected; existing claim/revision hashes and semiote lineage are the minimal retained identity, and CAS version cannot be relabeled. |
| `validFrom` / `validTo` | Rejected; existing optional `validAt` / `invalidAt` represent authoritative known bounds. |
| `conflictResolution` | Rejected; existing conflicted status plus separate semiotes represents no-known-winner without manufacturing resolution. |
| `sourceTurnId` / `sourceSpan` | Rejected; existing event, turn, cursor, raw-span, and session-turn fields represent known coordinates. |
| `identityEquivalentTo` | Rejected; no authoritative equivalence producer exists, and uncertainty requires separation rather than a new edge. |
| `itemSourceAnchors` | Rejected as a new field; strict item-class/index mapping fits existing `sourceEvidenceRefs`. |
| `sourceUnavailable` | Rejected as a new field; `sourceState="unavailable"` fits the existing evidence mapping. |
| `derivationVersion` | Rejected; no current producer/consumer contract or deterministic failing runtime fixture establishes a persisted field. |
| `generationDigest` | Rejected; existing sanitized `contentHash` already supplies deterministic report change detection. |

Result: **10 candidates, 0 accepted, no persisted schema change**. Existing optional fields are populated only when known; legacy absence remains unknown.

## Minimal implementation shipped in the current change

The implementation is confined to the existing continuity report path:

1. `sourceEvidenceRefs` now has a strict consumer mapping by exact `itemClass` and non-negative `itemIndex`. Exactly one matching entry is required. A resolved state item additionally requires an allowlisted source type, a non-empty source ID, and independent backing by the state's aggregate producer provenance or `supportingSemioteIds`. Item mappings cannot back one another, and raw IDs are compared before publication sanitization.
2. `sourceState="unavailable"` is accepted only for descriptive progress and only without source coordinates. Missing, duplicate, malformed, ambiguous, unbacked, or self-backed mappings reject the item.
3. Unanchored high-impact state items are rejected. Gap items require at least one runtime-validated allowlisted evidence reference, invalid mixed evidence is removed, and stale gaps are rejected while gap evaluation is pending.
4. Every accepted item emits an evidence record with item class, rendered index, original source index, text, source state and collision-resistant source-ID digests, sanitized user/workspace/project scope, known time, conflict/staleness, derivation version, and generation digest. Raw source IDs are never published. Unknown optional metadata is emitted honestly as `null`, not inferred.
5. The generation digest is the existing sanitized project `contentHash`. Markdown, JSON, and HTML all expose equivalent accepted-item evidence metadata; Markdown and HTML explicitly label unavailable progress sources.
6. The implementation adds no persisted field and no parallel claim/source graph, provenance table, store, scheduler, or report pipeline.

The current continuity builder still emits aggregate evidence only, so it does
not authorize any state-list item under this stricter contract. Those
unsupported high-impact items therefore fail closed. The post-change accepted
path is a deterministic synthetic contract test, not production activation and
not a claim that the frozen **1/18** baseline had per-item mappings.

## Fixture and validation evidence available so far

The current change includes deterministic fixtures at the consuming seams:

- event persistence keeps known historical `happenedAt` distinct from ingestion/validity time and leaves unknown event time absent;
- corrected preference supersession retains old and new atomic values;
- exclusive disagreement keeps two semiotes under the explicit guard, and a conflicted Noema is not surfaced as an active answer;
- duplicate import skips an identical in-window write without backfilling later coordinates, while the post-window control can create;
- similar unaliased people remain separate, while the exact-alias control records the current merge behavior;
- one continuity fixture supplies all six item classes, checks accepted and rejected sentinels across Markdown, JSON, and HTML, verifies explicit unavailable progress, and checks eight JSON item-evidence records for safe scope, source state, known time, conflict/staleness, derivation version, and a digest equal to project `contentHash`.

Recorded validation to this point:

- focused deterministic fixtures: 5 files, 80 tests passed;
- full TypeScript typecheck: passed;
- changed production-source ESLint: passed;
- changed-file language-server diagnostics: clean;
- `git diff --check`: passed;
- manual synthetic Markdown, JSON, and HTML inspection: accepted classes and
  evidence metadata were present, rejected sentinels were absent, source
  prefixes were not duplicated, active Markdown/HTML payloads were escaped,
  and common quoted/unquoted credentials, provider keys, private-key blocks,
  and Unix/Windows/relative private paths were sanitized;
- repository test run: 3,068 tests passed; the sole deterministic failure is
  the pre-existing tracked Rúnir-7no.1 `docs/analysis` artifact violating the
  repository artifact-boundary test;
- repository-wide lint remains blocked by pre-existing generated/bundled-file
  errors outside this diff.

Independent five-lane review iterations found and drove fixes for
source backing, runtime evidence validation, rendered/source index separation,
unavailable-source coordinates, hostile Markdown, and broader privacy
sanitization, including sanitization-before-Markdown-escaping and malformed
coordinate handling. The final renderer sanitizes field values before syntax,
serializes JSON structurally, and never performs a post-serialization scrub.
The final five-lane seal gate passed unanimously for acceptance, code
correctness, privacy/security, hands-on behavior, and repository closeout.
The private checksum manifest was sealed and verified over the final audit,
source, fixture, and publication bytes. Staged publication validation,
Git/Beads synchronization, and closeout remain.

No raw prompts, production record identifiers, source excerpts, private artifact locations, secrets, or tenant payloads are included in this tracked record.
