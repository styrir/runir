import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { labelBatch, realRunner } from "../../../../scripts/judge-benchmark/failure-groups.js";
import { rng } from "../../../../scripts/judge-benchmark/shared.js";
import { BINS, claudeProxyCompletion, disagreement, disagreementShares, failureRecord, jointBootstrap, kappa, LABELS, majority, pairPayload, parseResponses, promptFor, quotas, requestCap, roleOnlyControls, runWithinRequestCap, sampleControls, shares, uniqueMode, validateReportData, type FinalRow, type SignalRow } from "../failure-groups.js";

const row = (pairId: string, outcome: string, cluster: number, role = "matched_candidate", session: boolean | null = true): SignalRow => ({ pairId, outcome, cluster, snapshotRole: role, sameSession: { value: session }, newInOld: { value: 0.5 }, jaccard: { value: 0.5 } });
const id = (n: number) => `ss-${n.toString(16).padStart(12, "0")}`;
function fixture(): SignalRow[] {
  const rows: SignalRow[] = [];
  for (let i = 0; i < 47; i++) rows.push(row(id(i), "wrong_retirement", i, i % 2 ? "blocked_nomination" : "matched_candidate", i % 3 === 0));
  for (let i = 47; i < 89; i++) rows.push(row(id(i), "wrong_skip", i, i % 2 ? "blocked_nomination" : "matched_candidate", i % 3 === 0));
  rows.push(row(id(89), "wrong_skip", 89, "matched_candidate", null));
  for (let i = 90; i < 690; i++) rows.push(row(id(i), "correct_keep", 90 + Math.floor((i - 90) / 3), i % 2 ? "blocked_nomination" : "matched_candidate", i % 3 === 0));
  return rows;
}
const final = (pairId: string, population: FinalRow["population"], label: FinalRow["label"], cluster = 1): FinalRow => ({ pairId, population, mistakeType: population === "correct_keep" ? null : population, forType: "wrong_retirement", cluster, snapshotRole: "matched_candidate", sameSession: true, label, status: label ? "agreed" : "failed", confidence: label ? "high" : null });

describe("Step 3 sampling", () => {
  it("draws reproducible 47/42 quotas, skips null, and caps OLD reuse across draws", () => {
    const rows = fixture(), a = sampleControls(rows, rng(12)), b = sampleControls(rows, rng(12));
    expect(a).toEqual(b);
    expect(a.filter((x) => x.forType === "wrong_retirement")).toHaveLength(47);
    expect(a.filter((x) => x.forType === "wrong_skip")).toHaveLength(42);
    expect([...quotas(rows, "wrong_skip").values()].reduce((x, y) => x + y, 0)).toBe(42);
    expect(a.every((x) => x.cell.sameSession !== null)).toBe(true);
    expect(rows.filter((x) => x.outcome === "correct_keep" && x.cluster === 90)).toHaveLength(3);
    expect(Math.max(...[...new Set(a.map((x) => x.cluster))].map((c) => a.filter((x) => x.cluster === c).length))).toBeLessThanOrEqual(2);
  });
  it("aborts a shortfall without backfill", () => {
    expect(() => sampleControls([row(id(1), "wrong_retirement", 1), row(id(2), "correct_keep", 2, "blocked_nomination")], rng(1))).toThrow(/control_shortfall/u);
  });
  it("rejects a third control from one OLD cluster", () => {
    const mistakes = [1, 2, 3].map((n) => row(id(n), "wrong_retirement", n));
    const controls = [4, 5, 6].map((n) => row(id(n), "correct_keep", 99));
    expect(() => sampleControls([...mistakes, ...controls], rng(1))).toThrow(/control_shortfall/u);
  });
});
describe("Step 3 protocol and adjudication", () => {
  it("uses only the stripped payload and ordered protocol", () => {
    const payload = pairPayload(id(1), "old claim", "new claim");
    expect(Object.keys(payload)).toEqual(["pairId", "oldText", "newText"]);
    const prompt = promptFor([payload]);
    expect(prompt.indexOf("1. true_duplicate")).toBeLessThan(prompt.indexOf("7. other"));
    expect(prompt).toContain(JSON.stringify(payload));
  });
  it("validates exact response shape, note length, IDs, and enums", () => {
    const expected = new Set([id(1)]), good = JSON.stringify({ pairId: id(1), label: "continuation", confidence: "high", note: "later step" });
    expect(parseResponses(good, expected)).toHaveLength(1);
    expect(parseResponses(good.replace("continuation", "free text"), expected)).toEqual([]);
    expect(parseResponses(good.replace("later step", "one two three four five six seven eight nine ten eleven twelve thirteen"), expected)).toEqual([]);
    expect(parseResponses(good.replace('"note":', '"extra":"text","note":'), expected)).toEqual([]);
  });
  it("keeps valid lines when another batch row is invalid", () => {
    const good = JSON.stringify({ pairId: id(1), label: "continuation", confidence: "high", note: "later step" });
    const bad = JSON.stringify({ pairId: id(2), label: "invalid", confidence: "high", note: "later step" });
    expect(parseResponses(`${good}\n${bad}\nnot json`, new Set([id(1), id(2)]))).toEqual([JSON.parse(good)]);
  });
  it("caps requests before calling the runner", () => {
    expect(requestCap(25, 12)).toBe(28);
    let called = false;
    expect(() => runWithinRequestCap(28, 28, () => { called = true; })).toThrow("request_cap");
    expect(called).toBe(false);
    expect(runWithinRequestCap(27, 28, (next) => next)).toBe(28);
  });
  it("uses absolute Step 3 paths with an empty temp cwd in the real runner", () => {
    const root = mkdtempSync(join(tmpdir(), "runir-step3-runner-test-"));
    const step3 = join(root, "step3"), home = join(root, "home");
    mkdirSync(step3);
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "fake auth");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const labeler of ["gpt", "grok"] as const) {
        const fakeExec = ((file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
          expect(file).toBe(labeler === "gpt" ? "codex" : "grok");
          expect(isAbsolute(options.cwd)).toBe(true);
          expect(options.cwd.startsWith(tmpdir())).toBe(true);
          expect(readdirSync(options.cwd)).toEqual([]);
          const cwdFlag = labeler === "gpt" ? "-C" : "--cwd";
          expect(args[args.indexOf(cwdFlag) + 1]).toBe(options.cwd);
          const promptFiles = readdirSync(step3).filter((name) => name.endsWith(".prompt.md"));
          expect(promptFiles).toHaveLength(1);
          const promptPath = join(step3, promptFiles[0]!);
          expect(isAbsolute(promptPath)).toBe(true);
          expect(readFileSync(promptPath, "utf8")).toBe("synthetic prompt");
          if (labeler === "grok") {
            expect(args[args.indexOf("--prompt-file") + 1]).toBe(promptPath);
            expect(options.env.GROK_HOME).toBe(join(step3, "grok-home"));
            expect(existsSync(join(step3, "grok-home", "auth.json"))).toBe(true);
          } else {
            const outputPath = args[args.indexOf("--output-last-message") + 1]!;
            expect(isAbsolute(outputPath)).toBe(true);
            expect(outputPath.startsWith(`${step3}/`)).toBe(true);
            writeFileSync(outputPath, "synthetic output");
          }
          return Buffer.from("synthetic output");
        }) as unknown as typeof execFileSync;
        expect(realRunner(labeler, "synthetic prompt", relative(process.cwd(), step3), fakeExec)).toBe("synthetic output");
        expect(readdirSync(step3).filter((name) => name.endsWith(".prompt.md") || name.endsWith(".last.txt"))).toEqual([]);
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("retries each pair once when the whole batch call throws", async () => {
    const ids = [id(1), id(2)];
    const texts = new Map(ids.map((pairId) => [pairId, { pairId, oldText: "synthetic old", newText: "synthetic new" }]));
    const saved: string[] = [], failed: string[] = [], prompts: string[] = [];
    await labelBatch(new Set(ids), texts, (prompt) => {
      prompts.push(prompt);
      return runWithinRequestCap(prompts.length - 1, requestCap(ids.length, 12), () => {
        if (prompts.length === 1) throw new Error("batch failed");
        const pairId = ids.find((candidate) => prompt.includes(candidate))!;
        return JSON.stringify({ pairId, label: "continuation", confidence: "high", note: "later step" });
      });
    }, (row) => saved.push(row.pairId), (pairId) => failed.push(pairId));
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain(ids[0]);
    expect(prompts[0]).toContain(ids[1]);
    expect(prompts[1]).toContain(ids[0]);
    expect(prompts[1]).not.toContain(ids[1]);
    expect(prompts[2]).toContain(ids[1]);
    expect(prompts[2]).not.toContain(ids[0]);
    expect(saved).toEqual(ids);
    expect(failed).toEqual([]);
  });
  it("posts the frozen prompt to the Claude proxy and parses its first choice", async () => {
    const prompt = promptFor([{ pairId: id(1), oldText: "old", newText: "new" }]);
    let request: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      request = { url, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "first" } }, { message: { content: "second" } }] }) } as Response;
    }) as typeof fetch;
    expect(await claudeProxyCompletion(prompt, fakeFetch)).toBe("first");
    expect(request?.url).toBe("http://127.0.0.1:8318/v1/chat/completions");
    expect(JSON.parse(String(request?.init.body))).toEqual({ model: "claude-fable-5-1", messages: [{ role: "user", content: prompt }], temperature: 0 });
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("records only pair ID and sanitized code on proxy failures", async () => {
    const body = "sensitive response body";
    const fakeHttp = (async () => ({ ok: false, status: 503, text: async () => body })) as typeof fetch;
    const fakeNetwork = (async () => { throw new Error("sensitive network detail"); }) as typeof fetch;
    for (const [transport, code] of [[fakeHttp, "http_503"], [fakeNetwork, "network_error"]] as const) {
      const error: unknown = await claudeProxyCompletion("prompt", transport).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const record = failureRecord(id(1), error);
      expect(record).toEqual({ pairId: id(1), code });
      expect(JSON.stringify(record)).not.toContain("sensitive");
    }
  });
  it("returns majority or unresolved", () => {
    expect(majority("continuation", "continuation")).toEqual({ label: "continuation", status: "agreed" });
    expect(majority("continuation", "true_update", "true_update")).toEqual({ label: "true_update", status: "tiebroken" });
    expect(majority("continuation", "true_update", "other")).toEqual({ label: null, status: "unresolved" });
  });
  it("computes known Cohen kappa", () => {
    const pairs = [["true_duplicate", "true_duplicate"], ["true_duplicate", "true_update"], ["true_update", "true_update"], ["true_update", "true_duplicate"]] as const;
    expect(kappa(pairs).agreement).toBe(0.5);
    expect(kappa(pairs).kappa).toBe(0);
  });
});
describe("Step 3 reporting", () => {
  it("includes failed, unresolved, unmatched in denominators and preserves unmapped", () => {
    const rows = [final(id(1), "wrong_retirement", "continuation"), final(id(2), "wrong_retirement", "true_duplicate"), final(id(3), "wrong_retirement", null)];
    rows[2]!.sameSession = null;
    expect(shares(rows).continuation).toBe(1 / 3);
    expect(shares(rows).unmatched).toBe(1 / 3);
    expect(disagreement("wrong_retirement", "true_duplicate")).toBe("unmapped");
    expect(disagreementShares(rows).unmapped).toBe(2 / 3);
  });
  it("keeps the role-only control arm within its mistake type", () => {
    const retirement = final(id(1), "correct_keep", "continuation");
    const skip = { ...final(id(2), "correct_keep", "true_update"), forType: "wrong_skip" as const };
    expect(shares(roleOnlyControls([retirement, skip], "wrong_retirement", "matched_candidate")).continuation).toBe(1);
    expect(shares(roleOnlyControls([retirement, skip], "wrong_skip", "matched_candidate")).true_update).toBe(1);
  });
  it("requires a unique mode in at least 95 percent of draws", () => {
    const draw = (label: typeof LABELS[number]) => Object.fromEntries(BINS.map((x) => [x, x === label ? 1 : 0])) as Record<typeof BINS[number], number>;
    expect(uniqueMode([...Array(95).fill(draw("continuation")), ...Array(5).fill(draw("other"))]).label).toBe("continuation");
    expect(uniqueMode([...Array(94).fill(draw("continuation")), ...Array(6).fill(draw("other"))]).label).toBeNull();
  });
  it("bootstraps both arms on one OLD cluster draw and flags zero variance", () => {
    const result = jointBootstrap([final(id(1), "wrong_retirement", "continuation", 1)], [final(id(2), "correct_keep", "other", 1)], rng(1), 20);
    expect(result.difference.continuation.point).toBe(1);
    expect(result.difference.continuation.interval).toEqual([1, 1]);
    expect(result.difference.continuation.noVariance).toBe(true);
  });
  it("rejects free text in report data", () => {
    expect(() => validateReportData({ pairId: id(1), label: "continuation", n: 3 })).not.toThrow();
    expect(() => validateReportData({ note: "private memory text" })).toThrow(/report_free_text/u);
  });
});
