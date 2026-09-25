import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { normalizeCaptureMessages } from "../../src/capture/extraction/capture.js";
import { redactSourceTurn } from "../../src/shared/source-redaction.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/source-redaction/capture-20x4k.json", import.meta.url), "utf8")) as {
  name: string; messages: Array<{ role: string; content: string }>;
};
if (fixture.name !== "capture-20x4k" || fixture.messages.length !== 20 ||
    fixture.messages.some((message) => message.content.length !== 4096)) {
  throw new Error("invalid capture latency fixture");
}
const samples: number[] = [];
for (let i = 0; i < 1200; i++) {
  const start = performance.now();
  const formatted = normalizeCaptureMessages(fixture.messages);
  formatted.forEach((message) => redactSourceTurn(message.content));
  const elapsed = performance.now() - start;
  if (i >= 200) samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const percentile = (p: number) => Number(samples[Math.ceil(samples.length * p) - 1].toFixed(3));
process.stdout.write(JSON.stringify({
  fixture: fixture.name, sampleCount: samples.length, concurrency: 1,
  cpu: cpus()[0]?.model ?? "unknown", memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
  scope: "normalize plus redaction preprocessing; no extraction, embeddings, or DB",
  p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
}) + "\n");
