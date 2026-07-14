import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifact = join(root, "plugins/runir-claudecode/mcp/runir-mcp.mjs");

function frame(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseFrames(raw: string | Buffer): unknown[] {
  // Content-Length is bytes, not JS string units (ú in Rúnir is 2 UTF-8 bytes).
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  const out: unknown[] = [];
  let i = 0;
  while (i < buf.length) {
    const headerEnd = buf.indexOf("\r\n\r\n", i);
    if (headerEnd === -1) break;
    const header = buf.subarray(i, headerEnd).toString("utf8");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) break;
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const body = buf.subarray(start, start + len).toString("utf8");
    out.push(JSON.parse(body));
    i = start + len;
  }
  return out;
}

describe("runir-mcp stdio", () => {
  it("lists runir_store and stores via stub HTTP", async () => {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing ${artifact} — run npm run build:runir-mcp first`,
      );
    }

    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requests.push({
          url: req.url,
          method: req.method,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            id: "mcp-1",
            outcome: "create",
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    const child = spawn(process.execPath, [artifact], {
      env: {
        ...process.env,
        RUNIR_BASE: `http://127.0.0.1:${port}`,
        RUNIR_API_KEY: "harness-key",
        RUNIR_USER_ID: "harness-user",
        RUNIR_CLIENT: "claude",
        RUNIR_ENV_FILE: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => {
      stdoutChunks.push(Buffer.from(c));
    });

    const send = (msg: unknown) => {
      child.stdin.write(frame(msg));
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "runir_store",
        arguments: { text: "Remember that MCP store works" },
      },
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timeout waiting for 3 responses")),
        5000,
      );
      const check = () => {
        const msgs = parseFrames(Buffer.concat(stdoutChunks));
        if (msgs.length >= 3) {
          clearTimeout(t);
          resolve();
        }
      };
      child.stdout.on("data", check);
      check();
    });

    child.stdin.end();
    child.kill();
    server.close();

    const msgs = parseFrames(Buffer.concat(stdoutChunks)) as Array<{
      id?: number;
      result?: {
        tools?: Array<{ name: string }>;
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
    }>;
    const list = msgs.find((m) => m.id === 2);
    expect(list?.result?.tools?.map((t) => t.name)).toEqual(["runir_store"]);
    const call = msgs.find((m) => m.id === 3);
    expect(call?.result?.isError).toBeFalsy();
    expect(call?.result?.content?.[0]?.text).toBe("Remembered (new): mcp-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/memory/store",
      method: "POST",
      body: {
        text: "Remember that MCP store works",
        userId: "harness-user",
        client: "claude",
        scope: "user",
      },
    });
  });
});
