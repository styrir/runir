import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockUse = vi.fn().mockResolvedValue(undefined);
const mockSignin = vi.fn().mockResolvedValue(undefined);
const mockQuery = vi.fn().mockResolvedValue([[]]);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("surrealdb", () => ({
  Surreal: class {
    connect = mockConnect;
    use = mockUse;
    signin = mockSignin;
    query = mockQuery;
    close = mockClose;
  },
}));

vi.mock("fs", () => ({
  default: { existsSync: vi.fn(), writeFileSync: vi.fn() },
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

import {
  FILE_REF_REGEX,
  extractFileRefs,
  computeStalenessReport,
  sampleMemories,
  main,
  type MemorySample,
} from "../../scripts/staleness-oracle";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// FILE_REF_REGEX
// ---------------------------------------------------------------------------

describe("FILE_REF_REGEX", () => {
  beforeEach(() => {
    FILE_REF_REGEX.lastIndex = 0;
  });

  it("matches src/types.ts", () => {
    const m = FILE_REF_REGEX.exec("see src/types.ts for details");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("src/types.ts");
  });

  it("matches scripts/foo.ts", () => {
    FILE_REF_REGEX.lastIndex = 0;
    const m = FILE_REF_REGEX.exec("run scripts/foo.ts");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("scripts/foo.ts");
  });

  it("matches cli/index.ts", () => {
    FILE_REF_REGEX.lastIndex = 0;
    const m = FILE_REF_REGEX.exec("from cli/index.ts");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("cli/index.ts");
  });

  it("does NOT match node_modules paths", () => {
    FILE_REF_REGEX.lastIndex = 0;
    const m = FILE_REF_REGEX.exec("node_modules/foo/bar.ts");
    expect(m).toBeNull();
  });

  it("does NOT match dist paths", () => {
    FILE_REF_REGEX.lastIndex = 0;
    const m = FILE_REF_REGEX.exec("dist/index.ts");
    expect(m).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFileRefs
// ---------------------------------------------------------------------------

describe("extractFileRefs", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
  });

  it("extracts src/foo.ts from l2 text and resolves against basePath", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const refs = extractFileRefs("check src/foo.ts for the bug", "/project");
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).toBe("src/foo.ts");
    expect(refs[0].resolvedPath).toBe(path.resolve("/project", "src/foo.ts"));
    expect(refs[0].exists).toBe(true);
  });

  it("returns empty array when no file refs in text", () => {
    const refs = extractFileRefs("no references here at all", "/project");
    expect(refs).toHaveLength(0);
  });

  it("deduplicates repeated references", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const refs = extractFileRefs("src/foo.ts and src/foo.ts again", "/project");
    expect(refs).toHaveLength(1);
  });

  it("handles multiple refs in one l2 string", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const refs = extractFileRefs("see src/a.ts and scripts/b.ts", "/project");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.raw).sort()).toEqual(["scripts/b.ts", "src/a.ts"]);
  });
});

// ---------------------------------------------------------------------------
// computeStalenessReport
// ---------------------------------------------------------------------------

describe("computeStalenessReport", () => {
  const makeSample = (id: string, l2: string): MemorySample => ({
    id,
    l2,
    path: "/project",
    createdAt: "2026-01-01T00:00:00Z",
  });

  it("returns 0% when all files exist", () => {
    const samples = [makeSample("1", "src/a.ts exists")];
    const report = computeStalenessReport(samples, () => true);
    expect(report.staleness_rate).toBe(0);
    expect(report.stale_count).toBe(0);
  });

  it("returns correct staleness_rate when some files missing", () => {
    const samples = [
      makeSample("1", "src/exists.ts here"),
      makeSample("2", "src/missing.ts here"),
    ];
    const checkFile = (p: string) => !p.includes("missing");
    const report = computeStalenessReport(samples, checkFile);
    expect(report.stale_count).toBe(1);
    expect(report.staleness_rate).toBe(50);
    expect(report.memories_checked).toBe(2);
  });

  it("handles empty samples array", () => {
    const report = computeStalenessReport([], () => true);
    expect(report.memories_checked).toBe(0);
    expect(report.stale_count).toBe(0);
    expect(report.staleness_rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sampleMemories
// ---------------------------------------------------------------------------

describe("sampleMemories", () => {
  it("returns correct shape from mocked DB", async () => {
    const mockRows: MemorySample[] = [
      { id: "mem:1", l2: "some text", path: "/p", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const db = { query: vi.fn().mockResolvedValue([mockRows]) };
    const result = await sampleMemories(db, 10);
    expect(result).toEqual(mockRows);
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query.mock.calls[0][1]).toEqual({ limit: 10 });
  });
});

// ---------------------------------------------------------------------------
// main() CLI behavior
// ---------------------------------------------------------------------------

describe("main()", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;

  beforeEach(() => {
    mockConnect.mockResolvedValue(undefined);
    mockUse.mockResolvedValue(undefined);
    mockSignin.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue([[]]);
    mockClose.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.existsSync).mockReset();
    process.env.SURREAL_PASS = "test";
  });

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env.SURREAL_PASS;
    vi.restoreAllMocks();
  });

  it("exits 0 when staleness_rate <= 0.30 and writes output JSON", async () => {
    process.argv = ["node", "staleness-oracle.ts", "--output=.pipeline/test-output.json"];
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    await expect(main()).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
    const writtenJson = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenJson).toHaveProperty("staleness_rate");
  });

  it("exits 1 when staleness_rate > 0.30", async () => {
    mockQuery.mockResolvedValue([
      [
        { id: "mem:1", l2: "check src/nonexistent.ts here", path: "/project", createdAt: "2026-01-01" },
      ],
    ]);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    process.argv = ["node", "staleness-oracle.ts"];

    await expect(main()).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints summary line to console", async () => {
    process.argv = ["node", "staleness-oracle.ts"];
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    await expect(main()).rejects.toThrow("process.exit");

    const summaryCall = logSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("[staleness-oracle]"),
    );
    expect(summaryCall).toBeDefined();
  });

  it("writes valid JSON to --output path when specified", async () => {
    process.argv = ["node", "staleness-oracle.ts", "--output=custom/path.json"];
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    await expect(main()).rejects.toThrow("process.exit");

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
    const [writePath, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writePath).toBe("custom/path.json");
    expect(() => JSON.parse(content as string)).not.toThrow();
  });

  it("exits 1 when SURREAL_PASS is not set", async () => {
    delete process.env.SURREAL_PASS;
    process.argv = ["node", "staleness-oracle.ts"];

    await expect(main()).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith("SURREAL_PASS env var required");
  });
});
