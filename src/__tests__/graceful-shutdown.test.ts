import { describe, expect, it, vi } from "vitest";
import { performGracefulShutdown } from "../app/shutdown.js";

describe("performGracefulShutdown", () => {
  it("stops consolidation, closes the server + db, then exits 0 (in order)", async () => {
    const calls: string[] = [];
    const exit = vi.fn();
    await performGracefulShutdown("SIGTERM", {
      stopConsolidation: () => calls.push("stop"),
      server: { close: () => calls.push("server.close") },
      closeDb: () => { calls.push("db.close"); return Promise.resolve(); },
      exit,
    });
    expect(calls).toEqual(["stop", "server.close", "db.close"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("closes the HTTP server so the port is released (the bug this fixes)", async () => {
    const close = vi.fn();
    const exit = vi.fn();
    await performGracefulShutdown("SIGTERM", { server: { close }, closeDb: () => {}, exit });
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when db.close rejects (best-effort, never blocks the exit)", async () => {
    const exit = vi.fn();
    await performGracefulShutdown("SIGINT", {
      closeDb: () => Promise.reject(new Error("db boom")),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when server.close throws (best-effort)", async () => {
    const exit = vi.fn();
    await performGracefulShutdown("SIGTERM", {
      server: { close: () => { throw new Error("close boom"); } },
      closeDb: () => {},
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("force-exits 1 if shutdown exceeds the timeout", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const hang = new Promise<void>(() => { /* never resolves */ });
    void performGracefulShutdown("SIGTERM", { closeDb: () => hang, exit, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(120);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
