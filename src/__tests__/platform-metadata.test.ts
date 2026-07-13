import { describe, it, expect } from "vitest";
import { stripPlatformMetadata } from "../capture/extraction/capture.js";

describe("stripPlatformMetadata", () => {
  it("strips sentinel blocks from text", () => {
    const input = `Conversation info (untrusted metadata):
Some metadata here
Another line

Actual message content here`;
    const result = stripPlatformMetadata(input);
    expect(result).toBe("Actual message content here");
  });

  it("strips multiple sentinel blocks", () => {
    const input = `Sender (untrusted metadata):
user123
role: admin

Hello world

Forwarded message context (untrusted metadata):
from: someone

How are you?`;
    const result = stripPlatformMetadata(input);
    expect(result).toBe("Hello world\n\nHow are you?");
  });

  it("strips Discord @-mention prefix", () => {
    const result = stripPlatformMetadata("<@123456789> Hello there");
    expect(result).toBe("Hello there");
  });

  it("strips Slack @-mention prefix", () => {
    const result = stripPlatformMetadata("@some.user Hello there");
    expect(result).toBe("Hello there");
  });

  it("strips @-mention prefix with exclamation mark", () => {
    const result = stripPlatformMetadata("<@!123456789> What's up");
    expect(result).toBe("What's up");
  });

  it("strips system event lines", () => {
    const input = `Some real content
System: [build-123] Exec completed
More real content`;
    const result = stripPlatformMetadata(input);
    expect(result.trim()).toBe("Some real content\n\nMore real content");
  });

  it("strips system event lines with failed/started variants", () => {
    const input = `Start
System: [task-1] Exec failed with error
Middle
System: [deploy-2] Exec started successfully
End`;
    const result = stripPlatformMetadata(input);
    expect(result.trim()).toBe("Start\n\nMiddle\n\nEnd");
  });

  it("strips session reset prefix", () => {
    const input = `A new session was started via /new or /reset. Please continue the conversation.`;
    const result = stripPlatformMetadata(input);
    expect(result).toBe("Please continue the conversation.");
  });

  it("passes through normal text unchanged", () => {
    const input = "The SurrealDB RELATE statement requires both source and target to exist";
    expect(stripPlatformMetadata(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(stripPlatformMetadata("")).toBe("");
  });

  it("handles text with only metadata (returns empty after trimming)", () => {
    const input = `Conversation info (untrusted metadata):
channel: general
server: test

`;
    const result = stripPlatformMetadata(input);
    expect(result.trim()).toBe("");
  });

  it("strips sentinel block with internal blank line (multi-paragraph metadata)", () => {
    const input = `Forwarded message context (untrusted metadata):
from: someone
date: 2024-01-15

to: someone-else
channel: general

Hey, what do you think about this?`;
    const result = stripPlatformMetadata(input);
    expect(result).toBe("Hey, what do you think about this?");
  });

  it("strips sentinel block that runs to end of text with internal blank line", () => {
    const input = `Conversation info (untrusted metadata):
server: test-server
channel: general

members: 5
topic: testing`;
    const result = stripPlatformMetadata(input);
    expect(result).toBe("");
  });

  it("strips all 6 sentinel types", () => {
    const sentinels = [
      "Conversation info (untrusted metadata):",
      "Sender (untrusted metadata):",
      "Thread starter (untrusted, for context):",
      "Replied message (untrusted, for context):",
      "Forwarded message context (untrusted metadata):",
      "Chat history since last reply (untrusted, for context):",
    ];
    for (const sentinel of sentinels) {
      const input = `${sentinel}\nsome meta\n\nActual content`;
      const result = stripPlatformMetadata(input);
      expect(result).toBe("Actual content");
    }
  });
});
