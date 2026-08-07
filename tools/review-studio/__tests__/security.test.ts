import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_CSRF_TOKEN_META,
  BOOTSTRAP_LAUNCH_TOKEN_META,
  CSRF_TOKEN_HEADER,
  LAUNCH_TOKEN_HEADER,
  LOOPBACK_HOST,
  ConfiguredRunirBackend,
  ReviewStudioSecurityBoundary,
  SecurityViolation,
  assertLoopbackBinding,
  assertNoBrowserSuppliedUpstreamUrl,
  buildBootstrapResponseHeaders,
  buildSecurityResponseHeaders,
  type RequestHeaders,
  type ReviewStudioApiRequest,
} from "../security/index.js";

const PORT = 7711;

function metaToken(document: string, name: string): string {
  const match = document.match(new RegExp(`<meta name="${name}" content="([^"]+)">`, "u"));
  if (match === null) {
    throw new Error(`missing ${name}`);
  }
  return match[1];
}

function boundary(): ReviewStudioSecurityBoundary {
  return new ReviewStudioSecurityBoundary({ binding: { port: PORT } });
}

function request(
  studio: ReviewStudioSecurityBoundary,
  launchToken: string,
  csrfToken?: string,
  overrides: Partial<ReviewStudioApiRequest> = {},
): ReviewStudioApiRequest {
  const headers: Record<string, string> = {
    host: studio.binding.canonicalHost,
    origin: studio.binding.canonicalOrigin,
    [LAUNCH_TOKEN_HEADER]: launchToken,
    "sec-fetch-site": "same-origin",
  };
  if (csrfToken !== undefined) {
    headers[CSRF_TOKEN_HEADER] = csrfToken;
  }
  return {
    method: "GET",
    url: `${studio.binding.canonicalOrigin}/api/runs`,
    headers,
    ...overrides,
  };
}

describe("review studio security boundary", () => {
  it("only accepts exact 127.0.0.1 binding and canonicalizes the authority", () => {
    expect(assertLoopbackBinding({ port: PORT })).toEqual({
      host: LOOPBACK_HOST,
      port: PORT,
      protocol: "http",
      canonicalHost: `127.0.0.1:${PORT}`,
      canonicalOrigin: `http://127.0.0.1:${PORT}`,
    });

    for (const host of ["localhost", "::1", "0.0.0.0", "127.0.0.1.", "127.0.0.2", "::ffff:127.0.0.1"]) {
      expect(() => assertLoopbackBinding({ host, port: PORT })).toThrowError(
        expect.objectContaining({ code: "non-loopback-binding" }),
      );
    }
    expect(() => assertLoopbackBinding({ port: 0 })).toThrowError(
      expect.objectContaining({ code: "invalid-port" }),
    );
  });

  it("mints distinct cryptographically strong proofs and transports them only in bootstrap metadata", () => {
    const first = boundary();
    const second = boundary();
    const firstDocument = first.renderBootstrapDocument();
    const secondDocument = second.renderBootstrapDocument();
    const launchToken = metaToken(firstDocument, BOOTSTRAP_LAUNCH_TOKEN_META);
    const csrfToken = metaToken(firstDocument, BOOTSTRAP_CSRF_TOKEN_META);

    expect(launchToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(launchToken).not.toBe(csrfToken);
    expect(launchToken).not.toBe(metaToken(secondDocument, BOOTSTRAP_LAUNCH_TOKEN_META));
    expect(csrfToken).not.toBe(metaToken(secondDocument, BOOTSTRAP_CSRF_TOKEN_META));
    expect(firstDocument).toContain(`<meta name="${BOOTSTRAP_LAUNCH_TOKEN_META}"`);
    expect(firstDocument).toContain(`<meta name="${BOOTSTRAP_CSRF_TOKEN_META}"`);
    expect(firstDocument).not.toContain("localStorage");
    expect(firstDocument).not.toContain("sessionStorage");
    expect(firstDocument).not.toContain("document.cookie");
    expect(firstDocument).not.toContain("RUNIR_API_KEY");

    const urls = [...firstDocument.matchAll(/(?:src|href)="([^"]+)"/gu)].map((match) => match[1]);
    expect(urls).toEqual(["/assets/review-studio.css", "/assets/review-studio.js"]);
    expect(urls.join(" ")).not.toContain(launchToken);
    expect(urls.join(" ")).not.toContain(csrfToken);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(launchToken);
    expect(serialized).not.toContain(csrfToken);
    expect(first.toJSON()).toMatchObject({
      tokenTransport: "bootstrap-document+custom-request-header",
      browserStorage: "forbidden",
      exportTransport: "forbidden-unredacted",
      logTransport: "forbidden-unredacted",
    });
  });

  it("requires exact Host, Origin, URL origin, and launch header", () => {
    const studio = boundary();
    const document = studio.renderBootstrapDocument();
    const launchToken = metaToken(document, BOOTSTRAP_LAUNCH_TOKEN_META);

    expect(studio.authorizeApiRequest(request(studio, launchToken))).toEqual({ allowed: true, mutation: false });
    const browserHeaders = new Headers();
    for (const [name, value] of Object.entries(request(studio, launchToken).headers)) {
      if (typeof value === "string") {
        browserHeaders.set(name, value);
      }
    }
    expect(
      studio.authorizeApiRequest({
        ...request(studio, launchToken),
        headers: browserHeaders,
      }),
    ).toEqual({ allowed: true, mutation: false });

    const badHosts = [
      "localhost:7711",
      "127.0.0.1.evil:7711",
      "127.0.0.1.:7711",
      "127.0.0.1:7712",
      "127.0.0.1:7711.evil",
      "[::1]:7711",
    ];
    for (const host of badHosts) {
      const decision = studio.authorizeApiRequest(
        request(studio, launchToken, undefined, { headers: { ...request(studio, launchToken).headers, host } }),
      );
      expect(decision).toMatchObject({ allowed: false, code: "bad-host" });
    }

    for (const origin of [
      "http://localhost:7711",
      "http://127.0.0.1:7712",
      "http://127.0.0.1.evil:7711",
      "http://127.0.0.1:7711/",
      "null",
    ]) {
      const decision = studio.authorizeApiRequest(
        request(studio, launchToken, undefined, { headers: { ...request(studio, launchToken).headers, origin } }),
      );
      expect(decision).toMatchObject({ allowed: false, code: "bad-origin" });
    }

    expect(
      studio.authorizeApiRequest(request(studio, launchToken, undefined, { url: `http://localhost:${PORT}/api/runs` })),
    ).toMatchObject({ allowed: false, code: "invalid-request-url" });
    expect(
      studio.authorizeApiRequest(request(studio, launchToken, undefined, { url: `/api/runs?launchToken=${launchToken}` })),
    ).toMatchObject({ allowed: false, code: "invalid-request-url" });
    expect(studio.authorizeApiRequest(request(studio, "wrong-token"))).toMatchObject({
      allowed: false,
      code: "invalid-launch-token",
    });
    expect(studio.authorizeApiRequest(request(studio, ""))).toMatchObject({
      allowed: false,
      code: "invalid-launch-token",
    });
  });

  it("allows origin-less safe browser reads but still requires Origin for mutations", () => {
    const studio = boundary();
    const document = studio.renderBootstrapDocument();
    const launchToken = metaToken(document, BOOTSTRAP_LAUNCH_TOKEN_META);
    const csrfToken = metaToken(document, BOOTSTRAP_CSRF_TOKEN_META);
    const safeRead = request(studio, launchToken);
    const { origin: _origin, ...originLessHeaders } = safeRead.headers as Record<string, string>;

    expect(
      studio.authorizeApiRequest({ ...safeRead, headers: originLessHeaders }),
    ).toEqual({ allowed: true, mutation: false });
    expect(
      studio.authorizeApiRequest({
        ...safeRead,
        method: "POST",
        headers: { ...originLessHeaders, [CSRF_TOKEN_HEADER]: csrfToken },
      }),
    ).toMatchObject({ allowed: false, code: "bad-origin" });
  });

  it("rejects cross-site Fetch Metadata and all CORS preflight shapes", () => {
    const studio = boundary();
    const launchToken = metaToken(studio.renderBootstrapDocument(), BOOTSTRAP_LAUNCH_TOKEN_META);
    const valid = request(studio, launchToken);

    expect(
      studio.authorizeApiRequest({
        ...valid,
        headers: { ...valid.headers, "sec-fetch-site": "cross-site" },
      }),
    ).toMatchObject({ allowed: false, code: "cross-site-fetch-metadata" });
    expect(
      studio.authorizeApiRequest({
        ...valid,
        headers: { ...valid.headers, "sec-fetch-site": "unexpected" },
      }),
    ).toMatchObject({ allowed: false, code: "invalid-fetch-metadata" });
    expect(
      studio.authorizeApiRequest({
        ...valid,
        method: "OPTIONS",
      }),
    ).toMatchObject({ allowed: false, code: "cors-not-supported" });
    expect(
      studio.authorizeApiRequest({
        ...valid,
        headers: { ...valid.headers, "access-control-request-method": "POST" },
      }),
    ).toMatchObject({ allowed: false, code: "cors-not-supported" });
    expect(buildSecurityResponseHeaders()).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(() => buildSecurityResponseHeaders({ "access-control-allow-origin": "*" })).toThrowError(
      expect.objectContaining({ code: "forbidden-cors-header" }),
    );
  });

  it("requires a distinct CSRF proof for mutations", () => {
    const studio = boundary();
    const document = studio.renderBootstrapDocument();
    const launchToken = metaToken(document, BOOTSTRAP_LAUNCH_TOKEN_META);
    const csrfToken = metaToken(document, BOOTSTRAP_CSRF_TOKEN_META);

    expect(
      studio.authorizeApiRequest(request(studio, launchToken, undefined, { method: "POST" })),
    ).toMatchObject({ allowed: false, code: "invalid-csrf-token" });
    expect(
      studio.authorizeApiRequest(request(studio, launchToken, "wrong-csrf", { method: "POST" })),
    ).toMatchObject({ allowed: false, code: "invalid-csrf-token" });
    expect(
      studio.authorizeApiRequest(request(studio, launchToken, csrfToken, { method: "POST" })),
    ).toEqual({ allowed: true, mutation: true });
    expect(
      studio.authorizeApiRequest(request(studio, launchToken, csrfToken, { method: "GET" })),
    ).toMatchObject({ allowed: false, code: "invalid-csrf-token" });
  });

  it("provides a restrictive same-origin CSP and no cacheable bootstrap policy", () => {
    const studio = boundary();
    const headers = studio.responseHeaders();
    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(headers).not.toHaveProperty("Content-Type");
    expect(buildBootstrapResponseHeaders()["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(studio.bootstrapResponseHeaders()["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("redacts launch and CSRF proofs from logs and exports", () => {
    const studio = boundary();
    const document = studio.renderBootstrapDocument();
    const launchToken = metaToken(document, BOOTSTRAP_LAUNCH_TOKEN_META);
    const csrfToken = metaToken(document, BOOTSTRAP_CSRF_TOKEN_META);
    const input = {
      launchToken,
      csrfToken,
      requestUrl: `/api/runs?token=${encodeURIComponent(launchToken)}`,
      nested: { message: `launch=${launchToken}; csrf=${csrfToken}` },
    };

    const log = studio.sanitizeForLog(input) as Record<string, unknown>;
    const exported = studio.sanitizeForExport(input) as Record<string, unknown>;
    for (const value of [JSON.stringify(log), JSON.stringify(exported)]) {
      expect(value).not.toContain(launchToken);
      expect(value).not.toContain(csrfToken);
    }
    expect(log.launchToken).toBe("[REDACTED]");
    expect(exported.csrfToken).toBe("[REDACTED]");
    expect(studio.sanitizeForExport({
      max_tokens: 512,
      promptTokens: 42,
      completionTokens: 7,
      totalTokens: 49,
      accessToken: "credential",
    })).toEqual({
      max_tokens: 512,
      promptTokens: 42,
      completionTokens: 7,
      totalTokens: 49,
      accessToken: "[REDACTED]",
    });
  });

  it("keeps RUNIR_API_KEY in the backend-only seam and fixes the upstream origin", () => {
    const apiKey = "backend-only-secret-value";
    const backend = new ConfiguredRunirBackend({
      runirBaseUrl: "http://127.0.0.1:7700",
      runirApiKey: apiKey,
      runirUserId: "owner",
    });
    const request = backend.buildRequest("/hooks/traces", { query: { limit: 200 } });

    expect(request.url).toBe("http://127.0.0.1:7700/hooks/traces?limit=200&userId=owner");
    expect(request.headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(request.url).not.toContain(apiKey);
    expect(JSON.stringify(backend)).not.toContain(apiKey);
    expect(backend.toJSON()).toEqual({
      baseUrl: "http://127.0.0.1:7700",
      userId: "owner",
      credentialMode: "backend-only",
    });

    const safeLog = backend.sanitizeForLog({
      authorization: `Bearer ${apiKey}`,
      apiKey,
      message: `upstream failure for ${apiKey}`,
    });
    expect(JSON.stringify(safeLog)).not.toContain(apiKey);

    for (const baseUrl of [
      "https://evil.example",
      "http://localhost:7700",
      "http://127.0.0.1:7700/?token=secret",
      "http://127.0.0.1:7700/path",
    ]) {
      expect(
        () => new ConfiguredRunirBackend({ runirBaseUrl: baseUrl, runirApiKey: apiKey, runirUserId: "owner" }),
      ).toThrowError(expect.objectContaining({ code: "invalid-upstream-base-url" }));
    }
    expect(
      () => new ConfiguredRunirBackend({ runirBaseUrl: "http://127.0.0.1:7700", runirApiKey: apiKey, runirUserId: "" }),
    ).toThrowError(expect.objectContaining({ code: "missing-runir-user-id" }));
    expect(
      () => new ConfiguredRunirBackend({ runirBaseUrl: "http://127.0.0.1:7700", runirApiKey: "", runirUserId: "owner" }),
    ).toThrowError(expect.objectContaining({ code: "missing-runir-api-key" }));
  });

  it("rejects browser-supplied upstream URLs, traversal, credential overrides, and secret query keys", () => {
    const backend = new ConfiguredRunirBackend({
      runirBaseUrl: "http://127.0.0.1:7700",
      runirApiKey: "backend-only-secret-value",
      runirUserId: "owner",
    });

    expect(() => backend.buildRequest("https://evil.example/hooks/traces")).toThrowError(
      expect.objectContaining({ code: "invalid-upstream-path" }),
    );
    expect(() => backend.buildRequest("//evil.example/hooks/traces")).toThrowError(
      expect.objectContaining({ code: "invalid-upstream-path" }),
    );
    expect(() => backend.buildRequest("/hooks/../admin")).toThrowError(
      expect.objectContaining({ code: "invalid-upstream-path" }),
    );
    expect(() => backend.buildRequest("/hooks/traces", { query: { userId: "attacker" } })).toThrowError(
      expect.objectContaining({ code: "invalid-upstream-query" }),
    );
    expect(() => backend.buildRequest("/hooks/traces", { query: { token: "attacker" } })).toThrowError(
      expect.objectContaining({ code: "invalid-upstream-query" }),
    );
    expect(() => backend.buildRequest("/hooks/traces", { headers: { Authorization: "Bearer attacker" } })).toThrowError(
      expect.objectContaining({ code: "reserved-backend-header" }),
    );
    expect(() => backend.buildRequest("/hooks/traces", { url: "https://evil.example" } as never)).toThrowError(
      expect.objectContaining({ code: "browser-upstream-url" }),
    );
    expect(() => assertNoBrowserSuppliedUpstreamUrl("https://evil.example")).toThrowError(
      expect.objectContaining({ code: "browser-upstream-url" }),
    );
    expect(() => assertNoBrowserSuppliedUpstreamUrl(undefined)).not.toThrow();
  });

  it("handles duplicate or malformed security headers without choosing a parser winner", () => {
    const studio = boundary();
    const launchToken = metaToken(studio.renderBootstrapDocument(), BOOTSTRAP_LAUNCH_TOKEN_META);
    const valid = request(studio, launchToken);

    const duplicateHost: RequestHeaders = {
      Host: studio.binding.canonicalHost,
      host: studio.binding.canonicalHost,
      origin: studio.binding.canonicalOrigin,
      [LAUNCH_TOKEN_HEADER]: launchToken,
    };
    expect(studio.authorizeApiRequest({ ...valid, headers: duplicateHost })).toMatchObject({
      allowed: false,
      code: "bad-host",
    });
    expect(
      studio.authorizeApiRequest({
        ...valid,
        headers: { ...valid.headers, [LAUNCH_TOKEN_HEADER]: [launchToken, launchToken] },
      }),
    ).toMatchObject({ allowed: false, code: "invalid-launch-token" });
  });

  it("exposes stable error codes without echoing attacker-controlled values", () => {
    const studio = boundary();
    expect(() => studio.assertApiRequest({
      method: "GET",
      url: `http://evil.example/?token=secret`,
      headers: {},
    })).toThrowError(SecurityViolation);
    try {
      studio.assertApiRequest({ method: "GET", url: "http://evil.example/", headers: {} });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-request-url" });
      expect(String(error)).not.toContain("evil.example");
    }
  });
});
