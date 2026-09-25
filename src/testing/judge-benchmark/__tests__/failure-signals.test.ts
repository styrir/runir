import { describe, expect, it } from "vitest";
import { auc, captureEqual, categoryDifference, clusterBootstrap, containment, contextSignal, contrastLevel, provenanceBlocks, shortBefore, storedCosine, timeBucket, timeGap, validatePrivateArtifact } from "../failure-signals.js";

describe("failure signals", () => {
  it("uses token sets and classifies raw blocks", () => {
    expect(containment("Alpha alpha beta", "beta alpha gamma")).toEqual({ oldInNew: 1, newInOld: 2 / 3, jaccard: 2 / 3 });
    expect(provenanceBlocks("a\n\nSource:\nx", "b").relation).toBe("one_sided");
    expect(provenanceBlocks("a\n\nSource:\nx", "b\n\nSource:\nx").relation).toBe("identical");
  });
  it("enforces capture validity and time windows", () => {
    expect(captureEqual("skip", "x", "x").reason).toBe("not_applicable");
    expect(captureEqual("create", "x", "x").value).toBe(true);
    const gap = timeGap("2026-01-01T00:02:00Z", "2026-01-01T00:00:00Z");
    expect(shortBefore(gap).value).toBe(true);
    expect(timeBucket(gap.value!)).toBe("<1h");
    expect(timeGap("2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z").reason).toBe("invalid_time");
  });
  it("computes AUC and resamples entire clusters deterministically", () => {
    expect(auc([2, 3], [1, 2])).toBe(0.875);
    const rows = [{ cluster: 1, value: 1 }, { cluster: 1, value: 1 }, { cluster: 2, value: 0 }];
    const stat = (sample: readonly typeof rows[number][]) => sample.reduce((n, row) => n + row.value, 0) / sample.length;
    expect(clusterBootstrap(rows, stat, 100)).toEqual(clusterBootstrap(rows, stat, 100));
    const clustered = [...Array.from({ length: 10 }, () => ({ cluster: 1, value: 0 })), ...Array.from({ length: 10 }, () => ({ cluster: 2, value: 1 }))];
    const mean = (sample: readonly typeof clustered[number][]) => sample.reduce((n, row) => n + row.value, 0) / sample.length;
    expect(clusterBootstrap(clustered, mean, 200).interval).toEqual([0, 1]);
    const conditional = clusterBootstrap(clustered, (sample) => sample.some((x) => x.value === 0) && sample.some((x) => x.value === 1) ? mean(sample) : null, 200);
    expect(conditional.nullCount).toBeGreaterThan(0);
  });
  it("gates S8 and fixes categorical contrasts", () => {
    const allowed = new Set(["create"]);
    expect(contextSignal("create", "matched_candidate", allowed)).toEqual({ value: "create", reason: null });
    expect(contextSignal(null, "matched_candidate", allowed)).toEqual({ value: null, reason: "missing_value" });
    expect(contextSignal("create", "blocked_nomination", allowed)).toEqual({ value: null, reason: "other_candidate" });
    const numeric = new Set(["oldInNew", "newInOld"]);
    expect(contrastLevel("timeBucket", numeric)).toBe("<2m");
    expect(contrastLevel("blockRelation", numeric)).toBe("one_sided");
    expect(contrastLevel("sameSession", numeric)).toBe(true);
    expect(contrastLevel("oldInNew", numeric)).toBe(null);
    expect(categoryDifference(["<1d", "<2m"], ["<1d", "<1d"], "<2m")).toBe(0.5);
    expect(storedCosine(null, [1], "create").reason).toBe("missing_value");
  });
  it("validates complete artifact rows and rejects malformed values", () => {
    const pairId = "ss-012345abcdef", when = "2026-01-01T00:00:00.000Z";
    const signal = (value: unknown, reason: string | null = null) => ({ value, reason });
    const row = { pairId, cluster: 1, outcome: "correct_keep", gold: "independent", group: "baseline", snapshotRole: "matched_candidate", indistinguishable: false,
      sameSession: signal(true), capturedAtEqual: signal(null, "not_applicable"), oldCreatedShortlyBeforeLog: signal(false), timeGapSeconds: signal(300), timeBucket: signal("<1h"),
      oldInNew: signal(0.5), newInOld: signal(1), jaccard: signal(0.5), lengthRatio: signal(0.75), oldSource: signal(false), newSource: signal(false), oldList: signal(false), newList: signal(false), blockRelation: signal("none"), storedCosine: signal(null, "no_incoming_embedding"), sameProject: signal(null, "not_applicable"), appliedOutcome: signal("create"), wouldOutcome: signal("skip"), wouldBand: signal("none") };
    const snapshotRow = { pairId, cluster: 1, oldCreatedAt: when, occurredAt: when, sameSession: signal(true), capturedAtEqual: signal(null, "not_applicable"), sameProject: signal(null, "not_applicable"), storedCosine: signal(null, "no_incoming_embedding"), appliedOutcome: signal("create"), wouldOutcome: signal("skip"), wouldBand: signal("none") };
    const snapshot = { fetchedAt: when, namespaceVerified: true, namespaceOverlapCount: 1, rows: [snapshotRow] };
    expect(() => validatePrivateArtifact(row, "signal")).not.toThrow();
    expect(() => validatePrivateArtifact(snapshot, "snapshot")).not.toThrow();
    expect(() => validatePrivateArtifact({ ...row, wouldBand: signal("a private sentence") }, "signal")).toThrow();
    expect(() => validatePrivateArtifact({ ...snapshot, rows: [{ ...snapshotRow, wouldBand: signal("a private sentence") }] }, "snapshot")).toThrow();
    expect(() => validatePrivateArtifact({ ...row, sameSession: false }, "signal")).toThrow();
    expect(() => validatePrivateArtifact({ ...snapshot, rows: [{ ...snapshotRow, sameSession: false }] }, "snapshot")).toThrow();
  });
});
