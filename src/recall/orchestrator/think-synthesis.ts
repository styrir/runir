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

export type ThinkSynthesis = {
  answer: string | null;
  citations: Array<{ id: string; index: number }>;
  gaps: string[];
  droppedCitations: string[];
};

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
    '{"answer": string|null, "citations": ["<evidence id>", ...], "gaps": [string, ...]}',
    'Citations must be evidence ids exactly as given (e.g. "a1b2c3d4").',
  ].join("\n");
  const block = evidence
    .map((item) => `<evidence id="${shortId(item.id)}">\n${item.text}\n</evidence>`)
    .join("\n");
  const user = `Question: ${question}\n\n${block}\n\nRespond with the JSON object only.`;
  return { system, user };
}

/** Parses the model's JSON (jsonrepair fallback) and validates citations
 *  against the evidence set. Never throws — unparseable output degrades to an
 *  honest no-answer with the failure recorded as a gap. */
export function parseThinkResponse(
  raw: string,
  evidence: ThinkEvidenceItem[],
  repair: (s: string) => string,
): ThinkSynthesis {
  const byShort = new Map(evidence.map((item, index) => [shortId(item.id), { id: item.id, index }]));
  let jsonText = raw.trim();
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1].trim();
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(repair(jsonText));
    } catch {
      return {
        answer: null,
        citations: [],
        gaps: ["synthesis output was not parseable JSON — no answer produced"],
        droppedCitations: [],
      };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { answer: null, citations: [], gaps: ["synthesis output had no JSON object"], droppedCitations: [] };
  }
  const rawCitations: unknown[] = Array.isArray(parsed.citations) ? parsed.citations : [];
  const citations: Array<{ id: string; index: number }> = [];
  const droppedCitations: string[] = [];
  const seen = new Set<string>();
  for (const rawCitation of rawCitations) {
    const key = String(rawCitation).trim();
    const hit = byShort.get(key) ?? byShort.get(shortId(key));
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      citations.push(hit);
    } else if (!hit) {
      droppedCitations.push(key);
    }
  }
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.filter((g: unknown) => typeof g === "string").slice(0, 12) : [];
  const answer = typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : null;
  return { answer, citations, gaps, droppedCitations };
}

/** The honest empty-retrieval response — produced WITHOUT an LLM call. */
export function emptyThinkResponse(question: string): ThinkSynthesis {
  return {
    answer: null,
    citations: [],
    gaps: [`no stored memory covers: ${question.slice(0, 200)}`],
    droppedCitations: [],
  };
}
