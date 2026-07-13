import { describe, it, expect } from "vitest";

import { resolveRelativeTemporalPhrases } from "../domain/memory/temporal-resolver.js";

const ANCHOR = "2023-05-08T00:00:00Z";

describe("resolveRelativeTemporalPhrases — deterministic relative→absolute", () => {
  it("appends the absolute year for 'last year' while preserving the phrase", () => {
    const r = resolveRelativeTemporalPhrases(
      "Melanie painted the lake sunrise picture last year",
      ANCHOR,
    );
    expect(r.text).toContain("last year"); // verbatim preserved (additive)
    expect(r.text).toContain("2022");
    expect(r.validFrom).toBe("2022");
    expect(r.granularity).toBe("year");
  });

  it("resolves the full anchor table for anchor 2023-01-20", () => {
    const a = "2023-01-20T12:00:00Z";
    const cases: Array<[string, string]> = [
      ["yesterday", "2023-01-19"],
      ["today", "2023-01-20"],
      ["tomorrow", "2023-01-21"],
      ["last week", "2023-01-13"],
      ["next month", "2023-02"],
      ["last year", "2022"],
      ["3 days ago", "2023-01-17"],
      ["2 weeks ago", "2023-01-06"],
    ];
    for (const [phrase, expected] of cases) {
      const r = resolveRelativeTemporalPhrases(`event happened ${phrase}`, a);
      expect(r.text, `${phrase} → ${expected}`).toContain(expected);
    }
  });

  it("uses real date arithmetic across month and leap-year boundaries", () => {
    expect(resolveRelativeTemporalPhrases("paid rent last month", "2024-03-15T00:00:00Z").text).toContain("2024-02");
    // 2024 is a leap year: yesterday from Mar 1 is Feb 29.
    expect(resolveRelativeTemporalPhrases("we met yesterday", "2024-03-01T00:00:00Z").text).toContain("2024-02-29");
  });

  it("does not overflow on month-end anchors (setUTCMonth keeps day-of-month)", () => {
    // Mar 31 − 1 month must be Feb, not "Feb 31"→Mar.
    expect(resolveRelativeTemporalPhrases("paid rent last month", "2023-03-31T00:00:00Z").text).toContain("2023-02");
    expect(resolveRelativeTemporalPhrases("shipped 3 months ago", "2023-05-31T00:00:00Z").text).toContain("2023-02");
    expect(resolveRelativeTemporalPhrases("renewed last month", "2024-05-31T00:00:00Z").text).toContain("2024-04");
    // Feb-29 anchor − 1 year must still yield 2023.
    expect(resolveRelativeTemporalPhrases("happened last year", "2024-02-29T00:00:00Z").text).toContain("2023");
  });

  it("does not fire on absolute dates or non-temporal prose (no false positives)", () => {
    const abs = resolveRelativeTemporalPhrases("shipped on 2023-05-08 as planned", ANCHOR);
    expect(abs.text).toBe("shipped on 2023-05-08 as planned");
    expect(abs.validFrom).toBeUndefined();
    const prose = resolveRelativeTemporalPhrases("this approach is cleaner", ANCHOR);
    expect(prose.text).toBe("this approach is cleaner");
    expect(prose.validFrom).toBeUndefined();
  });

  it("strips a leaked {SESSION_TIMESTAMP} placeholder to the anchor day", () => {
    const r = resolveRelativeTemporalPhrases(
      "adopted a dog one day before {SESSION_TIMESTAMP} (yesterday)",
      "2023-03-04T15:15:00Z",
    );
    expect(r.text).not.toContain("{SESSION_TIMESTAMP}");
    expect(r.text).toContain("2023-03-04"); // placeholder → anchor day
    expect(r.text).toContain("2023-03-03"); // yesterday resolved
  });

  it("removes a leaked placeholder even when the anchor is missing/invalid", () => {
    const r = resolveRelativeTemporalPhrases("before {SESSION_TIMESTAMP} stuff", undefined);
    expect(r.text).not.toContain("{SESSION_TIMESTAMP}");
  });

  it("is idempotent — does not double-append an already-present date", () => {
    const once = resolveRelativeTemporalPhrases("painted last year", ANCHOR);
    const twice = resolveRelativeTemporalPhrases(once.text, ANCHOR);
    expect(twice.text).toBe(once.text);
  });

  it("is null-safe on non-string input", () => {
    expect(resolveRelativeTemporalPhrases(undefined as unknown as string, ANCHOR).text).toBe("");
    expect(resolveRelativeTemporalPhrases(12345 as unknown as string, ANCHOR).text).toBe("");
  });
});
