import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildFenceWrappedCodeExcerpt } from "../capture/extraction/capture.js";

// G003: fence-wrapping enrichment for code-bearing captures.
// Helpers must be deterministic, idempotent, and gated on RUNIR_VERBATIM_CODE_SHADOW=1.

describe("buildFenceWrappedCodeExcerpt", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.RUNIR_VERBATIM_CODE_SHADOW;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RUNIR_VERBATIM_CODE_SHADOW;
    else process.env.RUNIR_VERBATIM_CODE_SHADOW = originalEnv;
  });

  it("is on by default (env unset) — wraps a bare stack trace without opt-in", () => {
    delete process.env.RUNIR_VERBATIM_CODE_SHADOW;
    const input = "TypeError: bad\n    at foo (/x/y.ts:1:1)\n    at bar (/x/z.ts:2:2)";
    const out = buildFenceWrappedCodeExcerpt(input);
    expect((out.match(/```/g) ?? []).length).toBe(2);
  });

  it("is a no-op when RUNIR_VERBATIM_CODE_SHADOW=0 (opt-out)", () => {
    process.env.RUNIR_VERBATIM_CODE_SHADOW = "0";
    const input = "TypeError: bad\n    at foo (/x/y.ts:1:1)\n    at bar (/x/z.ts:2:2)";
    expect(buildFenceWrappedCodeExcerpt(input)).toBe(input);
  });

  describe("with RUNIR_VERBATIM_CODE_SHADOW=1 (explicit on)", () => {
    beforeEach(() => {
      process.env.RUNIR_VERBATIM_CODE_SHADOW = "1";
    });

    it("wraps a bare stack trace including its error header line", () => {
      const input = [
        "I'm seeing this crash in production — any idea?",
        "",
        "TypeError: Cannot read properties of undefined (reading 'toISOString')",
        "    at formatTimestamp (/app/src/utils/time-formatter.ts:42:18)",
        "    at buildAuditRecord (/app/src/audit/audit-builder.ts:97:12)",
      ].join("\n");
      const out = buildFenceWrappedCodeExcerpt(input);
      const fenceCount = (out.match(/```/g) ?? []).length;
      expect(fenceCount).toBe(2);
      expect(out).toContain("TypeError: Cannot read properties");
      expect(out).toContain("at formatTimestamp");
      // The error header is INSIDE the fences (per Codex caution #1)
      const opening = out.indexOf("```");
      const headerIdx = out.indexOf("TypeError:");
      expect(headerIdx).toBeGreaterThan(opening);
    });

    it("wraps an ANSI-bearing terminal block in ```ansi fences", () => {
      const input = [
        "Here is the terminal output from the failing deployment:",
        "",
        "\x1b[32m[INFO]\x1b[0m  Starting migration runner v2.4.1",
        "\x1b[33m[WARN]\x1b[0m  Pending migrations: 3",
        "\x1b[31m[ERROR]\x1b[0m  Migration failed",
      ].join("\n");
      const out = buildFenceWrappedCodeExcerpt(input);
      expect(out).toContain("```ansi");
      const fenceCount = (out.match(/```/g) ?? []).length;
      expect(fenceCount).toBe(2);
      // Raw ANSI bytes are preserved (per Codex caution #2)
      expect(out).toContain("\x1b[32m");
      expect(out).toContain("\x1b[31m");
    });

    it("closes a partial code block with an opening fence but no closing fence", () => {
      const input = [
        "My paste got cut off but here is what I have:",
        "",
        "```typescript",
        "async function syncUserProfile(userId: string) {",
        "  const profile = await db.users.findById",
      ].join("\n");
      const out = buildFenceWrappedCodeExcerpt(input);
      const fenceCount = (out.match(/```/g) ?? []).length;
      expect(fenceCount).toBe(2);
      // Trailing fence appended
      expect(out.endsWith("```")).toBe(true);
    });

    it("is idempotent — double application does not alter balanced output", () => {
      const input = "TypeError: bad\n    at foo (/x/y.ts:1:1)";
      const once = buildFenceWrappedCodeExcerpt(input);
      const twice = buildFenceWrappedCodeExcerpt(once);
      expect(twice).toBe(once);
      expect((twice.match(/```/g) ?? []).length).toBe(2);
    });

    it("is idempotent on partial-fence closure", () => {
      const input = "```typescript\nasync function foo() {";
      const once = buildFenceWrappedCodeExcerpt(input);
      const twice = buildFenceWrappedCodeExcerpt(once);
      expect(twice).toBe(once);
      expect((twice.match(/```/g) ?? []).length).toBe(2);
    });

    it("returns balanced input unchanged (no double-wrap)", () => {
      const input = "Already fenced:\n```\nconst x = 1;\n```\nDone.";
      const out = buildFenceWrappedCodeExcerpt(input);
      expect(out).toBe(input);
    });

    it("returns prose unchanged when no code markers present", () => {
      const input = "Just plain prose with no code markers anywhere.";
      const out = buildFenceWrappedCodeExcerpt(input);
      expect(out).toBe(input);
    });

    it("wraps a stack trace whose header is the bare 'Error: ...' form (no typed prefix)", () => {
      const input = [
        "Got an error:",
        "Error: something broke",
        "    at fn (/a/b.ts:1:2)",
        "    at gn (/a/c.ts:3:4)",
      ].join("\n");
      const out = buildFenceWrappedCodeExcerpt(input);
      const fenceCount = (out.match(/```/g) ?? []).length;
      expect(fenceCount).toBe(2);
      const opening = out.indexOf("```");
      const headerIdx = out.indexOf("Error: something broke");
      expect(headerIdx).toBeGreaterThan(opening);
    });

    it("wraps a standard indented Python traceback including source-context line and final exception", () => {
      const input = [
        "My script crashed:",
        "",
        "Traceback (most recent call last):",
        '  File "/app/main.py", line 42, in <module>',
        "    raise ValueError(\"bad\")",
        "ValueError: bad",
      ].join("\n");
      const out = buildFenceWrappedCodeExcerpt(input);
      const fenceCount = (out.match(/```/g) ?? []).length;
      expect(fenceCount).toBe(2);
      // All four trace lines must be inside the fence pair, including the
      // source-context line and the final ValueError line.
      const opening = out.indexOf("```");
      const closing = out.lastIndexOf("```");
      const tracebackIdx = out.indexOf("Traceback");
      const fileIdx = out.indexOf('  File "/app/main.py"');
      const raiseIdx = out.indexOf("    raise ValueError");
      const finalIdx = out.indexOf("ValueError: bad");
      expect(tracebackIdx).toBeGreaterThan(opening);
      expect(fileIdx).toBeGreaterThan(opening);
      expect(raiseIdx).toBeGreaterThan(opening);
      expect(finalIdx).toBeGreaterThan(opening);
      expect(finalIdx).toBeLessThan(closing);
    });

    it("prefers stack-trace wrapping when both stack trace and ANSI are present", () => {
      const input = [
        "Both pasted in one message:",
        "TypeError: bad",
        "    at foo (/x/y.ts:1:1)",
        "",
        "\x1b[31m[ERROR]\x1b[0m  later context",
      ].join("\n");
      const out = buildFenceWrappedCodeExcerpt(input);
      expect(out).toContain("TypeError: bad");
      expect(out).toContain("at foo");
      // Stack-trace path produces plain ``` not ```ansi
      const ansiFenceIdx = out.indexOf("```ansi");
      const plainFenceIdx = out.indexOf("```\n");
      expect(plainFenceIdx).toBeGreaterThanOrEqual(0);
      // Stack-trace wrap fires first; ANSI block remains outside fences
      expect(ansiFenceIdx).toBe(-1);
    });
  });
});
