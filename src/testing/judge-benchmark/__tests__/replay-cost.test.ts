import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Text } from "../../model-benchmark/provenance.js";
import { candidateById } from "../candidates.js";
import { executeCalls, type ExecuteDeps } from "../execute.js";
import { scoredRowIdentity, scoredRowIdentityFields } from "../identity.js";
import { manifestPathFor } from "../paths.js";
import { worstCaseReservationUsd } from "../preflight.js";
import { runJudgeBenchmark } from "../run.js";
import { scoreJudgeRows } from "../score.js";
import type { JudgePair, JudgeRunManifest, LoadedPair } from "../types.js";
import { makePair } from "./fixtures.js";

function loaded(id: string, oldText: string, newText: string): LoadedPair {
  return {
    pair: makePair({ pairId: id, oldText, newText, split: "calibration", cosine: 0.9, gold: "independent" }),
    oldText,
    newText,
  };
}

function deps(overrides: Partial<ExecuteDeps> & Pick<ExecuteDeps, "fetchImpl" | "cassetteText">): ExecuteDeps {
  return {
    sleep: async () => undefined,
    now: () => new Date("2026-09-24T00:00:00.000Z"),
    apiKey: "test-key",
    appendCassette: () => undefined,
    ...overrides,
  };
}

describe("replay fidelity and the hard cost cap", () => {
  it("replays recorded telemetry so identity fields and metrics match", async () => {
    const candidate = candidateById("jev-noul-v1");
    const oldText = "old memory";
    const newText = "new memory";
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      if (fetches === 1) return new Response("busy", { status: 429 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ q: { noul: 0.82 } }) } }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, cost: 0.002 },
      }), { status: 200 });
    };
    const cassette: string[] = [];
    let tick = 0;
    const recorded = await executeCalls({
      pairs: [loaded("p1", oldText, newText)],
      candidate,
      probe: false,
      threshold: candidate.defaultThreshold,
      runId: "record-run",
      datasetId: "demo",
      concurrency: 1,
      maxTotalCostUsd: null,
      replayOnly: false,
      deps: deps({
        fetchImpl,
        cassetteText: "",
        appendCassette: (line) => { cassette.push(line); },
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
      }),
    });
    expect(fetches).toBe(2);
    expect(recorded.rows[0]?.retryCount).toBe(1);
    expect(recorded.rows[0]?.billedCostUsd).toBe(0.002);
    expect(recorded.rows[0]?.usage).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
    expect(recorded.rows[0]?.latencyMs).toBeGreaterThan(0);
    expect(cassette[0]).toContain("\"latencyMs\"");
    expect(cassette[0]).toContain("\"retryCount\":1");

    const replay = await executeCalls({
      pairs: [loaded("p1", oldText, newText)],
      candidate,
      probe: false,
      threshold: candidate.defaultThreshold,
      runId: "replay-run",
      datasetId: "demo",
      concurrency: 1,
      maxTotalCostUsd: null,
      replayOnly: true,
      deps: deps({
        fetchImpl: async () => { throw new Error("replay called the network"); },
        cassetteText: cassette.join(""),
        now: () => new Date("2026-09-24T12:00:00.000Z"),
      }),
    });
    expect(replay.rows.map(scoredRowIdentity)).toEqual(recorded.rows.map(scoredRowIdentity));
    expect(replay.rows[0]?.runId).not.toBe(recorded.rows[0]?.runId);
    expect(replay.rows[0]?.timestamp).not.toBe(recorded.rows[0]?.timestamp);
    expect(scoreJudgeRows(replay.rows, "descriptive")).toEqual(scoreJudgeRows(recorded.rows, "descriptive"));
    expect(scoredRowIdentityFields).not.toContain("runId");
    expect(scoredRowIdentityFields).not.toContain("timestamp");
  });

  it("keeps concurrent reservations inside the cost cap", async () => {
    const candidate = candidateById("jev-noul-v1");
    const reservation = worstCaseReservationUsd("olda", "newa", candidate);
    const cap = (Math.round(reservation * 1_000_000) * 2) / 1_000_000;
    let active = 0;
    let maxActive = 0;
    const fetchImpl: typeof fetch = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ q: { noul: 0.1 } }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: reservation },
      }), { status: 200 });
    };
    const result = await executeCalls({
      pairs: ["a", "b", "c", "d"].map((id) => loaded(id, `old${id}`, `new${id}`)),
      candidate,
      probe: false,
      threshold: candidate.defaultThreshold,
      runId: "cap-run",
      datasetId: "demo",
      concurrency: 4,
      maxTotalCostUsd: cap,
      replayOnly: false,
      deps: deps({ fetchImpl, cassetteText: "" }),
    });
    expect(maxActive).toBe(2);
    expect(result.providerCalls).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.stopReason).toBe("cost_cap");
    expect(result.highWaterUsd).toBeLessThanOrEqual(cap + 1e-9);
  });

  it("shares one provider call when concurrent rows use the same cassette key", async () => {
    const candidate = candidateById("jev-noul-v1");
    const oldText = "same-old";
    const newText = "same-new";
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ q: { noul: 0.42 } }) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.004 },
      }), { status: 200 });
    };
    const cassette: string[] = [];
    const result = await executeCalls({
      pairs: [loaded("p1", oldText, newText), loaded("p2", oldText, newText)],
      candidate,
      probe: false,
      threshold: candidate.defaultThreshold,
      runId: "shared-run",
      datasetId: "demo",
      concurrency: 2,
      maxTotalCostUsd: null,
      replayOnly: false,
      deps: deps({
        fetchImpl,
        cassetteText: "",
        appendCassette: (line) => { cassette.push(line); },
      }),
    });
    expect(fetches).toBe(1);
    expect(result.providerCalls).toBe(1);
    expect(result.cumulativeCostUsd).toBe(0.004);
    expect(cassette).toHaveLength(1);
    expect(result.rows).toHaveLength(2);
    const [first, second] = result.rows;
    expect(first?.pairId).not.toBe(second?.pairId);
    expect(first?.latencyMs).toBe(second?.latencyMs);
    expect(first?.latencyMs).toBeGreaterThan(0);
    expect(first?.usage).toEqual(second?.usage);
    expect(first?.billedCostUsd).toBe(second?.billedCostUsd);
    expect(first?.estimatedCostUsd).toBe(second?.estimatedCostUsd);
    expect(first?.retryCount).toBe(second?.retryCount);
    expect(first?.signals).toEqual(second?.signals);
    expect(first?.decision).toBe(second?.decision);
  });

  it("leaves a failed call unrecorded so replay-only misses loudly", async () => {
    const candidate = candidateById("jev-noul-v1");
    const cassette: string[] = [];
    const recorded = await executeCalls({
      pairs: [loaded("p1", "old-err", "new-err")],
      candidate,
      probe: false,
      threshold: candidate.defaultThreshold,
      runId: "error-run",
      datasetId: "demo",
      concurrency: 1,
      maxTotalCostUsd: null,
      replayOnly: false,
      deps: deps({
        fetchImpl: async () => new Response("no", { status: 400 }),
        cassetteText: "",
        appendCassette: (line) => { cassette.push(line); },
      }),
    });
    expect(cassette).toEqual([]);
    expect(recorded.rows[0]?.errorClass).toBe("http_400");
    await expect(executeCalls({
      pairs: [loaded("p1", "old-err", "new-err")],
      candidate,
      probe: false,
      threshold: candidate.defaultThreshold,
      runId: "replay-error",
      datasetId: "demo",
      concurrency: 1,
      maxTotalCostUsd: null,
      replayOnly: true,
      deps: deps({
        fetchImpl: async () => { throw new Error("replay called the network"); },
        cassetteText: cassette.join(""),
      }),
    })).rejects.toThrow(/cassette miss/);
  });

  it("stops dispatch when a bill above the estimate reaches the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-overbill-"));
    const candidate = candidateById("jev-noul-v1");
    const pairs = [
      ["p1", "old-a", "new-a", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"],
      ["p2", "old-b", "new-b", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2"],
      ["p3", "old-c", "new-c", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3"],
    ] as const;
    const reservation = worstCaseReservationUsd(pairs[0][1], pairs[0][2], candidate);
    const reservationMicros = Math.round(reservation * 1_000_000);
    const cap = (reservationMicros * 3) / 1_000_000;
    const bill = (reservationMicros * 2) / 1_000_000;
    expect(reservation * pairs.length).toBeLessThanOrEqual(cap);
    const labels = {
      schemaVersion: "runir-judge-benchmark/v1",
      taskId: "supersession-pair/v1",
      datasetId: "demo",
      legacyBinaryGold: false,
      pairs: pairs.map(([pairId, oldText, newText, oldId, newId]): JudgePair => makePair({
        pairId,
        oldText,
        newText,
        oldId,
        newId,
        split: "calibration",
        cosine: 0.9,
        gold: "independent",
      })),
    };
    const labelsPath = join(dir, "labels.json");
    const textsPath = join(dir, "texts.jsonl");
    const rawPath = join(dir, "raw.jsonl");
    const reportPath = join(dir, "report.md");
    writeFileSync(labelsPath, JSON.stringify(labels));
    writeFileSync(textsPath, pairs.flatMap(([, oldText, newText, oldId, newId]) => [
      JSON.stringify({ id: oldId, sha256: sha256Text(oldText), text: oldText }),
      JSON.stringify({ id: newId, sha256: sha256Text(newText), text: newText }),
    ]).join("\n") + "\n");
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      const turn = ++fetches;
      await new Promise((resolve) => setTimeout(resolve, turn === 1 ? 20 : 80));
      const cost = turn === 1 ? bill : 0;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ q: { noul: 0.2 } }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost },
      }), { status: 200 });
    };
    const result = await runJudgeBenchmark([
      "run",
      "--dataset", "demo",
      "--candidate", "jev-noul-v1",
      "--labels", labelsPath,
      "--texts", textsPath,
      "--confirm-cost",
      "--max-total-cost-usd", String(cap),
      "--concurrency", "2",
      "--out-raw", rawPath,
      "--out-report", reportPath,
      "--cassette", join(dir, "cassette.jsonl"),
    ], {
      cwd: dir,
      env: { REQUESTY_API_KEY: "test-key" },
      git: () => ({ sha: "abc", dirty: false }),
      fetchImpl,
      log: () => undefined,
    });
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(1);
    expect(fetches).toBe(2);
    const raw = readFileSync(rawPath, "utf8");
    expect(raw).toContain("\"pairId\":\"p1\"");
    expect(raw).toContain("\"pairId\":\"p2\"");
    expect(raw).not.toContain("\"pairId\":\"p3\"");
    const manifest = JSON.parse(readFileSync(manifestPathFor(rawPath), "utf8")) as JudgeRunManifest;
    expect(manifest.completion.status).toBe("partial");
    expect(manifest.completion.stopReason).toBe("cost_cap");
    expect(manifest.completion.plannedRequestCount).toBe(3);
    expect(manifest.completion.completedRequestCount).toBe(2);
    expect(manifest.completion.cumulativeCostUsd).toBeGreaterThan(reservation);
  });
});
