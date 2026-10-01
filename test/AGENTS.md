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
- `minni-summary-contract.test.ts` owns synthetic A1 codec fixtures. It must exercise the real producer-response classifier, optional hash-free OCR projection caps and semantic coverage rules, content-free zero-evidence refusal, exact fractional/offset timestamp ordering and reversed intervals, all-evidence top-level interval derivation and stale-extent refusal, exact claim-support extent including uncited spoof refusal and equivalent-instant support-order ties, separate interval meanings, the canonical seven uncertainty values and conflict propagation, raw-ID/prose shape compatibility, distinct same-set anchors, mandatory OCR uncertainty structure, and closed durable states. These tests use no provider, model, route, database, operator data, or authority seam; arbitrary prose tests remain structural only.
- `minni-summary-builder.test.ts` owns synthetic A2 evidence-builder fixtures. It must exercise the real all-input lineage join (including uncited restrictions), content-free legacy/invalid/mismatched lineage refusal, exact all-input and support-only interval derivation, shared timestamp precision/offset handling, exact zero-evidence precedence before transient fields, unconditional base OCR uncertainty, delta and anchor handling, explicit claim states/scopes, symmetric conflict propagation, and mutation isolation. These tests use no provider, model, route, database, operator data, or authority seam; prose remains hand-labeled structure rather than inferred meaning.
- `minni-summary-goldens.test.ts` and `fixtures/minni-summary-contract/v1.json` own exactly 15 synthetic, hand-labeled B cases. The evaluator must invoke the real A1 classifier, A2 builder, and strict serializer, then exact-compare static structured contracts or content-free refusals. It must keep expected structures independent of the implementation and use no keyword, regular-expression, prose, model, provider, route, database, operator data, or authority seam to infer meaning; forbidden fields and closed states are structural assertions only.

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
