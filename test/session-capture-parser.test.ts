import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { claudeHooksAvailable } from "./helpers/skip-conditions.js";

const FILTER_PATH = path.join(
  process.env.HOME!,
  ".claude/hooks/lib/extract-messages.jq"
);
const FIXTURES_DIR = path.resolve(__dirname, "fixtures/session-capture");
const SKIP = !claudeHooksAvailable("lib/extract-messages.jq");

function parseJqOutput(fixturePath: string): Array<{ role: string; content: string }> {
  const raw = execSync(`jq -Rc -f ${FILTER_PATH} ${fixturePath}`, {
    encoding: "utf8",
  });
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function parseJqFromStdin(jsonl: string): Array<{ role: string; content: string }> {
  const raw = execSync(`jq -Rc -f ${FILTER_PATH}`, {
    encoding: "utf8",
    input: jsonl,
  });
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe.skipIf(SKIP)("session-capture JSONL parser", () => {
  it("basic-conversation: extracts 3 messages with correct roles and content", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "basic-conversation.jsonl"));
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain("SurrealDB connection pool");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toContain("max_connections");
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toContain("idle timeout");
  });

  it("tool-use-filtering: extracts 2 messages (user + final assistant text)", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "tool-use-filtering.jsonl"));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toContain("configuration file looks clean");
  });

  it("mixed-content: extracts 2 messages (thinking+tool_use filtered, text extracted)", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "mixed-content.jsonl"));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toContain("refactor the query builder");
    expect(msgs[0].content).not.toContain("thinking");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toContain("method chaining");
  });

  it("relevant-memories: first line has tags stripped, second line yields 0 messages", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "relevant-memories.jsonl"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).not.toContain("<relevant-memories>");
    expect(msgs[0].content).not.toContain("</relevant-memories>");
    expect(msgs[0].content).toContain("full-text search index");
  });

  it("non-message-types: all 7 lines filtered, 0 messages", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "non-message-types.jsonl"));
    expect(msgs).toHaveLength(0);
  });

  it("edge-cases: exactly 1 valid message extracted", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "edge-cases.jsonl"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain("bead watermark replay prevention");
  });

  it("large-transcript: extracts all 20 messages", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "large-transcript.jsonl"));
    expect(msgs).toHaveLength(20);
  });

  it("malformed: skips bad/empty lines, extracts 3 valid messages", () => {
    const msgs = parseJqOutput(path.join(FIXTURES_DIR, "malformed.jsonl"));
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
  });

  it("content type: user message with string content extracted correctly", () => {
    const jsonl = '{"type":"user","message":{"role":"user","content":"hello world"}}';
    const msgs = parseJqFromStdin(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "hello world" });
  });

  it("content type: assistant with array [text] extracted correctly", () => {
    const jsonl = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"response here"}]}}';
    const msgs = parseJqFromStdin(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "assistant", content: "response here" });
  });

  it("tool filtering: assistant with [thinking, text, tool_use] yields only text", () => {
    const jsonl = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"visible"},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}';
    const msgs = parseJqFromStdin(jsonl);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("visible");
  });

  it("role filtering: system role inside message is filtered", () => {
    const jsonl = '{"type":"user","message":{"role":"system","content":"you are helpful"}}';
    const msgs = parseJqFromStdin(jsonl);
    expect(msgs).toHaveLength(0);
  });
});
