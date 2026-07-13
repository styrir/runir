import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { attachServerErrorHandler } from "../app/server-error-handler.js";

// imaf.2: a listen-time 'error' (EADDRINUSE double-bind) must be a CONTROLLED
// exit with a clear log line — not an uncaught event crash that launchd
// KeepAlive turns into a re-colliding crash loop.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachServerErrorHandler (imaf.2)", () => {
  it("EADDRINUSE exits deliberately with a clear port-in-use line", () => {
    const server = new EventEmitter();
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    attachServerErrorHandler(server, 7700, exit);

    const err = Object.assign(new Error("listen EADDRINUSE :::7700"), { code: "EADDRINUSE" });
    expect(() => server.emit("error", err)).not.toThrow(); // handled, not uncaught
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("port 7700 is already in use"));
  });

  it("other server errors also exit controlled, with the error attached", () => {
    const server = new EventEmitter();
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    attachServerErrorHandler(server, 7700, exit);

    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    server.emit("error", err);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith("runir-service: HTTP server error:", err);
  });

  it("an unhandled emitter without the handler WOULD throw (control)", () => {
    const server = new EventEmitter();
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(() => server.emit("error", err)).toThrow(); // EventEmitter contract: unhandled 'error' throws
  });
});
