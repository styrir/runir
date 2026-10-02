# Tests DOX - Test Suites And Fixtures

## Purpose

Primary Vitest and Python tests plus local fixtures for service behavior, hooks, plugins, schemas, storage, recall, capture, and harness helpers.

## Ownership

- Root `*.test.ts`: service, plugin, route, schema, hook, capture, recall, and storage tests.
- `integration/`: integration tests that may require external/local dependencies.
- `fixtures/`: test-only transcript/event/scenario fixtures.
- `helpers/`: shared test helpers.

## Local Contracts

- Tests should exercise behavior through the same surface clients use when the user asks for integration evidence.
- Raw integration artifacts must preserve exactly what the system produces; do not add presentation wrappers.
- Do not mark dependency tests as skipped simply because Docker/Ollama/service is down; start required services or report a real startup blocker.
- Mock only mapping/hydration or controlled unit seams; DB/service behavior belongs in the service.
- Sourcea lineage native tests may start only an owned loopback ephemeral Surreal memory process with synthetic data, must exercise actual schema/parser/wrapper behavior, and must terminate the process in cleanup. They are opt-in and must not fall back to an operator endpoint.
- Sourcea delivery positives must use the fixed source-owned synthetic resolver; request-shaped flags, copied evidence, and serialized evidence are refusal fixtures. Backlog schema tests must call `ensureStalenessBacklogTable` itself for absent, idempotent, partial, incompatible, and extra hierarchy cases.
- Sourceb-A native writer tests use only synthetic ids/text and a fresh owned loopback Surreal 3.1.4 MEMORY process through the installed SDK. They must exercise the real authority mint, protected `CREATE ONLY` writer, generic absent/valid/invalid-present lineage behavior, collisions, concurrent same-id creation, and transaction rollback, then close the SDK and terminate the owned PID in cleanup. They must never use the operator/default database or silently fall back to a mock for native proof.
- Sourceb-B native tests extend that same owned process contract for exact-mint known-id merges and generic containment: strict stored-lineage joins, rich-payload preservation, full user/lineage/delete CAS races, precommit rollback, candidate exclusion before mapping, and absent-lineage update compatibility. They must keep preflight SELECTs lineage-only, use no protected text in heuristic/provider seams, and remove any test-only schema constraint before later generic cases.
- Sourcec-N1 unit tests cover stable-id-only Noema admission: invalid/missing ids refuse before DB access; caller payload/getter traps are untouched; metadata-only valid/invalid lineage refuses before content/provider/write; absent-lineage content comes from an exact guarded read; caller conflicts are ignored; metadata-to-content races refuse; and consolidation/feedback callers pass ids only. The environment/default-endpoint `noema-promotion-embedding.test.ts` remains byte-identical and excluded from proof.
- The safe generic-supersede fixture in `src/__tests__/supersede-transaction.test.ts` must always use a fresh owned loopback SurrealDB 3.1.4 MEMORY process through the resolved SDK 2.0.3 client, with exact CLI token parsing, no `SURREAL_*`/dotenv/default-endpoint factory reads, a six-key process-scoped sentinel (URL/user/password/namespace/database aliases), no pre-existing table/database removal, and bounded SDK/PID/socket/sentinel cleanup in finally paths. Its four actual cases cover fresh/existing commit and rollback with normalized exact links and absence assertions; negative seams cover hanging/rejected close and wrong CLI tokens. The historical unsafe default-endpoint fixture remains outside this contract.
- Sourceb-C native tests extend the same fresh owned process for protected fresh and existing-survivor supersedes, strict monotonic unions across incoming/previous/replacement lineage, survivor payload preservation, cycle refusal, full atomic rollback, generic absent-lineage branch assertions, full CAS/collision/revocation races, guarded archive affected-row evidence, and metadata-only outcome evidence including post-commit mismatch. They must use synthetic known ids/text, exercise both real `CREATE ONLY` and update branches through `queryTransaction`, preserve protected rows outside generic lifecycle/search seams, and never infer rollback from an SDK error without bounded readback.
- `minni-summary-contract.test.ts` owns synthetic A1 codec fixtures. It must exercise the real producer-response classifier, optional hash-free OCR projection caps and semantic coverage rules, content-free zero-evidence refusal, exact fractional/offset timestamp ordering and reversed intervals, all-evidence top-level interval derivation and stale-extent refusal, exact claim-support extent including uncited spoof refusal and equivalent-instant support-order ties, separate interval meanings, the canonical seven uncertainty values and conflict propagation, raw-ID/prose shape compatibility, distinct same-set anchors, mandatory OCR uncertainty structure, and closed durable states. These tests use no provider, model, route, database, operator data, or authority seam; arbitrary prose tests remain structural only.
- `minni-summary-builder.test.ts` owns synthetic A2 evidence-builder fixtures. It must exercise the real all-input lineage join (including uncited restrictions), content-free legacy/invalid/mismatched lineage refusal, exact all-input and support-only interval derivation, shared timestamp precision/offset handling, exact zero-evidence precedence before transient fields, unconditional base OCR uncertainty, delta and anchor handling, explicit claim states/scopes, symmetric conflict propagation, and mutation isolation. These tests use no provider, model, route, database, operator data, or authority seam; prose remains hand-labeled structure rather than inferred meaning.
- `minni-summary-goldens.test.ts` and `fixtures/minni-summary-contract/v1.json` own exactly 15 synthetic, hand-labeled B cases. The evaluator must invoke the real A1 classifier, A2 builder, and strict serializer, then exact-compare static structured contracts or content-free refusals. It must keep expected structures independent of the implementation and use no keyword, regular-expression, prose, model, provider, route, database, operator data, or authority seam to infer meaning; forbidden fields and closed states are structural assertions only.
- Sourcec-R1 native read tests use only a fresh owned loopback SurrealDB 3.1.4 MEMORY process through the installed SDK 2.0.3 and actual storage mappers. They cover valid/restricted, absent, malformed/unsupported, payload-spoofed, extra-field, and cross-user rows across list/get/recent/similar, capture-context, latest-state, and continuity projections; an actual query that omits top-level `processing_lineage` proves the shared one-argument mapper stays `unavailable`, while owned selected projections classify observed absence as `legacy_unknown`; generic similarity remains legacy-only. The test must close the SDK and terminate only its owned child and sockets in cleanup, with no operator endpoint or mock fallback.
- H1 generic supersede preparation tests use the real exported preparation/composer and legacy API. Unit coverage proves private-token identity, copied inputs, exact DB/table/user context, descriptor-checked plan collections, strict scalar rejection, metadata-first active/inactive/link/root/scope/session/provenance/stale/bookkeeping/version eligibility, constrained plain full-row witness handling, all-plan initial guards before effects, row-disjoint namespacing, overlap refusal, one-transaction compatibility, direct foreign-loader refusal, JSON/CBOR and mutation isolation, descriptor-only arrays/plain/null-prototype metadata, holes/shared references, and getter/iterator/cycle/unknown-prototype/spoof refusal. The native fixture uses only a fresh owned SurrealDB 3.1.4 MEMORY process through SDK 2.0.3, `ensurePhase2Schema(768)` plus enrichment and the test-only post-COMMIT `queryTransaction` wrapper, synthetic rows, fresh and existing-survivor branches with stored `RecordId`/`Uuid`/`DateTime` values preserved server-side, wrong-user/lineage and eligibility-race refusal, complete-row body/extra-field and one-nanosecond CAS refusal, every fresh/existing/batch failure boundary with full `SELECT *` readback, committed-versus-rolled-back post-COMMIT wrapper evidence, two-plan commit and rollback boundaries, six-key endpoint sentinel, exact version assertions, and bounded rejected/hanging SDK close plus owned PID/socket cleanup. Production batches use one server timestamp per transaction; mock timestamp and legacy variable aliases are compatibility-only. H1 does not claim H2 shared replacement behavior.

## Work Guidance

- Read root AGENTS.md `Test Dependencies` before integration tests.
- Read `docs/agent-guidance/verification-and-release.md` before deciding quality gates.
- Keep fixtures minimal and explicit about the contract they lock.

## Verification

- Run the specific test file(s) changed.
- For broad test infrastructure changes, run `npm run test:ci` or `npm run check` when warranted.
- Schema fixture changes may require `npm run test:schema:events`.
- `test/**` is lint-covered (Rúnir-u2we removed it from the eslint ignore list); `npm run lint` must stay clean here. `src/__tests__/**` remains eslint-ignored.

## Child DOX Index

This subtree has no child AGENTS.md files yet.
