import { jsonrepair } from "jsonrepair";
import type { ParseClassification, ParsedExtraction } from "./types.js";

const VALID_CATEGORIES = new Set([
  "profile",
  "preferences",
  "entities",
  "events",
  "cases",
  "patterns",
]);

/**
 * Classify and parse a model content string the way production extraction expects:
 * object with facts[] — not a bare array.
 */
export function parseExtractionResponse(rawContent: unknown): ParsedExtraction {
  if (typeof rawContent !== "string" || rawContent.trim() === "") {
    return {
      classification: "empty_content",
      schemaValid: false,
      facts: [],
      rawTextHead: "",
      parseError: "empty or non-string content",
    };
  }

  const text = rawContent;
  const head = text.slice(0, 240).replace(/\n/g, "\\n");
  let classification: ParseClassification = "valid";
  let jsonText = text.trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1]!.trim();
    classification = "fenced";
  } else if (/^\s*[^\[{]/.test(text) && /[\[{]/.test(text)) {
    // Prose before JSON object/array
    const objStart = text.search(/[\[{]/);
    if (objStart > 0) {
      jsonText = text.slice(objStart).trim();
      // trim trailing prose after balanced... best-effort: try parse slice
      classification = "prose_prefixed";
    }
  }

  let parsed: unknown;
  try {
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = JSON.parse(jsonrepair(jsonText));
      if (classification === "valid") classification = "malformed";
    }
  } catch (err) {
    return {
      classification: "malformed",
      schemaValid: false,
      facts: [],
      rawTextHead: head,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      classification: "wrong_schema",
      schemaValid: false,
      facts: [],
      rawTextHead: head,
      parseError: "root is not an object with facts[]",
    };
  }

  const factsRaw = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(factsRaw)) {
    return {
      classification: "wrong_schema",
      schemaValid: false,
      facts: [],
      rawTextHead: head,
      parseError: "root.facts is not an array",
    };
  }

  const facts: ParsedExtraction["facts"] = [];
  let schemaOk = true;
  for (const el of factsRaw) {
    if (typeof el === "string") {
      facts.push({ l2: el, confidence: 1 });
      continue;
    }
    if (el === null || typeof el !== "object") {
      schemaOk = false;
      continue;
    }
    const o = el as Record<string, unknown>;
    const l2 = typeof o.l2 === "string" ? o.l2 : undefined;
    if (!l2 || l2.trim() === "") {
      schemaOk = false;
      continue;
    }
    const category = typeof o.category === "string" ? o.category : undefined;
    if (category !== undefined && !VALID_CATEGORIES.has(category)) {
      schemaOk = false;
    }
    const sti = o.source_turn_index;
    if (sti !== undefined && (typeof sti !== "number" || !Number.isFinite(sti) || Array.isArray(sti))) {
      schemaOk = false;
    }
    facts.push({
      l2,
      l0: typeof o.l0 === "string" ? o.l0 : undefined,
      l1: typeof o.l1 === "string" ? o.l1 : undefined,
      confidence: typeof o.confidence === "number" ? o.confidence : undefined,
      source_turn_index: typeof sti === "number" ? sti : undefined,
      category,
      tier: typeof o.tier === "string" ? o.tier : undefined,
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : undefined,
    });
  }

  // Empty facts array is schema-valid production shape.
  return {
    classification: schemaOk ? classification : "wrong_schema",
    schemaValid: schemaOk,
    facts,
    rawTextHead: head,
  };
}
