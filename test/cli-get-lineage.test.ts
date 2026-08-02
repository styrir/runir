import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";

interface MockServer {
  url: string;
  requests: Array<{ url: string }>;
  close: () => Promise<void>;
}

const MEMORY_FIXTURE = {
  id: "mem123",
  memory: "User prefers dark mode",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  tags: ["preferences", "ui"],
  source: "capture",
};

const LINEAGE_FIXTURE = {
  memoryId: "mem123",
  chainLength: 2,
  lineage: [
    {
      id: "mem100",
      text: "User prefers light mode",
      active: false,
      createdAt: "2026-07-01T00:00:00Z",
      inactiveReason: "superseded",
      supersededBy: "mem123",
    },
    {
      id: "mem123",
      text: "User prefers dark mode",
      active: true,
      createdAt: "2026-08-01T00:00:00Z",
    },
  ],
};

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: Array<{ url: string }> = [];
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      requests.push({ url });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.startsWith("/memory/lineage/")) {
        res.end(JSON.stringify(LINEAGE_FIXTURE));
      } else {
        res.end(JSON.stringify(MEMORY_FIXTURE));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runCli(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "cli/index.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("runir CLI get/lineage", () => {
  let server: MockServer;

  beforeEach(async () => {
    server = await startMockServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("get renders compact plain text with id, memory, and metadata", async () => {
    const result = await runCli(["get", "--id", "mem123", "--user-id", "brooks"], {
      RUNIR_URL: server.url,
    });

    expect(result.status).toBe(0);
    expect(server.requests[0]?.url).toBe("/memory/get/mem123?userId=brooks");
    expect(result.stdout).toContain("[mem123] User prefers dark mode");
    expect(result.stdout).toContain("tags: preferences,ui");
    expect(result.stdout).toContain("source: capture");
    // updated_at === created_at: no duplicate "updated" noise
    expect(result.stdout).not.toContain("updated ");
  }, 60000);

  it("get --json emits the raw record", async () => {
    const result = await runCli(["get", "--id", "mem123", "--user-id", "brooks", "--json"], {
      RUNIR_URL: server.url,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(MEMORY_FIXTURE);
  }, 60000);

  it("lineage renders oldest→newest chain with supersession arrows", async () => {
    const result = await runCli(["lineage", "--id", "mem123", "--user-id", "brooks"], {
      RUNIR_URL: server.url,
    });

    expect(result.status).toBe(0);
    expect(server.requests[0]?.url).toBe("/memory/lineage/mem123?userId=brooks");
    expect(result.stdout).toContain("lineage for mem123 (2 entries, oldest → newest)");
    expect(result.stdout).toContain("1. [mem100] (superseded) 2026-07-01T00:00:00Z");
    expect(result.stdout).toContain("↓ superseded by [mem123]");
    expect(result.stdout).toContain("2. [mem123] (active) 2026-08-01T00:00:00Z");
    // Oldest entry appears before newest
    expect(result.stdout.indexOf("[mem100]")).toBeLessThan(result.stdout.lastIndexOf("[mem123]"));
  }, 60000);

  it("lineage --json emits the raw chain", async () => {
    const result = await runCli(["lineage", "--id", "mem123", "--user-id", "brooks", "--json"], {
      RUNIR_URL: server.url,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(LINEAGE_FIXTURE);
  }, 60000);

  it("both verbs fail fast without --id", async () => {
    for (const verb of ["get", "lineage"]) {
      const result = await runCli([verb], { RUNIR_URL: server.url });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`--id is required for ${verb}`);
    }
    expect(server.requests).toHaveLength(0);
  }, 60000);
});
