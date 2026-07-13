import type { Hono } from "hono";
import { extractMemories, normalizeCaptureMessages, resolveCapturePrompt, segmentAndSummarize } from "../../capture/extraction/capture.js";
import { compressMessages } from "../../capture/continuity/session-compressor.js";
import { runtime } from "../runtime.js";
import { resolveCaptureApiKey } from "../../shared/config.js";
import { makeDebugLogger } from "../../shared/debug-logger.js";

export function registerDebugRoutes(app: Hono) {
  app.post("/debug/ping", async (c) => {
    if (process.env.RUNIR_DEBUG !== "1") return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    const messages = body.messages ?? [];
    const sessionId: string = body.sessionId ?? "debug-ping";
    const formatted = normalizeCaptureMessages(messages, messages.length);
    const compressed = compressMessages(formatted, runtime.cfg.extractMaxChars);
    const apiKey = resolveCaptureApiKey(runtime.cfg);
    if (!apiKey) return c.json({ error: "no API key" }, 500);
    const debugLines: string[] = [];
    const verboseLogger = makeDebugLogger(true, (line) => debugLines.push(line));
    const segResult = await segmentAndSummarize(compressed, apiKey, console.warn, { timeoutMs: runtime.cfg.extractTimeoutMs });
    verboseLogger.segmentation({ session: sessionId, topics: segResult.topics.length, titles: segResult.topics.map((t: any) => t.title).join(",") });
    const sessionTs = new Date().toISOString();
    const sessionFacts = await extractMemories(compressed, resolveCapturePrompt(runtime.cfg.customPrompt), apiKey, sessionTs, undefined, {
      timeoutMs: runtime.cfg.extractTimeoutMs,
      model: runtime.cfg.extractModel,
    });
    verboseLogger.factExtraction({ session: sessionId, count: sessionFacts.length, facts: sessionFacts.map((f: any) => ({ conf: f.confidence, text: f.text })) });
    let entityNames: string[] = [];
    try {
      const { extractEntities } = await import("../../entities/entity-extractor.js");
      const entities = await extractEntities(formatted, apiKey, sessionTs, runtime.cfg.extractTimeoutMs);
      entityNames = entities.map((e: any) => e.name);
      verboseLogger.entityExtraction({ session: sessionId, count: entities.length, names: entityNames.join(",") });
    } catch {}
    return c.json({
      topics: segResult.topics.map((t: any) => t.title),
      facts: sessionFacts.map((f: any) => ({ text: f.text, confidence: f.confidence })),
      entities: entityNames,
      debugLines,
    });
  });
}
