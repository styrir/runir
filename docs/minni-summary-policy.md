# Minni summary policy

Policy version: **1**. Owner: **Rúnir-4nb**, policy groundwork **Rúnir-4nb.1**.
This is a maintained source policy for the future Minni delivery. Enforcement,
owner delivery and consumer/live qualification remain separate gates. This
document installs no endpoint, activates no flag and selects no wire schema.

## Authority and scope

The operator-approved Styrir [Minni decision](../../styrir-os/agent-guidance/minni-activity-recall-decision.md)
is the authority: **Exact interaction §3** assigns summaries and embeddings to
Rúnir; **Access and persistence delta · Processing** requires local processing
and denies cloud summarization; **Agent access** binds consumer delivery to
provider + client registrations; **Retention and storage** requires deletion
propagation by provenance. This policy applies those requirements to the whole
Rúnir lifecycle of Minni-derived content. It does not change other origins'
processing or authorize Personal Area/C3 capture or model access.

The [README](../README.md) remains the service entry point and
[zed-01 beta scope](zed-01-beta-scope.md) the frozen endpoint baseline. Existing
route registrations determine the implemented surface. This policy is not an
additional API contract or evidence that any current payload is Minni-origin.

## Lifetime processing requirement

Local-only is a **lifetime Rúnir processing policy**, not an ingest-time hint.
It must follow accepted Minni content and its derivatives through writes,
embedding/re-embedding, arbitration, merge/supersession, promotion, repair,
enrichment, retrieval-side synthesis and scheduled or forced maintenance.
No such Rúnir operation may hand protected text to an unapproved or nonlocal
model dependency. No remote fallback becomes permitted when a local dependency
is missing, unhealthy or incompatible.
“Local” must satisfy the approved same-device registration, network/telemetry
and retention requirements; a loopback address alone is not that proof.

The requirement covers extraction, segmentation, enrichment, embedding,
supersession/staleness judges and any later model-backed operation that reads
the content. Admission must prove that every dependency reachable by the
intended write is permitted before text egress or a durable row mutation.
Later processing must revalidate its dependencies: unavailable or nonlocal
processing is refused or skipped with an auditable, content-free reason;
existing content is not silently routed elsewhere.

Permitted delivery of a summary to an approved cloud consumer is a separate
authorization decision. It does not authorize Rúnir to perform cloud
summarization, embedding, judging or maintenance. Audio-derived and
excluded-source/local-only content means items carrying the producer's
restricted delivery classification, not every Minni summary subject to lifetime
local processing. Eligible ordinary summaries may reach registered, approved
cloud consumers under the Minni decision. Restricted items remain unavailable
to cloud consumers through every projection, including excerpts, selected items, deep lookup,
lineage, trace/debug output and plugin injection. A local display alone does
not make its conversational provider local.

## Server-trusted facts

Before a Minni operation is admitted, the owner must resolve the facts
applicable to that operation through reviewed server-controlled mechanisms.
Recall requires consumer authorization plus origin and delivery policy;
idempotency identity applies only to mutating writes/retractions where the
reviewed contract uses idempotency, and deletion authority applies only to
retraction. Ordinary authorized recall requires neither of those mutation
privileges nor per-request operator approval.

| Fact | Required authority |
|---|---|
| Origin and lifetime processing policy | Authenticated producer registration and owner policy; a source label in caller text is insufficient. |
| Consumer identity and access | Authenticated provider + client registration, approved tiers, locality and current review terms. Source attribution does not grant consumer authorization. |
| Idempotency identity | Owner-validated identity within the authenticated operation/user/origin scope, bound to the reviewed content and provenance. |
| Provenance | Validated, bounded supporting Minni event references and source interval under the producer contract; unknown source facts remain unknown. |
| Deletion authority | Authenticated authority over the target user's permitted Minni origin and reviewed provenance scope, including affected derivatives. |

JSON body values, including `client`, `preferredClient`, origin, tiers,
locality or policy claims, are request data rather than authorization. They
cannot widen delivery, manufacture trusted provenance, change processing
policy or grant deletion authority. A general service bearer is not proof of
a reviewed Minni consumer registration. An exact idempotent retry must preserve
the same logical receipt without another durable write; conflicting reuse must
not mutate rows or reveal another principal's content.

## Refusal invariants

These are required semantic outcomes, not selected status codes, response
fields or an implemented refusal API. Validate before protected text egress,
durable writes or delivery; refusals retain the existing data and permissions.

| Condition | Required outcome |
|---|---|
| Unsupported delivery contract version | Refuse; do not reinterpret it as a supported version or ordinary generic ingest. |
| Missing, unknown, mismatched or no-longer-approved registration | Refuse Minni access; caller attribution cannot supply the missing authority. |
| Unknown origin or processing policy | Refuse admission to the Minni lane; do not guess from content or retroactively relabel other-origin rows. |
| Unregistered, nonlocal or otherwise unapproved processing dependency | Refuse ingest before egress or rows; refuse/skip later processing without a remote fallback. |
| Reused idempotency identity with different content, provenance or authorized scope | Conflict with no durable mutation; exact authorized retry remains distinguishable. |
| Invalid, unbounded, inconsistent or unsupported provenance/deletion scope | Refuse; do not widen a range, drop constraints or invent missing evidence. |
| Consumer not permitted to receive an audio-derived/local-only item | Withhold it from every content projection; do not downgrade its class or bypass the gate through lineage/debug. |

Diagnostics may record bounded reason, operation, policy version, registration
reference and counts under the reviewed logging contract; they must not log
summary text, raw events, credentials or withheld content. The representation
of those diagnostics is not selected here.

## Existing source gaps and qualification

Current [API auth](../src/app/auth.ts) checks a service bearer, without resolving
a Minni provider + client policy context. The generic
[memory route](../src/app/routes/memory/index.ts) passes writes into
[runtime arbitration](../src/app/runtime.ts), which calls its embedding
provider and supersession judge. The [server scheduler](../src/app/server.ts)
also invokes later [consolidation/staleness processing](../src/lifecycle/semion/consolidation.ts).
The [recall orchestrator](../src/recall/orchestrator/recall-orchestrator.ts)
uses caller client attribution for filtering; that is distinct from trusted
consumer authorization. These source paths do **not** establish enforcement
of this policy. No actual Minni-origin live exposure is asserted.

Rúnir-4nb.2 must qualify lifetime processing with throwing egress fakes at
ingest and immediate scheduled/forced maintenance. Rúnir-4nb.3 owns trusted
consumer delivery. Rúnir-4nb.4 waits for reviewed Minni observation/retrieval
delivery; Rúnir-4nb.5 and .6 own idempotent ingest and provenance retraction.
Rúnir-4nb.7 qualifies and publishes owner delivery. Source tests, published
owner artifacts, Styrir consumer inspection and installed/live qualification
must each retain their own evidence; none proves the others.

## Unselected decisions

The reviewed dependent work must choose route and wire fields/versioning,
registration/token issuance and storage, stable idempotency identity and
receipt persistence, provenance/claim representation and bounds, the exact
registered local runtime/model and compatible embeddings, and deletion method
(hard deletion versus irreversible inactivation) with full derivative lineage
semantics. Partial evidence must not become a definitive completion claim;
the claim representation awaits the producer contract.

This policy does not choose how a supporting-event deletion retracts a whole
derivative versus a narrower lineage, or how related evidence/index/cache
copies are removed. Those choices must satisfy the approved deletion and
delivery requirements before their implementation. No current generic route,
caller flag or client label substitutes for that reviewed owner delivery.
