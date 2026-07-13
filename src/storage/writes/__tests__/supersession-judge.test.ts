import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  parseJudgeVerdictRaw,
  DEFAULT_JUDGE_CONFIDENCE_FLOOR,
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM_PROMPT,
  judgePromptSha256,
} from "../supersession-judge.js";

// Rúnir-pn1l Layer 2 / 13.7 — the PURE judge module (no LLM gateway import).
// Prompt construction + raw/wrapper parse. Factory lives in src/app/.

describe("buildJudgePrompt", () => {
  it("role-labels OLD before NEW and includes both texts (position-bias mitigation)", () => {
    const msgs = buildJudgePrompt("Priya is the lead", "Marcus is the lead now");
    expect(msgs[0].role).toBe("system");
    const user = msgs.find((m) => m.role === "user")!;
    expect(user.content).toContain("Priya is the lead");
    expect(user.content).toContain("Marcus is the lead now");
    // OLD must appear before NEW so the role assignment is stable across calls.
    expect(user.content.indexOf("OLD")).toBeLessThan(user.content.indexOf("NEW"));
  });
});

// ── D6 — prompt v2 snapshot + version/sha (test 12) ──────────────────────────
// Frozen sha256 of JUDGE_SYSTEM_PROMPT (v2-continuation-2026-07-09). Recompute
// with `node -e "createHash('sha256').update(JUDGE_SYSTEM_PROMPT).digest('hex')"`
// if the prompt text deliberately changes — a self-comparison is vacuous.
const FROZEN_JUDGE_PROMPT_SHA256 =
  "800ccf63d568a87609c19668e3f0af75b32f5670aa5067de8a06a602e36f7e1d";

describe("prompt v2 (Rúnir-pn1l.13.7 D6)", () => {
  it("exports frozen JUDGE_PROMPT_VERSION and continuation clause; sha is pinned literal", () => {
    expect(JUDGE_PROMPT_VERSION).toBe("v2-continuation-2026-07-09");
    expect(JUDGE_SYSTEM_PROMPT).toContain("A CONTINUATION is independent, not a supersession");
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      "Progress in the same workstream does not make the earlier step stale",
    );
    // Literal hex constant — catches accidental prompt drift (P1#5 test 12).
    expect(judgePromptSha256()).toBe(FROZEN_JUDGE_PROMPT_SHA256);
  });

  it("buildJudgePrompt system message is the frozen v2 prompt", () => {
    const msgs = buildJudgePrompt("old", "new");
    expect(msgs[0].content).toBe(JUDGE_SYSTEM_PROMPT);
  });
});

// ── D0 — parseJudgeVerdictRaw (test 10) ──────────────────────────────────────
describe("parseJudgeVerdictRaw", () => {
  it("returns a confident supersede as status:verdict", () => {
    const r = parseJudgeVerdictRaw(JSON.stringify({ verdict: "supersede", confidence: 0.9 }));
    expect(r).toEqual({
      status: "verdict",
      verdict: { verdict: "supersede", confidence: 0.9 },
    });
  });

  it("malformed JSON → invalid_response with class detail", () => {
    const r = parseJudgeVerdictRaw("not json at all");
    expect(r).toEqual({ status: "invalid_response", detail: "malformed_json" });
  });

  it("wrong shape → invalid_response", () => {
    expect(parseJudgeVerdictRaw("null")).toEqual({ status: "invalid_response", detail: "wrong_shape" });
    expect(parseJudgeVerdictRaw("[]")).toEqual({ status: "invalid_response", detail: "wrong_shape" });
    expect(parseJudgeVerdictRaw('"just a string"')).toEqual({
      status: "invalid_response",
      detail: "wrong_shape",
    });
  });

  it("unknown label → invalid_response", () => {
    const r = parseJudgeVerdictRaw(JSON.stringify({ verdict: "delete", confidence: 0.99 }));
    expect(r).toEqual({ status: "invalid_response", detail: "unknown_label" });
  });

  it("out-of-range confidence → invalid_response", () => {
    expect(parseJudgeVerdictRaw(JSON.stringify({ verdict: "supersede", confidence: 99 }))).toEqual({
      status: "invalid_response",
      detail: "out_of_range_confidence",
    });
    expect(parseJudgeVerdictRaw(JSON.stringify({ verdict: "supersede", confidence: -1 }))).toEqual({
      status: "invalid_response",
      detail: "out_of_range_confidence",
    });
  });

  it("non-finite / missing confidence → invalid_response", () => {
    expect(parseJudgeVerdictRaw(JSON.stringify({ verdict: "supersede" }))).toEqual({
      status: "invalid_response",
      detail: "non_finite_confidence",
    });
    expect(parseJudgeVerdictRaw(JSON.stringify({ verdict: "supersede", confidence: NaN }))).toEqual({
      status: "invalid_response",
      detail: "non_finite_confidence",
    });
  });

  it("below-floor confidence stays status:verdict (floor is the resolver's job)", () => {
    const r = parseJudgeVerdictRaw(
      JSON.stringify({ verdict: "supersede", confidence: DEFAULT_JUDGE_CONFIDENCE_FLOOR - 0.1 }),
    );
    expect(r.status).toBe("verdict");
    if (r.status === "verdict") {
      expect(r.verdict.verdict).toBe("supersede");
      expect(r.verdict.confidence).toBeCloseTo(0.5);
    }
  });

  it("strips a ```json fence wrapper before parsing", () => {
    const r = parseJudgeVerdictRaw('```json\n{"verdict":"supersede","confidence":0.9}\n```');
    expect(r.status).toBe("verdict");
  });
});

describe("parseJudgeVerdict (back-compat wrapper)", () => {
  it("returns a confident supersede verdict unchanged", () => {
    const v = parseJudgeVerdict(JSON.stringify({ verdict: "supersede", confidence: 0.9 }));
    expect(v.verdict).toBe("supersede");
    expect(v.confidence).toBe(0.9);
  });

  it("returns a confident duplicate verdict unchanged", () => {
    const v = parseJudgeVerdict(JSON.stringify({ verdict: "duplicate", confidence: 0.8 }));
    expect(v.verdict).toBe("duplicate");
  });

  it("passes through independent", () => {
    const v = parseJudgeVerdict(JSON.stringify({ verdict: "independent", confidence: 0.95 }));
    expect(v.verdict).toBe("independent");
  });

  it("keep-both (independent) on invalid_response cases", () => {
    expect(parseJudgeVerdict("not json at all").verdict).toBe("independent");
    expect(parseJudgeVerdict(JSON.stringify({ verdict: "delete", confidence: 0.99 })).verdict).toBe(
      "independent",
    );
    expect(parseJudgeVerdict(JSON.stringify({ verdict: "supersede", confidence: 99 })).verdict).toBe(
      "independent",
    );
  });

  it("does NOT floor-coerce sub-floor supersede (thin wrapper; floor is resolver-owned)", () => {
    const v = parseJudgeVerdict(
      JSON.stringify({ verdict: "supersede", confidence: DEFAULT_JUDGE_CONFIDENCE_FLOOR - 0.1 }),
    );
    expect(v.verdict).toBe("supersede");
    expect(v.confidence).toBeCloseTo(0.5);
  });

  it("strips a ```json fence wrapper before parsing", () => {
    const v = parseJudgeVerdict('```json\n{"verdict":"supersede","confidence":0.9}\n```');
    expect(v.verdict).toBe("supersede");
  });
});
