#!/usr/bin/env node
/**
 * Rúnir MCP adapter entrypoint — stdio tools (v1: runir_store only).
 * Built to plugins/runir-{claudecode,codex}/mcp/runir-mcp.mjs (byte-identical).
 */
import { runStdioServer } from "./server.js";

runStdioServer().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`runir-mcp fatal: ${message}\n`);
  process.exit(1);
});
