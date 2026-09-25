import { createHash, createHmac } from "node:crypto";
import { SOURCE_REDACTION_VERSION, redactSourceTurn } from "../shared/source-redaction.js";

export const LEGACY_EPOCH = "legacy";
export const SOURCE_FORMAT = 1;
export const MAX_SOURCE_BYTES = 256 * 1024;

export type SourceTurn = {
  id: string;
  userId: string;
  client: string;
  sessionId: string;
  sessionEpoch: string;
  turnKey: string;
  turnIndex?: number;
  role: "user" | "assistant";
  content: string;
  contentHmac: string;
  keyFingerprint: string;
  redactionVersion: number;
  sourceFormat: number;
  identityQuality: "native" | "ordinal" | "content_only";
  occurredAt: string;
  scope: "user" | "session" | "project" | "team";
  teamId?: string;
  projectKey?: string;
  path?: string;
  truncated: boolean;
  originalBytes: number;
};

export type SourceTurnInput = Omit<SourceTurn, "id" | "content" | "contentHmac" | "keyFingerprint" | "redactionVersion" | "sourceFormat" | "identityQuality" | "truncated" | "originalBytes" | "turnKey" | "sessionEpoch"> & {
  content: string;
  turnKey?: string;
  sessionEpoch?: string;
};

const omission = "\n[TRUNCATED_SOURCE_TURN]";

/** Non-secret operator key identifier. Rotation needs a separate reconciliation tool. */
export function sourceKeyFingerprint(hmacKey: string): string {
  if (!hmacKey) throw new Error("source HMAC key unavailable");
  return createHmac("sha256", hmacKey).update("runir-source-key-id").digest("hex").slice(0, 16);
}

export function prepareSourceTurn(input: SourceTurnInput, hmacKey: string): SourceTurn {
  if (!hmacKey) throw new Error("source HMAC key unavailable");
  if (!input.userId || !input.sessionId || !input.client) throw new Error("source identity unavailable");
  if (input.role !== "user" && input.role !== "assistant") throw new Error("non-text source role");
  if (input.content.includes("\0")) throw new Error("binary source turn");
  const redacted = redactSourceTurn(input.content);
  const originalBytes = Buffer.byteLength(redacted);
  let content = redacted;
  if (originalBytes > MAX_SOURCE_BYTES) {
    const max = MAX_SOURCE_BYTES - Buffer.byteLength(omission);
    content = Buffer.from(redacted).subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "") + omission;
  }
  const contentHmac = createHmac("sha256", hmacKey).update(content).digest("hex");
  const keyFingerprint = sourceKeyFingerprint(hmacKey);
  const hasNative = typeof input.turnKey === "string" && input.turnKey.length > 0 && input.turnKey.length <= 512;
  const hasOrdinal = Number.isSafeInteger(input.turnIndex) && input.turnIndex! >= 0
    && typeof input.sessionEpoch === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(input.sessionEpoch);
  const sessionEpoch = hasNative || hasOrdinal
    ? input.sessionEpoch && /^[A-Za-z0-9._:-]{1,128}$/.test(input.sessionEpoch) ? input.sessionEpoch : "native"
    : LEGACY_EPOCH;
  const turnKey = hasNative
    ? `native:${createHash("sha256").update(input.turnKey!).digest("hex")}`
    : hasOrdinal ? `ordinal:${input.turnIndex}` : `legacy:${input.role}:${contentHmac}`;
  const id = createHash("sha256").update(JSON.stringify([
    input.userId, input.client, input.sessionId, sessionEpoch, turnKey,
  ])).digest("hex");
  return {
    ...input, id, sessionEpoch, turnKey, content, contentHmac, keyFingerprint,
    redactionVersion: SOURCE_REDACTION_VERSION, sourceFormat: SOURCE_FORMAT,
    identityQuality: hasNative ? "native" : hasOrdinal ? "ordinal" : "content_only",
    truncated: originalBytes > MAX_SOURCE_BYTES, originalBytes,
    turnIndex: hasNative || hasOrdinal ? input.turnIndex : undefined,
  };
}

export function chunkSourceTurn(content: string, maxBytes = 4096): string[] {
  if (!content) return [];
  const chunks: string[] = [];
  let rest = content;
  while (Buffer.byteLength(rest) > maxBytes) {
    const chars = [...rest];
    let n = 0;
    let bytes = 0;
    while (n < chars.length && bytes + Buffer.byteLength(chars[n]) <= maxBytes) bytes += Buffer.byteLength(chars[n++]);
    const prefix = chars.slice(0, n).join("");
    const boundary = Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf("\n```"));
    const split = boundary > prefix.length / 2 ? boundary + 2 : prefix.length;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
