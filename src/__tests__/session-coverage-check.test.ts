import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TopicResult } from "../../scripts/session-coverage-check.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Dynamic import so we can manipulate process.argv before main() runs
let checkTopicCoverage: typeof import("../../scripts/session-coverage-check.js").checkTopicCoverage;
let computeCoverage: typeof import("../../scripts/session-coverage-check.js").computeCoverage;
let main: typeof import("../../scripts/session-coverage-check.js").main;

beforeEach(async () => {
  mockFetch.mockReset();
  const mod = await import("../../scripts/session-coverage-check.js");
  checkTopicCoverage = mod.checkTopicCoverage;
  computeCoverage = mod.computeCoverage;
  main = mod.main;
});

// ---------------------------------------------------------------------------
// checkTopicCoverage
// ---------------------------------------------------------------------------

describe("checkTopicCoverage", () => {
  it("returns covered: true when topic keyword appears in bullets", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        prependContext:
          "- arbitration pipeline handles dedup\n- decay scoring runs nightly",
      }),
    });

    const result = await checkTopicCoverage(
      "http://localhost:7700",
      "sess-1",
      "arbitration",
    );
    expect(result.covered).toBe(true);
    expect(result.matchedBullets).toHaveLength(1);
    expect(result.bulletCount).toBe(2);
  });

  it("returns covered: false when topic keyword is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        prependContext:
          "- memory pipeline handles dedup\n- scoring runs nightly",
      }),
    });

    const result = await checkTopicCoverage(
      "http://localhost:7700",
      "sess-1",
      "arbitration",
    );
    expect(result.covered).toBe(false);
    expect(result.matchedBullets).toHaveLength(0);
    expect(result.bulletCount).toBe(2);
  });

  it("handles empty prependContext", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ prependContext: "" }),
    });

    const result = await checkTopicCoverage(
      "http://localhost:7700",
      "sess-1",
      "arbitration",
    );
    expect(result.covered).toBe(false);
    expect(result.bulletCount).toBe(0);
    expect(result.matchedBullets).toHaveLength(0);
  });

  it("matches case-insensitively: 'Decay' matches bullet with 'decay'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        prependContext: "- decay scoring runs nightly",
      }),
    });

    const result = await checkTopicCoverage(
      "http://localhost:7700",
      "sess-1",
      "Decay",
    );
    expect(result.covered).toBe(true);
    expect(result.matchedBullets).toHaveLength(1);
  });

  it("throws when fetch rejects (network error)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      checkTopicCoverage("http://localhost:7700", "sess-1", "arbitration"),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("throws when response is non-2xx", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(
      checkTopicCoverage("http://localhost:7700", "sess-1", "arbitration"),
    ).rejects.toThrow("Recall service returned HTTP 503");
  });

  it("throws when response is malformed JSON", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    await expect(
      checkTopicCoverage("http://localhost:7700", "sess-1", "arbitration"),
    ).rejects.toThrow("Malformed response from recall service");
  });
});

// ---------------------------------------------------------------------------
// computeCoverage
// ---------------------------------------------------------------------------

describe("computeCoverage", () => {
  it("returns 100% when all topics covered", () => {
    const results: TopicResult[] = [
      { topic: "a", covered: true, bulletCount: 3, matchedBullets: ["- a thing"] },
      { topic: "b", covered: true, bulletCount: 2, matchedBullets: ["- b thing"] },
    ];
    const cov = computeCoverage("sess-1", results);
    expect(cov.coverage_pct).toBe(100);
    expect(cov.topics_covered).toBe(2);
    expect(cov.topics_checked).toBe(2);
  });

  it("returns 0% when no topics covered", () => {
    const results: TopicResult[] = [
      { topic: "a", covered: false, bulletCount: 3, matchedBullets: [] },
      { topic: "b", covered: false, bulletCount: 2, matchedBullets: [] },
    ];
    const cov = computeCoverage("sess-1", results);
    expect(cov.coverage_pct).toBe(0);
    expect(cov.topics_covered).toBe(0);
  });

  it("returns correct fractional percentage (66.7% for 2/3)", () => {
    const results: TopicResult[] = [
      { topic: "a", covered: true, bulletCount: 3, matchedBullets: ["- a"] },
      { topic: "b", covered: false, bulletCount: 2, matchedBullets: [] },
      { topic: "c", covered: true, bulletCount: 1, matchedBullets: ["- c"] },
    ];
    const cov = computeCoverage("sess-1", results);
    expect(cov.coverage_pct).toBeCloseTo(66.667, 1);
    expect(cov.topics_covered).toBe(2);
  });

  it("handles empty results array (0%, 0 topics)", () => {
    const cov = computeCoverage("sess-1", []);
    expect(cov.coverage_pct).toBe(0);
    expect(cov.topics_checked).toBe(0);
    expect(cov.topics_covered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

describe("main", () => {
  let originalArgv: string[];
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as any);
  const mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    originalArgv = process.argv;
    mockExit.mockClear();
    mockConsoleError.mockClear();
    mockConsoleLog.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("exits 0 when coverage >= threshold", async () => {
    process.argv = [
      "node",
      "session-coverage-check.ts",
      "--topics=arbitration,decay",
      "--session-id=sess-1",
      "--threshold=50",
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        prependContext: "- arbitration pipeline\n- decay scoring",
      }),
    });

    // coverage = 100% >= 50% threshold → should NOT exit
    await main();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("exits 1 when coverage < threshold", async () => {
    process.argv = [
      "node",
      "session-coverage-check.ts",
      "--topics=arbitration,decay,staleness",
      "--session-id=sess-1",
      "--threshold=80",
    ];

    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      const context =
        body.prompt === "arbitration"
          ? "- arbitration pipeline handles dedup"
          : "- unrelated memory bullet";
      return { ok: true, json: async () => ({ prependContext: context }) };
    });

    // 1/3 covered = 33.3% < 80% → exit 1
    await expect(main()).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits 1 with usage when --topics is missing", async () => {
    process.argv = ["node", "session-coverage-check.ts", "--session-id=sess-1"];

    await expect(main()).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--topics"),
    );
  });

  it("exits 1 with usage when --session-id is missing", async () => {
    process.argv = ["node", "session-coverage-check.ts", "--topics=a,b"];

    await expect(main()).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--session-id"),
    );
  });

  it("exits 1 when fetch rejects (network error)", async () => {
    process.argv = [
      "node",
      "session-coverage-check.ts",
      "--topics=arbitration",
      "--session-id=sess-1",
    ];

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(main()).rejects.toThrow("ECONNREFUSED");
  });

  it("exits 1 when /hooks/recall returns non-2xx", async () => {
    process.argv = [
      "node",
      "session-coverage-check.ts",
      "--topics=arbitration",
      "--session-id=sess-1",
    ];

    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(main()).rejects.toThrow("Recall service returned HTTP 500");
  });

  it("exits 1 when /hooks/recall returns malformed JSON", async () => {
    process.argv = [
      "node",
      "session-coverage-check.ts",
      "--topics=arbitration",
      "--session-id=sess-1",
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    await expect(main()).rejects.toThrow("Malformed response from recall service");
  });
});
