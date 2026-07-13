import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTranscriptFixtureBundle } from "../testing/transcript-derived-fixtures.js";

const tempDirs: string[] = [];

function writeTranscript(dir: string, fileName: string, rows: unknown[]): void {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
}

describe("transcript-derived fixtures", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("builds deterministic sanitized scenarios from local transcript-like inputs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runir-transcript-fixtures-"));
    tempDirs.push(dir);

    writeTranscript(dir, "a.jsonl", [
      {
        type: "attachment",
        timestamp: "2026-04-16T10:00:00Z",
        attachment: { type: "hook_success", hookEvent: "SessionStart", content: "" },
      },
      {
        type: "user",
        timestamp: "2026-04-16T10:00:01Z",
        message: {
          role: "user",
          content: "Please update /Users/alice/private-repo and email alice@example.com after visiting https://secret.example.com",
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-16T10:00:02Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "tool_use", name: "Read" },
            { type: "text", text: "I checked diff --git a/private.ts b/private.ts" },
          ],
        },
      },
    ]);

    writeTranscript(dir, "b.jsonl", [
      {
        type: "queue-operation",
        timestamp: "2026-04-16T11:00:00Z",
        operation: "enqueue",
      },
      {
        type: "user",
        timestamp: "2026-04-16T11:00:01Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "token sk-live-secret" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-16T11:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done with a medium summary." }],
        },
      },
      {
        type: "user",
        timestamp: "2026-04-16T11:00:03Z",
        message: {
          role: "user",
          content: "Add verification and preserve tool adjacency.",
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-16T11:00:04Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Verified." }],
        },
      },
      {
        type: "user",
        timestamp: "2026-04-16T11:00:05Z",
        message: {
          role: "user",
          content: "Wrap up the session state.",
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-16T11:00:06Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Session complete." }],
        },
      },
    ]);

    const bundleA = buildTranscriptFixtureBundle(dir);
    const bundleB = buildTranscriptFixtureBundle(dir);

    expect(bundleA.scenarios.map((scenario) => scenario.id)).toEqual([
      "capture-transcript-derived-conversational",
      "capture-transcript-derived-tool-heavy",
      "session-end-transcript-derived-summary",
    ]);
    expect(bundleA.sanitizerContract.redacted).toContain("filesystem paths");
    expect(bundleA.census).toHaveLength(2);
    expect(bundleA.scenarios[0].edgeExtraction.droppedItems[0]?.summary).toContain("Dropped");
    expect(bundleA.scenarios[2].route).toBe("/hooks/session-end");
    expect(bundleA.scenarios[2].edgeExtraction.extractedMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    const serialized = JSON.stringify(bundleA);
    expect(serialized).not.toContain("/Users/alice/private-repo");
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("https://secret.example.com");
    expect(serialized).not.toContain("sk-live-secret");
    expect(JSON.stringify(bundleA)).toBe(JSON.stringify(bundleB));
  });
});
