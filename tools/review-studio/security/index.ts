import { randomBytes, timingSafeEqual } from "node:crypto";

/** The only companion bind address supported by this first security contract. */
export const LOOPBACK_HOST = "127.0.0.1" as const;

/** Browser transport for the per-launch authorization proof. */
export const LAUNCH_TOKEN_HEADER = "x-runir-launch-token" as const;

/** Browser transport for the separate mutation proof. */
export const CSRF_TOKEN_HEADER = "x-runir-csrf-token" as const;

/** Bootstrap metadata names consumed by the local review application. */
export const BOOTSTRAP_LAUNCH_TOKEN_META = "runir-launch-token" as const;
export const BOOTSTRAP_CSRF_TOKEN_META = "runir-csrf-token" as const;

const TOKEN_BYTES = 32;
const DEFAULT_BOOTSTRAP_SCRIPT = "/assets/review-studio.js";
const DEFAULT_BOOTSTRAP_STYLESHEET = "/assets/review-studio.css";
const REDACTED = "[REDACTED]";

export type CompanionProtocol = "http" | "https";

export type SecurityFailureCode =
  | "non-loopback-binding"
  | "invalid-port"
  | "invalid-protocol"
  | "invalid-method"
  | "method-not-allowed"
  | "bad-host"
  | "bad-origin"
  | "invalid-request-url"
  | "invalid-launch-token"
  | "invalid-csrf-token"
  | "cross-site-fetch-metadata"
  | "invalid-fetch-metadata"
  | "cors-not-supported"
  | "backend-credential-from-browser"
  | "invalid-bootstrap-asset"
  | "invalid-bootstrap-title"
  | "invalid-upstream-base-url"
  | "missing-runir-api-key"
  | "missing-runir-user-id"
  | "invalid-backend-secret"
  | "browser-upstream-url"
  | "invalid-upstream-path"
  | "invalid-upstream-query"
  | "reserved-backend-header"
  | "invalid-backend-header"
  | "forbidden-cors-header";

/** A stable, non-secret error suitable for a route-level 4xx response. */
export class SecurityViolation extends Error {
  readonly code: SecurityFailureCode;

  constructor(code: SecurityFailureCode) {
    super(`review studio security policy rejected the request: ${code}`);
    this.name = "SecurityViolation";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface LoopbackBinding {
  readonly host?: string;
  readonly port: number;
  readonly protocol?: CompanionProtocol;
}

export interface CanonicalCompanionBinding {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly protocol: CompanionProtocol;
  readonly canonicalHost: string;
  readonly canonicalOrigin: string;
}

function fail(code: SecurityFailureCode): never {
  throw new SecurityViolation(code);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Validate and canonicalize the only binding currently supported by the
 * companion. `localhost`, `::1`, wildcard binds, mapped addresses, and
 * rebinding aliases are intentionally not accepted.
 */
export function assertLoopbackBinding(binding: LoopbackBinding): CanonicalCompanionBinding {
  const host = binding.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    fail("non-loopback-binding");
  }

  if (!Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65_535) {
    fail("invalid-port");
  }

  const protocol = binding.protocol ?? "http";
  if (protocol !== "http" && protocol !== "https") {
    fail("invalid-protocol");
  }

  const originUrl = new URL(`${protocol}://${LOOPBACK_HOST}:${binding.port}`);
  return Object.freeze({
    host: LOOPBACK_HOST,
    port: binding.port,
    protocol,
    canonicalHost: originUrl.host,
    canonicalOrigin: originUrl.origin,
  });
}

export type HeaderValue = string | readonly string[] | undefined;

/** Header input accepted from Node's record shape or a Fetch `Headers` object. */
export type RequestHeaders =
  | Readonly<Record<string, HeaderValue>>
  | { readonly get: (name: string) => string | null };

type HeaderRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: string };

function isHeaderGetter(value: RequestHeaders): value is { readonly get: (name: string) => string | null } {
  return typeof value === "object" && value !== null && "get" in value && typeof value.get === "function";
}

function validateHeaderValue(value: unknown): HeaderRead {
  if (value === undefined || value === null) {
    return { kind: "missing" };
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return { kind: "invalid" };
    }
    return validateHeaderValue(value[0]);
  }

  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
    return { kind: "invalid" };
  }

  // All security headers are single-valued. Reject comma-joined duplicates
  // rather than letting a proxy/parser choose a different interpretation.
  if (value.includes(",")) {
    return { kind: "invalid" };
  }

  return { kind: "value", value };
}

function readHeader(headers: RequestHeaders, name: string): HeaderRead {
  if (isHeaderGetter(headers)) {
    try {
      return validateHeaderValue(headers.get(name));
    } catch {
      return { kind: "invalid" };
    }
  }

  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length !== 1) {
    return { kind: "invalid" };
  }
  return validateHeaderValue(matches[0][1]);
}

function hasHeader(headers: RequestHeaders, name: string): boolean {
  if (isHeaderGetter(headers)) {
    try {
      return headers.get(name) !== null;
    } catch {
      return true;
    }
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

function assertTokenFormat(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    fail("invalid-launch-token");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function validateBootstrapAssetPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("..") ||
    path.includes("?") ||
    path.includes("#") ||
    hasControlCharacter(path)
  ) {
    fail("invalid-bootstrap-asset");
  }
  return path;
}

function validateBootstrapTitle(title: string): string {
  if (typeof title !== "string" || title.length === 0 || title.length > 120 || hasControlCharacter(title)) {
    fail("invalid-bootstrap-title");
  }
  return title;
}

export interface BootstrapDocumentOptions {
  readonly title?: string;
  readonly scriptPath?: string;
  readonly stylesheetPath?: string;
}

export interface ReviewStudioApiRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: RequestHeaders;
}

export type RequestAuthorizationDecision =
  | { readonly allowed: true; readonly mutation: boolean }
  | {
      readonly allowed: false;
      readonly status: 403 | 405;
      readonly code: SecurityFailureCode;
    };

function denied(code: SecurityFailureCode): RequestAuthorizationDecision {
  return {
    allowed: false,
    status: code === "method-not-allowed" || code === "invalid-method" ? 405 : 403,
    code,
  };
}

const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

function validateFetchMetadata(headers: RequestHeaders): SecurityFailureCode | undefined {
  const site = readHeader(headers, "sec-fetch-site");
  if (site.kind === "missing") {
    return undefined;
  }
  if (site.kind !== "value") {
    return "invalid-fetch-metadata";
  }

  const normalized = site.value.toLowerCase();
  if (normalized === "cross-site") {
    return "cross-site-fetch-metadata";
  }
  if (!ALLOWED_FETCH_SITES.has(normalized)) {
    return "invalid-fetch-metadata";
  }
  return undefined;
}

function containsSensitiveQueryKey(key: string): boolean {
  return /(?:token|csrf|api[_-]?key|authorization|bearer|secret|credential|password|cookie)/iu.test(key);
}

function requestUrlIsSafe(rawUrl: string, canonicalOrigin: string, secrets: readonly string[]): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || hasControlCharacter(rawUrl)) {
    return false;
  }

  for (const secret of secrets) {
    if (secret.length > 0 && (rawUrl.includes(secret) || rawUrl.includes(encodeURIComponent(secret)))) {
      return false;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl, canonicalOrigin);
  } catch {
    return false;
  }

  if (parsed.origin !== canonicalOrigin || parsed.hash.length > 0) {
    return false;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (containsSensitiveQueryKey(key) || secrets.some((secret) => value === secret)) {
      return false;
    }
  }
  return true;
}

function commonRequestFailure(
  request: ReviewStudioApiRequest,
  binding: CanonicalCompanionBinding,
  secrets: readonly string[],
  requireOrigin: boolean,
): SecurityFailureCode | undefined {
  if (typeof request.method !== "string" || request.method.length === 0 || request.method !== request.method.trim()) {
    return "invalid-method";
  }

  const method = request.method.toUpperCase();
  if (!/^[A-Z]+$/u.test(method)) {
    return "invalid-method";
  }

  // OPTIONS is rejected as a CORS/preflight surface before ordinary method
  // allowlisting so callers get the stable no-CORS contract.
  if (method === "OPTIONS") {
    return "cors-not-supported";
  }

  if (!READ_METHODS.has(method) && !MUTATION_METHODS.has(method)) {
    return "method-not-allowed";
  }

  if (!requestUrlIsSafe(request.url, binding.canonicalOrigin, secrets)) {
    return "invalid-request-url";
  }

  const host = readHeader(request.headers, "host");
  if (host.kind !== "value" || host.value !== binding.canonicalHost) {
    return "bad-host";
  }

  const origin = readHeader(request.headers, "origin");
  if (origin.kind === "invalid" || (requireOrigin && origin.kind !== "value")) {
    return "bad-origin";
  }
  if (origin.kind === "value" && origin.value !== binding.canonicalOrigin) {
    return "bad-origin";
  }

  const fetchMetadataFailure = validateFetchMetadata(request.headers);
  if (fetchMetadataFailure !== undefined) {
    return fetchMetadataFailure;
  }

  if (
    hasHeader(request.headers, "access-control-request-method") ||
    hasHeader(request.headers, "access-control-request-headers")
  ) {
    return "cors-not-supported";
  }

  if (hasHeader(request.headers, "authorization") || hasHeader(request.headers, "cookie") || hasHeader(request.headers, "x-runir-api-key")) {
    return "backend-credential-from-browser";
  }

  return undefined;
}

const SECURITY_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; media-src 'none'; manifest-src 'self'",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function hasCorsResponseHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase().startsWith("access-control-"));
}

/** Return the fixed response policy; permissive CORS headers cannot be merged in. */
export function buildSecurityResponseHeaders(
  existing: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  if (hasCorsResponseHeader(existing)) {
    fail("forbidden-cors-header");
  }
  return Object.freeze({ ...existing, ...SECURITY_RESPONSE_HEADERS });
}

/** Add the bootstrap-only media type after applying the common security policy. */
export function buildBootstrapResponseHeaders(
  existing: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...buildSecurityResponseHeaders(existing),
    "Content-Type": "text/html; charset=utf-8",
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceKnownSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.replace(new RegExp(escapeRegExp(secret), "gu"), REDACTED);
    }
  }
  return result.replace(/\bBearer\s+[^\s,;]+/giu, `Bearer ${REDACTED}`);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_-]/gu, "").toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "bearer" ||
    normalized === "cookie" ||
    normalized === "csrf" ||
    normalized === "credential" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    // Singular *Token keys are credential-shaped. Metric fields such as
    // promptTokens/completionTokens intentionally remain visible evidence.
    normalized.endsWith("token")
  );
}

function sanitizeValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return replaceKnownSecrets(value, secrets);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") {
      return "[Function]";
    }
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof URL) {
    return replaceKnownSecrets(value.href, secrets);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: replaceKnownSecrets(value.message, secrets),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, secrets, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = sanitizeValue(entryValue, secrets, seen, entryKey);
  }
  return result;
}

function sanitize(value: unknown, secrets: readonly string[]): unknown {
  return sanitizeValue(value, secrets, new WeakSet<object>());
}

export interface SecurityBoundarySummary {
  readonly binding: CanonicalCompanionBinding;
  readonly tokenTransport: "bootstrap-document+custom-request-header";
  readonly browserStorage: "forbidden";
  readonly exportTransport: "forbidden-unredacted";
  readonly logTransport: "forbidden-unredacted";
}

export interface SecurityBoundaryOptions {
  readonly binding: LoopbackBinding;
}

/**
 * Owner-local browser security boundary.
 *
 * The launch and CSRF values are private fields. There is deliberately no
 * token getter, no browser-storage helper, and no serialization method that
 * can expose either value. The browser receives them only through the
 * bootstrap metadata rendered by `renderBootstrapDocument`; request
 * authorization then accepts them only in the two named custom headers.
 */
export class ReviewStudioSecurityBoundary {
  readonly binding: CanonicalCompanionBinding;
  readonly #launchToken: string;
  readonly #csrfToken: string;

  constructor(options: SecurityBoundaryOptions) {
    this.binding = assertLoopbackBinding(options.binding);
    this.#launchToken = randomBytes(TOKEN_BYTES).toString("base64url");
    this.#csrfToken = randomBytes(TOKEN_BYTES).toString("base64url");
    assertTokenFormat(this.#launchToken);
    assertTokenFormat(this.#csrfToken);
  }

  /** Render the only document transport for the two per-launch proofs. */
  renderBootstrapDocument(options: BootstrapDocumentOptions = {}): string {
    const title = validateBootstrapTitle(options.title ?? "Rúnir Evaluation Review Studio");
    const scriptPath = validateBootstrapAssetPath(options.scriptPath ?? DEFAULT_BOOTSTRAP_SCRIPT);
    const stylesheetPath = validateBootstrapAssetPath(options.stylesheetPath ?? DEFAULT_BOOTSTRAP_STYLESHEET);

    return [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<meta name="${BOOTSTRAP_LAUNCH_TOKEN_META}" content="${escapeHtml(this.#launchToken)}">`,
      `<meta name="${BOOTSTRAP_CSRF_TOKEN_META}" content="${escapeHtml(this.#csrfToken)}">`,
      `<title>${escapeHtml(title)}</title>`,
      `<link rel="stylesheet" href="${escapeHtml(stylesheetPath)}">`,
      "</head>",
      '<body><main id="review-studio" aria-live="polite"></main>',
      `<script type="module" src="${escapeHtml(scriptPath)}" defer></script>`,
      "</body>",
      "</html>",
    ].join("");
  }

  /** Bootstrap navigation is pre-token and may omit Origin, but is still exact-host and loopback-only. */
  authorizeBootstrapRequest(request: ReviewStudioApiRequest): RequestAuthorizationDecision {
    const failure = commonRequestFailure(request, this.binding, [this.#launchToken, this.#csrfToken], false);
    if (failure !== undefined) {
      return denied(failure);
    }
    const method = request.method.toUpperCase();
    if (!READ_METHODS.has(method)) {
      return denied("method-not-allowed");
    }
    return { allowed: true, mutation: false };
  }

  /** Every API request must carry launch authorization; mutations also need the separate CSRF proof. */
  authorizeApiRequest(request: ReviewStudioApiRequest): RequestAuthorizationDecision {
    // Browsers do not attach Origin to ordinary same-origin GET/HEAD fetches,
    // and script cannot set that forbidden header itself. Require Origin for
    // every mutation; safe reads still require the launch proof, exact Host,
    // same-origin URL, and reject cross-site Fetch Metadata when present.
    const requireOrigin = MUTATION_METHODS.has(request.method.toUpperCase());
    const failure = commonRequestFailure(
      request,
      this.binding,
      [this.#launchToken, this.#csrfToken],
      requireOrigin,
    );
    if (failure !== undefined) {
      return denied(failure);
    }

    const method = request.method.toUpperCase();
    const mutation = MUTATION_METHODS.has(method);
    const launchHeader = readHeader(request.headers, LAUNCH_TOKEN_HEADER);
    if (launchHeader.kind !== "value" || !safeTokenEqual(launchHeader.value, this.#launchToken)) {
      return denied("invalid-launch-token");
    }

    const csrfHeader = readHeader(request.headers, CSRF_TOKEN_HEADER);
    if (mutation) {
      if (csrfHeader.kind !== "value" || !safeTokenEqual(csrfHeader.value, this.#csrfToken)) {
        return denied("invalid-csrf-token");
      }
    } else if (csrfHeader.kind !== "missing") {
      return denied("invalid-csrf-token");
    }

    return { allowed: true, mutation };
  }

  /** Throwing form for thin route handlers that want one fail-closed guard. */
  assertApiRequest(request: ReviewStudioApiRequest): void {
    const decision = this.authorizeApiRequest(request);
    if (!decision.allowed) {
      fail(decision.code);
    }
  }

  /** Apply the fixed CSP/no-store/same-origin response policy. */
  responseHeaders(existing: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
    return buildSecurityResponseHeaders(existing);
  }

  /** Bootstrap-only response helper; JSON/API routes retain their own media type. */
  bootstrapResponseHeaders(existing: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
    return buildBootstrapResponseHeaders(existing);
  }

  /** Redact launch/CSRF values before any log sink receives an event. */
  sanitizeForLog(value: unknown): unknown {
    return sanitize(value, [this.#launchToken, this.#csrfToken]);
  }

  /** Redact launch/CSRF values before a report/export leaves the review surface. */
  sanitizeForExport(value: unknown): unknown {
    return sanitize(value, [this.#launchToken, this.#csrfToken]);
  }

  /** Safe projection for diagnostics; neither per-launch proof is enumerable or serializable. */
  toJSON(): SecurityBoundarySummary {
    return {
      binding: this.binding,
      tokenTransport: "bootstrap-document+custom-request-header",
      browserStorage: "forbidden",
      exportTransport: "forbidden-unredacted",
      logTransport: "forbidden-unredacted",
    };
  }
}

export interface ConfiguredRunirBackendOptions {
  /** Explicit fixed server-side base URL; never accept this from a browser request. */
  readonly runirBaseUrl: string;
  /** Server-side bearer only; never pass this object or request headers to the browser. */
  readonly runirApiKey: string;
  /** Explicit user scope; this module never supplies a default user. */
  readonly runirUserId: string;
}

export interface BackendRequestOptions {
  readonly method?: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Existing Rúnir reads use an explicit userId query parameter. The trace
   * rating route is the one exception: its existing contract takes userId in
   * the JSON body, so the server-owned identity can be placed there without
   * trusting a browser body.
   */
  readonly userIdPlacement?: "query" | "body" | "both";
}

export interface BackendRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

function assertBackendSecret(value: unknown, missingCode: SecurityFailureCode): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || hasControlCharacter(value) || /\s/u.test(value)) {
    fail(missingCode);
  }
  return value;
}

function parseConfiguredRunirBaseUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) {
    fail("invalid-upstream-base-url");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("invalid-upstream-base-url");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname !== LOOPBACK_HOST ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.port.length === 0
  ) {
    fail("invalid-upstream-base-url");
  }
  return new URL(`${parsed.origin}/`);
}

function assertSafeUpstreamPath(pathname: string): string {
  if (
    typeof pathname !== "string" ||
    pathname.length === 0 ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    hasControlCharacter(pathname)
  ) {
    fail("invalid-upstream-path");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    fail("invalid-upstream-path");
  }
  if (/(?:^|\/)(?:\.{1,2})(?:\/|$)/u.test(decoded)) {
    fail("invalid-upstream-path");
  }
  return pathname;
}

function assertSafeQuery(query: Readonly<Record<string, string | number | boolean>> | undefined): void {
  if (query === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) || key.toLowerCase() === "userid" || containsSensitiveQueryKey(key)) {
      fail("invalid-upstream-query");
    }
    if (
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      (typeof value === "string" && (hasControlCharacter(value) || value.includes("\n") || value.includes("\r")))
    ) {
      fail("invalid-upstream-query");
    }
  }
}

const RESERVED_BACKEND_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-runir-api-key",
  "x-runir-user-id",
  LAUNCH_TOKEN_HEADER,
  CSRF_TOKEN_HEADER,
]);

function assertSafeBackendHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  if (headers === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (RESERVED_BACKEND_HEADERS.has(name.toLowerCase())) {
      fail("reserved-backend-header");
    }
    if (typeof value !== "string" || hasControlCharacter(value)) {
      fail("invalid-backend-header");
    }
  }
}

export interface ConfiguredRunirBackendSummary {
  readonly baseUrl: string;
  readonly userId: string;
  readonly credentialMode: "backend-only";
}

/**
 * Server-side-only Rúnir request seam. It accepts a relative endpoint path,
 * appends the configured user scope, and owns the bearer header. There is no
 * method accepting a browser URL or a way to serialize the API key.
 */
export class ConfiguredRunirBackend {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #userId: string;

  constructor(options: ConfiguredRunirBackendOptions) {
    this.#baseUrl = parseConfiguredRunirBaseUrl(options.runirBaseUrl);
    this.#apiKey = assertBackendSecret(options.runirApiKey, "missing-runir-api-key");
    this.#userId = assertBackendSecret(options.runirUserId, "missing-runir-user-id");
  }

  /** Server-owned identity for backend request bodies; never read from a browser request. */
  get userId(): string {
    return this.#userId;
  }

  buildRequest(pathname: string, options: BackendRequestOptions = {}): BackendRequest {
    const unknownOptions = options as Record<string, unknown>;
    if ("url" in unknownOptions || "upstreamUrl" in unknownOptions || "baseUrl" in unknownOptions) {
      fail("browser-upstream-url");
    }

    const safePath = assertSafeUpstreamPath(pathname);
    assertSafeQuery(options.query);
    assertSafeBackendHeaders(options.headers);

    const url = new URL(safePath, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      fail("invalid-upstream-path");
    }

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      query.set(key, String(value));
    }
    const userIdPlacement = options.userIdPlacement ?? "query";
    if (userIdPlacement !== "query" && userIdPlacement !== "body" && userIdPlacement !== "both") {
      fail("invalid-upstream-query");
    }
    if (userIdPlacement === "query" || userIdPlacement === "both") {
      query.set("userId", this.#userId);
    }
    url.search = query.toString();

    const method = options.method ?? "GET";
    if (typeof method !== "string" || method.length === 0 || method !== method.trim() || !/^[A-Za-z]+$/u.test(method)) {
      fail("invalid-method");
    }

    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${this.#apiKey}`,
    };
    return Object.freeze({
      url: url.href,
      method: method.toUpperCase(),
      headers: Object.freeze(headers),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  }

  sanitizeForLog(value: unknown): unknown {
    return sanitize(value, [this.#apiKey]);
  }

  toJSON(): ConfiguredRunirBackendSummary {
    return {
      baseUrl: this.#baseUrl.origin,
      userId: this.#userId,
      credentialMode: "backend-only",
    };
  }
}

/** Explicit guard for route adapters: only a server-owned relative path may reach the backend seam. */
export function assertNoBrowserSuppliedUpstreamUrl(value: unknown): void {
  if (value !== undefined && value !== null) {
    fail("browser-upstream-url");
  }
}
