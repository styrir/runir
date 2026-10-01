# Processing Policy DOX - Internal Producer Authority

## Purpose

The internal authority boundary for the Minni processing lane. It binds a
server-authenticated producer principal, server-selected operation, and
server-resolved target user to a local-only processing context.

## Ownership

- `authority.ts` owns opaque producer principal, registration, operation, target-user, and processing-context values. Minted identities are private `WeakMap` values; context use revalidates the current internal registry.
- The module owns the default-empty production registry and content-free refusal result/error contracts.
- Runtime consumers validate an authority-produced context before provider egress; storage lineage and lifecycle enforcement belong to later Rúnir-4nb.2 children.

## Local Contracts

- Request body `userId`, `client`, source/origin, policy, locality, tier, and operation labels are never producer authority.
- The general service bearer cannot select the protected Minni lane.
- Producer authority is distinct from future consumer authorization and grants no provider/client delivery permission.
- The production registry is empty. Synthetic registrations are test-only inputs and do not provision credentials or runtime grants.
- Any registration revocation/removal mechanism is server-internal only and is not a credential, public route, token store, or active production grant.
- Generic routes continue to omit the optional context and preserve their current behavior.

## Work Guidance

Resolve a context only after server authentication and target-user binding, then pass it to the runtime pre-egress fence. Do not add public endpoints, payload fields, token stores, credential wiring, model/runtime selection, storage schema, or lifecycle mutation here.

## Verification

Run the focused authority/runtime admission tests, `npm run typecheck`, and the focused existing generic route compatibility test. Refusal tests must prove the protected callback is never invoked and expose only content-free reason codes.

## Child DOX Index

This subtree has no child AGENTS.md files.
