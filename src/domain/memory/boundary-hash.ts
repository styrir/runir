// Canonical-absent sentinel encoding and hash projection for ADR 0006.
//
// This module owns `CanonicalField<T>`, `encodeField()`, and `boundaryHash()`.
// It was extracted from `boundary.ts` during arch1 critic revision (2026-04-27)
// so that `boundary.ts` stays under the strict <200 LOC AC from US-FND-004.
//
// Consumers should generally import from the barrel (`types.js`) or directly
// from this module. `boundary.ts` re-exports everything here for backwards
// compatibility.

import { createHash } from "crypto";

// --- Canonical-absent sentinel (ADR 0006) ---
//
// A typed discriminated tuple for optional fields. A present field carries
// a value; an absent field carries no payload. The discriminant is a byte
// prefix in the hash encoding, so no value of type T can produce the same
// byte sequence as an absent field.
export type CanonicalField<T> = readonly [present: true, value: T] | readonly [present: false];

// Encodes a single CanonicalField to a Buffer per ADR 0006 framing:
//   [absent]         → 0x00
//   [present, value] → 0x01 || serialize(value)
//
// serialize() is pinned to JSON.stringify for this stub implementation.
// ADR 0006 notes that a fixed-format encoding (canonical JSON or msgpack)
// must be pinned at implementation time. JSON.stringify is the stub choice;
// arch1.02.0 will pin to a canonical JSON library if ordering guarantees
// are required for object-valued fields.
function encodeField(field: CanonicalField<unknown>): Buffer {
  if (!field[0]) {
    return Buffer.from([0x00]);
  }
  const serialized = JSON.stringify(field[1]);
  const valueBytes = Buffer.from(serialized, "utf8");
  return Buffer.concat([Buffer.from([0x01]), valueBytes]);
}

/**
 * Hashes a sequence of CanonicalField values to a sha256 hex digest.
 *
 * Encoding per ADR 0006:
 *   - [present: false]       → 0x00
 *   - [present: true, value] → 0x01 || JSON.stringify(value) (UTF-8)
 *
 * All encoded fields are concatenated, then sha256-hashed.
 * Production wiring (calling boundaryHash from arbitrator/retrieval) is
 * deferred to arch1.02.0.
 */
export function boundaryHash(fields: readonly CanonicalField<unknown>[]): string {
  const parts = fields.map(encodeField);
  const combined = Buffer.concat(parts);
  return createHash("sha256").update(combined).digest("hex");
}
