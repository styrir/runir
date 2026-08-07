import type { Candidate, ReasoningLevel } from "./types.js";

const PRICE_AS_OF = "2026-07-23";

/**
 * Primary decision matrix (user-confirmed 2026-07-23):
 * 1. Gemini 3.1 Flash-Lite @us — production control
 * 2. Gemini 3.5 Flash-Lite — generation challenger
 * 3. GPT-5.6 Luna low — reasoning=low
 * 4. Grok 4.5 low — reasoning_effort=low (xAI default is high; cannot disable)
 *
 * Optional extras (Luna none, Grok high, etc.) stay under explicit ids / extended.
 */
export const DEFAULT_CANDIDATES: Candidate[] = [
  {
    id: "flash-lite-3.1-control",
    label: "Gemini 3.1 Flash-Lite @us (control / production)",
    modelId: "vertex/gemini-3.1-flash-lite@us",
    reasoningSupport: "unsupported",
    jsonMode: "off",
    pricePer1M: {
      input: 0.45,
      output: 2.7,
      asOf: PRICE_AS_OF,
      source: "Google global list pricing orientation (gateway may differ)",
    },
  },
  {
    id: "flash-lite-3.5",
    label: "Gemini 3.5 Flash-Lite (challenger)",
    // Requesty list: bare + @eu (no @us pin for 3.5-flash-lite).
    modelId: "vertex/gemini-3.5-flash-lite",
    reasoningSupport: "unsupported",
    jsonMode: "off",
    pricePer1M: {
      input: 0.45,
      output: 2.7,
      asOf: PRICE_AS_OF,
      source: "Google global list pricing orientation (gateway may differ)",
    },
  },
  {
    id: "luna-low",
    label: "GPT-5.6 Luna (reasoning=low)",
    modelId: "openai/gpt-5.6-luna",
    reasoning: "low",
    reasoningSupport: "native",
    jsonMode: "required",
    pricePer1M: {
      input: 1.0,
      output: 6.0,
      asOf: PRICE_AS_OF,
      source: "OpenAI list pricing; reasoning tokens count as output",
    },
  },
  {
    id: "grok-4.5-low",
    label: "Grok 4.5 (reasoning=low)",
    modelId: "xai/grok-4.5",
    // xAI: reasoning_effort low|medium|high; default HIGH; cannot disable.
    // Requesty accepts top-level reasoning_effort=low (verified 2026-07-23).
    reasoning: "low",
    reasoningSupport: "native",
    jsonMode: "off",
    pricePer1M: {
      input: 2.0,
      output: 6.0,
      asOf: PRICE_AS_OF,
      source: "xAI list pricing; reasoning tokens bill as output",
    },
  },
];

/** Optional extras beyond the primary four. */
export const EXTENDED_CANDIDATES: Candidate[] = [
  ...DEFAULT_CANDIDATES,
  {
    id: "luna-none",
    label: "GPT-5.6 Luna (reasoning=none)",
    modelId: "openai/gpt-5.6-luna",
    reasoning: "none",
    reasoningSupport: "native",
    jsonMode: "required",
    pricePer1M: {
      input: 1.0,
      output: 6.0,
      asOf: PRICE_AS_OF,
      source: "OpenAI list pricing; reasoning tokens count as output",
    },
  },
  {
    id: "grok-4.5-high",
    label: "Grok 4.5 (reasoning=high / xAI default)",
    modelId: "xai/grok-4.5",
    reasoning: "high",
    reasoningSupport: "native",
    jsonMode: "off",
    pricePer1M: {
      input: 2.0,
      output: 6.0,
      asOf: PRICE_AS_OF,
      source: "xAI list pricing; reasoning tokens bill as output",
    },
  },
  // Legacy aliases used in early session artifacts
  {
    id: "grok-4.5",
    label: "Grok 4.5 (reasoning=low) [alias]",
    modelId: "xai/grok-4.5",
    reasoning: "low",
    reasoningSupport: "native",
    jsonMode: "off",
    pricePer1M: {
      input: 2.0,
      output: 6.0,
      asOf: PRICE_AS_OF,
      source: "xAI list pricing; reasoning tokens bill as output",
    },
  },
];

const ALL_KNOWN: Candidate[] = (() => {
  const m = new Map<string, Candidate>();
  for (const c of [...DEFAULT_CANDIDATES, ...EXTENDED_CANDIDATES]) m.set(c.id, c);
  m.set("flash-lite-control", DEFAULT_CANDIDATES[0]!);
  return [...m.values()];
})();

export function resolveCandidateMatrix(selector: string[] | undefined): Candidate[] {
  if (!selector || selector.length === 0 || (selector.length === 1 && selector[0] === "default")) {
    return DEFAULT_CANDIDATES.map((c) => ({ ...c }));
  }
  if (selector.length === 1 && (selector[0] === "extended" || selector[0] === "all")) {
    // Deduplicate by id while preserving order
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of EXTENDED_CANDIDATES) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c });
    }
    return out;
  }
  if (
    selector.length === 1 &&
    (selector[0] === "smoke-default" || selector[0] === "primary" || selector[0] === "flash-lite")
  ) {
    // flash-lite alone is the two Flash models; primary/smoke-default = full primary four
    if (selector[0] === "flash-lite") {
      return DEFAULT_CANDIDATES.filter((c) => c.id.startsWith("flash-lite-")).map((c) => ({ ...c }));
    }
    return DEFAULT_CANDIDATES.map((c) => ({ ...c }));
  }

  const byId = new Map(ALL_KNOWN.map((c) => [c.id, c]));
  const byModel = new Map(ALL_KNOWN.map((c) => [c.modelId, c]));
  const out: Candidate[] = [];
  for (const token of selector) {
    const known = byId.get(token) ?? byModel.get(token);
    if (known) {
      out.push({ ...known });
      continue;
    }
    out.push({
      id: token,
      label: token,
      modelId: token,
      reasoningSupport:
        token.includes("luna") || token.startsWith("openai/")
          ? "native"
          : token.includes("grok")
            ? "native"
            : "unsupported",
      reasoning: token.includes("luna") || token.includes("grok") ? "low" : undefined,
      jsonMode: token.startsWith("openai/") ? "required" : "off",
    });
  }
  return out;
}

/**
 * Build the gateway reasoning parameter payload for a candidate.
 * Returns null when no reasoning field should be sent.
 * Throws when a requested reasoning level cannot be represented honestly.
 */
export function buildReasoningParam(
  candidate: Candidate,
): { param: Record<string, unknown> | undefined; notes: string[]; effective?: ReasoningLevel } {
  const notes: string[] = [];
  const level = candidate.reasoning;

  if (candidate.reasoningSupport === "unsupported") {
    if (level && level !== "none") {
      throw new Error(
        `Candidate ${candidate.id}: reasoning=${level} requested but reasoningSupport=unsupported — refusing silent mislabel`,
      );
    }
    notes.push("reasoning unsupported; no reasoning parameter sent");
    return { param: undefined, notes };
  }

  if (candidate.reasoningSupport === "default-only") {
    if (level && level !== "none") {
      notes.push(
        `reasoningSupport=default-only: requested reasoning=${level} is NOT asserted; gateway default behavior applies; do not label results as "${level}"`,
      );
    } else {
      notes.push("reasoningSupport=default-only; no reasoning parameter sent");
    }
    return { param: undefined, notes, effective: undefined };
  }

  // native
  if (!level) {
    notes.push("native reasoning support but no level set; omitting parameter");
    return { param: undefined, notes };
  }

  // Grok 4.5 cannot disable reasoning — refuse none so we never mislabel.
  if (
    (candidate.modelId.includes("grok-4.5") || candidate.id.includes("grok-4.5")) &&
    level === "none"
  ) {
    throw new Error(
      `Candidate ${candidate.id}: Grok 4.5 cannot disable reasoning (xAI); use low|medium|high`,
    );
  }

  if (level === "none") {
    return {
      param: { reasoning_effort: "none" },
      notes: ["native reasoning_effort=none"],
      effective: "none",
    };
  }
  return {
    param: { reasoning_effort: level },
    notes: [`native reasoning_effort=${level}`],
    effective: level,
  };
}

/** Only enforced when 2+ Luna configs are present in the selected matrix. */
export function assertLunaConfigsDistinct(candidates: Candidate[]): void {
  const luna = candidates.filter((c) => c.modelId.includes("gpt-5.6-luna") || c.id.startsWith("luna-"));
  if (luna.length < 2) return;
  const fingerprints = luna.map((c) => {
    const built = buildReasoningParam(c);
    return JSON.stringify({
      id: c.id,
      modelId: c.modelId,
      reasoning: c.reasoning,
      param: built.param ?? null,
      effective: built.effective ?? null,
    });
  });
  const unique = new Set(fingerprints);
  if (unique.size !== fingerprints.length) {
    throw new Error("Luna low and Luna none must serialize as distinct effective configurations");
  }
}
