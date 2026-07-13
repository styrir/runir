import type { SimilarCandidate } from "../../domain/memory/types.js";
import type { ReferentKeys } from "./referent-identity.js";
import { normalizeText } from "./text-normalize.js";

// Rúnir-pn1l.13.4: string-only helper — a payload/metadata value is a usable
// referent key only when it is a present, non-empty string. Mirrors the
// `typeof … === "string"` guards already used for factKey/continuitySubjectKey
// throughout the write path (`lockKeyFromMetadata` in overlay-lifecycle; tier/validAt reads in the arbitration pipeline).
function referentKeyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Rúnir-h435.1 [R3-2]: reserved identity delimiter. Form validation REJECTS any
 *  subject/predicate containing `|` so join collisions cannot false-prove. */
const ATOMIC_IDENTITY_DELIMITER = "|";

/** Rúnir-h435.1 F8 / C-2 T1: payload.atomicFact is a non-null object.
 *  Same object check `atomicFactIdentity` uses as its first gate. */
export function isAtomicFactObject(fact: unknown): boolean {
  return fact !== null && typeof fact === "object";
}

/** Rúnir-h435.1 F8 / C-2 T2: T1 AND subject, predicate, value all non-empty strings.
 *  Same complete-triple check `atomicFactIdentity` uses internally. */
export function isCompleteAtomicTriple(fact: unknown): boolean {
  if (!isAtomicFactObject(fact)) return false;
  const raw = fact as { subject?: unknown; predicate?: unknown; value?: unknown };
  return (
    referentKeyString(raw.subject) !== undefined &&
    referentKeyString(raw.predicate) !== undefined &&
    referentKeyString(raw.value) !== undefined
  );
}

/** Rúnir-h435.1 [R1-3, R3-2]: proof-ready atomicFact = complete non-empty
 *  {subject, predicate, value} with canonicalized subject/predicate non-empty
 *  and neither containing the reserved `|` delimiter. Value is validated present
 *  but EXCLUDED from the identity string. Malformed/partial objects return
 *  undefined (may persist as payload; carry no proof authority). Never derive
 *  missing fields. Canonicalization = normalizeText (trim + lowercase +
 *  whitespace-collapse) of subject and predicate only — NO punctuation folding,
 *  NO synonym mapping, NO derivation from other fields [R1-7].
 *  Applied IDENTICALLY on both sides (incoming + candidate) via this one helper.
 *  F8: consumes isAtomicFactObject / isCompleteAtomicTriple (zero behavior change). */
export function atomicFactIdentity(fact: unknown): string | undefined {
  if (!isCompleteAtomicTriple(fact)) return undefined;
  const raw = fact as { subject?: unknown; predicate?: unknown; value?: unknown };
  const subjectRaw = referentKeyString(raw.subject)!;
  const predicateRaw = referentKeyString(raw.predicate)!;
  const subject = normalizeText(subjectRaw);
  const predicate = normalizeText(predicateRaw);
  if (subject.length === 0 || predicate.length === 0) return undefined;
  // Delimiter safety [R3-2]: reject if either canonicalized part contains `|`.
  if (subject.includes(ATOMIC_IDENTITY_DELIMITER) || predicate.includes(ATOMIC_IDENTITY_DELIMITER)) {
    return undefined;
  }
  return `${subject}${ATOMIC_IDENTITY_DELIMITER}${predicate}`;
}

/** Rúnir-h435.1 PIN-7 / [R1-2, R2-2, R7-3]: merge-update atomicFact policy.
 *  retain ONLY when incoming is proof-ready AND complete triple equals stored:
 *  subject+predicate under slice-1 canonicalization; VALUE under trim-only
 *  (case- and punctuation-PRESERVING). Every other case (stored absent, value
 *  differs, partial/missing/malformed incoming, identity conflict) → clear.
 *  Never blind-rewrite to the incoming value. Operand order: STORED first,
 *  INCOMING second. */
export function mergeAtomicFactAction(
  storedAtomicFact: unknown,
  incomingAtomicFact: unknown,
): "retain" | "clear" {
  // Incoming must be proof-ready (complete triple + delimiter-safe canonicalization).
  const incomingIdentity = atomicFactIdentity(incomingAtomicFact);
  if (incomingIdentity === undefined) return "clear";

  // Stored must also be a complete non-empty triple for a retain comparison
  // (identity alone is insufficient — value must match under trim-only).
  if (storedAtomicFact === null || typeof storedAtomicFact !== "object") return "clear";
  const stored = storedAtomicFact as { subject?: unknown; predicate?: unknown; value?: unknown };
  const storedSubjectRaw = referentKeyString(stored.subject);
  const storedPredicateRaw = referentKeyString(stored.predicate);
  const storedValueRaw = referentKeyString(stored.value);
  if (
    storedSubjectRaw === undefined ||
    storedPredicateRaw === undefined ||
    storedValueRaw === undefined
  ) {
    return "clear";
  }

  const incoming = incomingAtomicFact as {
    subject?: unknown;
    predicate?: unknown;
    value?: unknown;
  };
  const incomingSubjectRaw = referentKeyString(incoming.subject)!;
  const incomingPredicateRaw = referentKeyString(incoming.predicate)!;
  const incomingValueRaw = referentKeyString(incoming.value)!;

  // Subject/predicate: slice-1 canonicalization equality.
  if (normalizeText(storedSubjectRaw) !== normalizeText(incomingSubjectRaw)) return "clear";
  if (normalizeText(storedPredicateRaw) !== normalizeText(incomingPredicateRaw)) return "clear";

  // Value: trim-only equality (case- and punctuation-preserving) [R7-3].
  if (storedValueRaw.trim() !== incomingValueRaw.trim()) return "clear";

  return "retain";
}

/** Rúnir-pn1l.13.4: project the INCOMING write's referent keys off its metadata
 *  into a `ReferentKeys`-shaped view for `proveReferentIdentity`. The keys
 *  already exist on `input.metadata` before arbitration (`factMetadata` stamps
 *  `factKey`; `deriveContinuityMetadata` stamps `continuitySubjectKey`), so this
 *  only surfaces them — it never mutates `metadata` (which is persisted into the
 *  stored payload on create/supersede) and never computes new keys.
 *  `atomicFactIdentity` is deliberately left for the U5 gate to derive from the
 *  raw `atomicFact` on BOTH sides, keeping this a pure surfacing helper.
 *  Exported and inert: no arbitration-decision call site reads it until U5.
 *  Rúnir-pn1l Q4 U0 (2026-07-07): `noemaClaimKey` REMOVED from this projection —
 *  it was dropped from the `ReferentKeys` proof list (see `referent-identity.ts`
 *  doc comment); projecting it here would be dead weight now that
 *  `proveReferentIdentity` never reads that field. */
export function incomingReferentKeys(
  metadata: Record<string, unknown> | undefined,
): ReferentKeys {
  if (!metadata) return {};
  return {
    factKey: referentKeyString(metadata.factKey),
    continuitySubjectKey: referentKeyString(metadata.continuitySubjectKey),
    // Rúnir-pn1l.13.4 (U5) / Rúnir-h435.1: canonicalize the raw incoming atomicFact
    // identically to the candidate side so the `key:atomicFactIdentity` proof arm can fire.
    atomicFactIdentity: atomicFactIdentity(metadata.atomicFact),
  };
}

/** Rúnir-pn1l.13.4: project a stored CANDIDATE's referent keys (surfaced by the
 *  `findSimilarMemories` mapper) into the same `ReferentKeys` view, so the U5
 *  gate compares like-for-like against `incomingReferentKeys`. Symmetric partner
 *  of the incoming helper; also inert until U5. Rúnir-pn1l Q4 U0: `noemaClaimKey`
 *  REMOVED from this projection (see `incomingReferentKeys` above) — the field
 *  stays on `SimilarCandidate` itself (consumed directly by `snapshotCandidate`
 *  for the shadow replay snapshot), only its `ReferentKeys` proof-arm use is gone. */
export function candidateReferentKeys(candidate: SimilarCandidate): ReferentKeys {
  return {
    factKey: referentKeyString(candidate.factKey),
    continuitySubjectKey: referentKeyString(candidate.continuitySubjectKey),
    // Rúnir-pn1l.13.4 (U5) / Rúnir-h435.1: same canonicalization as the incoming side.
    atomicFactIdentity: atomicFactIdentity(candidate.atomicFact),
  };
}
