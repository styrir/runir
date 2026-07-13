import { describe, it, expect } from "vitest";
import { resolveTier } from "../capture/extraction/capture.js";

describe("resolveTier", () => {
  it("profile category -> durable regardless of confidence", () => {
    expect(resolveTier("profile", 0.3)).toBe("durable");
  });

  it("preferences category -> durable regardless of confidence", () => {
    expect(resolveTier("preferences", 0.1)).toBe("durable");
  });

  it("cases + confidence 0.91 -> durable", () => {
    expect(resolveTier("cases", 0.91)).toBe("durable");
  });

  it("cases + confidence 0.89 -> working", () => {
    expect(resolveTier("cases", 0.89)).toBe("working");
  });

  it("any category + confidence 0.49 -> ephemeral", () => {
    expect(resolveTier("entities", 0.49)).toBe("ephemeral");
  });

  it("any category + confidence 0.5 -> working (not ephemeral)", () => {
    expect(resolveTier("entities", 0.5)).toBe("working");
  });

  it("events + confidence 0.9 -> durable", () => {
    expect(resolveTier("events", 0.9)).toBe("durable");
  });

  it("events + confidence 0.89 -> working", () => {
    expect(resolveTier("events", 0.89)).toBe("working");
  });

  it("patterns + confidence 0.95 -> working (not durable)", () => {
    expect(resolveTier("patterns", 0.95)).toBe("working");
  });
});
