# Consumer Policy DOX

## Purpose

Internal consumer authority and pure delivery decisions for persisted Minni
lineage. This boundary prepares a later consumer integration without enabling
active filtering, provider calls, remote Rúnir processing, or a public route.

## Ownership

- `authority.ts` owns opaque server-authenticated consumer identities, the
  empty production registry, current registration checks, and content-free
  refusal results.
- `delivery.ts` owns the pure projection decision over Sourcea's neutral
  processing-lineage classifier.
- The later consumer integration owns route, recall, projection, and provider
  wiring; this boundary does not authorize those effects.

## Local Contracts

- Consumer principals are distinct from producer principals and persisted
  lineage. Private identity bindings are required for every trusted context.
- Production authority is empty by construction. Fixture registration
  construction is internal reviewed server/test setup and is not request
  resolution or credential provisioning.
- Every use revalidates the current principal, registration, provider, client,
  locality, target user, operation, tier, grants, status, and expiry. Copied,
  inherited, spread, descriptor-forged, JSON, body, bearer, and producer
  values refuse before a protected callback.
- Async protected callbacks revalidate the complete current delivery-grant
  snapshot after awaiting. Revocation, expiry, removal, replacement, or any
  changed operation, target, tier, provider, client, locality, or delivery
  grant returns a content-free refusal without the callback value or a retry.
- Valid ordinary Minni lineage requires an active ordinary delivery grant.
  Valid local-only lineage also requires same-device locality and every
  canonical restriction grant. Invalid present lineage withholds. Missing
  lineage keeps a distinct generic continuation and never becomes verified
  generic authority.
- A delivery decision never grants embedding, reranking, synthesis, thinking,
  maintenance, remote processing, or any other provider operation.

## Work Guidance

- Keep provider/model, route, credential, runtime, storage, producer, and
  lifecycle changes in their owning children.
- Add only focused synthetic tests for identity, current-state revocation and
  expiry, lineage classification, delivery grants, and callback suppression.
- Preserve Sourcea's neutral parser and do not derive trust from content,
  client labels, or caller-supplied metadata.

## Verification

- Run the focused consumer-policy Vitest files, exact TypeScript noemit, and
  changed-file ESLint using the existing dependency tree.
- Remove the temporary candidate dependency link and verify the candidate is
  free of generated dependency state before handoff.

## Child DOX Index

This boundary has no child DOX documents.
