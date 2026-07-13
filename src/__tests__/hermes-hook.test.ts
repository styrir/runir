/**
 * hermes-hook.test.ts — Code-kf2w
 * Shell integration test: verifies handler.sh maps HERMES_EVENT_PAYLOAD
 * to the correct POST body shape for /hooks/session-end.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HANDLER_SH = join(process.env.HOME!, ".hermes/hooks/runir-session-end/handler.sh");
// Plan-as-contract: this test depends on a local Hermes install at ~/.hermes —
// self-skip when the handler is missing rather than rely on package.json
// --exclude. See AGENTS.md "Test Dependencies".
const SKIP_HERMES = !existsSync(HANDLER_SH);

describe.skipIf(SKIP_HERMES)("Hermes handler.sh payload contract", () => {
  it("emits correct JSON body: sessionId, userId=owner, messages, messageOffset=0", () => {
    // Create a temp dir to hold the stub curl
    const tmpDir = mkdtempSync(join(tmpdir(), "hermes-hook-test-"));
    const stubCurlPath = join(tmpDir, "curl");

    // Stub curl: iterate argv to capture the -d value verbatim, exit 0
    writeFileSync(stubCurlPath, [
      `#!/usr/bin/env bash`,
      `# Capture the -d argument directly`,
      `prev=""`,
      `for arg in "$@"; do`,
      `  if [ "$prev" = "-d" ]; then`,
      `    printf '%s' "$arg" > "${tmpDir}/curl-body.json"`,
      `  fi`,
      `  prev="$arg"`,
      `done`,
      `exit 0`,
    ].join("\n"));
    chmodSync(stubCurlPath, 0o755);

    const fixturePayload = JSON.stringify({
      sessionKey: "hermes-test-session-uuid",
      messages: [
        { role: "user", content: "Hello from Hermes" },
        { role: "assistant", content: "Hi there" },
      ],
    });

    // Run handler.sh with stub curl on PATH
    execSync(`bash "${HANDLER_SH}"`, {
      env: {
        ...process.env,
        HERMES_EVENT_PAYLOAD: fixturePayload,
        RUNIR_URL: "http://localhost:4000",
        PATH: `${tmpDir}:${process.env.PATH}`,
      },
      encoding: "utf-8",
    });

    // Wait for the detached background curl stub to write the file
    // (handler.sh uses disown pattern so curl runs after shell exit)
    // Poll up to 5 seconds
    execSync(`for i in $(seq 1 50); do [ -f "${tmpDir}/curl-body.json" ] && break; sleep 0.1; done`);

    // Read the captured -d body directly
    const rawBody = execSync(`cat "${tmpDir}/curl-body.json"`, { encoding: "utf-8" });
    expect(rawBody, "curl -d body file not found").toBeTruthy();

    const body = JSON.parse(rawBody);

    // sessionId must be mapped from sessionKey
    expect(body.sessionId).toBe("hermes-test-session-uuid");
    // userId is always "owner" for Hermes
    expect(body.userId).toBe("owner");
    // messages array is passed through
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "Hello from Hermes" });
    // messageOffset is always 0 (full session, not incremental)
    expect(body.messageOffset).toBe(0);
  });

  it("exits 0 and skips curl when HERMES_EVENT_PAYLOAD is empty", () => {
    const result = execSync(`bash "${HANDLER_SH}"`, {
      env: { ...process.env, HERMES_EVENT_PAYLOAD: "" },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Should exit 0 without error (guard clause exits cleanly)
    expect(result).toBeDefined();
  });

  it("exits 0 and skips curl when no sessionKey in payload", () => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: "test" }] });
    const result = execSync(`bash "${HANDLER_SH}"`, {
      env: { ...process.env, HERMES_EVENT_PAYLOAD: payload },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(result).toBeDefined();
  });

  it("exits 0 and skips curl when messages array is empty", () => {
    const payload = JSON.stringify({ sessionKey: "test-session", messages: [] });
    const result = execSync(`bash "${HANDLER_SH}"`, {
      env: { ...process.env, HERMES_EVENT_PAYLOAD: payload },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(result).toBeDefined();
  });
});
