/** Fixed synthetic capture load: twenty text turns, each below 4 KiB. */
export const CAPTURE_20X4K = Array.from({ length: 20 }, (_, index) => ({
  role: index % 2 ? "assistant" as const : "user" as const,
  content: `Synthetic turn ${index}: ` + "TypeScript module exports stableName.\n".repeat(105),
  turnIndex: index,
  sessionEpoch: "fixture:0",
}));

if (CAPTURE_20X4K.some((turn) => Buffer.byteLength(turn.content) > 4096)) {
  throw new Error("capture-20x4k fixture exceeds 4 KiB");
}
