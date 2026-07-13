import { createHash } from "node:crypto";
import type { NoemaClaimStatus, NoemaStableClaim } from "../domain/memory/payload.js";

export type { NoemaClaimStatus, NoemaStableClaim };

export type NoemaClaimContract = {
  identityVersion: "noema-claim-v1";
  claimKey: string;
  revisionHash: string;
  status: NoemaClaimStatus;
  stableClaim: NoemaStableClaim;
  factKeySeed?: string;
};

export type DeriveNoemaClaimContractInput = {
  userId: string;
  scope?: string;
  path?: string;
  memoryRole?: string;
  factKey?: string;
  canonicalText: string;
  category?: string;
  continuitySubjectKey?: string;
  claimSubject?: string;
  claimPredicate?: string;
  status?: NoemaClaimStatus;
};

const VALID_NOEMA_CLAIM_STATUSES = new Set<NoemaClaimStatus>([
  "active",
  "superseded",
  "conflicted",
  "rejected",
]);

function normalizeIdentityPart(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hashParts(prefix: string, parts: Array<string | undefined>): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part ?? "");
  }
  return hash.digest("hex");
}

export function normalizeNoemaClaimStatus(status: unknown): NoemaClaimStatus {
  return VALID_NOEMA_CLAIM_STATUSES.has(status as NoemaClaimStatus)
    ? status as NoemaClaimStatus
    : "active";
}

export function isValidNoemaStatusTransition(from: NoemaClaimStatus, to: NoemaClaimStatus): boolean {
  if (from === to) return true;
  switch (from) {
    case "active":
      return to === "superseded" || to === "conflicted" || to === "rejected";
    case "conflicted":
      return to === "active" || to === "superseded" || to === "rejected";
    case "superseded":
    case "rejected":
      return false;
  }
}

export function deriveNoemaClaimContract(input: DeriveNoemaClaimContractInput): NoemaClaimContract {
  const value = normalizeValue(input.canonicalText);
  const stableClaim: NoemaStableClaim = {
    subject: normalizeIdentityPart(
      input.claimSubject ?? input.continuitySubjectKey,
      normalizeIdentityPart(input.category, normalizeIdentityPart(input.memoryRole, "memory")),
    ),
    predicate: normalizeIdentityPart(
      input.claimPredicate,
      normalizeIdentityPart(input.memoryRole, normalizeIdentityPart(input.category, "states")),
    ),
    value,
  };
  const factKeySeed = input.factKey?.trim() || undefined;
  const claimKey = hashParts("noema-claim-v1", [
    input.userId,
    input.scope ?? "user",
    input.path ?? "*",
    factKeySeed,
    stableClaim.subject,
    stableClaim.predicate,
  ]).slice(0, 32);
  const revisionHash = hashParts("noema-revision-v1", [
    claimKey,
    stableClaim.value,
  ]);

  return {
    identityVersion: "noema-claim-v1",
    claimKey,
    revisionHash,
    status: normalizeNoemaClaimStatus(input.status),
    stableClaim,
    factKeySeed,
  };
}
