import { describe, expect, it } from "vitest";
import { chunkSourceTurn, prepareSourceTurn } from "../capture/source-turn-identity.js";

const base = {
  userId: "synthetic-user", client: "codex", sessionId: "synthetic-session", role: "user" as const,
  content: "The synthetic compiler passed.", occurredAt: "2026-09-25T00:00:00.000Z", scope: "user" as const,
};

describe("source turn identity and chunking", () => {
  it("keeps native IDs stable across redacted text changes and flags HMAC conflicts", () => {
    const a = prepareSourceTurn({ ...base, sessionEpoch: "epoch:0", turnKey: "message:a", turnIndex: 4 }, "key-one");
    const changed = prepareSourceTurn({ ...base, content: "The synthetic compiler failed.", sessionEpoch: "epoch:0", turnKey: "message:a", turnIndex: 4 }, "key-one");
    expect(a.id).toBe(changed.id);
    expect(a.contentHmac).not.toBe(changed.contentHmac);
    expect(a.identityQuality).toBe("native");
  });

  it("separates compaction epochs and Pi fork keys at the same ordinal", () => {
    const first = prepareSourceTurn({ ...base, sessionEpoch: "epoch:0", turnIndex: 4 }, "key-one");
    const reset = prepareSourceTurn({ ...base, sessionEpoch: "epoch:1", turnIndex: 4 }, "key-one");
    const fork = prepareSourceTurn({ ...base, sessionEpoch: "epoch:0", turnKey: "pi:branch-b", turnIndex: 4 }, "key-one");
    expect(new Set([first.id, reset.id, fork.id]).size).toBe(3);
  });

  it("collapses Grok role-and-content retries and keeps roles separate", () => {
    const first = prepareSourceTurn(base, "key-one");
    const retry = prepareSourceTurn({ ...base, occurredAt: "2026-09-26T00:00:00.000Z" }, "key-one");
    const otherRole = prepareSourceTurn({ ...base, role: "assistant" }, "key-one");
    expect(first.id).toBe(retry.id);
    expect(first.id).not.toBe(otherRole.id);
    expect(first.identityQuality).toBe("content_only");
    expect(first.turnIndex).toBeUndefined();
  });

  it("rotates legacy IDs with HMAC keys and redacts source before HMAC", () => {
    const input = { ...base, content: "email synthetic.person@example.com" };
    const oldKey = prepareSourceTurn(input, "key-one");
    const newKey = prepareSourceTurn(input, "key-two");
    expect(oldKey.content).not.toContain("synthetic.person@example.com");
    expect(oldKey.id).not.toBe(newKey.id);
  });

  it("splits deterministically, caps turns and rejects binary text", () => {
    const text = "synthetic paragraph\n\n".repeat(700);
    const chunks = chunkSourceTurn(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 4096)).toBe(true);
    const long = prepareSourceTurn({ ...base, content: "s".repeat(300_000) }, "key-one");
    expect(long.truncated).toBe(true);
    expect(Buffer.byteLength(long.content)).toBeLessThanOrEqual(256 * 1024);
    expect(long.content).toContain("[TRUNCATED_SOURCE_TURN]");
    expect(() => prepareSourceTurn({ ...base, content: "text\0binary" }, "key-one")).toThrow("binary source turn");
  });
});
