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
- Sourceb-C native tests extend the same fresh owned process for protected fresh and existing-survivor supersedes, strict monotonic unions across incoming/previous/replacement lineage, survivor payload preservation, cycle refusal, full atomic rollback, generic absent-lineage branch assertions, full CAS/collision/revocation races, guarded archive affected-row evidence, and metadata-only outcome evidence including post-commit mismatch. They must use synthetic known ids/text, exercise both real `CREATE ONLY` and update branches through `queryTransaction`, preserve protected rows outside generic lifecycle/search seams, and never infer rollback from an SDK error without bounded readback.
- `minni-summary-contract.test.ts` owns synthetic A1 codec fixtures. It must exercise the real producer-response classifier, optional hash-free OCR projection caps and semantic coverage rules, content-free zero-evidence refusal, separate interval meanings, the canonical seven uncertainty values and conflict propagation, raw-ID/prose shape compatibility, distinct same-set anchors, mandatory OCR uncertainty structure, and closed durable states. These tests use no provider, model, route, database, operator data, or authority seam; arbitrary prose tests remain structural only.
- Sourcec-R1 native read tests use only a fresh owned loopback SurrealDB 3.1.4 MEMORY process through the installed SDK 2.0.3 and actual storage mappers. They cover valid/restricted, absent, malformed/unsupported, payload-spoofed, extra-field, and cross-user rows across list/get/recent/similar, capture-context, latest-state, and continuity projections; an actual query that omits top-level `processing_lineage` proves the shared one-argument mapper stays `unavailable`, while owned selected projections classify observed absence as `legacy_unknown`; generic similarity remains legacy-only. The test must close the SDK and terminate only its owned child and sockets in cleanup, with no operator endpoint or mock fallback.

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
