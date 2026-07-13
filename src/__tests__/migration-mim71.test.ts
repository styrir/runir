import { describe, it, expect, vi } from "vitest";
import { characterizeNullPathRecords } from "../../scripts/migration-mim71.js";
import type { MigrationDb } from "../../scripts/migration-mim71.js";

function makeMockDb(countRows: any[], sampleRows: any[]): MigrationDb {
  let callCount = 0;
  return {
    query: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [countRows];
      return [sampleRows];
    }),
  };
}

describe("characterizeNullPathRecords (MIM-71)", () => {
  it("returns correct structure from mock DB", async () => {
    const countRows = [
      { cnt: 3000, client: "openclaw" },
      { cnt: 1020, client: null },
    ];
    const sampleRows = [
      { l2: "Sample memory one about project configuration" },
      { l2: "Sample memory two about deployment steps" },
    ];

    const db = makeMockDb(countRows, sampleRows);
    const report = await characterizeNullPathRecords(db);

    expect(report.total).toBe(4020);
    expect(report.byClient["openclaw"]).toBe(3000);
    expect(report.byClient["(none)"]).toBe(1020);
    expect(report.samples).toHaveLength(2);
    expect(report.samples[0]).toContain("Sample memory one");
  });

  it("warning logged when count differs by >10% from expected (4020)", async () => {
    // 4020 * 0.10 = 402, so a count of 1000 deviates >10%
    const countRows = [{ cnt: 1000, client: "openclaw" }];
    const sampleRows: any[] = [];

    const db = makeMockDb(countRows, sampleRows);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await characterizeNullPathRecords(db);

    expect(report.total).toBe(1000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("WARNING"),
    );

    warnSpy.mockRestore();
  });

  it("no warning when count is within 10% of expected", async () => {
    // 4020 * 0.10 = 402 — count of 4100 is within tolerance
    const countRows = [{ cnt: 4100, client: "openclaw" }];
    const sampleRows: any[] = [];

    const db = makeMockDb(countRows, sampleRows);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await characterizeNullPathRecords(db);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("handles empty DB results gracefully", async () => {
    const db = makeMockDb([], []);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await characterizeNullPathRecords(db);

    expect(report.total).toBe(0);
    expect(report.byClient).toEqual({});
    expect(report.samples).toEqual([]);
    expect(warnSpy).toHaveBeenCalled(); // 0 deviates from 4020 by >10%

    warnSpy.mockRestore();
  });
});
