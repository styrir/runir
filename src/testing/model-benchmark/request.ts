import { createHash } from "node:crypto";
import { extractorJsonMode } from "../../capture/extraction/capture.js";
import { DEFAULT_CAPTURE_PROMPT } from "../../domain/memory/prompts.js";
import { buildReasoningParam } from "./candidates.js";
import type { BenchmarkCase, Candidate, EffectiveRequestConfig } from "./types.js";

export function productionCapturePrompt(sessionTimestamp: string): string {
  return DEFAULT_CAPTURE_PROMPT.replaceAll("{SESSION_TIMESTAMP}", sessionTimestamp);
}

export function buildUserContent(messages: BenchmarkCase["messages"]): string {
  const conversation = messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `Extract facts from this conversation and return a valid json object:\n\n${conversation}`;
}

/**
 * Serialize the effective OpenAI-compatible request body for one candidate/case.
 * Provider-specific unsupported parameters are omitted, never silently mislabeled.
 */
export function buildEffectiveRequest(args: {
  candidate: Candidate;
  maxOutputTokens: number;
  seed?: number;
}): EffectiveRequestConfig {
  const { candidate, maxOutputTokens } = args;
  const seed = args.seed === undefined ? 42 : args.seed;
  const notes: string[] = [];

  const reasoning = buildReasoningParam(candidate);
  notes.push(...reasoning.notes);

  let useJson = false;
  if (candidate.jsonMode === "required") {
    useJson = true;
    if (!extractorJsonMode(candidate.modelId) && !candidate.modelId.startsWith("openai/")) {
      notes.push(
        "jsonMode=required but extractorJsonMode heuristic is false; still sending response_format for openai-compatible luna-style models only if modelId starts with openai/",
      );
    }
    // Only send json_object when openai/* (matches production extractorJsonMode auto path)
    // OR when candidate explicitly requires and model is openai/*.
    useJson = candidate.modelId.startsWith("openai/") || extractorJsonMode(candidate.modelId);
    if (!useJson) {
      throw new Error(
        `Candidate ${candidate.id}: jsonMode=required but model ${candidate.modelId} cannot receive response_format safely`,
      );
    }
  } else if (candidate.jsonMode === "best-effort") {
    useJson = extractorJsonMode(candidate.modelId);
    notes.push(useJson ? "jsonMode best-effort: sending response_format" : "jsonMode best-effort: omitted");
  } else {
    useJson = false;
    notes.push("jsonMode=off: response_format omitted (matches production non-openai extract path)");
  }

  // Production always sends temperature=0. Seed is omitted when undefined.
  const cfg: EffectiveRequestConfig = {
    modelId: candidate.modelId,
    temperature: 0,
    max_tokens: maxOutputTokens,
    notes,
  };

  if (seed !== undefined && Number.isFinite(seed)) {
    // Anthropic-style models may not support seed; mark and omit for anthropic/*
    if (candidate.modelId.startsWith("anthropic/")) {
      cfg.notes.push("seed omitted for anthropic/* (unsupported)");
    } else {
      cfg.seed = seed;
    }
  }

  if (useJson) {
    cfg.response_format = { type: "json_object" };
  }

  if (reasoning.param) {
    cfg.reasoningParam = reasoning.param;
    cfg.reasoning = reasoning.effective;
  } else if (candidate.reasoningSupport === "default-only") {
    // Do not set cfg.reasoning to the requested label — would mislabel.
    cfg.notes.push("effective reasoning level: gateway-default (unlabeled)");
  }

  if (candidate.extraRequestFields) {
    const blocked = ["api_key", "authorization", "token", "password", "secret"];
    for (const key of Object.keys(candidate.extraRequestFields)) {
      if (blocked.some((b) => key.toLowerCase().includes(b))) {
        throw new Error(`Refusing secret-like extraRequestFields key: ${key}`);
      }
    }
  }

  return cfg;
}

export function serializeRequestBody(
  cfg: EffectiveRequestConfig,
  systemPrompt: string,
  userContent: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: cfg.max_tokens,
    temperature: cfg.temperature,
  };
  if (cfg.seed !== undefined) body.seed = cfg.seed;
  if (cfg.response_format) body.response_format = cfg.response_format;
  if (cfg.reasoningParam) Object.assign(body, cfg.reasoningParam);
  if (extra) Object.assign(body, extra);
  return body;
}

export function promptHashFor(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

/** Parameters that must never appear for a given candidate family. */
export function disallowedParamsFor(candidate: Candidate): string[] {
  const disallowed: string[] = [];
  if (candidate.jsonMode === "off" || !candidate.modelId.startsWith("openai/")) {
    // Gemini/xAI production path does not send response_format by default.
    if (candidate.jsonMode === "off") disallowed.push("response_format");
  }
  if (candidate.reasoningSupport !== "native") {
    disallowed.push("reasoning_effort", "reasoning");
  }
  if (candidate.modelId.startsWith("anthropic/")) {
    disallowed.push("seed");
  }
  return disallowed;
}
