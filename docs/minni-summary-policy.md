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

## Internal A1 summary codec

The source-owned `runir.minni.summary/v1` codec in
`src/domain/memory/minni-summary-contract.ts` is a pure structural boundary for
the later summary builder. It decodes a response already admitted by the
authenticated producer seam and validates only its published `get_events` shape;
the codec does not authenticate callers or grant processing authority. It
rejects duplicate returned event IDs, preserves the unique returned count and
the producer's aggregate `localOnlyWithheld` count without reconciling either
against an unretained request, and maps empty, missing, or wholly withheld
evidence to the exact content-free `no_authorized_evidence` result. That result
contains no event IDs, interval, lineage, prose, or callback value.

The OCR observation is optional metadata on an accepted Minni OCR event. The
codec validates the published screen-ocr caps and Swift coverage relationships,
deep-copies accepted nested metadata, and omits malformed, future, oversized,
or semantically inconsistent observation metadata while retaining the base
event. It excludes pixels, alternate candidates, and storage-only full-text
hashes. A durable OCR evidence or claim entry must carry the structural
uncertainties `ocr_source`, `source_clip_unknown`, and
`source_completeness_unknown`; a supported observation can add collector
coverage but cannot clear those uncertainties. Event capture/index intervals
and OCR screenshot capture intervals remain separate and neither is a message
sent-time claim. The complete closed uncertainty vocabulary is
`ocr_source`, `source_clip_unknown`, `source_completeness_unknown`,
`partial_delta`, `anchor_unavailable`, `contradictory_evidence`, and
`scope_linkage_unknown`; collector coverage is represented in its collector
metadata rather than as an additional uncertainty. Every claim in a conflict
relationship and each supporting evidence reference carries
`contradictory_evidence`.

The durable codec requires non-empty evidence and claims for an accepted
contract, links an authorized anchor only to a different event in the same
accepted evidence set, preserves contradictory claims as symmetric
relationships, and allows only the closed claim states and conclusions defined
by the source contract. Raw producer event IDs and summary/claim prose have no
invented A1 byte cap; existing reviewed bounds remain on durable reference and
label fields, while later ingest/storage work owns any additional prose or
locator limits. Structural field allowlists do not establish that arbitrary
summary or claim prose is masked, true, complete, or safe, and later builders
must retain that limitation. It has no authority constructor, write path,
route, provider, model, persistence, or delivery capability. Parsing lineage
is evidence only. An accepted contract also carries the required top-level
`event_capture_or_index_interval`, whose start is the exact minimum event
capture/index start and whose end is the exact maximum event capture/index end
across every durable evidence reference, including uncited evidence. Claim
intervals remain support-only and OCR screenshot intervals remain separate. The
strict codec rederives each claim extent from its ordered support references
and refuses mismatched original-string endpoints. Equivalent-instant ties retain
the first supporting reference, matching the builder.
The A1 codec and A2 builder share one source-compatible ISO timestamp parser
and exact precision-preserving comparator; accepted original timestamp strings
are retained, while invalid or reversed intervals refuse. The comparator uses
calendar/clock/offset validation and integer/rational fraction comparison; it
does not use `Date.parse`, millisecond conversion, or lexical tie-breaking.

## Internal A2 evidence builder

`src/domain/memory/minni-summary-builder.ts` builds the same internal v1
contract from an A1-decoded accepted event set, an explicit hand-labeled claim
set, and one stored `ProcessingLineageV1` value for every event made available
to the builder. It preserves every accepted event reference, folds every
lineage with `classifyProcessingLineage` and
`conservativeJoinProcessingLineage`, and refuses content-free when a lineage
is missing, legacy, invalid, mismatched, or when a claim reference is invalid.
An uncited restricted input therefore remains part of the conservative joined
delivery classification. Empty A1 evidence passes through the exact
`no_authorized_evidence` result without prose, claims, IDs, intervals,
lineage, or a callback value.

The builder derives each event interval and the required top-level overall
interval from `ts`/`end` with the fixed
`event_capture_or_index_interval` meaning. The overall interval covers every
accepted event even when no claim cites it; each claim interval covers only its
own support events. A supported `source=minni`,
`kind=ocr` event always carries `ocr_source`, `source_clip_unknown`, and
`source_completeness_unknown`; a supported observation may add its separate
screenshot interval and collector counts. A source `delta` flag adds
`partial_delta`. An anchor is serialized only when its different event ID is
in the accepted set; otherwise the builder records unavailable context and
`anchor_unavailable` without identifying why.

Claim state, modality, scope, statement, supports, conflicts, and explicit
scope-linkage uncertainty are hand-labeled inputs. The builder performs no
prose interpretation, keyword inference, success promotion, identity
inference, or model/provider call. It keeps claims for different scopes
separate, symmetrizes declared conflicts, and propagates
`contradictory_evidence` to both claims and their supporting evidence. The
parsed or joined lineage remains structural evidence and grants no processing,
persistence, consumer-delivery, or mutation authority.

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

The reviewed dependent work must choose public route and wire
fields/versioning, registration/token issuance and storage, stable idempotency
identity and receipt persistence, the protected all-input provenance binding,
the exact registered local runtime/model and compatible embeddings, and
deletion method (hard deletion versus irreversible inactivation) with full
derivative lineage semantics. The source-owned A1 internal summary shape and
A2 builder are selected above; they do not select a public wire schema,
persistence implementation, actual ingestion, or claim truth. Partial evidence
must not become a definitive completion claim.

This policy does not choose how a supporting-event deletion retracts a whole
derivative versus a narrower lineage, or how related evidence/index/cache
copies are removed. Those choices must satisfy the approved deletion and
delivery requirements before their implementation. No current generic route,
caller flag or client label substitutes for that reviewed owner delivery.
