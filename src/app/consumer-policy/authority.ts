/**
 * Internal consumer authority for Minni delivery.
 *
 * Consumer identity is a separate capability from producer identity and from
 * the persisted processing lineage. Request labels, a general bearer, and
 * copied values never create a trusted consumer context. The production
 * registry is empty until a later reviewed owner gate provisions it.
 */

import {
  PROCESSING_LINEAGE_RESTRICTIONS,
  type ProcessingLineageRestriction,
} from "../../domain/memory/processing-lineage.js";

export const CONSUMER_OPERATIONS = ["recall", "summary_delivery"] as const;
export const CONSUMER_PROVIDERS = [
  "openai",
  "anthropic",
  "xai",
  "local_hermes",
  "cloud_hermes",
] as const;
export const CONSUMER_CLIENTS = ["codex", "claude", "grok", "pi", "hermes"] as const;
export const CONSUMER_LOCALITIES = ["same_device", "cloud"] as const;
export const CONSUMER_TIERS = ["ordinary", "restricted"] as const;

export type ConsumerOperation = (typeof CONSUMER_OPERATIONS)[number];
export type ConsumerProvider = (typeof CONSUMER_PROVIDERS)[number];
export type ConsumerClient = (typeof CONSUMER_CLIENTS)[number];
export type ConsumerLocality = (typeof CONSUMER_LOCALITIES)[number];
export type ConsumerTier = (typeof CONSUMER_TIERS)[number];
export type ConsumerPrincipalRef = string & { readonly __consumerPrincipalRef: unique symbol };
export type ConsumerRegistrationRef = string & { readonly __consumerRegistrationRef: unique symbol };

export type ConsumerPrincipal = Readonly<{
  principalRef: ConsumerPrincipalRef;
  authenticatedBy: "server";
}>;

export type ServerResolvedConsumerTargetUser = Readonly<{
  userId: string;
}>;

export type ServerSelectedConsumerOperation = Readonly<{
  name: ConsumerOperation;
}>;

export type ServerSelectedConsumerTier = Readonly<{
  name: ConsumerTier;
}>;

export type ConsumerRegistration = Readonly<{
  registrationRef: ConsumerRegistrationRef;
  principalRef: ConsumerPrincipalRef;
  provider: ConsumerProvider;
  client: ConsumerClient;
  locality: ConsumerLocality;
  authorizedOperations: readonly ConsumerOperation[];
  authorizedTargetUsers: readonly string[];
  authorizedTiers: readonly ConsumerTier[];
  allowOrdinary: boolean;
  allowedLocalOnlyRestrictions: readonly ProcessingLineageRestriction[];
  status: "active" | "revoked";
  expiresAt?: string;
}>;

export type ConsumerDeliveryContext = Readonly<{
  principalRef: ConsumerPrincipalRef;
  registrationRef: ConsumerRegistrationRef;
  provider: ConsumerProvider;
  client: ConsumerClient;
  locality: ConsumerLocality;
  operation: ConsumerOperation;
  targetUserId: string;
  tier: ConsumerTier;
}>;

export type ConsumerAdmissionRefusalReason =
  | "principal_missing"
  | "principal_untrusted"
  | "target_user_missing"
  | "target_user_untrusted"
  | "requested_user_mismatch"
  | "operation_untrusted"
  | "tier_untrusted"
  | "registration_missing"
  | "registration_mismatch"
  | "registration_revoked"
  | "registration_expired"
  | "operation_not_authorized"
  | "target_user_not_authorized"
  | "tier_not_authorized"
  | "context_invalid"
  | "authority_mismatch";

export type ConsumerAdmissionRefusal = Readonly<{
  ok: false;
  code: "consumer_policy_refused";
  reason: ConsumerAdmissionRefusalReason;
  contentFree: true;
}>;

export type ConsumerAdmission =
  | Readonly<{ ok: true; context: ConsumerDeliveryContext }>
  | ConsumerAdmissionRefusal;

export type ConsumerAdmissionInput = Readonly<{
  /** Must be created by server authentication, never from request JSON. */
  principal?: ConsumerPrincipal | null;
  /** Must be selected by the server dispatch, never by a body label. */
  operation?: ServerSelectedConsumerOperation | null;
  /** Must be selected by server policy for this consumer tier. */
  tier?: ServerSelectedConsumerTier | null;
  /** Must be resolved by server user/tenant policy. */
  targetUser?: ServerResolvedConsumerTargetUser | null;
  /** Optional request value checked against the server target, never authoritative. */
  requestedUserId?: unknown;
}>;

export interface ConsumerAuthority {
  resolve(input: ConsumerAdmissionInput): ConsumerAdmission;
}

export type CurrentConsumerDeliveryGrant = Readonly<{
  context: ConsumerDeliveryContext;
  registrationRef: ConsumerRegistrationRef;
  provider: ConsumerProvider;
  client: ConsumerClient;
  locality: ConsumerLocality;
  allowOrdinary: boolean;
  allowedLocalOnlyRestrictions: readonly ProcessingLineageRestriction[];
  status: "active";
  expiresAt?: string;
}>;

type ConsumerAuthorityState = {
  readonly byPrincipal: Map<string, ConsumerRegistration>;
  readonly byRegistration: Map<string, ConsumerRegistration>;
  readonly revoked: Set<string>;
};

type ConsumerContextBinding = Readonly<{
  state: ConsumerAuthorityState;
  principalRef: ConsumerPrincipalRef;
  registrationRef: ConsumerRegistrationRef;
  provider: ConsumerProvider;
  client: ConsumerClient;
  locality: ConsumerLocality;
  operation: ConsumerOperation;
  targetUserId: string;
  tier: ConsumerTier;
}>;

const consumerPrincipalIdentity = new WeakMap<object, ConsumerPrincipalRef>();
const consumerTargetIdentity = new WeakMap<object, string>();
const consumerOperationIdentity = new WeakMap<object, ConsumerOperation>();
const consumerTierIdentity = new WeakMap<object, ConsumerTier>();
const consumerRegistrationIdentity = new WeakMap<object, true>();
const consumerContextIdentity = new WeakMap<object, ConsumerContextBinding>();
const consumerAuthorityIdentity = new WeakMap<ConsumerAuthority, ConsumerAuthorityState>();

function refusal(reason: ConsumerAdmissionRefusalReason): ConsumerAdmissionRefusal {
  return Object.freeze({
    ok: false,
    code: "consumer_policy_refused",
    reason,
    contentFree: true,
  });
}

function nonEmptyBoundedString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value;
}

function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function isConsumerOperation(value: unknown): value is ConsumerOperation {
  return typeof value === "string" && (CONSUMER_OPERATIONS as readonly string[]).includes(value);
}

function isConsumerProvider(value: unknown): value is ConsumerProvider {
  return typeof value === "string" && (CONSUMER_PROVIDERS as readonly string[]).includes(value);
}

function isConsumerClient(value: unknown): value is ConsumerClient {
  return typeof value === "string" && (CONSUMER_CLIENTS as readonly string[]).includes(value);
}

function isConsumerLocality(value: unknown): value is ConsumerLocality {
  return typeof value === "string" && (CONSUMER_LOCALITIES as readonly string[]).includes(value);
}

function isConsumerTier(value: unknown): value is ConsumerTier {
  return typeof value === "string" && (CONSUMER_TIERS as readonly string[]).includes(value);
}

function canonicalRestrictions(
  restrictions: readonly ProcessingLineageRestriction[],
): readonly ProcessingLineageRestriction[] {
  if (restrictions.some((restriction) => !PROCESSING_LINEAGE_RESTRICTIONS.includes(restriction))) {
    throw new TypeError("consumer restriction grants are unsupported");
  }
  const set = new Set(restrictions);
  return Object.freeze(PROCESSING_LINEAGE_RESTRICTIONS.filter((restriction) => set.has(restriction)));
}

function isServerAuthenticatedConsumerPrincipal(value: unknown): value is ConsumerPrincipal {
  const object = asObject(value);
  if (!object) return false;
  const principalRef = consumerPrincipalIdentity.get(object);
  return Boolean(
    principalRef !== undefined
    && (value as { principalRef?: unknown }).principalRef === principalRef
    && (value as { authenticatedBy?: unknown }).authenticatedBy === "server"
    && nonEmptyBoundedString(principalRef),
  );
}

function isServerResolvedConsumerTarget(value: unknown): value is ServerResolvedConsumerTargetUser {
  const object = asObject(value);
  if (!object) return false;
  const userId = consumerTargetIdentity.get(object);
  return Boolean(
    userId !== undefined
    && (value as { userId?: unknown }).userId === userId
    && nonEmptyBoundedString(userId),
  );
}

function isServerSelectedConsumerOperation(value: unknown): value is ServerSelectedConsumerOperation {
  const object = asObject(value);
  if (!object) return false;
  const operation = consumerOperationIdentity.get(object);
  return Boolean(
    operation !== undefined
    && (value as { name?: unknown }).name === operation,
  );
}

function isServerSelectedConsumerTier(value: unknown): value is ServerSelectedConsumerTier {
  const object = asObject(value);
  if (!object) return false;
  const tier = consumerTierIdentity.get(object);
  return Boolean(
    tier !== undefined
    && (value as { name?: unknown }).name === tier,
  );
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function contextFieldsMatchBinding(
  context: ConsumerDeliveryContext,
  binding: ConsumerContextBinding,
): boolean {
  return context.principalRef === binding.principalRef
    && context.registrationRef === binding.registrationRef
    && context.provider === binding.provider
    && context.client === binding.client
    && context.locality === binding.locality
    && context.operation === binding.operation
    && context.targetUserId === binding.targetUserId
    && context.tier === binding.tier;
}

function consumerGrantSnapshotMatches(
  initial: CurrentConsumerDeliveryGrant,
  current: CurrentConsumerDeliveryGrant,
): boolean {
  return initial.context === current.context
    && initial.registrationRef === current.registrationRef
    && initial.provider === current.provider
    && initial.client === current.client
    && initial.locality === current.locality
    && initial.allowOrdinary === current.allowOrdinary
    && initial.status === current.status
    && initial.expiresAt === current.expiresAt
    && initial.allowedLocalOnlyRestrictions.length === current.allowedLocalOnlyRestrictions.length
    && initial.allowedLocalOnlyRestrictions.every(
      (restriction, index) => restriction === current.allowedLocalOnlyRestrictions[index],
    );
}

function isTrustedConsumerContext(value: unknown): value is ConsumerDeliveryContext {
  const object = asObject(value);
  if (!object) return false;
  const binding = consumerContextIdentity.get(object);
  return binding !== undefined && contextFieldsMatchBinding(value as ConsumerDeliveryContext, binding);
}

function currentContextRefusal(
  context: ConsumerDeliveryContext,
  binding: ConsumerContextBinding,
): ConsumerAdmissionRefusalReason | undefined {
  const registration = binding.state.byRegistration.get(binding.registrationRef);
  if (!registration) return "registration_missing";
  if (registration.registrationRef !== binding.registrationRef || registration.principalRef !== binding.principalRef) {
    return "registration_mismatch";
  }
  const principalRegistration = binding.state.byPrincipal.get(binding.principalRef);
  if (!principalRegistration || principalRegistration.registrationRef !== binding.registrationRef) {
    return "registration_mismatch";
  }
  if (
    registration.provider !== binding.provider
    || registration.client !== binding.client
    || registration.locality !== binding.locality
  ) return "registration_mismatch";
  if (binding.state.revoked.has(binding.registrationRef) || registration.status !== "active") {
    return "registration_revoked";
  }
  if (isExpired(registration.expiresAt)) return "registration_expired";
  if (!registration.authorizedOperations.includes(binding.operation)) return "operation_not_authorized";
  if (!registration.authorizedTargetUsers.includes(binding.targetUserId)) return "target_user_not_authorized";
  if (!registration.authorizedTiers.includes(binding.tier)) return "tier_not_authorized";
  if (!contextFieldsMatchBinding(context, binding)) return "context_invalid";
  return undefined;
}

function bindingForContext(
  authority: ConsumerAuthority,
  value: unknown,
): Readonly<{ state: ConsumerAuthorityState; binding: ConsumerContextBinding; context: ConsumerDeliveryContext }> | ConsumerAdmissionRefusal {
  const state = consumerAuthorityIdentity.get(authority);
  const object = asObject(value);
  const binding = object ? consumerContextIdentity.get(object) : undefined;
  if (!state) return refusal("authority_mismatch");
  if (!binding) return refusal("context_invalid");
  if (binding.state !== state) return refusal("authority_mismatch");
  if (!isTrustedConsumerContext(value)) return refusal("context_invalid");
  const context = value as ConsumerDeliveryContext;
  const currentRefusal = currentContextRefusal(context, binding);
  if (currentRefusal) return refusal(currentRefusal);
  return { state, binding, context };
}

export function createServerAuthenticatedConsumerPrincipal(principalRef: string): ConsumerPrincipal {
  if (!nonEmptyBoundedString(principalRef)) throw new TypeError("consumer principal reference is required");
  const principal = Object.freeze({
    principalRef: principalRef as ConsumerPrincipalRef,
    authenticatedBy: "server" as const,
  }) as ConsumerPrincipal;
  consumerPrincipalIdentity.set(principal, principal.principalRef);
  return principal;
}

export function createServerResolvedConsumerTargetUser(userId: string): ServerResolvedConsumerTargetUser {
  if (!nonEmptyBoundedString(userId)) throw new TypeError("consumer target user is required");
  const target = Object.freeze({ userId }) as ServerResolvedConsumerTargetUser;
  consumerTargetIdentity.set(target, target.userId);
  return target;
}

export function createServerSelectedConsumerOperation(operation: ConsumerOperation): ServerSelectedConsumerOperation {
  if (!isConsumerOperation(operation)) throw new TypeError("consumer operation is unsupported");
  const selected = Object.freeze({ name: operation }) as ServerSelectedConsumerOperation;
  consumerOperationIdentity.set(selected, selected.name);
  return selected;
}

export function createServerSelectedConsumerTier(tier: ConsumerTier): ServerSelectedConsumerTier {
  if (!isConsumerTier(tier)) throw new TypeError("consumer tier is unsupported");
  const selected = Object.freeze({ name: tier }) as ServerSelectedConsumerTier;
  consumerTierIdentity.set(selected, selected.name);
  return selected;
}

/** Synthetic reviewed registration construction is internal/test-only. */
export function createReviewedConsumerRegistration(input: {
  registrationRef: string;
  principalRef: string;
  provider: ConsumerProvider;
  client: ConsumerClient;
  locality: ConsumerLocality;
  authorizedOperations: readonly ConsumerOperation[];
  authorizedTargetUsers: readonly string[];
  authorizedTiers: readonly ConsumerTier[];
  allowOrdinary: boolean;
  allowedLocalOnlyRestrictions: readonly ProcessingLineageRestriction[];
  status?: "active" | "revoked";
  expiresAt?: string;
}): ConsumerRegistration {
  if (!nonEmptyBoundedString(input.registrationRef) || !nonEmptyBoundedString(input.principalRef)) {
    throw new TypeError("consumer registration references are required");
  }
  if (!isConsumerProvider(input.provider) || !isConsumerClient(input.client) || !isConsumerLocality(input.locality)) {
    throw new TypeError("consumer provider, client, or locality is unsupported");
  }
  if (input.authorizedOperations.length === 0 || input.authorizedOperations.some((operation) => !isConsumerOperation(operation))) {
    throw new TypeError("consumer registration operations are invalid");
  }
  if (input.authorizedTiers.length === 0 || input.authorizedTiers.some((tier) => !isConsumerTier(tier))) {
    throw new TypeError("consumer registration tiers are invalid");
  }
  const targetUsers = input.authorizedTargetUsers.map((userId) => userId.trim()).filter(Boolean);
  if (targetUsers.length === 0 || targetUsers.some((userId) => !nonEmptyBoundedString(userId))) {
    throw new TypeError("consumer registration target users are invalid");
  }
  if (typeof input.allowOrdinary !== "boolean") throw new TypeError("consumer ordinary grant is invalid");
  if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new TypeError("consumer registration expiry is invalid");
  }
  const registration = Object.freeze({
    registrationRef: input.registrationRef as ConsumerRegistrationRef,
    principalRef: input.principalRef as ConsumerPrincipalRef,
    provider: input.provider,
    client: input.client,
    locality: input.locality,
    authorizedOperations: Object.freeze([...new Set(input.authorizedOperations)]),
    authorizedTargetUsers: Object.freeze([...new Set(targetUsers)]),
    authorizedTiers: Object.freeze([...new Set(input.authorizedTiers)]),
    allowOrdinary: input.allowOrdinary,
    allowedLocalOnlyRestrictions: canonicalRestrictions(input.allowedLocalOnlyRestrictions),
    status: input.status ?? "active",
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  consumerRegistrationIdentity.set(registration, true);
  return registration;
}

function buildContext(
  state: ConsumerAuthorityState,
  principal: ConsumerPrincipal,
  registration: ConsumerRegistration,
  operation: ConsumerOperation,
  targetUserId: string,
  tier: ConsumerTier,
): ConsumerDeliveryContext {
  const context = Object.freeze({
    principalRef: principal.principalRef,
    registrationRef: registration.registrationRef,
    provider: registration.provider,
    client: registration.client,
    locality: registration.locality,
    operation,
    targetUserId,
    tier,
  }) as ConsumerDeliveryContext;
  consumerContextIdentity.set(context, {
    state,
    principalRef: principal.principalRef,
    registrationRef: registration.registrationRef,
    provider: registration.provider,
    client: registration.client,
    locality: registration.locality,
    operation,
    targetUserId,
    tier,
  });
  return context;
}

export function createConsumerAuthority(
  registrations: readonly ConsumerRegistration[] = [],
): ConsumerAuthority {
  const state: ConsumerAuthorityState = {
    byPrincipal: new Map(),
    byRegistration: new Map(),
    revoked: new Set(),
  };
  for (const registration of registrations) {
    if (!asObject(registration) || !consumerRegistrationIdentity.has(registration)) {
      throw new TypeError("consumer registration must come from reviewed server construction");
    }
    if (state.byPrincipal.has(registration.principalRef)) throw new TypeError("consumer principal has multiple registrations");
    if (state.byRegistration.has(registration.registrationRef)) throw new TypeError("consumer registration reference is duplicated");
    state.byPrincipal.set(registration.principalRef, registration);
    state.byRegistration.set(registration.registrationRef, registration);
  }

  const authority: ConsumerAuthority = Object.freeze({
    resolve(input: ConsumerAdmissionInput): ConsumerAdmission {
      if (input.principal === undefined || input.principal === null) return refusal("principal_missing");
      if (!isServerAuthenticatedConsumerPrincipal(input.principal)) return refusal("principal_untrusted");
      if (input.targetUser === undefined || input.targetUser === null) return refusal("target_user_missing");
      if (!isServerResolvedConsumerTarget(input.targetUser)) return refusal("target_user_untrusted");
      if (!isServerSelectedConsumerOperation(input.operation)) return refusal("operation_untrusted");
      if (!isServerSelectedConsumerTier(input.tier)) return refusal("tier_untrusted");
      if (input.requestedUserId !== undefined && input.requestedUserId !== input.targetUser.userId) {
        return refusal("requested_user_mismatch");
      }
      const registration = state.byPrincipal.get(input.principal.principalRef);
      if (!registration) return refusal("registration_missing");
      if (registration.principalRef !== input.principal.principalRef) return refusal("registration_mismatch");
      if (state.revoked.has(registration.registrationRef) || registration.status !== "active") return refusal("registration_revoked");
      if (isExpired(registration.expiresAt)) return refusal("registration_expired");
      if (!registration.authorizedOperations.includes(input.operation.name)) return refusal("operation_not_authorized");
      if (!registration.authorizedTargetUsers.includes(input.targetUser.userId)) return refusal("target_user_not_authorized");
      if (!registration.authorizedTiers.includes(input.tier.name)) return refusal("tier_not_authorized");
      return Object.freeze({
        ok: true as const,
        context: buildContext(state, input.principal, registration, input.operation.name, input.targetUser.userId, input.tier.name),
      });
    },
  });
  consumerAuthorityIdentity.set(authority, state);
  return authority;
}

/** Empty by construction: no production consumer registration is active. */
export const productionConsumerAuthority = createConsumerAuthority();

export function revokeConsumerRegistration(authority: ConsumerAuthority, registrationRef: string): void {
  const state = consumerAuthorityIdentity.get(authority);
  if (!state || !nonEmptyBoundedString(registrationRef) || !state.byRegistration.has(registrationRef)) {
    throw new TypeError("consumer registration is unknown");
  }
  state.revoked.add(registrationRef);
}

export function removeConsumerRegistration(authority: ConsumerAuthority, registrationRef: string): void {
  const state = consumerAuthorityIdentity.get(authority);
  const registration = state?.byRegistration.get(registrationRef);
  if (!state || !registration) throw new TypeError("consumer registration is unknown");
  state.byRegistration.delete(registrationRef);
  state.byPrincipal.delete(registration.principalRef);
  state.revoked.delete(registrationRef);
}

export function replaceConsumerRegistration(authority: ConsumerAuthority, registration: ConsumerRegistration): void {
  const state = consumerAuthorityIdentity.get(authority);
  const current = state?.byRegistration.get(registration.registrationRef);
  if (!state || !current) throw new TypeError("consumer registration is unknown");
  if (!consumerRegistrationIdentity.has(registration)) {
    throw new TypeError("consumer registration must come from reviewed server construction");
  }
  const principalRegistration = state.byPrincipal.get(registration.principalRef);
  if (principalRegistration && principalRegistration.registrationRef !== registration.registrationRef) {
    throw new TypeError("consumer principal has multiple registrations");
  }
  state.byRegistration.set(registration.registrationRef, registration);
  state.byPrincipal.delete(current.principalRef);
  state.byPrincipal.set(registration.principalRef, registration);
  state.revoked.delete(registration.registrationRef);
}

export function assertTrustedConsumerDeliveryContext(
  authority: ConsumerAuthority,
  value: unknown,
): asserts value is ConsumerDeliveryContext {
  const current = bindingForContext(authority, value);
  if (!("state" in current)) throw new ConsumerPolicyRefusalError(current.reason);
}

export function getCurrentConsumerDeliveryGrant(
  authority: ConsumerAuthority,
  value: unknown,
): CurrentConsumerDeliveryGrant | ConsumerAdmissionRefusal {
  const current = bindingForContext(authority, value);
  if (!("state" in current)) return current;
  const registration = current.state.byRegistration.get(current.binding.registrationRef);
  if (!registration) return refusal("registration_missing");
  return Object.freeze({
    context: current.context,
    registrationRef: registration.registrationRef,
    provider: registration.provider,
    client: registration.client,
    locality: registration.locality,
    allowOrdinary: registration.allowOrdinary,
    allowedLocalOnlyRestrictions: registration.allowedLocalOnlyRestrictions,
    status: "active" as const,
    ...(registration.expiresAt ? { expiresAt: registration.expiresAt } : {}),
  });
}

export class ConsumerPolicyRefusalError extends Error {
  readonly code = "consumer_policy_refused" as const;
  readonly contentFree = true as const;
  readonly reason: ConsumerAdmissionRefusalReason;

  constructor(reason: ConsumerAdmissionRefusalReason) {
    super("consumer policy refused");
    this.name = "ConsumerPolicyRefusalError";
    this.reason = reason;
  }
}

export async function runWithConsumerAdmission<T>(
  authority: ConsumerAuthority,
  input: ConsumerAdmissionInput,
  callback: (context: ConsumerDeliveryContext) => T | Promise<T>,
): Promise<ConsumerAdmission | Readonly<{ ok: true; context: ConsumerDeliveryContext; value: T }>> {
  const admission = authority.resolve(input);
  if (!admission.ok) return admission;
  const initialGrant = getCurrentConsumerDeliveryGrant(authority, admission.context);
  if (!("context" in initialGrant)) return initialGrant;
  const value = await callback(admission.context);
  const currentGrant = getCurrentConsumerDeliveryGrant(authority, admission.context);
  if (!("context" in currentGrant)) return currentGrant;
  if (!consumerGrantSnapshotMatches(initialGrant, currentGrant)) return refusal("context_invalid");
  return Object.freeze({ ok: true as const, context: admission.context, value });
}
