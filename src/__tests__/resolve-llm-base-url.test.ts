import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLlmBaseUrl } from "../shared/config";

const ENV_KEY = "RUNIR_LLM_BASE_URL";
const DEFAULT = "https://openrouter.ai/api/v1";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = saved;
  }
});

describe("resolveLlmBaseUrl", () => {
  it("returns the default when RUNIR_LLM_BASE_URL is unset", () => {
    expect(resolveLlmBaseUrl()).toBe(DEFAULT);
  });

  it("returns the default when RUNIR_LLM_BASE_URL is empty string", () => {
    process.env[ENV_KEY] = "";
    expect(resolveLlmBaseUrl()).toBe(DEFAULT);
  });

  it("returns the default when RUNIR_LLM_BASE_URL is whitespace only", () => {
    process.env[ENV_KEY] = "   ";
    expect(resolveLlmBaseUrl()).toBe(DEFAULT);
  });

  it("returns the override when set", () => {
    process.env[ENV_KEY] = "http://localhost:7811";
    expect(resolveLlmBaseUrl()).toBe("http://localhost:7811");
  });

  it("strips a single trailing slash", () => {
    process.env[ENV_KEY] = "http://localhost:7811/";
    expect(resolveLlmBaseUrl()).toBe("http://localhost:7811");
  });

  it("strips multiple trailing slashes", () => {
    process.env[ENV_KEY] = "http://localhost:7811///";
    expect(resolveLlmBaseUrl()).toBe("http://localhost:7811");
  });

  it("trims leading/trailing whitespace", () => {
    process.env[ENV_KEY] = "  http://localhost:7811  ";
    expect(resolveLlmBaseUrl()).toBe("http://localhost:7811");
  });

  it("trims whitespace AND strips trailing slash together", () => {
    process.env[ENV_KEY] = "  http://localhost:7811/api/v1/  ";
    expect(resolveLlmBaseUrl()).toBe("http://localhost:7811/api/v1");
  });

  it("preserves a path segment with no trailing slash", () => {
    process.env[ENV_KEY] = "http://localhost:7811/api/v1";
    expect(resolveLlmBaseUrl()).toBe("http://localhost:7811/api/v1");
  });
});
