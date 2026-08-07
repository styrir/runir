// Think-mode synthesis helpers (Rúnir-b40x.6) — the G-Brain-style cited-answer
// layer for the agent-steered retrieval surface.
//
// Design constraints (see Rúnir-b40x.6 notes / gbrain analysis):
// - Synthesis lives ONLY on the explicit /memory/think surface — the ambient
//   hooks stay raw prepend (the consuming agent is itself an LLM; per-turn
//   synthesis would pay twice).
// - Hard rules: cite every substantive claim; when the brain lacks the data,
//   say so in gaps[] — NEVER invent. Empty retrieval short-circuits to an
//   honest no-answer WITHOUT an LLM call.
// - Citations are validated against the evidence set: an id the model invents
//   is DROPPED (and surfaces in droppedCitations for observability).

export type ThinkEvidenceItem = { id: string; text: string };

export const THINK_MAX_EVIDENCE_ITEMS = 12;
export const THINK_MAX_EVIDENCE_TEXT_CHARS = 4_000;
export const THINK_MAX_QUESTION_CHARS = 2_000;
export const THINK_RETRIEVAL_TOP_K = 24;
export const THINK_PROMPT_OVERHEAD_CHARS = 8_000;
export const THINK_MAX_OUTPUT_TOKENS = 1_200;

export type ThinkCitation = { id: string; index: number };

export type ThinkClaim = {
  text: string;
  citations: ThinkCitation[];
  droppedCitations: string[];
};

export type ThinkSynthesis = {
  answer: string | null;
  claims: ThinkClaim[];
  citations: ThinkCitation[];
  gaps: string[];
  droppedCitations: string[];
  schemaValid: boolean;
  parseClassification: "valid" | "repaired" | "wrong_schema" | "unparseable" | "empty_evidence";
};

/** Default model for explicit /memory/think answer synthesis. This lane is
 *  independent from capture extraction and intentionally sends no
 *  reasoning-effort parameter. */
export const DEFAULT_THINK_MODEL = "openai/gpt-5.6-luna";

/** Resolve the Think model without coupling it to the capture-only
 *  EXTRACT_MODEL override. RUNIR_EXTRACTOR_MODEL remains a legacy shared
 *  fallback for existing deployments. */
export function resolveThinkModel(
  env: Record<string, string | undefined> = process.env,
): string {
  const own = env.RUNIR_THINK_MODEL?.trim();
  if (own) return own;
  const shared = env.RUNIR_EXTRACTOR_MODEL?.trim();
  if (shared) return shared;
  return DEFAULT_THINK_MODEL;
}

export function shortId(fullId: string): string {
  const bare = fullId.replace(/^[^:]+:/, "").replace(/[⟨⟩]/g, "");
  return bare.slice(0, 8);
}

export function buildThinkPrompt(question: string, evidence: ThinkEvidenceItem[]): { system: string; user: string } {
  const system = [
    "You are the synthesis layer of a personal memory system. Answer the question",
    "using ONLY the evidence items provided.",
    "",
    "Hard rules:",
    "- Cite EVERY substantive claim with the id of the evidence item supporting it.",
    "- If the evidence does not contain the data needed to answer (fully or partly),",
    '  say so in the "gaps" array, listing the specific missing pieces. Do NOT make',
    "  up answers and do NOT use outside knowledge.",
    "- If nothing in the evidence is relevant, set answer to null and explain in gaps.",
    "",
    "Return ONLY valid JSON, no fences, in this exact shape:",
    '{"answer": string|null, "claims": [{"text": string, "citations": ["<evidence id>", ...]}], "gaps": [string, ...]}',
    "- Split the answer into independently checkable claims. Every claim must carry its own citations.",
    "- The answer is the readable synthesis of claims; use null when no claim can be supported.",
    "- Citations must be the complete evidence ids exactly as given.",
  ].join("\n");
  const block = evidence
    .map((item) => `<evidence id="${item.id}">\n${item.text}\n</evidence>`)
    .join("\n");
  const user = `Question: ${question}\n\n${block}\n\nRespond with the JSON object only.`;
  return { system, user };
}

export function buildThinkChatRequest(
  model: string,
  system: string,
  user: string,
  options: { maxOutputTokens?: number; temperature?: number } = {},
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: options.maxOutputTokens ?? THINK_MAX_OUTPUT_TOKENS,
    temperature: options.temperature ?? 0.2,
  };
}

/** Parses the model's JSON (jsonrepair fallback) and validates citations
 *  against the evidence set. Never throws — unparseable output degrades to an
 *  honest no-answer with the failure recorded as a gap. */
export function parseThinkResponse(
  raw: string,
  evidence: ThinkEvidenceItem[],
  repair: (s: string) => string,
): ThinkSynthesis {
  const byFull = new Map(evidence.map((item, index) => [item.id, { id: item.id, index }]));
  const byShort = new Map<string, ThinkCitation | null>();
  evidence.forEach((item, index) => {
    const key = shortId(item.id);
    byShort.set(key, byShort.has(key) ? null : { id: item.id, index });
  });
  let jsonText = raw.trim();
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1].trim();
  let parsed: any;
  let parseClassification: ThinkSynthesis["parseClassification"] = "valid";
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(repair(jsonText));
      parseClassification = "repaired";
    } catch {
      return {
        answer: null,
        claims: [],
        citations: [],
        gaps: ["synthesis output was not parseable JSON — no answer produced"],
        droppedCitations: [],
        schemaValid: false,
        parseClassification: "unparseable",
      };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      answer: null,
      claims: [],
      citations: [],
      gaps: ["synthesis output had no JSON object"],
      droppedCitations: [],
      schemaValid: false,
      parseClassification: "wrong_schema",
    };
  }
  const resolveCitation = (rawId: string): ThinkCitation | undefined => {
    const full = byFull.get(rawId);
    if (full) return full;
    const directShort = byShort.get(rawId);
    if (directShort) return directShort;
    const shortened = byShort.get(shortId(rawId));
    return shortened ?? undefined;
  };
  const normalizeClaim = (value: unknown): ThinkClaim | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const claim = value as Record<string, unknown>;
    if (typeof claim.text !== "string" || !claim.text.trim() || !Array.isArray(claim.citations)) return undefined;
    const citations: ThinkCitation[] = [];
    const droppedCitations: string[] = [];
    const seen = new Set<string>();
    for (const rawCitation of claim.citations) {
      const citationValue = rawCitation && typeof rawCitation === "object" && !Array.isArray(rawCitation)
        ? (rawCitation as Record<string, unknown>).id
        : rawCitation;
      const key = String(citationValue ?? "").trim();
      const hit = resolveCitation(key);
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        citations.push(hit);
      } else if (!hit) {
        droppedCitations.push(key);
      }
    }
    return { text: claim.text.trim(), citations, droppedCitations };
  };
  const rawClaims: unknown[] = Array.isArray(parsed.claims) ? parsed.claims : [];
  const parsedClaims = rawClaims
    .map(normalizeClaim)
    .filter((claim: ThinkClaim | undefined): claim is ThinkClaim => claim !== undefined);
  // Old top-level citation output remains readable, but is classified as the
  // legacy/wrong schema so benchmark provenance cannot silently mix it.
  const legacyCitations = Array.isArray(parsed.citations) ? parsed.citations : [];
  const answer = typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : null;
  const claims = parsedClaims.length
    ? parsedClaims
    : answer
      ? [normalizeClaim({ text: answer, citations: legacyCitations })!]
      : [];
  const citations: ThinkCitation[] = [];
  const droppedCitations = claims.flatMap((claim) => claim.droppedCitations);
  const seen = new Set<string>();
  for (const claim of claims) {
    for (const citation of claim.citations) {
      if (!seen.has(citation.id)) {
        seen.add(citation.id);
        citations.push(citation);
      }
    }
  }
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.filter((g: unknown) => typeof g === "string").slice(0, 12) : [];
  const schemaValid = Array.isArray(parsed.claims) &&
    parsedClaims.length === rawClaims.length &&
    Array.isArray(parsed.gaps) &&
    (parsed.answer === null || typeof parsed.answer === "string");
  return {
    answer,
    claims,
    citations,
    gaps,
    droppedCitations,
    schemaValid,
    parseClassification: schemaValid ? parseClassification : "wrong_schema",
  };
}

/** The honest empty-retrieval response — produced WITHOUT an LLM call. */
export function emptyThinkResponse(question: string): ThinkSynthesis {
  return {
    answer: null,
    claims: [],
    citations: [],
    gaps: [`no stored memory covers: ${question.slice(0, 200)}`],
    droppedCitations: [],
    schemaValid: true,
    parseClassification: "empty_evidence",
  };
}
