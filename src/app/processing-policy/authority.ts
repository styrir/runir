/**
 * Internal producer authority for the Minni processing lane.
 *
 * This module is deliberately smaller than the eventual processing-policy
 * enforcement. It binds a server-authenticated producer principal to a
 * server-selected operation and a server-resolved target user. The production
 * registry is empty until a later owner gate provisions a registration.
 *
 * Request body fields, source/client labels, policy claims, and the general
 * service bearer are not accepted by this authority boundary. Consumer
 * authorization is a separate contract and must not be derived from these
 * producer values.
 */

import {
  classifyProcessingLineage,
  PROCESSING_LINEAGE_ORIGIN,
  PROCESSING_LINEAGE_STATE,
  PROCESSING_LINEAGE_VERSION,
  PROCESSING_POLICY_VERSION,
  type ProcessingLineageRestriction,
  type ProcessingLineageV1,
} from "../../domain/memory/processing-lineage.js";

export const MINNI_ORIGIN = "minni" as const;
export const MINNI_PROCESSING_POLICY_VERSION = "runir.minni.local/v1" as const;

export const PRODUCER_OPERATIONS = [
  "capture_ingest",
  "scheduled_maintenance",
  "forced_maintenance",
] as const;

export type ProducerOperation = typeof PRODUCER_OPERATIONS[number];
export type ProducerPrincipalRef = string & { readonly __producerPrincipalRef: unique symbol };
export type ProducerRegistrationRef = string & { readonly __producerRegistrationRef: unique symbol };

export type ProducerPrincipal = Readonly<{
  principalRef: ProducerPrincipalRef;
  authenticatedBy: "server";
}>;

export type ServerResolvedTargetUser = Readonly<{
  userId: string;
}>;

export type ServerSelectedProducerOperation = Readonly<{
  name: ProducerOperation;
}>;

export type TrustedProducerRegistration = Readonly<{
  registrationRef: ProducerRegistrationRef;
  principalRef: ProducerPrincipalRef;
  origin: typeof MINNI_ORIGIN;
  policyVersion: typeof MINNI_PROCESSING_POLICY_VERSION;
  authorizedOperations: readonly ProducerOperation[];
  authorizedTargetUsers: readonly string[];
  status: "active" | "revoked";
  expiresAt?: string;
}>;

export type ProcessingPolicyContext = Readonly<{
  principalRef: ProducerPrincipalRef;
  registrationRef: ProducerRegistrationRef;
  origin: typeof MINNI_ORIGIN;
  policyVersion: typeof MINNI_PROCESSING_POLICY_VERSION;
  operation: ProducerOperation;
  targetUserId: string;
  mode: "local-only";
  lineageState: "minni_verified";
}>;

export type ProducerAdmissionRefusalReason =
  | "principal_missing"
  | "principal_untrusted"
  | "target_user_missing"
  | "target_user_untrusted"
  | "requested_user_mismatch"
  | "operation_untrusted"
  | "registration_missing"
  | "registration_mismatch"
  | "registration_revoked"
  | "registration_expired"
  | "operation_not_authorized"
  | "target_user_not_authorized"
  | "target_user_mismatch"
  | "operation_mismatch"
  | "registration_invalid"
  | "context_invalid"
  | "authority_mismatch"
  | "lineage_present"
  | "delivery_resolver_unconfigured"
  | "delivery_resolver_untrusted"
  | "delivery_evidence_invalid"
  | "lineage_invalid";

export type ProducerAdmissionRefusal = Readonly<{
  ok: false;
  code: "producer_policy_refused";
  reason: ProducerAdmissionRefusalReason;
  contentFree: true;
}>;

export type ProducerAdmission =
  | Readonly<{ ok: true; context: ProcessingPolicyContext }>
  | ProducerAdmissionRefusal;

/** Opaque producer-owned delivery evidence; its fields are private by design. */
export type ProducerDeliveryEvidence = Readonly<{
  readonly __producerDeliveryEvidence: unique symbol;
}>;

export interface TrustedProducerDeliveryResolver {
  resolve(
    authority: ProducerAuthority,
    context: unknown,
  ): ProducerDeliveryEvidence | ProducerAdmissionRefusal;
}

export type MintedProcessingLineage = Readonly<{
  ok: true;
  context: ProcessingPolicyContext;
  lineage: ProcessingLineageV1;
}>;

export type MintedProcessingLineageUseResult<T> =
  | Readonly<{
      ok: true;
      context: ProcessingPolicyContext;
      lineage: ProcessingLineageV1;
      value: T;
    }>
  | ProducerAdmissionRefusal;

export type ProducerAdmissionInput = Readonly<{
  /** Must be created by a server-authenticated producer adapter. */
  principal?: ProducerPrincipal | null;
  /** Must be selected by the server route/dispatch, never by request JSON. */
  operation?: ServerSelectedProducerOperation | null;
  /** Must be resolved by the server before any protected callback runs. */
  targetUser?: ServerResolvedTargetUser | null;
  /** Optional request value checked against the server binding; never authoritative. */
  requestedUserId?: unknown;
}>;

export interface ProducerAuthority {
  resolve(input: ProducerAdmissionInput): ProducerAdmission;
}

type AuthorityState = {
  readonly byPrincipal: Map<string, TrustedProducerRegistration>;
  readonly byRegistration: Map<string, TrustedProducerRegistration>;
  readonly revoked: Set<string>;
};

type ProcessingPolicyContextBinding = Readonly<{
  state: AuthorityState;
  context: ProcessingPolicyContext;
  principalRef: ProducerPrincipalRef;
  registrationRef: ProducerRegistrationRef;
  operation: ProducerOperation;
  targetUserId: string;
}>;

/**
 * These identity maps are the authority boundary. Symbols or public scalar
 * fields are not proof: inherited, spread, descriptor-forged, and JSON-built
 * objects must never become trusted producer values.
 */
const producerPrincipalIdentity = new WeakMap<object, ProducerPrincipalRef>();
const serverTargetUserIdentity = new WeakMap<object, string>();
const serverOperationIdentity = new WeakMap<object, ProducerOperation>();
const processingPolicyContextIdentity = new WeakMap<object, ProcessingPolicyContextBinding>();
const authorityIdentity = new WeakMap<ProducerAuthority, AuthorityState>();
const mintedProcessingLineageIdentity = new WeakMap<object, Readonly<{
  state: AuthorityState;
  contextBinding: ProcessingPolicyContextBinding;
  lineage: ProcessingLineageV1;
}>>();
type ProducerDeliveryEvidenceBinding = Readonly<{
  state: AuthorityState;
  contextBinding: ProcessingPolicyContextBinding;
  restrictions: readonly ProcessingLineageRestriction[];
}>;
const producerDeliveryEvidenceIdentity = new WeakMap<object, ProducerDeliveryEvidenceBinding>();
const producerDeliveryResolverIdentity = new WeakMap<object, "unconfigured" | "synthetic">();

function refusal(reason: ProducerAdmissionRefusalReason): ProducerAdmissionRefusal {
  return {
    ok: false,
    code: "producer_policy_refused",
    reason,
    contentFree: true,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asPrincipalRef(value: string): ProducerPrincipalRef {
  return value.trim() as ProducerPrincipalRef;
}

function asRegistrationRef(value: string): ProducerRegistrationRef {
  return value.trim() as ProducerRegistrationRef;
}

function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function freezeOpaque<T extends object>(value: T): T {
  return Object.freeze(value);
}

function isProducerOperation(value: unknown): value is ProducerOperation {
  return typeof value === "string" && (PRODUCER_OPERATIONS as readonly string[]).includes(value);
}

function isServerSelectedProducerOperation(value: unknown): value is ServerSelectedProducerOperation {
  const object = asObject(value);
  if (!object) return false;
  const operation = serverOperationIdentity.get(object);
  return Boolean(
    operation !== undefined
    && (value as { name?: unknown }).name === operation,
  );
}

function isServerAuthenticatedPrincipal(value: unknown): value is ProducerPrincipal {
  const object = asObject(value);
  if (!object) return false;
  const principalRef = producerPrincipalIdentity.get(object);
  return Boolean(
    principalRef !== undefined
    && (value as { principalRef?: unknown }).principalRef === principalRef
    && (value as { authenticatedBy?: unknown }).authenticatedBy === "server"
    && nonEmptyString(principalRef),
  );
}

function isServerResolvedTargetUser(value: unknown): value is ServerResolvedTargetUser {
  const object = asObject(value);
  if (!object) return false;
  const userId = serverTargetUserIdentity.get(object);
  return Boolean(
    userId !== undefined
    && (value as { userId?: unknown }).userId === userId
    && nonEmptyString(userId),
  );
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function contextFieldsMatchBinding(
  context: ProcessingPolicyContext,
  binding: ProcessingPolicyContextBinding,
): boolean {
  return context.principalRef === binding.principalRef
    && context.registrationRef === binding.registrationRef
    && context.origin === MINNI_ORIGIN
    && context.policyVersion === MINNI_PROCESSING_POLICY_VERSION
    && context.operation === binding.operation
    && context.targetUserId === binding.targetUserId
    && context.mode === "local-only"
    && context.lineageState === "minni_verified";
}

function isTrustedProcessingPolicyContext(value: unknown): value is ProcessingPolicyContext {
  const object = asObject(value);
  if (!object) return false;
  const binding = processingPolicyContextIdentity.get(object);
  return binding !== undefined && contextFieldsMatchBinding(value as ProcessingPolicyContext, binding);
}

function currentContextRefusal(
  context: ProcessingPolicyContext,
  binding: ProcessingPolicyContextBinding,
  expected: Readonly<{ operation?: ProducerOperation; targetUserId?: string }>,
): ProducerAdmissionRefusalReason | undefined {
  const registration = binding.state.byRegistration.get(binding.registrationRef);
  if (!registration) return "registration_missing";
  if (registration.registrationRef !== binding.registrationRef || registration.principalRef !== binding.principalRef) {
    return "registration_mismatch";
  }
  if (registration.origin !== MINNI_ORIGIN || registration.policyVersion !== MINNI_PROCESSING_POLICY_VERSION) {
    return "registration_invalid";
  }
  const principalRegistration = binding.state.byPrincipal.get(binding.principalRef);
  if (!principalRegistration || principalRegistration.registrationRef !== binding.registrationRef) {
    return "registration_mismatch";
  }
  if (binding.state.revoked.has(binding.registrationRef) || registration.status !== "active") {
    return "registration_revoked";
  }
  if (isExpired(registration.expiresAt)) return "registration_expired";
  if (!registration.authorizedOperations.includes(binding.operation)) return "operation_not_authorized";
  if (!registration.authorizedTargetUsers.includes(binding.targetUserId)) return "target_user_not_authorized";
  if (expected.targetUserId !== undefined && context.targetUserId !== expected.targetUserId) {
    return "target_user_mismatch";
  }
  if (expected.operation !== undefined && context.operation !== expected.operation) {
    return "operation_mismatch";
  }
  return undefined;
}

function createOpaqueProducerDeliveryEvidence(
  authority: ProducerAuthority,
  context: unknown,
  restrictions: readonly ProcessingLineageRestriction[],
): ProducerDeliveryEvidence | ProducerAdmissionRefusal {
  const state = authorityIdentity.get(authority);
  const contextObject = asObject(context);
  const contextBinding = contextObject ? processingPolicyContextIdentity.get(contextObject) : undefined;
  if (!state || !contextBinding || contextBinding.state !== state || !isTrustedProcessingPolicyContext(context)) {
    return refusal("authority_mismatch");
  }
  const evidence = Object.freeze({}) as ProducerDeliveryEvidence;
  producerDeliveryEvidenceIdentity.set(evidence, {
    state,
    contextBinding,
    restrictions: Object.freeze([...restrictions]),
  });
  return evidence;
}

const productionProducerDeliveryResolver: TrustedProducerDeliveryResolver = Object.freeze({
  resolve: () => refusal("delivery_resolver_unconfigured"),
});
producerDeliveryResolverIdentity.set(productionProducerDeliveryResolver, "unconfigured");

/**
 * Fixed synthetic resolver used by source tests only. It has no caller-supplied
 * flags: its fixture restrictions are selected from the already authenticated
 * server operation and the resulting evidence is bound to this authority and
 * context through a private identity map.
 */
export const syntheticProducerDeliveryResolver: TrustedProducerDeliveryResolver = Object.freeze({
  resolve: (authority: ProducerAuthority, context: unknown) => {
    const contextObject = asObject(context);
    const contextBinding = contextObject ? processingPolicyContextIdentity.get(contextObject) : undefined;
    const state = authorityIdentity.get(authority);
    if (!state || !contextBinding || contextBinding.state !== state || !isTrustedProcessingPolicyContext(context)) {
      return refusal("authority_mismatch");
    }
    const restrictions: readonly ProcessingLineageRestriction[] = context.operation === "capture_ingest"
      ? []
      : context.operation === "scheduled_maintenance"
        ? ["audio_derived"]
        : ["audio_derived", "excluded_source", "producer_local_only"];
    return createOpaqueProducerDeliveryEvidence(authority, context, restrictions);
  },
});
producerDeliveryResolverIdentity.set(syntheticProducerDeliveryResolver, "synthetic");

/**
 * Internal boundary constructor for a principal authenticated by server code.
 * It must never be called with request body data or a general service bearer.
 * The constructor exists so the future authenticated producer adapter can
 * publish a neutral principal value without choosing a credential mechanism.
 */
export function createServerAuthenticatedProducerPrincipal(principalRef: string): ProducerPrincipal {
  if (!nonEmptyString(principalRef)) throw new TypeError("producer principal reference is required");
  const principal = freezeOpaque({
    principalRef: asPrincipalRef(principalRef),
    authenticatedBy: "server" as const,
  }) as ProducerPrincipal;
  producerPrincipalIdentity.set(principal, principal.principalRef);
  return principal;
}

/**
 * Internal binding constructor for a target user already resolved by server
 * authentication/tenant policy. Request `userId` values cannot create this
 * binding.
 */
export function createServerResolvedTargetUser(userId: string): ServerResolvedTargetUser {
  if (!nonEmptyString(userId)) throw new TypeError("server-resolved target user is required");
  const targetUser = freezeOpaque({
    userId: userId.trim(),
  }) as ServerResolvedTargetUser;
  serverTargetUserIdentity.set(targetUser, targetUser.userId);
  return targetUser;
}

/**
 * Internal dispatch constructor for an operation selected by trusted server
 * code. Request JSON cannot manufacture the private identity or choose the
 * operation.
 */
export function createServerSelectedProducerOperation(
  operation: ProducerOperation,
): ServerSelectedProducerOperation {
  if (!isProducerOperation(operation)) throw new TypeError("server-selected producer operation is invalid");
  const selectedOperation = freezeOpaque({ name: operation }) as ServerSelectedProducerOperation;
  serverOperationIdentity.set(selectedOperation, selectedOperation.name);
  return selectedOperation;
}

/** Synthetic registration construction is source-internal and test-only until a later owner gate. */
export function createTrustedProducerRegistration(input: {
  registrationRef: string;
  principalRef: string;
  authorizedOperations: readonly ProducerOperation[];
  authorizedTargetUsers: readonly string[];
  status?: "active" | "revoked";
  expiresAt?: string;
}): TrustedProducerRegistration {
  if (!nonEmptyString(input.registrationRef) || !nonEmptyString(input.principalRef)) {
    throw new TypeError("producer registration references are required");
  }
  if (input.authorizedOperations.length === 0 || input.authorizedOperations.some((operation) => !isProducerOperation(operation))) {
    throw new TypeError("producer registration operations are invalid");
  }
  const targetUsers = input.authorizedTargetUsers.map((userId) => userId.trim()).filter(Boolean);
  if (targetUsers.length === 0) throw new TypeError("producer registration target users are required");
  if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new TypeError("producer registration expiry is invalid");
  }
  return Object.freeze({
    registrationRef: asRegistrationRef(input.registrationRef),
    principalRef: asPrincipalRef(input.principalRef),
    origin: MINNI_ORIGIN,
    policyVersion: MINNI_PROCESSING_POLICY_VERSION,
    authorizedOperations: Object.freeze([...new Set(input.authorizedOperations)]),
    authorizedTargetUsers: Object.freeze([...new Set(targetUsers)]),
    status: input.status ?? "active",
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
}

function buildContext(
  state: AuthorityState,
  principal: ProducerPrincipal,
  registration: TrustedProducerRegistration,
  operation: ProducerOperation,
  targetUserId: string,
): ProcessingPolicyContext {
  const context = freezeOpaque({
    principalRef: principal.principalRef,
    registrationRef: registration.registrationRef,
    origin: MINNI_ORIGIN,
    policyVersion: MINNI_PROCESSING_POLICY_VERSION,
    operation,
    targetUserId,
    mode: "local-only" as const,
    lineageState: "minni_verified" as const,
  }) as ProcessingPolicyContext;
  processingPolicyContextIdentity.set(context, {
    state,
    context,
    principalRef: principal.principalRef,
    registrationRef: registration.registrationRef,
    operation,
    targetUserId,
  });
  return context;
}

export function createProducerAuthority(
  registrations: readonly TrustedProducerRegistration[] = [],
): ProducerAuthority {
  const state: AuthorityState = {
    byPrincipal: new Map<string, TrustedProducerRegistration>(),
    byRegistration: new Map<string, TrustedProducerRegistration>(),
    revoked: new Set<string>(),
  };
  for (const registration of registrations) {
    if (registration.origin !== MINNI_ORIGIN || registration.policyVersion !== MINNI_PROCESSING_POLICY_VERSION) {
      throw new TypeError("producer registration policy is unsupported");
    }
    if (state.byPrincipal.has(registration.principalRef)) {
      throw new TypeError("producer principal has multiple registrations");
    }
    if (state.byRegistration.has(registration.registrationRef)) {
      throw new TypeError("producer registration reference is duplicated");
    }
    state.byPrincipal.set(registration.principalRef, registration);
    state.byRegistration.set(registration.registrationRef, registration);
  }

  const authority: ProducerAuthority = Object.freeze({
    resolve(input: ProducerAdmissionInput): ProducerAdmission {
      if (input.principal === undefined || input.principal === null) return refusal("principal_missing");
      if (!isServerAuthenticatedPrincipal(input.principal)) return refusal("principal_untrusted");
      if (input.targetUser === undefined || input.targetUser === null) return refusal("target_user_missing");
      if (!isServerResolvedTargetUser(input.targetUser)) return refusal("target_user_untrusted");
      if (!isServerSelectedProducerOperation(input.operation)) return refusal("operation_untrusted");
      if (input.requestedUserId !== undefined && input.requestedUserId !== input.targetUser.userId) {
        return refusal("requested_user_mismatch");
      }

      const operation = input.operation.name;

      const registration = state.byPrincipal.get(input.principal.principalRef);
      if (!registration) return refusal("registration_missing");
      if (registration.principalRef !== input.principal.principalRef) return refusal("registration_mismatch");
      if (state.revoked.has(registration.registrationRef) || registration.status !== "active") return refusal("registration_revoked");
      if (isExpired(registration.expiresAt)) return refusal("registration_expired");
      if (!registration.authorizedOperations.includes(operation)) return refusal("operation_not_authorized");
      if (!registration.authorizedTargetUsers.includes(input.targetUser.userId)) {
        return refusal("target_user_not_authorized");
      }

      return { ok: true, context: buildContext(state, input.principal, registration, operation, input.targetUser.userId) };
    },
  });
  authorityIdentity.set(authority, state);
  return authority;
}

/** Empty by construction: no production registration or credential is activated by this slice. */
export const productionProducerAuthority = createProducerAuthority();

/** Internal server-only registry mutation used by the later owner gate. */
export function revokeProducerRegistration(authority: ProducerAuthority, registrationRef: string): void {
  const state = authorityIdentity.get(authority);
  if (!state || !nonEmptyString(registrationRef) || !state.byRegistration.has(registrationRef.trim())) {
    throw new TypeError("producer registration is unknown");
  }
  state.revoked.add(registrationRef.trim());
}

/** Internal server-only registry replacement used to exercise stale authority. */
export function removeProducerRegistration(authority: ProducerAuthority, registrationRef: string): void {
  const state = authorityIdentity.get(authority);
  const normalizedRef = registrationRef.trim();
  const registration = state?.byRegistration.get(normalizedRef);
  if (!state || !nonEmptyString(registrationRef) || !registration) {
    throw new TypeError("producer registration is unknown");
  }
  state.byRegistration.delete(normalizedRef);
  state.byPrincipal.delete(registration.principalRef);
  state.revoked.delete(normalizedRef);
}

/** Internal server-only registry replacement used to revalidate current grants. */
export function replaceProducerRegistration(
  authority: ProducerAuthority,
  registration: TrustedProducerRegistration,
): void {
  if (registration.origin !== MINNI_ORIGIN || registration.policyVersion !== MINNI_PROCESSING_POLICY_VERSION) {
    throw new TypeError("producer registration policy is unsupported");
  }
  const state = authorityIdentity.get(authority);
  const current = state?.byRegistration.get(registration.registrationRef);
  if (!state || !current) throw new TypeError("producer registration is unknown");
  const principalRegistration = state.byPrincipal.get(registration.principalRef);
  if (principalRegistration && principalRegistration.registrationRef !== registration.registrationRef) {
    throw new TypeError("producer principal has multiple registrations");
  }
  state.byRegistration.set(registration.registrationRef, registration);
  state.byPrincipal.delete(current.principalRef);
  state.byPrincipal.set(registration.principalRef, registration);
  state.revoked.delete(registration.registrationRef);
}

export function assertTrustedProcessingPolicyContext(
  value: unknown,
  expected: Readonly<{ operation?: ProducerOperation; targetUserId?: string }> = {},
): asserts value is ProcessingPolicyContext {
  const object = asObject(value);
  const binding = object ? processingPolicyContextIdentity.get(object) : undefined;
  if (!binding || !isTrustedProcessingPolicyContext(value)) {
    throw new ProducerPolicyRefusalError("context_invalid");
  }
  const reason = currentContextRefusal(value, binding, expected);
  if (reason) throw new ProducerPolicyRefusalError(reason);
}

function isProducerAdmissionRefusal(value: unknown): value is ProducerAdmissionRefusal {
  const object = asObject(value);
  return Boolean(
    object
    && (object as { ok?: unknown }).ok === false
    && (object as { code?: unknown }).code === "producer_policy_refused"
    && (object as { contentFree?: unknown }).contentFree === true,
  );
}

/**
 * Mint persisted Minni provenance only from an opaque context admitted by the
 * same authority instance. Current registration state is checked again at the
 * mint point, so expiry, revocation, replacement, and grant changes cannot be
 * bypassed by retaining an earlier context. The production authority has no
 * registrations and therefore refuses until a later owner gate provisions it.
 */
export function mintProcessingLineage(
  authority: ProducerAuthority,
  context: unknown,
  deliveryEvidenceOrResolver: ProducerDeliveryEvidence | TrustedProducerDeliveryResolver = productionProducerDeliveryResolver,
): MintedProcessingLineage | ProducerAdmissionRefusal {
  const state = authorityIdentity.get(authority);
  const contextObject = asObject(context);
  const binding = contextObject ? processingPolicyContextIdentity.get(contextObject) : undefined;
  if (!state || !binding || binding.state !== state || !isTrustedProcessingPolicyContext(context)) {
    return refusal("authority_mismatch");
  }
  const beforeRefusal = currentContextRefusal(context, binding, {});
  if (beforeRefusal) return refusal(beforeRefusal);

  let evidence: ProducerDeliveryEvidence;
  const resolverKind = asObject(deliveryEvidenceOrResolver)
    ? producerDeliveryResolverIdentity.get(deliveryEvidenceOrResolver)
    : undefined;
  if (resolverKind !== undefined) {
    if (resolverKind === "unconfigured") return refusal("delivery_resolver_unconfigured");
    let resolved: ProducerDeliveryEvidence | ProducerAdmissionRefusal;
    try {
      resolved = (deliveryEvidenceOrResolver as TrustedProducerDeliveryResolver).resolve(authority, context);
    } catch {
      return refusal("delivery_evidence_invalid");
    }
    if (isProducerAdmissionRefusal(resolved)) return resolved;
    evidence = resolved;
    const afterResolverRefusal = currentContextRefusal(context, binding, {});
    if (afterResolverRefusal) return refusal(afterResolverRefusal);
  } else {
    if (deliveryEvidenceOrResolver === undefined) return refusal("delivery_resolver_unconfigured");
    const evidenceObject = asObject(deliveryEvidenceOrResolver);
    const evidenceBinding = evidenceObject
      ? producerDeliveryEvidenceIdentity.get(evidenceObject)
      : undefined;
    if (!evidenceBinding) return refusal("delivery_resolver_untrusted");
    if (evidenceBinding.state !== state || evidenceBinding.contextBinding !== binding) {
      return refusal("authority_mismatch");
    }
    evidence = deliveryEvidenceOrResolver as ProducerDeliveryEvidence;
  }

  const evidenceBinding = producerDeliveryEvidenceIdentity.get(evidence);
  if (!evidenceBinding || evidenceBinding.state !== state || evidenceBinding.contextBinding !== binding) {
    return refusal("delivery_evidence_invalid");
  }
  const restrictions = evidenceBinding.restrictions;
  const parsed = classifyProcessingLineage({
    state: PROCESSING_LINEAGE_STATE,
    origin: PROCESSING_LINEAGE_ORIGIN,
    producer_principal_ref: context.principalRef,
    producer_registration_ref: context.registrationRef,
    processing_policy_version: PROCESSING_POLICY_VERSION,
    admitted_operation: context.operation,
    target_user_id: context.targetUserId,
    delivery: {
      version: PROCESSING_LINEAGE_VERSION,
      disposition: restrictions.length > 0 ? "local_only" : "ordinary",
      restrictions,
    },
  });
  if (parsed.state !== "minni_verified") return refusal("lineage_invalid");
  const minted = Object.freeze({ ok: true as const, context, lineage: parsed.lineage });
  mintedProcessingLineageIdentity.set(minted, {
    state,
    contextBinding: binding,
    lineage: parsed.lineage,
  });
  return minted;
}

/**
 * Revalidate the exact object returned by `mintProcessingLineage` immediately
 * before a protected operation. Structural copies and parsed lineage values do
 * not carry the private binding and therefore refuse before the callback runs.
 */
export async function runWithMintedProcessingLineage<T>(
  authority: ProducerAuthority,
  minted: unknown,
  callback: (lineage: ProcessingLineageV1, context: ProcessingPolicyContext) => T | Promise<T>,
  expected: Readonly<{ operation?: ProducerOperation; targetUserId?: string }> = {},
): Promise<MintedProcessingLineageUseResult<T>> {
  const state = authorityIdentity.get(authority);
  const mintedObject = asObject(minted);
  const binding = mintedObject ? mintedProcessingLineageIdentity.get(mintedObject) : undefined;
  if (!state || !binding) return refusal("lineage_invalid");
  if (binding.state !== state) return refusal("authority_mismatch");

  const context = binding.contextBinding;
  const exactContext = context.context;
  const contextRefusal = currentContextRefusal(
    exactContext,
    context,
    expected,
  );
  if (contextRefusal) return refusal(contextRefusal);
  if (binding.lineage.target_user_id !== context.targetUserId
    || binding.lineage.admitted_operation !== context.operation
    || binding.lineage.producer_principal_ref !== context.principalRef
    || binding.lineage.producer_registration_ref !== context.registrationRef) {
    return refusal("lineage_invalid");
  }

  return {
    ok: true,
    context: exactContext,
    lineage: binding.lineage,
    value: await callback(binding.lineage, exactContext),
  };
}

export class ProducerPolicyRefusalError extends Error {
  readonly code = "producer_policy_refused" as const;
  readonly contentFree = true as const;
  readonly reason: ProducerAdmissionRefusalReason;

  constructor(reason: ProducerAdmissionRefusalReason) {
    super("producer policy refused");
    this.name = "ProducerPolicyRefusalError";
    this.reason = reason;
  }
}

/**
 * The callback is the protected pre-egress seam. A refusal returns before the
 * callback is invoked, so extraction, embedding, judging, fetching, and
 * mutation dependencies cannot observe protected content.
 */
export async function runWithProducerAdmission<T>(
  authority: ProducerAuthority,
  input: ProducerAdmissionInput,
  callback: (context: ProcessingPolicyContext) => T | Promise<T>,
): Promise<ProducerAdmission | Readonly<{ ok: true; context: ProcessingPolicyContext; value: T }>> {
  const admission = authority.resolve(input);
  if (!admission.ok) return admission;
  return { ok: true, context: admission.context, value: await callback(admission.context) };
}
