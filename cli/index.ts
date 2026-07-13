#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchRecall } from "../src/recall/recall-client.js";
import { formatTraceList, formatTraceReceipt, type TraceView } from "../src/recall/trace-receipt-format.js";

const BASE_URL = process.env.RUNIR_URL ?? "http://localhost:7700";
const DEFAULT_USER_ID = process.env.RUNIR_USER_ID ?? "default";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  // The service gates everything except /health,/ready,/hooks/maintenance behind
  // a Bearer token. Mirror recall-client: attach it when configured.
  const apiKey = process.env.RUNIR_API_KEY;
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

function loadMessagesFile(path: string): unknown[] {
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`Expected array of messages in ${path}`);
  }
  return data;
}

function printJson(data: unknown, pretty: boolean): void {
  console.log(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

function usage(code = 0): never {
  const output = code === 0 ? console.log : console.error;
  output(`runir - CLI for the Rúnir memory service

Usage: runir <command> [options]

Commands:
  health                       Check service health
  recall   --query <text>      Pre-turn recall (returns context to prepend)
  capture  --messages <path>   Post-turn capture (extracts facts from messages)
  session-end --messages <path> End-of-session summarization
  store    --text <text>       Store a memory
  search   --query <text>      Search memories
  traces                       Memory Impact Viewer: list recent recall receipts
  traces   --id <id>           Full receipt: prompt → recalled memories → injected text → answer
  traces rate --id <id> --rating <r>  Rate a recall: helped|hurt|unused|missing|stale (+--note)

Global options:
  --session-id <id>            Session ID for scoped operations
  --user-id <id>               User ID for all commands (prefer a real human identity)

Traces options:
  --id <id>                    Show one receipt by trace id (omit to list the latest)
  --limit <n>                  Max receipts in the list (default: service default, max 200)
  --json                       Emit JSON instead of the formatted receipt (add --pretty to indent)
  --rating <r>                 (traces rate) helped | hurt | unused | missing | stale
  --note <text>                (traces rate) optional free-text note for the rating

Store options:
  --tags <t1,t2,...>           Comma-separated tags
  --scope <scope>              session | user | global

Search options:
  --limit <n>                  Max results (default: 5)

Environment:
  RUNIR_URL                    Base URL (default: http://localhost:7700)
  RUNIR_API_KEY                Bearer token; required when the service is auth-gated
  RUNIR_USER_ID                Default user id when --user-id is omitted (default: default)

Examples:
  runir health
  runir recall --query "How do I configure logging?"
  runir store --text "User prefers dark mode" --tags "preferences,ui"
  runir search --query "user preferences" --limit 10
  runir capture --messages ./conversation.json
  runir session-end --messages ./conversation.json --session-id abc123
  runir traces --user-id brooks --limit 20
  runir traces --id <trace-id> --user-id brooks
  runir traces rate --id <trace-id> --rating helped --note "nailed the config detail" --user-id brooks
`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdHealth(pretty: boolean): Promise<void> {
  const data = await request("GET", "/health");
  printJson(data, pretty);
}

async function cmdRecall(
  query: string,
  opts: { sessionId?: string; userId: string; topK?: number },
): Promise<void> {
  const data = await fetchRecall(BASE_URL, {
    prompt: query,
    sessionId: opts.sessionId,
    topK: opts.topK,
    userId: opts.userId,
  });
  if ("warning" in data) {
    console.error(`runir recall warning: ${data.warning}`);
  }
  if ("error" in data) {
    console.error(`runir recall error: ${data.error}`);
  }
  console.log(data.prependContext ?? "");
}

async function cmdCapture(
  messagesPath: string,
  opts: { sessionId?: string; userId: string; pretty: boolean },
): Promise<void> {
  const messages = loadMessagesFile(messagesPath);
  const body: Record<string, unknown> = { messages, userId: opts.userId };
  if (opts.sessionId) body.sessionId = opts.sessionId;
  const data = await request("POST", "/hooks/capture", body);
  printJson(data, opts.pretty);
}

async function cmdSessionEnd(
  messagesPath: string,
  opts: { sessionId?: string; userId: string; pretty: boolean },
): Promise<void> {
  const messages = loadMessagesFile(messagesPath);
  const body: Record<string, unknown> = { messages, userId: opts.userId };
  if (opts.sessionId) body.sessionId = opts.sessionId;
  const data = await request("POST", "/hooks/session-end", body);
  printJson(data, opts.pretty);
}

async function cmdStore(
  text: string,
  opts: { tags?: string; scope?: string; sessionId?: string; userId: string; pretty: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { text, userId: opts.userId };
  if (opts.sessionId) body.sessionId = opts.sessionId;
  if (opts.scope) body.scope = opts.scope;
  if (opts.tags) {
    body.metadata = { tags: opts.tags.split(",").map((t) => t.trim()) };
  }
  const data = await request("POST", "/memory/store", body);
  printJson(data, opts.pretty);
}

async function cmdSearch(
  query: string,
  opts: { limit?: number; sessionId?: string; userId: string; scope?: string; pretty: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { query, userId: opts.userId };
  if (opts.sessionId) body.sessionId = opts.sessionId;
  if (opts.scope) body.scope = opts.scope;
  if (opts.limit) body.limit = opts.limit;
  const data = await request("POST", "/memory/search", body);
  printJson(data, opts.pretty);
}

async function cmdTraces(
  opts: { id?: string; limit?: number; userId: string; json: boolean; pretty: boolean },
): Promise<void> {
  const params = new URLSearchParams({ userId: opts.userId });
  if (opts.id) {
    const data = (await request("GET", `/hooks/traces/${encodeURIComponent(opts.id)}?${params}`)) as { trace: TraceView };
    if (opts.json) return printJson(data.trace, opts.pretty);
    console.log(formatTraceReceipt(data.trace));
    return;
  }
  if (opts.limit) params.set("limit", String(opts.limit));
  const data = (await request("GET", `/hooks/traces?${params}`)) as { traces: TraceView[] };
  if (opts.json) return printJson(data.traces, opts.pretty);
  console.log(formatTraceList(data.traces, opts.userId));
}

// `runir traces rate` — attach a THIN recall-quality label to a trace. The
// service is the single authority on the allowed rating vocabulary, so we don't
// duplicate it here: an out-of-range value surfaces as the server's 400 message.
async function cmdTracesRate(
  opts: { id: string; rating: string; note?: string; userId: string; pretty: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { userId: opts.userId, rating: opts.rating };
  if (opts.note) body.note = opts.note;
  const data = await request("POST", `/hooks/traces/${encodeURIComponent(opts.id)}/rate`, body);
  printJson(data, opts.pretty);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage(1);

  // Handle --help/-h before command dispatch
  if (args[0] === "--help" || args[0] === "-h") usage(0);

  const command = args[0];
  let rest = args.slice(1);
  // `runir traces rate ...` is a sub-action of `traces`. Strip the positional
  // here so the shared (positional-free) parseArgs below stays unchanged.
  const tracesRate = command === "traces" && rest[0] === "rate";
  if (tracesRate) rest = rest.slice(1);

  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        query: { type: "string" },
        text: { type: "string" },
        messages: { type: "string" },
        tags: { type: "string" },
        scope: { type: "string" },
        limit: { type: "string" },
        id: { type: "string" },
        rating: { type: "string" },
        note: { type: "string" },
        "top-k": { type: "string" },
        "session-id": { type: "string" },
        "user-id": { type: "string" },
        pretty: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });

    if (values.help) usage(0);

    const sessionId = values["session-id"];
    const userId = values["user-id"] ?? DEFAULT_USER_ID;
    const pretty = values.pretty ?? false;

    // Validate numeric flags
    let topK: number | undefined;
    if (values["top-k"]) {
      topK = parseInt(values["top-k"], 10);
      if (Number.isNaN(topK) || topK <= 0) {
        console.error("Error: --top-k must be a positive integer");
        process.exit(1);
      }
    }

    let limit: number | undefined;
    if (values.limit) {
      limit = parseInt(values.limit, 10);
      if (Number.isNaN(limit) || limit <= 0) {
        console.error("Error: --limit must be a positive integer");
        process.exit(1);
      }
    }

    switch (command) {
      case "health":
        await cmdHealth(pretty);
        break;

      case "recall":
        if (!values.query) {
          console.error("Error: --query is required for recall");
          process.exit(1);
        }
        await cmdRecall(values.query, { sessionId, userId, topK });
        break;

      case "capture":
        if (!values.messages) {
          console.error("Error: --messages is required for capture");
          process.exit(1);
        }
        await cmdCapture(values.messages, { sessionId, userId, pretty });
        break;

      case "session-end":
        if (!values.messages) {
          console.error("Error: --messages is required for session-end");
          process.exit(1);
        }
        await cmdSessionEnd(values.messages, { sessionId, userId, pretty });
        break;

      case "store":
        if (!values.text) {
          console.error("Error: --text is required for store");
          process.exit(1);
        }
        await cmdStore(values.text, {
          tags: values.tags,
          scope: values.scope,
          sessionId,
          userId,
          pretty,
        });
        break;

      case "search":
        if (!values.query) {
          console.error("Error: --query is required for search");
          process.exit(1);
        }
        await cmdSearch(values.query, {
          limit,
          sessionId,
          userId,
          scope: values.scope,
          pretty,
        });
        break;

      case "traces":
        if (tracesRate) {
          if (!values.id) {
            console.error("Error: --id is required for `traces rate`");
            process.exit(1);
          }
          if (!values.rating) {
            console.error("Error: --rating is required for `traces rate` (helped|hurt|unused|missing|stale)");
            process.exit(1);
          }
          await cmdTracesRate({ id: values.id, rating: values.rating, note: values.note, userId, pretty });
        } else {
          await cmdTraces({ id: values.id, limit, userId, json: values.json ?? false, pretty });
        }
        break;

      default:
        console.error(`Unknown command: ${command}`);
        usage(1);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
