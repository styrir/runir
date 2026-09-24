import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Text } from "../../model-benchmark/provenance.js";
import { cassetteKey, lookupCassette, parseCassette } from "../cassette.js";
import { parseJudgeBenchmarkArgs } from "../cli.js";
import { loadDataset } from "../dataset.js";
import { buildHeldoutDataset, buildQ4Dataset } from "../legacy.js";
import { renderJudgeReport } from "../report.js";
import { runJudgeBenchmark } from "../run.js";
import { validateLabels } from "../schema.js";
import { sealThresholds } from "../calibrate.js";
import { candidateById } from "../candidates.js";
import { ledgerPath } from "../paths.js";
import type { JudgeBenchmarkRow, JudgeLabelsFile, JudgePair } from "../types.js";
import { makePair, makeRow } from "./fixtures.js";

function sha(text: string): string {
  return sha256Text(text);
}

function pair(id: string, oldText: string, newText: string): JudgePair {
  return makePair({ pairId: id, oldText, newText });
}

function dataset(pairs: JudgePair[]): JudgeLabelsFile {
  return {
    schemaVersion: "runir-judge-benchmark/v1",
    taskId: "supersession-pair/v1",
    datasetId: "demo",
    legacyBinaryGold: false,
    pairs,
  };
}

describe("labels validation and snapshot checks", () => {
  it("rejects a free-text field", () => {
    const labels = dataset([pair("p1", "old", "new")]);
    const sneaky = { ...labels, pairs: [{ ...labels.pairs[0], reason: "the memory says the user moved" }] };
    expect(() => validateLabels(sneaky)).toThrow(/unknown field reason/);
  });

  it("turns a sha mismatch or a missing text into a case error", () => {
    const labels = validateLabels(dataset([pair("p1", "old-text", "new-text")]));
    const mismatch = loadDataset(labels, `${JSON.stringify({
      id: labels.pairs[0]!.oldRef.id,
      sha256: sha("other-text"),
      text: "other-text",
    })}\n${JSON.stringify({
      id: labels.pairs[0]!.newRef.id,
      sha256: sha("new-text"),
      text: "new-text",
    })}\n`);
    expect(mismatch[0]?.caseError).toBe("sha256_mismatch");
    const missing = loadDataset(labels, null);
    expect(missing[0]?.caseError).toBe("missing_text");
  });

  it("keeps correct_keep_both out of strict agreement", () => {
    const built = buildHeldoutDataset({
      packets: [{
        shadow_row_id: "s-1",
        occurred_at: "2026-07-05T00:00:00.000Z",
        applied: { result: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } },
        would: {
          outcome: "supersede",
          cosine: 0.9,
          matched_candidate: { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
        },
      }],
      finals: new Map([["s-1", { shadow_row_id: "s-1", label: "over_supersede", label_A: "correct_keep_both", label_B: "over_supersede" }]]),
      evidence: new Map(),
      textById: new Map([
        ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "new"],
        ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "old"],
      ]),
    });
    expect(built.dataset.pairs[0]?.goldStrict).toBeNull();
    expect(built.dataset.pairs[0]?.gold.labelA).toBe("independent");
    expect(() => validateLabels(built.dataset)).not.toThrow();
  });

  it("maps Q4 disagreement to the headline safety default", () => {
    const built = buildQ4Dataset({
      rows: [{
        shadow_row_id: "row-1",
        frame: "diverged",
        occurred_at: "2026-07-07T00:00:00.000Z",
        view: {
          incoming_text_full: "incoming",
          would: { matched_candidate: { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", hydration: { created_at: "2026-05-01T00:00:00.000Z", text_trunc: "trunc" } } },
        },
      }],
      labelA: new Map([["row-1", "over_supersede_fp"]]),
      labelB: new Map([["row-1", "correct_would_supersede"]]),
      oldById: new Map([["cccccccc-cccc-cccc-cccc-cccccccccccc", { l2: "full old" }]]),
    });
    expect(built.dataset.pairs[0]?.gold.resolution).toBe("disagreement_defaulted_over");
    expect(built.dataset.pairs[0]?.goldHeadline).toBe("independent");
    expect(built.dataset.pairs[0]?.goldStrict).toBeNull();
    expect(built.dataset.pairs[0]?.newRef.id).toBe("q4-incoming:row-1");
    expect(built.snapshot.find((line) => line.id === "cccccccc-cccc-cccc-cccc-cccccccccccc")?.text).toBe("full old");
    expect(JSON.stringify(built.snapshot)).not.toContain("trunc");
    expect(built.failures).toEqual([]);
  });

  it("uses corpus l0 and never the archive truncation", () => {
    const built = buildQ4Dataset({
      rows: [{
        shadow_row_id: "row-l0",
        frame: "control",
        occurred_at: "2026-07-07T00:00:00.000Z",
        view: {
          incoming_text_full: "incoming",
          would: { matched_candidate: { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", hydration: { text_trunc: "TRUNCATED_OLD_TEXT" } } },
        },
      }],
      labelA: new Map([["row-l0", "correct_would_supersede"]]),
      labelB: new Map([["row-l0", "correct_would_supersede"]]),
      oldById: new Map([["dddddddd-dddd-dddd-dddd-dddddddddddd", { l0: "full from l0" }]]),
    });
    expect(built.failures).toEqual([]);
    expect(built.snapshot.find((line) => line.id === "dddddddd-dddd-dddd-dddd-dddddddddddd")?.text).toBe("full from l0");
    expect(JSON.stringify(built)).not.toContain("TRUNCATED_OLD_TEXT");
  });

  it("fails a Q4 pair when the seed corpus has no full OLD text", () => {
    const built = buildQ4Dataset({
      rows: [{
        shadow_row_id: "row-missing",
        frame: "diverged",
        occurred_at: "2026-07-07T00:00:00.000Z",
        view: {
          incoming_text_full: "incoming",
          would: { matched_candidate: { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", hydration: { text_trunc: "TRUNCATED_OLD_TEXT" } } },
        },
      }],
      labelA: new Map([["row-missing", "over_supersede_fp"]]),
      labelB: new Map([["row-missing", "correct_would_supersede"]]),
      oldById: new Map(),
    });
    expect(built.failures).toEqual([{
      pairId: "row-missing",
      refId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      reason: "full OLD text unavailable from pn1l_eval/seed_q4corpus",
    }]);
    expect(built.counts.failed_full_text).toBe(1);
    expect(built.dataset.pairs).toHaveLength(0);
    expect(JSON.stringify(built)).not.toContain("TRUNCATED_OLD_TEXT");
  });
});

describe("cassette and test lock", () => {
  it("keeps the cassette key stable and fails loudly on a miss", () => {
    const key = cassetteKey({ candidateConfigHash: "abc", oldText: "old", newText: "new", direction: "forward" });
    expect(key).toBe(cassetteKey({ candidateConfigHash: "abc", oldText: "old", newText: "new", direction: "forward" }));
    expect(key).not.toBe(cassetteKey({ candidateConfigHash: "abc", oldText: "old", newText: "new", direction: "swapped" }));
    expect(key).toHaveLength(64);
    const entries = parseCassette("");
    expect(() => lookupCassette(entries, "jev-noul-v1", key)).toThrow(/cassette miss for jev-noul-v1/);
    try {
      lookupCassette(entries, "jev-noul-v1", key);
    } catch (error) {
      expect(String(error)).not.toContain("old");
    }
  });

  function sealedThresholds(dir: string, split: "calibration" | "test", datasetId = "demo"): { path: string; thresholdsHash: string } {
    const candidate = candidateById("jev-noul-v1");
    const thresholds = sealThresholds({
      datasetId,
      candidate,
      split,
      fit: {
        threshold: 0.7,
        thresholdSource: "fitted",
        defaultThreshold: 0.5,
        updateRecall: 1,
        updateLanded: 1,
        supersedeN: 1,
        harmful: 0,
        n: 35,
        wilson95Upper: 0.05,
        considered: [0.7],
      },
    });
    const path = join(dir, "thresholds.json");
    writeFileSync(path, JSON.stringify(thresholds));
    return { path, thresholdsHash: thresholds.thresholdsHash };
  }

  function writeDemoLabels(dir: string, pairs = [pair("p1", "old-text", "new-text")]): string {
    const labelsPath = join(dir, "labels.json");
    writeFileSync(labelsPath, JSON.stringify(dataset(pairs)));
    return labelsPath;
  }

  it("refuses a test-split score without recording an unlock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-lock-"));
    const labelsPath = writeDemoLabels(dir);
    const result = await runJudgeBenchmark(
      ["score", "--dataset", "demo", "--candidate", "jev-noul-v1", "--split", "test", "--labels", labelsPath],
      { cwd: dir, log: () => undefined },
    );
    expect(result.code).toBe(4);
    expect(result.error).toMatch(/unlock-test/);
    expect(() => readFileSync(join(dir, ledgerPath()), "utf8")).toThrow();
  });

  it("refuses a test-split run before it prints a result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-run-lock-"));
    const labelsPath = writeDemoLabels(dir);
    const lines: string[] = [];
    const result = await runJudgeBenchmark(
      ["run", "--dataset", "demo", "--candidate", "jev-noul-v1", "--split", "test", "--labels", labelsPath],
      { cwd: dir, log: (line) => lines.push(line) },
    );
    expect(result.code).toBe(4);
    expect(result.error).toMatch(/unlock-test/);
    expect(lines).toEqual([]);
    expect(() => readFileSync(join(dir, ledgerPath()), "utf8")).toThrow();
  });

  it("excludes test rows when run omits --split", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-exclude-"));
    const oldText = "old-text";
    const newText = "new-text";
    const calibration = pair("p-cal", oldText, newText);
    calibration.split = "calibration";
    const heldOut = pair("p-test", oldText, newText);
    const labelsPath = writeDemoLabels(dir, [calibration, heldOut]);
    const textsPath = join(dir, "texts.jsonl");
    writeFileSync(textsPath, [
      JSON.stringify({ id: calibration.oldRef.id, sha256: sha(oldText), text: oldText }),
      JSON.stringify({ id: calibration.newRef.id, sha256: sha(newText), text: newText }),
    ].join("\n") + "\n");
    const lines: string[] = [];
    const result = await runJudgeBenchmark([
      "run",
      "--dataset", "demo",
      "--candidate", "judge-v2",
      "--labels", labelsPath,
      "--texts", textsPath,
    ], { cwd: dir, log: (line) => lines.push(line), git: () => ({ sha: "abc", dirty: false }) });
    expect(result.code).toBe(0);
    expect(result.disclosure?.plannedRequestCount).toBe(1);
    expect(result.disclosure?.testRowsExcluded).toBe(1);
    expect(result.disclosure?.testSplitNote).toMatch(/excludes test rows/);
    expect(lines.join("\n")).toContain("Excluded test rows: 1");
  });

  it("refuses thresholds sealed for the test split or another dataset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-threshold-lock-"));
    const labelsPath = writeDemoLabels(dir);
    const wrongSplit = sealedThresholds(dir, "test");
    const splitResult = await runJudgeBenchmark([
      "score", "--dataset", "demo", "--candidate", "jev-noul-v1", "--split", "test",
      "--unlock-test", "--thresholds", wrongSplit.path, "--labels", labelsPath, "--rows", join(dir, "missing.jsonl"),
    ], { cwd: dir, log: () => undefined });
    expect(splitResult.code).toBe(4);
    expect(splitResult.error).toMatch(/calibration/);
    expect(() => readFileSync(join(dir, ledgerPath()), "utf8")).toThrow();

    const wrongDataset = sealedThresholds(dir, "calibration", "other-dataset");
    const datasetResult = await runJudgeBenchmark([
      "score", "--dataset", "demo", "--candidate", "jev-noul-v1", "--split", "test",
      "--unlock-test", "--thresholds", wrongDataset.path, "--labels", labelsPath, "--rows", join(dir, "missing.jsonl"),
    ], { cwd: dir, log: () => undefined });
    expect(datasetResult.code).toBe(4);
    expect(datasetResult.error).toMatch(/does not match/);
    expect(() => readFileSync(join(dir, ledgerPath()), "utf8")).toThrow();
  });

  it("refuses calibrate on the test split", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-cal-lock-"));
    const labelsPath = writeDemoLabels(dir);
    const result = await runJudgeBenchmark([
      "calibrate", "--dataset", "demo", "--candidate", "jev-noul-v1", "--split", "test",
      "--labels", labelsPath, "--rows", join(dir, "rows.jsonl"),
    ], { cwd: dir, log: () => undefined });
    expect(result.code).toBe(2);
    expect(result.error).toMatch(/test/);
  });

  it("refuses to calibrate from rows of another dataset or candidate config", async () => {
    const candidate = candidateById("jev-noul-v1");
    for (const [label, override] of [
      ["dataset", { datasetId: "other-dataset" }],
      ["config", { candidateConfigHash: "0".repeat(64) }],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), `judge-cal-${label}-`));
      const labelsPath = writeDemoLabels(dir);
      const base = {
        pairId: "p1",
        datasetId: "demo",
        candidateId: candidate.id,
        candidateConfigHash: candidate.candidateConfigHash,
        split: "calibration",
        population: "probability",
        retireScore: 0.8,
        signals: { family: "noul", probability: 0.8 },
      } as const;
      const row = makeRow({ ...base, ...override });
      const rowsPath = join(dir, "rows.jsonl");
      writeFileSync(rowsPath, `${JSON.stringify(row)}\n`);
      const result = await runJudgeBenchmark([
        "calibrate", "--dataset", "demo", "--candidate", candidate.id, "--split", "calibration",
        "--labels", labelsPath, "--rows", rowsPath, "--thresholds-out", join(dir, "t.json"),
      ], { cwd: dir, log: () => undefined });
      expect(result.code).toBe(3);
      expect(result.error).toMatch(/not demo/);
    }
  });

  it("appends the unlock ledger once, before any score result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-unlock-"));
    const labels = dataset([pair("p1", "old-text", "new-text")]);
    labels.pairs[0]!.split = "test";
    const labelsPath = join(dir, "labels.json");
    writeFileSync(labelsPath, JSON.stringify(labels));
    const candidate = candidateById("jev-noul-v1");
    const sealed = sealedThresholds(dir, "calibration");
    const sample = makeRow({
      pairId: "p1",
      candidateConfigHash: candidate.candidateConfigHash,
      split: "test",
      oldRef: { id: labels.pairs[0]!.oldRef.id, sha256: labels.pairs[0]!.oldRef.sha256 },
      newRef: { id: labels.pairs[0]!.newRef.id, sha256: labels.pairs[0]!.newRef.sha256 },
      retireScore: 0.8,
      signals: { family: "noul", probability: 0.8 },
      outcome: "missed_update",
      latencyMs: 3,
    });
    const second = { ...sample, pairId: "p2" };
    const rowsPath = join(dir, "rows.jsonl");
    writeFileSync(rowsPath, `${JSON.stringify(sample)}\n${JSON.stringify(second)}\n`);
    const lines: string[] = [];
    const events: string[] = [];
    const args = [
      "score",
      "--dataset", "demo",
      "--candidate", "jev-noul-v1",
      "--split", "test",
      "--unlock-test",
      "--thresholds", sealed.path,
      "--rows", rowsPath,
      "--labels", labelsPath,
    ];
    const result = await runJudgeBenchmark(args, {
      cwd: dir,
      log: (line) => {
        events.push("log");
        lines.push(line);
      },
      appendFile: (path, data) => {
        events.push("ledger");
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, data);
      },
      git: () => ({ sha: "abc", dirty: false }),
    });
    expect(result.code).toBe(0);
    expect(events[0]).toBe("ledger");
    expect(events.filter((event) => event === "ledger")).toEqual(["ledger"]);
    const ledger = readFileSync(join(dir, ledgerPath()), "utf8").trim().split("\n");
    expect(ledger).toHaveLength(1);
    const entry = JSON.parse(ledger[0]!) as { thresholdsHash: string; candidateConfigHashes: string[] };
    expect(entry.thresholdsHash).toBe(sealed.thresholdsHash);
    expect(entry.candidateConfigHashes).toEqual([candidate.candidateConfigHash]);
    expect(lines.join("\n")).toContain("retire");
    const again = await runJudgeBenchmark(args, {
      cwd: dir,
      log: () => undefined,
      git: () => ({ sha: "abc", dirty: false }),
    });
    expect(again.code).toBe(0);
    expect(readFileSync(join(dir, ledgerPath()), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("refuses dataset B rows under dataset A's unlock before any ledger or output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-dataset-bind-"));
    const labels = dataset([pair("p1", "old-text", "new-text")]);
    labels.pairs[0]!.split = "test";
    const labelsPath = join(dir, "labels.json");
    writeFileSync(labelsPath, JSON.stringify(labels));
    const candidate = candidateById("jev-noul-v1");
    const sealed = sealedThresholds(dir, "calibration", "demo");
    const row = (pairId: string, datasetId: string): JudgeBenchmarkRow => makeRow({
      pairId,
      datasetId,
      candidateConfigHash: candidate.candidateConfigHash,
      split: "test",
      oldRef: { id: labels.pairs[0]!.oldRef.id, sha256: labels.pairs[0]!.oldRef.sha256 },
      newRef: { id: labels.pairs[0]!.newRef.id, sha256: labels.pairs[0]!.newRef.sha256 },
      retireScore: 0.8,
      signals: { family: "noul", probability: 0.8 },
      outcome: "missed_update",
      latencyMs: 3,
    });
    const rowsPath = join(dir, "rows.jsonl");
    const reportPath = join(dir, "report.md");
    writeFileSync(rowsPath, `${JSON.stringify(row("p-a", "demo"))}\n${JSON.stringify(row("p-b", "dataset-b"))}\n`);
    const events: string[] = [];
    const result = await runJudgeBenchmark([
      "score",
      "--dataset", "demo",
      "--candidate", "jev-noul-v1",
      "--split", "test",
      "--unlock-test",
      "--thresholds", sealed.path,
      "--rows", rowsPath,
      "--labels", labelsPath,
      "--out-report", reportPath,
    ], {
      cwd: dir,
      log: () => events.push("log"),
      appendFile: () => events.push("ledger"),
      writeFile: () => events.push("write"),
      git: () => ({ sha: "abc", dirty: false }),
    });
    expect(result.code).toBe(4);
    expect(result.error).toMatch(/score refused/);
    expect(result.error).toMatch(/dataset-b/);
    expect(result.error).toMatch(/--dataset demo/);
    expect(result.error).toMatch(/thresholds datasetId demo/);
    expect(events).toEqual([]);
    expect(result.report).toBeUndefined();
    expect(() => readFileSync(join(dir, ledgerPath()), "utf8")).toThrow();
    expect(() => readFileSync(reportPath, "utf8")).toThrow();
  });

  it("appends one unlock ledger line before a test-split run discloses results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-run-unlock-"));
    const oldText = "old-text";
    const newText = "new-text";
    const labelsPath = writeDemoLabels(dir, [pair("p1", oldText, newText)]);
    const labels = dataset([pair("p1", oldText, newText)]);
    const textsPath = join(dir, "texts.jsonl");
    writeFileSync(textsPath, [
      JSON.stringify({ id: labels.pairs[0]!.oldRef.id, sha256: sha(oldText), text: oldText }),
      JSON.stringify({ id: labels.pairs[0]!.newRef.id, sha256: sha(newText), text: newText }),
    ].join("\n") + "\n");
    const sealed = sealedThresholds(dir, "calibration");
    const events: string[] = [];
    const result = await runJudgeBenchmark([
      "run", "--dataset", "demo", "--candidate", "jev-noul-v1", "--split", "test",
      "--unlock-test", "--thresholds", sealed.path, "--labels", labelsPath, "--texts", textsPath,
    ], {
      cwd: dir,
      log: () => events.push("log"),
      appendFile: (path, data) => {
        events.push("ledger");
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, data);
      },
      git: () => ({ sha: "abc", dirty: false }),
    });
    expect(result.code).toBe(0);
    expect(events[0]).toBe("ledger");
    expect(events.filter((event) => event === "ledger")).toEqual(["ledger"]);
    expect(result.disclosure?.plannedRequestCount).toBe(1);
    expect(readFileSync(join(dir, ledgerPath()), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("scores non-test rows only when --split is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-score-exclude-"));
    const labelsPath = writeDemoLabels(dir);
    const candidate = candidateById("jev-noul-v1");
    const row = (pairId: string, split: "calibration" | "test"): JudgeBenchmarkRow => makeRow({
      pairId,
      candidateConfigHash: candidate.candidateConfigHash,
      split,
      retireScore: 0.2,
      signals: { family: "noul", probability: 0.2 },
      outcome: "missed_update",
      latencyMs: 3,
    });
    const rowsPath = join(dir, "rows.jsonl");
    writeFileSync(rowsPath, `${JSON.stringify(row("p-cal", "calibration"))}\n${JSON.stringify(row("p-test", "test"))}\n`);
    const lines: string[] = [];
    const result = await runJudgeBenchmark([
      "score", "--dataset", "demo", "--candidate", "jev-noul-v1", "--labels", labelsPath, "--rows", rowsPath,
    ], { cwd: dir, log: (line) => lines.push(line) });
    expect(result.code).toBe(0);
    expect(lines.join("\n")).toContain("Excluded test rows: 1");
    expect(result.report).toContain("p-cal");
    expect(result.report).not.toContain("p-test");
    expect(() => readFileSync(join(dir, ledgerPath()), "utf8")).toThrow();
  });
});

describe("cli and dry-run preflight", () => {
  it("parses the cost gates and rejects unknown flags", () => {
    const parsed = parseJudgeBenchmarkArgs([
      "run",
      "--dataset", "supersession-q4-insample",
      "--candidate", "judge-v2",
      "--probe", "order-swap",
      "--confirm-cost",
      "--max-total-cost-usd", "1.5",
      "--allow-dirty",
      "--allow-overwrite",
      "--concurrency", "1",
    ]);
    expect(parsed.command).toBe("run");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.confirmCost).toBe(true);
    expect(parsed.maxTotalCostUsd).toBe(1.5);
    expect(parsed.probe).toBe("order-swap");
    expect(parsed.requireCleanGit).toBe(false);
    expect(parsed.allowOverwrite).toBe(true);
    expect(() => parseJudgeBenchmarkArgs(["run", "--nope"])).toThrow(/Unknown option/);
  });

  it("prints a zero-network preflight with the planned request count and cost cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-dry-"));
    const oldText = "old-text";
    const newText = "new-text";
    const labels = dataset([pair("p1", oldText, newText)]);
    labels.pairs[0]!.split = "insample";
    const labelsPath = join(dir, "labels.json");
    const textsPath = join(dir, "texts.jsonl");
    writeFileSync(labelsPath, JSON.stringify(labels));
    writeFileSync(textsPath, [
      JSON.stringify({ id: labels.pairs[0]!.oldRef.id, sha256: sha(oldText), text: oldText }),
      JSON.stringify({ id: labels.pairs[0]!.newRef.id, sha256: sha(newText), text: newText }),
    ].join("\n") + "\n");
    let called = 0;
    const lines: string[] = [];
    const result = await runJudgeBenchmark([
      "run",
      "--dataset", "demo",
      "--candidate", "judge-v2",
      "--labels", labelsPath,
      "--texts", textsPath,
      "--max-total-cost-usd", "2",
    ], {
      cwd: dir,
      log: (line) => lines.push(line),
      git: () => ({ sha: "abc123", dirty: true }),
      fetchImpl: () => {
        called += 1;
        throw new Error("network");
      },
    });
    expect(result.code).toBe(0);
    expect(called).toBe(0);
    expect(result.disclosure?.plannedRequestCount).toBe(1);
    expect(result.disclosure?.maxTotalCostUsd).toBe(2);
    expect(result.disclosure?.networkCalls).toBe(0);
    const printed = lines.join("\n");
    expect(printed).toContain("Planned requests: 1");
    expect(printed).toContain("Cost cap: $2");
    expect(printed).toContain("Network calls: 0");
    expect(printed).not.toContain(oldText);
  });

  it("keeps rationale text out of the markdown projection", () => {
    const candidate = candidateById("jev-noul-v1");
    const row = {
      ...makeRow({
        candidateConfigHash: candidate.candidateConfigHash,
        split: "insample",
        population: "legacy",
        stratum: "legacy-diverged",
        frame: "diverged",
        legacyBinaryGold: true,
        gold: "independent",
        retireScore: 0.2,
        signals: { family: "noul", probability: 0.2 },
        outcome: "correct_keep",
        latencyMs: 4,
        estimatedCostUsd: 0.01,
      }),
      rationale: "UNIQUE_RATIONALE_SENTINEL",
    } as JudgeBenchmarkRow;
    const markdown = renderJudgeReport({
      datasetId: "demo",
      candidateId: "jev-noul-v1",
      manifest: null,
      score: { schemaVersion: "runir-judge-scoring/v1", groups: [] },
      rows: [row],
    });
    expect(markdown).not.toContain("UNIQUE_RATIONALE_SENTINEL");
    expect(markdown).toContain("p1");
  });
});

describe("committed legacy labels", () => {
  it("matches the frozen Q4 and July-5 denominators", () => {
    const q4 = validateLabels(JSON.parse(readFileSync("fixtures/judge-benchmark/supersession-q4-insample.labels.json", "utf8")));
    const held = validateLabels(JSON.parse(readFileSync("fixtures/judge-benchmark/supersession-0705-heldout.labels.json", "utf8")));
    expect(q4.pairs).toHaveLength(108);
    expect(q4.pairs.filter((item) => item.frame === "diverged")).toHaveLength(97);
    expect(q4.pairs.filter((item) => item.frame === "control")).toHaveLength(11);
    expect(q4.pairs.filter((item) => item.frame === "diverged" && item.goldStrict !== null)).toHaveLength(78);
    expect(held.pairs).toHaveLength(49);
    expect(held.pairs.filter((item) => item.goldStrict !== null)).toHaveLength(36);
    expect(held.pairs.every((item) => item.frame === "heldout")).toBe(true);
    for (const file of [q4, held]) {
      const walk = (value: unknown): void => {
        if (typeof value === "string") {
          expect(value.length <= 80 || /^[a-f0-9]{64}$/.test(value)).toBe(true);
          return;
        }
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") Object.values(value).forEach(walk);
      };
      walk(file);
    }
  });
});

